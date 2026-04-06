const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const cron = require("node-cron");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── DB Setup ──────────────────────────────────────────
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
  CREATE TABLE IF NOT EXISTS tree_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    level TEXT NOT NULL,
    topics TEXT NOT NULL,
    updated_at INTEGER,
    UNIQUE(subject, level)
  );
`);

// Safe migrations
const cols = db.prepare("PRAGMA table_info(explanations)").all().map(c => c.name);
if (!cols.includes("visuals")) {
  try { db.exec("ALTER TABLE explanations ADD COLUMN visuals TEXT"); } catch(e) {}
}
if (!CLAUDE_API_KEY) console.error("⚠️  CLAUDE_API_KEY not set!");

// ── Constants ─────────────────────────────────────────
const LEVELS = ["grade5", "college", "masters", "phd"];
const LEVEL_LABELS = { grade5: "5th Grade", college: "College", masters: "Master's", phd: "PhD" };

const ALL_SUBJECTS = [
  "Business & Economics", "Arts, Law & Education", "Health & Medicine",
  "Sciences & Engineering", "Maritime & Logistics", "Marine & Antarctic Studies",
  "Information & Computing", "Research & Methods", "CPA Australia",
  "AMSA & STCW Certification", "Project Management (PMP)",
  "GMAT & Graduate Admissions", "IELTS & Academic English"
];

// Base topics per subject — used as seed for tree generation
const BASE_TOPICS = {
  "Business & Economics": ["Microeconomics","Macroeconomics","Financial Accounting","Management Accounting","Corporate Finance","Business Statistics","Organisational Behaviour","Strategic Management","Marketing Management","International Business","Supply Chain Management","Entrepreneurship","Business Law","Human Resource Management","Operations Management","Behavioural Economics","Investment Analysis","Business Ethics"],
  "Arts, Law & Education": ["Constitutional Law","Contract Law","Criminal Law","Tort Law","International Law","Curriculum Design","Educational Psychology","Sociology","Political Science","International Relations","Criminology","Social Work","Philosophy","History","English Literature","Media & Communications","Gender Studies","Indigenous Studies","Fine Arts & Design","Music Theory"],
  "Health & Medicine": ["Human Anatomy","Physiology","Biochemistry","Pathology","Pharmacology","Immunology","Microbiology","Clinical Medicine","Medical Ethics","Epidemiology","Nursing Practice","Mental Health Nursing","Paramedic Science","Public Health","Health Policy","Pharmacy Practice","Neuropsychology","Dementia & Ageing","Nutrition & Dietetics","Occupational Therapy"],
  "Sciences & Engineering": ["Calculus & Analysis","Linear Algebra","Statistics & Probability","Physics","Chemistry","Environmental Science","Marine Biology","Ecology","Geology","Geography & GIS","Civil Engineering","Mechanical Engineering","Electrical Engineering","Chemical Engineering","Software Engineering","Algorithms & Data Structures","Architecture & Urban Design","Agricultural Science","Climate Science"],
  "Maritime & Logistics": ["Maritime Law","Ship Stability","Naval Architecture","Marine Engineering","Nautical Science & Navigation","Port Operations Management","Maritime Safety","Shipping Logistics","Vessel Traffic Management","Marine Environmental Management","Offshore Engineering","Maritime Economics","Cargo Management","Maritime Risk Assessment","Seafarer Certification"],
  "Marine & Antarctic Studies": ["Oceanography","Antarctic Climate Systems","Southern Ocean Ecology","Marine Conservation","Fisheries Science","Aquaculture","Sea Ice Dynamics","Polar Meteorology","Deep Sea Biology","Marine Biogeochemistry","Remote Sensing of Oceans","Climate Change & Sea Level","Coastal Management"],
  "Information & Computing": ["Programming Fundamentals","Object-Oriented Design","Database Systems","Cybersecurity","Artificial Intelligence","Machine Learning","Data Science","Human-Computer Interaction","Cloud Computing","Operating Systems","Computer Networks","Information Systems","Web Development","Blockchain Technology","Quantum Computing","Digital Forensics"],
  "Research & Methods": ["Research Design","Quantitative Methods","Qualitative Methods","Systematic Literature Review","Statistical Analysis","Academic Writing","Ethics in Research","Mixed Methods","Survey Design","Data Visualisation","Bibliometrics","Econometrics","DEA & Productivity Analysis"],
  "CPA Australia": ["Ethics & Governance","Strategic Management Accounting","Financial Reporting","Global Strategy & Leadership","Advanced Audit & Assurance","Australian Taxation","Advanced Taxation","Financial Risk Management","Contemporary Business Issues","Corporate Governance","Financial Accounting Foundations","Economics & Markets","Business Law Foundations","Digital Finance"],
  "AMSA & STCW Certification": ["STCW Basic Safety Training","Personal Survival Techniques","Fire Prevention & Firefighting","Elementary First Aid","Personal Safety & Social Responsibility","Navigational Watchkeeping","Collision Regulations (COLREGs)","Celestial Navigation","ECDIS & Electronic Navigation","Radar & ARPA","GMDSS Radio Operations","Ship Stability & Trim","Marine Engineering Watchkeeping","ISM Code","MARPOL","SOLAS Regulations","ISPS Code","Cargo Operations","Search & Rescue","Port State Control"],
  "Project Management (PMP)": ["Project Initiation & Charter","Scope Management","Schedule Management","Cost Management","Risk Management","Quality Management","Stakeholder Engagement","Resource Management","Procurement Management","Communications Management","Agile & Scrum","Hybrid Project Management","Change Management","Earned Value Management","Project Leadership","Benefits Realisation","Project Closure"],
  "GMAT & Graduate Admissions": ["Quantitative Reasoning","Verbal Reasoning","Data Insights","Critical Reasoning","Reading Comprehension","Data Sufficiency","Problem Solving","Integrated Reasoning","MBA Application Strategy","Statement of Purpose Writing"],
  "IELTS & Academic English": ["Academic Reading Skills","Academic Writing Task 1","Academic Writing Task 2","IELTS Listening","IELTS Speaking","Grammar for Academic Writing","Vocabulary Building","Critical Thinking in English","Referencing & Citation","Paraphrasing & Summarising","Research Paper Writing","Presentation Skills"]
};

const LEVEL_TREE_INSTRUCTIONS = {
  grade5: `You are mapping the foundational, entry-level subtopics for this subject. Include the core concepts a beginner or school student would encounter first. Use clear, recognisable academic topic names (not simplified descriptions). Return 8-12 subtopics.`,
  college: `You are mapping undergraduate-level subtopics for this subject. Include the core topics PLUS intermediate concepts introduced at university level that build on foundations. Use proper academic terminology. Return 12-16 subtopics.`,
  masters: `You are mapping postgraduate/Master's-level subtopics for this subject. Include advanced theoretical frameworks, research methodologies, and specialised areas not typically covered at undergraduate level. Return 14-18 subtopics.`,
  phd: `You are mapping doctoral/PhD-level subtopics for this subject. Include frontier research areas, cutting-edge methodologies, interdisciplinary topics, and open research questions that define the knowledge frontier of this field. Return 16-20 subtopics.`
};

// ── Tree generation ───────────────────────────────────
async function generateTreeTopics(subject, level) {
  const baseTopics = BASE_TOPICS[subject] || [];
  const prompt = `${LEVEL_TREE_INSTRUCTIONS[level]}

Subject: "${subject}"
Base topics already known at this level: ${baseTopics.slice(0, 8).join(", ")}

Generate the comprehensive list of canonical academic subtopics for "${subject}" at the ${LEVEL_LABELS[level]} level. 
These will appear in a knowledge tree to guide students on what they can learn.

Rules:
- Use proper academic/professional terminology (e.g. "Metacentric Height" not "How ships balance")
- Include topics from the base list that are relevant at this level
- Add deeper/more specialised topics appropriate for this level
- Each topic should be 2-5 words
- Topics should be genuinely distinct from each other

Respond ONLY with a JSON array of topic strings, no other text:
["Topic 1", "Topic 2", "Topic 3", ...]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: "You are an academic curriculum mapping assistant. You only output valid JSON arrays of academic topic strings. Never include explanations or markdown.",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content?.map(b => b.text || "").join("") || "[]";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function refreshTreeForSubject(subject, level) {
  try {
    const topics = await generateTreeTopics(subject, level);
    db.prepare(`INSERT OR REPLACE INTO tree_topics (subject, level, topics, updated_at) VALUES (?,?,?,?)`)
      .run(subject, level, JSON.stringify(topics), Date.now());
    console.log(`✓ Tree refreshed: ${subject} / ${level} (${topics.length} topics)`);
    return topics;
  } catch(e) {
    console.error(`✗ Tree refresh failed: ${subject} / ${level}:`, e.message);
    return BASE_TOPICS[subject] || [];
  }
}

async function refreshAllTree() {
  console.log("🌳 Starting full tree refresh...");
  for (const subject of ALL_SUBJECTS) {
    for (const level of LEVELS) {
      await refreshTreeForSubject(subject, level);
      await new Promise(r => setTimeout(r, 500)); // rate limit buffer
    }
  }
  console.log("✅ Full tree refresh complete.");
}

// ── Level prompts ──────────────────────────────────────
const LEVEL_INSTRUCTIONS = {
  grade5: `You are a warm, brilliant teacher explaining to a curious 10-year-old. Use very simple words, vivid everyday analogies, and short friendly sentences. No jargon. This is the reader's very first encounter with this topic.`,
  college: `You are explaining to a college undergraduate who has ALREADY read and fully understood a basic introductory explanation of this topic. DO NOT re-explain the basic premise. Build directly on that foundation — introduce proper terminology, mechanisms, and real-world applications.`,
  masters: `You are explaining to a graduate student who fully understands both the introductory and undergraduate treatments. DO NOT recap basics. Go directly into advanced mechanisms, theoretical frameworks, mathematical formulations (LaTeX: $...$ inline, $$...$$ block), nuance, and research context.`,
  phd: `You are writing for a doctoral researcher who has mastered all previous levels. DO NOT revisit anything covered before. Focus on: cutting-edge research questions, open problems, competing theoretical frameworks, mathematical rigour (LaTeX: $...$ inline, $$...$$ block), seminal literature, methodological debates, and frontier ideas.`
};

const SYSTEM_PROMPT = `You are Curiosity Wikipedia — an elegant, progressive academic knowledge engine. Each explanation builds on the previous level — never restates basics. You only explain legitimate academic topics. Refuse NSFW or non-academic requests politely.

Write in narrative flowing prose grouped under clear thematic section headings. NEVER use markdown symbols like **, ##, *, or bullet points.

Structure every explanation as 3-5 thematic sections, each starting with [HEADING: Section Title Here].

Always cite real, verifiable academic sources inline as [1], [2] etc. and include a bibliography.`;

function buildPrompt(topic, level, branch, prevContent) {
  const instruction = LEVEL_INSTRUCTIONS[level];
  const branchCtx = branch ? ` Focus specifically on the subtopic: "${branch}" within "${topic}".` : "";
  const prevCtx = prevContent
    ? `\n\nThe reader has ALREADY studied this at the previous level — do NOT repeat or re-introduce any of this:\n---\n${prevContent}\n---\nBuild directly on this.\n`
    : "";

  return `${instruction}${prevCtx}

Topic: "${branch || topic}"${branchCtx}

Write a thorough explanation in 3-5 thematic sections. Each section begins with:
[HEADING: Your Section Title Here]
Then flowing narrative prose. No bullet points, no markdown, no bold markers.
Include LaTeX math where genuinely useful ($...$ inline, $$...$$ block).
Cite sources inline as [1], [2] etc.

Then output EXACTLY this JSON in <META> tags and nothing after:
<META>
{
  "branches": ["subtopic 1", "subtopic 2", "subtopic 3", "subtopic 4"],
  "bibliography": [
    {"ref": "1", "authors": "Author, A.", "year": "2020", "title": "Full title", "source": "Journal or Publisher"}
  ],
  "flowchart": {
    "include": true,
    "title": "Short title",
    "nodes": [{"id": "1", "label": "Step name"}, {"id": "2", "label": "Next step"}]
  },
  "conceptMap": {
    "include": true,
    "title": "Short title",
    "nodes": [{"label": "Central topic"}, {"label": "Related 1"}, {"label": "Related 2"}]
  }
}
</META>

flowchart.include=true only for sequential processes. conceptMap.include=true for interconnected concepts. Otherwise set include=false.
Branches: 4 genuinely interesting subtopics (2-5 words). Bibliography: real verifiable sources only.`;
}

// ── Routes ─────────────────────────────────────────────

// Get tree topics for a given level
app.get("/api/tree", (req, res) => {
  const level = req.query.level || "grade5";
  const result = {};
  for (const subject of ALL_SUBJECTS) {
    const row = db.prepare("SELECT topics FROM tree_topics WHERE subject=? AND level=?").get(subject, level);
    if (row) {
      try { result[subject] = JSON.parse(row.topics); } catch(e) { result[subject] = BASE_TOPICS[subject] || []; }
    } else {
      result[subject] = BASE_TOPICS[subject] || [];
    }
  }
  res.json({ tree: result, level });
});

// Trigger tree refresh for a specific subject+level (called lazily when user opens a section)
app.post("/api/tree/refresh", async (req, res) => {
  const { subject, level } = req.body;
  if (!subject || !level) return res.status(400).json({ error: "subject and level required" });
  const existing = db.prepare("SELECT topics, updated_at FROM tree_topics WHERE subject=? AND level=?").get(subject, level);
  const oneDay = 24 * 60 * 60 * 1000;
  if (existing && (Date.now() - existing.updated_at) < oneDay) {
    try { return res.json({ topics: JSON.parse(existing.topics), cached: true }); } catch(e) {}
  }
  const topics = await refreshTreeForSubject(subject, level);
  res.json({ topics, cached: false });
});

// Main explore endpoint — one level at a time
app.post("/api/explore", async (req, res) => {
  const { topic, branch, category, level, prevContent } = req.body;
  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Invalid topic" });

  const topicClean = topic.trim();
  const topicLower = topicClean.toLowerCase();
  const branchKey = branch ? branch.trim() : null;
  const lvl = level || "grade5";

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
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
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

      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower, branch, level, content, branches, citations, visuals, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(topicLower, branchKey, lvl, content, JSON.stringify(branches), JSON.stringify(bibliography), JSON.stringify(visuals), Date.now());

      result = { content, branches, bibliography, ...visuals };
    } catch(err) {
      console.error("Claude error:", err.message);
      return res.status(500).json({ error: "Failed to fetch explanation. Please try again." });
    }
  }

  if (lvl === "grade5") {
    const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
    if (existing) {
      db.prepare("UPDATE topics SET visits=visits+1, last_visited=?, category=? WHERE topic_lower=?").run(Date.now(), category || "general", topicLower);
    } else {
      db.prepare("INSERT INTO topics (topic, topic_lower, category, visits, last_visited, created_at) VALUES (?,?,?,1,?,?)").run(topicClean, topicLower, category || "general", Date.now(), Date.now());
    }
  }

  res.json({ levels: { [lvl]: result } });
});

// Repository — includes explored branches per topic
app.get("/api/repository", (req, res) => {
  const topics = db.prepare("SELECT topic, category, visits FROM topics ORDER BY visits DESC LIMIT 100").all();
  const withBranches = topics.map(t => {
    const branches = db.prepare("SELECT DISTINCT branch FROM explanations WHERE topic_lower=? AND branch IS NOT NULL AND level='grade5' ORDER BY created_at ASC")
      .all(t.topic.toLowerCase()).map(r => r.branch);
    return { ...t, branches };
  });
  res.json({ topics: withBranches });
});

// Admin: trigger full tree refresh manually
app.post("/api/admin/refresh-tree", async (req, res) => {
  res.json({ message: "Tree refresh started in background" });
  refreshAllTree().catch(console.error);
});

// ── Daily cron: refresh tree at midnight UTC ───────────
cron.schedule("0 0 * * *", () => {
  console.log("🕛 Daily tree refresh triggered by cron");
  refreshAllTree().catch(console.error);
}, { timezone: "UTC" });

// ── Initial tree seed on startup (if empty) ───────────
const treeCount = db.prepare("SELECT COUNT(*) as n FROM tree_topics").get().n;
if (treeCount === 0) {
  console.log("🌱 No tree data found — seeding base topics...");
  // Seed synchronously from BASE_TOPICS (no API calls, instant)
  const insert = db.prepare("INSERT OR IGNORE INTO tree_topics (subject, level, topics, updated_at) VALUES (?,?,?,?)");
  for (const [subject, topics] of Object.entries(BASE_TOPICS)) {
    for (const level of LEVELS) {
      insert.run(subject, level, JSON.stringify(topics), Date.now());
    }
  }
  console.log("✅ Base tree seeded. Daily cron will enrich with level-specific topics tonight.");
}

app.listen(PORT, () => console.log(`Curiosity Wikipedia running on port ${PORT}`));
