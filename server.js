const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const cron = require("node-cron");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const ANALYTICS_SECRET = process.env.ANALYTICS_SECRET || "change-me-in-railway-env";
const DB_PATH = process.env.DB_PATH || "/app/data/curiosity.db";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── DB ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL, topic_lower TEXT NOT NULL UNIQUE,
    category TEXT DEFAULT 'general', visits INTEGER DEFAULT 1,
    last_visited INTEGER, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS explanations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_lower TEXT NOT NULL, branch TEXT, level TEXT NOT NULL,
    content TEXT NOT NULL, branches TEXT, citations TEXT, visuals TEXT,
    created_at INTEGER, UNIQUE(topic_lower, branch, level)
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT, level TEXT, category TEXT, action TEXT DEFAULT 'view',
    ip_hash TEXT, user_agent TEXT, referrer TEXT, created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_pv_topic ON page_views(topic);
`);

const ecols = db.prepare("PRAGMA table_info(explanations)").all().map(c=>c.name);
if(!ecols.includes("visuals")) try{db.exec("ALTER TABLE explanations ADD COLUMN visuals TEXT");}catch(e){}
if(!CLAUDE_API_KEY) console.error("⚠️  CLAUDE_API_KEY not set!");

// ── Constants ─────────────────────────────────────────
const LEVELS = ["grade5","college","masters","phd"];
const LEVEL_LABELS = {grade5:"5th Grade",college:"College",masters:"Master's",phd:"PhD"};

const LEVEL_INSTRUCTIONS = {
  grade5:`You are a warm, brilliant teacher giving someone their very first encounter with this topic. Use simple words and vivid everyday analogies. Keep sentences short and friendly. No unexplained jargon. Begin with 1-2 sentences of essential context so the explanation stands alone.

When you mention a concept that naturally leads somewhere more advanced, mark it: [DEEPER: concept name]. Use sparingly — 2-3 per explanation maximum.`,

  college:`You are explaining this topic at undergraduate level. Begin with 1-2 sentences of essential context so the explanation stands alone even without prior reading. Introduce proper terminology, mechanisms, and real-world applications with clear precision.

Mark foundational concepts the reader might not know: [PREREQ: concept name]. Mark advanced concepts worth exploring: [DEEPER: concept name]. Use each 2-3 times maximum.`,

  masters:`You are writing at graduate level. Begin with 2-3 sentences orienting the reader — the key insight or framework that grounds everything — before going deep. Use full technical rigour: advanced mechanisms, theoretical frameworks, mathematical formulations (LaTeX: $...$ inline, $$...$$ block), research context.

Mark prerequisites: [PREREQ: concept name]. Mark frontier extensions: [DEEPER: concept name]. Use each 2-4 times.`,

  phd:`You are writing a doctoral-level treatment. Open with 2-3 sentences anchoring the topic's position in the field and its central open question. Focus on research frontiers, open problems, competing frameworks, mathematical rigour (LaTeX: $...$ inline, $$...$$ block), seminal and recent literature, methodological debates.

Mark key prerequisites: [PREREQ: concept name]. Do NOT use [DEEPER] — this is the frontier. Use [PREREQ] 3-5 times.`
};

const SYSTEM_PROMPT = `You are Curiosity Wikipedia — an elegant, progressive academic knowledge engine. You only explain legitimate academic topics. Refuse NSFW or non-academic requests politely.

Write in narrative flowing prose grouped under clear thematic section headings. NEVER use markdown symbols like **, ##, *, or bullet points. Everything is beautiful flowing prose.

Structure every explanation as 3-5 thematic sections, each starting with [HEADING: Section Title Here].

Always cite real, verifiable academic sources inline as [1], [2] etc. and include a bibliography.`;

function buildPrompt(topic, level, branch, prevContent) {
  const instruction = LEVEL_INSTRUCTIONS[level];
  const branchCtx = branch ? ` Focus specifically on the subtopic: "${branch}" within "${topic}".` : "";
  const prevCtx = prevContent
    ? `\n\nThe reader may or may not have read previous levels. Provide essential context in your opening sentences, then build on this foundation:\n---\n${prevContent.slice(0,1200)}\n---\n`
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
  "branches": ["subtopic 1","subtopic 2","subtopic 3","subtopic 4"],
  "bibliography": [{"ref":"1","authors":"Author, A.","year":"2020","title":"Full title","source":"Journal or Publisher"}],
  "flowchart": {"include": false, "title": "", "nodes": []},
  "conceptMap": {"include": false, "title": "", "nodes": []}
}
</META>

flowchart.include=true only for sequential processes. conceptMap.include=true for interconnected concepts. Otherwise false.
Branches: 4 genuinely interesting subtopics (2-5 words). Bibliography: real verifiable sources only.`;
}

// ── Explore endpoint ──────────────────────────────────
app.post("/api/explore", async (req, res) => {
  const { topic, branch, category, level, prevContent } = req.body;
  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Invalid topic" });

  const topicClean = topic.trim();
  const topicLower = topicClean.toLowerCase();
  const branchKey = branch ? branch.trim() : null;
  const lvl = level || "grade5";

  const cached = db.prepare("SELECT content,branches,citations,visuals FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
    .get(topicLower, branchKey, lvl);

  let result;
  if (cached) {
    result = { content:cached.content, branches:JSON.parse(cached.branches||"[]"), bibliography:JSON.parse(cached.citations||"[]"), ...JSON.parse(cached.visuals||"{}") };
  } else {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":CLAUDE_API_KEY,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:2400, system:SYSTEM_PROMPT, messages:[{role:"user",content:buildPrompt(topicClean,lvl,branchKey,prevContent)}] })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const raw = data.content?.map(b=>b.text||"").join("")||"";
      const metaMatch = raw.match(/<META>([\s\S]*?)<\/META>/);
      let branches=[],bibliography=[],flowchart=null,conceptMap=null;
      let content = raw;
      if (metaMatch) {
        try {
          const json = JSON.parse(metaMatch[1].trim());
          branches = json.branches||[];
          bibliography = json.bibliography||[];
          if (json.flowchart?.include && json.flowchart.nodes?.length) flowchart=json.flowchart;
          if (json.conceptMap?.include && json.conceptMap.nodes?.length) conceptMap=json.conceptMap;
        } catch(e) {}
        content = raw.replace(/<META>[\s\S]*?<\/META>/,"").trim();
      }
      const visuals = {};
      if (flowchart) { visuals.flowchart=flowchart.nodes; visuals.flowchartTitle=flowchart.title; }
      if (conceptMap) { visuals.conceptMap=conceptMap.nodes; visuals.conceptMapTitle=conceptMap.title; }
      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower,branch,level,content,branches,citations,visuals,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(topicLower,branchKey,lvl,content,JSON.stringify(branches),JSON.stringify(bibliography),JSON.stringify(visuals),Date.now());
      result = { content, branches, bibliography, ...visuals };
    } catch(err) {
      console.error("Claude error:", err.message);
      return res.status(500).json({ error:"Failed to fetch explanation. Please try again." });
    }
  }

  if (lvl === "grade5") {
    const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
    if (existing) db.prepare("UPDATE topics SET visits=visits+1,last_visited=?,category=? WHERE topic_lower=?").run(Date.now(),category||"general",topicLower);
    else db.prepare("INSERT INTO topics (topic,topic_lower,category,visits,last_visited,created_at) VALUES (?,?,?,1,?,?)").run(topicClean,topicLower,category||"general",Date.now(),Date.now());
  }
  res.json({ levels:{ [lvl]:result } });
});

// ── Repository ────────────────────────────────────────
app.get("/api/repository", (req, res) => {
  const topics = db.prepare("SELECT topic,category,visits FROM topics ORDER BY visits DESC LIMIT 100").all();
  const withBranches = topics.map(t => {
    const branches = db.prepare("SELECT DISTINCT branch FROM explanations WHERE topic_lower=? AND branch IS NOT NULL AND level='grade5' ORDER BY created_at ASC")
      .all(t.topic.toLowerCase()).map(r=>r.branch);
    return {...t, branches};
  });
  res.json({ topics:withBranches });
});

// ── Analytics ─────────────────────────────────────────
function hashIP(ip){let h=0;for(let i=0;i<ip.length;i++){h=Math.imul(31,h)+ip.charCodeAt(i)|0;}return Math.abs(h).toString(16);}

app.post("/api/analytics/track", (req, res) => {
  const {topic,level,category,action} = req.body;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()||req.socket.remoteAddress||"unknown";
  const ua = (req.headers["user-agent"]||"").slice(0,200);
  const referrer = (req.headers.referer||"").slice(0,200);
  db.prepare(`INSERT INTO page_views (topic,level,category,action,ip_hash,user_agent,referrer,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(topic||null,level||null,category||null,action||"view",hashIP(ip),ua,referrer,Date.now());
  res.json({ok:true});
});

app.get(`/analytics/${ANALYTICS_SECRET}`, (req, res) => {
  const now=Date.now(), day=86400000, week=day*7, month=day*30;
  const totalViews=db.prepare("SELECT COUNT(*) as n FROM page_views").get().n;
  const viewsToday=db.prepare("SELECT COUNT(*) as n FROM page_views WHERE created_at>?").get(now-day).n;
  const viewsWeek=db.prepare("SELECT COUNT(*) as n FROM page_views WHERE created_at>?").get(now-week).n;
  const uvToday=db.prepare("SELECT COUNT(DISTINCT ip_hash) as n FROM page_views WHERE created_at>?").get(now-day).n;
  const uvWeek=db.prepare("SELECT COUNT(DISTINCT ip_hash) as n FROM page_views WHERE created_at>?").get(now-week).n;
  const topTopics=db.prepare("SELECT topic,COUNT(*) as views,COUNT(DISTINCT ip_hash) as uv FROM page_views WHERE topic IS NOT NULL GROUP BY topic ORDER BY views DESC LIMIT 20").all();
  const levelDist=db.prepare("SELECT level,COUNT(*) as n FROM page_views WHERE level IS NOT NULL GROUP BY level ORDER BY n DESC").all();
  const catDist=db.prepare("SELECT category,COUNT(*) as n FROM page_views WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC LIMIT 10").all();
  const recent=db.prepare("SELECT topic,level,category,action,created_at FROM page_views ORDER BY created_at DESC LIMIT 20").all();
  const maxV=topTopics[0]?.views||1, maxL=levelDist[0]?.n||1, maxC=catDist[0]?.n||1;
  const bar=(v,m,c="#1D9E75")=>`<div style="display:flex;align-items:center;gap:8px;"><div style="flex:1;height:7px;background:#f0efe9;border-radius:4px;"><div style="width:${Math.round(v/m*100)}%;height:100%;background:${c};border-radius:4px;"></div></div><span style="font-size:12px;color:#5a5a56;min-width:28px;text-align:right;">${v}</span></div>`;
  const card=(t,v,s="")=>`<div style="background:#fff;border:0.5px solid rgba(0,0,0,0.12);border-radius:10px;padding:16px 20px;"><div style="font-size:10px;font-weight:600;color:#9a9890;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${t}</div><div style="font-size:28px;font-weight:600;color:#1a1a18;">${v.toLocaleString()}</div>${s?`<div style="font-size:12px;color:#9a9890;margin-top:3px;">${s}</div>`:""}</div>`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Analytics</title><meta name="robots" content="noindex,nofollow"><style>body{font-family:-apple-system,sans-serif;background:#f7f6f3;color:#1a1a18;padding:32px;max-width:1100px;margin:0 auto;}h1{font-size:22px;font-weight:600;margin-bottom:4px;}h2{font-size:13px;font-weight:600;color:#5a5a56;margin:28px 0 12px;text-transform:uppercase;letter-spacing:0.06em;}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:0;}.panel{background:#fff;border:0.5px solid rgba(0,0,0,0.12);border-radius:10px;padding:20px;}.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);font-size:13px;}.row:last-child{border:none;}.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500;background:#E1F5EE;color:#0a5a40;}</style></head><body>
<h1>📊 Curiosity Wikipedia — Analytics</h1><p style="font-size:13px;color:#9a9890;margin-bottom:24px;">Private · ${new Date().toUTCString()}</p>
<h2>Overview</h2><div class="g4">${card("Total views",totalViews)}${card("Views today",viewsToday,`${uvToday} unique`)}${card("Views this week",viewsWeek,`${uvWeek} unique`)}${card("Topics explored",db.prepare("SELECT COUNT(*) as n FROM topics").get().n)}</div>
<div class="g2"><div><h2>Top topics</h2><div class="panel">${topTopics.map(t=>`<div class="row"><span>${t.topic||"—"}</span><div style="display:flex;align-items:center;gap:8px;min-width:160px;">${bar(t.views,maxV)}<span class="tag">${t.uv}uv</span></div></div>`).join("")||"<div style='color:#9a9890;'>No data</div>"}</div></div>
<div><h2>Levels &amp; Categories</h2><div class="panel">${levelDist.map(l=>`<div class="row"><span>${l.level}</span>${bar(l.n,maxL)}</div>`).join("")}<div style="margin-top:16px;">${catDist.map(c=>`<div class="row"><span style="font-size:12px;">${c.category||"general"}</span>${bar(c.n,maxC,"#534AB7")}</div>`).join("")}</div></div></div></div>
<h2>Recent activity</h2><div class="panel"><table style="width:100%;border-collapse:collapse;font-size:12px;"><tr style="color:#9a9890;text-align:left;border-bottom:0.5px solid rgba(0,0,0,0.1);"><th style="padding:6px 8px;">Time</th><th style="padding:6px 8px;">Topic</th><th style="padding:6px 8px;">Level</th><th style="padding:6px 8px;">Category</th><th style="padding:6px 8px;">Action</th></tr>${recent.map(r=>`<tr style="border-bottom:0.5px solid rgba(0,0,0,0.05);"><td style="padding:6px 8px;color:#9a9890;">${new Date(r.created_at).toLocaleString()}</td><td style="padding:6px 8px;font-weight:500;">${r.topic||"—"}</td><td style="padding:6px 8px;">${r.level||"—"}</td><td style="padding:6px 8px;color:#5a5a56;">${r.category||"—"}</td><td style="padding:6px 8px;"><span class="tag">${r.action||"view"}</span></td></tr>`).join("")}</table></div>
</body></html>`);
});

// ── Daily cron ────────────────────────────────────────
cron.schedule("0 0 * * *", () => { console.log("🕛 Daily cron fired"); }, { timezone:"UTC" });

app.listen(PORT, () => console.log(`Curiosity Wikipedia running on port ${PORT}`));
