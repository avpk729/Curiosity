const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("curiosity.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    topic_lower TEXT NOT NULL UNIQUE,
    category TEXT DEFAULT 'general',
    visits INTEGER DEFAULT 1,
    last_visited INTEGER,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS explanations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_lower TEXT NOT NULL,
    branch TEXT,
    level TEXT NOT NULL,
    content TEXT NOT NULL,
    branches TEXT,
    citations TEXT,
    visuals TEXT,
    created_at INTEGER,
    UNIQUE(topic_lower, branch, level)
  );
`);

// Safe schema migration — add columns if missing
const cols = db.prepare("PRAGMA table_info(explanations)").all().map(c => c.name);
if (!cols.includes("visuals")) {
  try { db.exec("ALTER TABLE explanations ADD COLUMN visuals TEXT"); } catch(e) { console.log("visuals col:", e.message); }
}

// Validate Claude API key on startup
if (!CLAUDE_API_KEY) console.error("⚠️  CLAUDE_API_KEY environment variable is not set!");

const LEVEL_INSTRUCTIONS = {
  grade5: `You are a warm, brilliant teacher explaining to a curious 10-year-old. Use very simple words, vivid everyday analogies, and short friendly sentences. No jargon. Make it memorable and delightful. This is the reader's very first encounter with this topic.`,
  college: `You are explaining to a college undergraduate who has ALREADY read and fully understood a basic introductory explanation of this topic. DO NOT re-explain the basic premise or restate introductory concepts. Build directly on that foundation — introduce proper terminology, mechanisms, and real-world applications.`,
  masters: `You are explaining to a graduate student who fully understands both the introductory and undergraduate treatments of this topic. DO NOT recap basics. Go directly into advanced mechanisms, theoretical frameworks, mathematical formulations where relevant (LaTeX: $...$ inline, $$...$$ block), nuance, and research context. Introduce sub-concepts that would have been premature at lower levels.`,
  phd: `You are writing for a doctoral researcher who has mastered all previous levels of understanding of this topic. DO NOT revisit anything covered before. Focus exclusively on: cutting-edge research questions, open problems, competing theoretical frameworks, mathematical rigour (LaTeX: $...$ inline, $$...$$ block), seminal and recent literature, methodological debates, and frontier ideas entirely new to this level.`
};

const SYSTEM_PROMPT = `You are Curiosity Wikipedia — an elegant, progressive academic knowledge engine. Each explanation builds on the previous level — never restates basics already covered. You only explain legitimate academic topics across all fields of knowledge. Refuse any NSFW, harmful, or non-academic requests politely.

Your writing style is narrative and flowing — like the best academic prose and science writing. You write in well-formed paragraphs grouped under clear thematic section headings. You NEVER use markdown symbols like **, ##, *, or bullet points. Everything is beautiful flowing prose.

Structure every explanation as 3-5 thematic sections, each starting with [HEADING: Section Title Here].

Always cite real, verifiable academic sources inline as [1], [2] etc. and include a bibliography.`;

function buildPrompt(topic, level, branch, prevContent) {
  const instruction = LEVEL_INSTRUCTIONS[level];
  const branchCtx = branch ? ` Focus specifically on the subtopic: "${branch}" within "${topic}".` : "";
  const prevCtx = prevContent
    ? `\n\nThe reader has ALREADY studied this topic at the previous level. Here is what they learned — do NOT repeat or re-introduce any of this:\n---\n${prevContent}\n---\nBuild directly on top of this knowledge.\n`
    : "";

  return `${instruction}${prevCtx}

Topic: "${branch || topic}"${branchCtx}

Write a thorough explanation in 3-5 thematic sections. Each section begins with exactly:
[HEADING: Your Section Title Here]
Then flowing narrative prose paragraphs. No bullet points, no markdown, no bold markers.

Include LaTeX math where it genuinely aids understanding ($...$ inline, $$...$$ block).

After your explanation, provide inline citations [1], [2] etc.

Then output EXACTLY this JSON in <META> tags and nothing after:
<META>
{
  "branches": ["subtopic 1", "subtopic 2", "subtopic 3", "subtopic 4"],
  "bibliography": [
    {"ref": "1", "authors": "Author, A.", "year": "2020", "title": "Full title", "source": "Journal or Publisher"}
  ],
  "flowchart": {
    "include": true or false,
    "title": "Short descriptive title",
    "nodes": [
      {"id": "1", "label": "Step or concept name"},
      {"id": "2", "label": "Next step or concept"}
    ]
  },
  "conceptMap": {
    "include": true or false,
    "title": "Short title",
    "nodes": [
      {"label": "Central topic"},
      {"label": "Related concept 1"},
      {"label": "Related concept 2"},
      {"label": "Related concept 3"},
      {"label": "Related concept 4"},
      {"label": "Related concept 5"}
    ]
  }
}
</META>

For flowchart: include=true only if this topic has a clear sequential process or causal chain (e.g. how a cell divides, how monetary policy works, how a compiler works). Keep nodes to 4-7 steps, labels max 5 words each.
For conceptMap: include=true for topics with multiple interconnected sub-concepts (e.g. economic theories, philosophical movements, biological systems). First node is the central hub. 4-6 spoke nodes.
If neither adds genuine comprehension value, set include=false for both.
Branches: 4 genuinely interesting subtopics (2-5 words each). Bibliography: real verifiable sources only.`;
}

app.post("/api/explore", async (req, res) => {
  const { topic, branch, category, level, prevContent } = req.body;
  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Invalid topic" });

  const topicClean = topic.trim();
  const topicLower = topicClean.toLowerCase();
  const branchKey = branch ? branch.trim() : null;
  const lvl = level || "grade5";

  // Check cache for this specific level
  const cached = db.prepare("SELECT content, branches, citations, visuals FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
    .get(topicLower, branchKey, lvl);

  let result;
  if (cached) {
    result = {
      content: cached.content,
      branches: JSON.parse(cached.branches || "[]"),
      bibliography: JSON.parse(cached.citations || "[]"),
      ...JSON.parse(cached.visuals || "{}")
    };
  } else {
    // Fetch from Claude
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2400,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildPrompt(topicClean, lvl, branchKey, prevContent) }]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      const raw = data.content?.map(b => b.text || "").join("") || "";
      const metaMatch = raw.match(/<META>([\s\S]*?)<\/META>/);
      let branches = [], bibliography = [], flowchart = null, conceptMap = null;
      let content = raw;

      if (metaMatch) {
        try {
          const json = JSON.parse(metaMatch[1].trim());
          branches = json.branches || [];
          bibliography = json.bibliography || [];
          if (json.flowchart?.include && json.flowchart.nodes?.length) flowchart = json.flowchart;
          if (json.conceptMap?.include && json.conceptMap.nodes?.length) conceptMap = json.conceptMap;
        } catch(e) {}
        content = raw.replace(/<META>[\s\S]*?<\/META>/, "").trim();
      }

      const visuals = {};
      if (flowchart) { visuals.flowchart = flowchart.nodes; visuals.flowchartTitle = flowchart.title; }
      if (conceptMap) { visuals.conceptMap = conceptMap.nodes; visuals.conceptMapTitle = conceptMap.title; }

      const now = Date.now();
      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower, branch, level, content, branches, citations, visuals, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(topicLower, branchKey, lvl, content, JSON.stringify(branches), JSON.stringify(bibliography), JSON.stringify(visuals), now);

      result = { content, branches, bibliography, ...visuals };

    } catch (err) {
      console.error("Claude error:", err.message);
      return res.status(500).json({ error: "Failed to fetch explanation. Please try again." });
    }
  }

  // Update visit count (only on grade5 = first load of topic)
  if (lvl === "grade5") {
    const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
    if (existing) {
      db.prepare("UPDATE topics SET visits=visits+1, last_visited=? WHERE topic_lower=?").run(Date.now(), topicLower);
    } else {
      db.prepare("INSERT INTO topics (topic, topic_lower, category, visits, last_visited, created_at) VALUES (?,?,?,1,?,?)")
        .run(topicClean, topicLower, category || "general", Date.now(), Date.now());
    }
  }

  res.json({ levels: { [lvl]: result } });
});

app.get("/api/repository", (req, res) => {
  const topics = db.prepare("SELECT topic, category, visits FROM topics ORDER BY visits DESC LIMIT 100").all();
  // For each topic, get its explored branches
  const withBranches = topics.map(t => {
    const branches = db.prepare(
      "SELECT DISTINCT branch FROM explanations WHERE topic_lower=? AND branch IS NOT NULL AND level='grade5' ORDER BY created_at ASC"
    ).all(t.topic.toLowerCase()).map(r => r.branch);
    return { ...t, branches };
  });
  res.json({ topics: withBranches });
});

app.listen(PORT, () => console.log(`Curiosity Wikipedia running on port ${PORT}`));
