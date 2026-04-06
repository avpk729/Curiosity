const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- DB Setup ---
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
    created_at INTEGER,
    UNIQUE(topic_lower, branch, level)
  );
`);

// --- Helpers ---
const LEVELS = ["eli5", "intermediate", "advanced", "expert"];

const LEVEL_INSTRUCTIONS = {
  eli5: "You are a brilliant, warm teacher explaining to a curious child (age 5-8). Use very simple words, vivid everyday analogies, short sentences, and a friendly tone. No jargon whatsoever. Make it delightful and memorable.",
  intermediate: "You are an engaging teacher speaking to a curious adult with general education. Use clear prose, introduce key terms naturally within sentences, use relatable analogies. Assume high-school level background.",
  advanced: "You are a knowledgeable expert writing for someone with undergraduate-level domain knowledge. Use proper terminology, explain mechanisms with precision, include mathematical formulations where genuinely useful (LaTeX: $...$ inline, $$...$$ block). Be thorough and technically accurate.",
  expert: "You are writing for a fellow specialist. Use full technical and mathematical rigor (LaTeX: $...$ inline, $$...$$ block), domain-specific language, reference key theories, models, and seminal works. Discuss nuance, limitations, and open questions in the field."
};

const SYSTEM_PROMPT = `You are Curiosity Wikipedia — an elegant academic knowledge engine. You only explain real, legitimate academic topics across all fields of knowledge. You refuse any NSFW, harmful, politically inflammatory, or non-academic requests politely and briefly.

Your writing style is narrative and flowing — like the best popular science writing. You write in well-formed paragraphs. You NEVER use markdown symbols like **, ##, *, or bullet points with hyphens in your explanation text. Everything is written as beautiful prose.

You always cite real, verifiable academic sources inline using [1], [2] etc. notation, and provide a bibliography at the end.`;

function buildPrompt(topic, level, branch) {
  const instruction = LEVEL_INSTRUCTIONS[level];
  const branchContext = branch ? ` Focus specifically on the subtopic: "${branch}" within the context of "${topic}".` : "";
  return `${instruction}

Topic to explain: "${branch || topic}"${branchContext}

Write a thorough explanation at this level. Use flowing narrative prose — NO bullet points, NO markdown headers, NO bold (**) or italic (*) markers in the explanation text. Write in well-formed paragraphs only.

Where equations genuinely aid understanding, include them as LaTeX ($...$ for inline math, $$...$$ for block equations).

After your explanation, provide inline citations using [1], [2] etc. for any claims, theories, or named concepts you reference.

Then output EXACTLY this JSON block and nothing after it, wrapped in <META> tags:
<META>
{
  "branches": ["subtopic 1", "subtopic 2", "subtopic 3", "subtopic 4"],
  "bibliography": [
    {"ref": "1", "authors": "Author, A.", "year": "2020", "title": "Full title of work", "source": "Journal or Publisher"},
    {"ref": "2", "authors": "Author, B. & Author, C.", "year": "2018", "title": "Full title of work", "source": "Journal or Publisher"}
  ]
}
</META>

Branches should be genuinely interesting subtopics to explore next (2-5 words each). Bibliography entries must be real, verifiable academic sources — books, journal articles, textbooks. Never invent sources.`;
}

async function fetchLevel(topic, level, branch) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(topic, level, branch) }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content?.map(b => b.text || "").join("") || "";
  const metaMatch = raw.match(/<META>([\s\S]*?)<\/META>/);
  let branches = [], bibliography = [];
  let content = raw;
  if (metaMatch) {
    try {
      const json = JSON.parse(metaMatch[1].trim());
      branches = json.branches || [];
      bibliography = json.bibliography || [];
    } catch {}
    content = raw.replace(/<META>[\s\S]*?<\/META>/, "").trim();
  }
  return { content, branches, bibliography };
}

// --- Routes ---

// Get all levels for a topic (parallel fetch or from cache)
app.post("/api/explore", async (req, res) => {
  const { topic, branch } = req.body;
  if (!topic || typeof topic !== "string" || topic.trim().length < 2) {
    return res.status(400).json({ error: "Invalid topic" });
  }
  const topicClean = topic.trim();
  const topicLower = topicClean.toLowerCase();
  const branchKey = branch ? branch.trim() : null;

  // Check cache for all 4 levels
  const cached = {};
  for (const lvl of LEVELS) {
    const row = db.prepare("SELECT content, branches, citations FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
      .get(topicLower, branchKey, lvl);
    if (row) {
      cached[lvl] = {
        content: row.content,
        branches: JSON.parse(row.branches || "[]"),
        bibliography: JSON.parse(row.citations || "[]")
      };
    }
  }

  const missing = LEVELS.filter(l => !cached[l]);

  if (missing.length > 0) {
    // Fetch missing levels in parallel
    try {
      const results = await Promise.all(missing.map(lvl => fetchLevel(topicClean, lvl, branchKey)));
      const now = Date.now();
      const insert = db.prepare(`
        INSERT OR REPLACE INTO explanations (topic_lower, branch, level, content, branches, citations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      missing.forEach((lvl, i) => {
        const r = results[i];
        insert.run(topicLower, branchKey, lvl, r.content, JSON.stringify(r.branches), JSON.stringify(r.bibliography), now);
        cached[lvl] = r;
      });
    } catch (err) {
      console.error("Claude fetch error:", err.message);
      return res.status(500).json({ error: "Failed to fetch explanation. Check API key or try again." });
    }
  }

  // Update visit count
  const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
  if (existing) {
    db.prepare("UPDATE topics SET visits=visits+1, last_visited=? WHERE topic_lower=?").run(Date.now(), topicLower);
  } else {
    db.prepare("INSERT INTO topics (topic, topic_lower, category, visits, last_visited, created_at) VALUES (?,?,?,1,?,?)")
      .run(topicClean, topicLower, req.body.category || "general", Date.now(), Date.now());
  }

  res.json({ levels: cached });
});

// Get repository (top topics by visits)
app.get("/api/repository", (req, res) => {
  const rows = db.prepare("SELECT topic, category, visits FROM topics ORDER BY visits DESC LIMIT 100").all();
  res.json({ topics: rows });
});

app.listen(PORT, () => console.log(`Curiosity Wikipedia running on port ${PORT}`));
