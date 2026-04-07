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
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── DB ────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Performance & durability tuning for Railway persistent volume
db.pragma("journal_mode = WAL");       // concurrent reads while writing
db.pragma("synchronous = NORMAL");     // safe on Railway (fsync on checkpoint)
db.pragma("cache_size = -64000");      // 64 MB in-memory page cache
db.pragma("temp_store = MEMORY");      // temp tables in RAM
db.pragma("mmap_size = 268435456");    // 256 MB memory-mapped I/O
db.pragma("wal_autocheckpoint = 1000");// checkpoint every 1000 pages

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
    source TEXT DEFAULT 'user',
    created_at INTEGER, UNIQUE(topic_lower, branch, level)
  );
  CREATE TABLE IF NOT EXISTS image_cache (
    query TEXT PRIMARY KEY,
    images_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS simplify_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL UNIQUE,
    reply TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT, level TEXT, category TEXT, action TEXT DEFAULT 'view',
    ip_hash TEXT, user_agent TEXT, referrer TEXT, created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_pv_topic ON page_views(topic);
  CREATE INDEX IF NOT EXISTS idx_exp_lookup ON explanations(topic_lower, branch, level);
  CREATE INDEX IF NOT EXISTS idx_img_cache ON image_cache(query);
  CREATE INDEX IF NOT EXISTS idx_simplify_key ON simplify_cache(cache_key);
`);

const ecols = db.prepare("PRAGMA table_info(explanations)").all().map(c=>c.name);
if(!ecols.includes("visuals")) try{db.exec("ALTER TABLE explanations ADD COLUMN visuals TEXT");}catch(e){}
if(!ecols.includes("source")) try{db.exec("ALTER TABLE explanations ADD COLUMN source TEXT DEFAULT 'user'");}catch(e){}
if(!CLAUDE_API_KEY) console.error("⚠️  CLAUDE_API_KEY not set!");

// ── Constants ─────────────────────────────────────────
const LEVELS = ["grade5","college","masters","phd"];
const LEVEL_LABELS = {grade5:"5th Grade",college:"College",masters:"Master's",phd:"PhD"};

const LEVEL_INSTRUCTIONS = {
  grade5:`You are a warm, brilliant teacher giving someone their very first encounter with this topic. Use simple words and vivid everyday analogies. Keep sentences short and friendly. No unexplained jargon. Begin with 1-2 sentences of essential context so the explanation stands alone.

When you mention a concept that naturally leads somewhere more advanced, mark it: [DEEPER: concept name]. Use sparingly — 2-3 per explanation maximum.

At the end of each section (just before the next [HEADING:] tag), add a single signpost sentence that bridges naturally to the next section — like a good lecturer saying "you're probably wondering X, and that's exactly what we'll look at next." Mark it: [SIGNPOST: your bridging sentence here]. Keep it one sentence, conversational, and anticipate the reader's most obvious next question.`,

  college:`You are explaining this topic at undergraduate level. Begin with 1-2 sentences of essential context so the explanation stands alone even without prior reading. Introduce proper terminology, mechanisms, and real-world applications with clear precision.

Mark foundational concepts the reader might not know: [PREREQ: concept name]. Mark advanced concepts worth exploring: [DEEPER: concept name]. Use each 2-3 times maximum.

At the end of each section (just before the next [HEADING:] tag), add a signpost sentence bridging to the next section — anticipate the reader's natural next question. Mark it: [SIGNPOST: your bridging sentence here]. One sentence, conversational.`,

  masters:`You are writing at graduate level. Begin with 2-3 sentences orienting the reader — the key insight or framework that grounds everything — before going deep. Use full technical rigour: advanced mechanisms, theoretical frameworks, mathematical formulations (LaTeX: $...$ inline, $$...$$ block), research context.

Mark prerequisites: [PREREQ: concept name]. Mark frontier extensions: [DEEPER: concept name]. Use each 2-4 times.

At the end of each section (just before the next [HEADING:] tag), add a signpost sentence that anticipates the reader's next intellectual question and bridges to the next section. Mark it: [SIGNPOST: your bridging sentence here].`,

  phd:`You are writing a doctoral-level treatment. Open with 2-3 sentences anchoring the topic's position in the field and its central open question. Focus on research frontiers, open problems, competing frameworks, mathematical rigour (LaTeX: $...$ inline, $$...$$ block), seminal and recent literature, methodological debates.

Mark key prerequisites: [PREREQ: concept name]. Do NOT use [DEEPER] — this is the frontier. Use [PREREQ] 3-5 times.

At the end of each section (just before the next [HEADING:] tag), add a precise signpost sentence bridging to the next section — frame it as the natural theoretical or empirical question that follows. Mark it: [SIGNPOST: your bridging sentence here].`
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
        body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:2400, system:SYSTEM_PROMPT, messages:[{role:"user",content:buildPrompt(topicClean,lvl,branchKey,prevContent)}] })
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
      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower,branch,level,content,branches,citations,visuals,source,created_at) VALUES (?,?,?,?,?,?,?,'user',?)`)
        .run(topicLower,branchKey,lvl,content,JSON.stringify(branches),JSON.stringify(bibliography),JSON.stringify(visuals),Date.now());
      result = { content, branches, bibliography, ...visuals };
    } catch(err) {
      console.error("Claude error:", err.message);
      return res.status(500).json({ error: `Failed to fetch explanation: ${err.message}` });
    }
  }

  if (lvl === "grade5") {
    const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
    if (existing) db.prepare("UPDATE topics SET visits=visits+1,last_visited=?,category=? WHERE topic_lower=?").run(Date.now(),category||"general",topicLower);
    else db.prepare("INSERT INTO topics (topic,topic_lower,category,visits,last_visited,created_at) VALUES (?,?,?,1,?,?)").run(topicClean,topicLower,category||"general",Date.now(),Date.now());
  }
  res.json({ levels:{ [lvl]:result } });
});

// ── Simplify endpoint ─────────────────────────────────
app.post("/api/simplify", async (req, res) => {
  const { topic, branch, level, sectionHeading, sectionContent, gapType, userQuestion, history } = req.body;
  if (!topic || !sectionHeading) return res.status(400).json({ error: "Missing required fields" });

  const levelLabel = LEVEL_LABELS[level] || level;
  const gapDesc = {
    concept: "a core concept in this section that isn't clicking",
    example: "a concrete real-world example to make this tangible",
    formula: "how a formula or mathematical step actually works",
    connection: "how this connects to something I already know",
    custom: userQuestion || "something specific I'm unclear about"
  }[gapType] || "something unclear in this section";

  const contextHistory = (history || []).map(m => ({ role: m.role, content: m.content }));

  // Cache only cacheable first-turn requests (no prior history, no custom questions)
  const isCacheable = contextHistory.length === 0 && gapType !== "custom" && !userQuestion;
  const cacheKey = isCacheable
    ? `${(topic||"").toLowerCase()}||${(branch||"").toLowerCase()}||${level}||${sectionHeading}||${gapType}`
    : null;

  if (cacheKey) {
    const cached = getSimplifyCache(cacheKey);
    if (cached) return res.json({ reply: cached, cached: true });
  }

  const systemPrompt = `You are a brilliant, concise academic tutor. The student is reading a ${levelLabel}-level explanation of "${branch || topic}" and has stopped at the section: "${sectionHeading}". They need clarification on ${gapDesc}. Keep your reply SHORT — 3-5 sentences max. Be concrete, use analogies if helpful. No new jargon unless you immediately explain it. Write in flowing prose, no bullet points. End with one natural follow-up question.`;

  const messages = contextHistory.length > 0
    ? [...contextHistory, { role: "user", content: userQuestion || `Clarify ${gapDesc} from the section "${sectionHeading}".` }]
    : [{ role: "user", content: `I am reading about "${branch || topic}" at ${levelLabel} level. In the section "${sectionHeading}", I do not understand ${gapDesc}. Relevant content:\n\n${(sectionContent || "").slice(0, 800)}\n\nPlease clarify briefly.` }];

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, system: systemPrompt, messages })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map(b => b.text || "").join("") || "";
    if (cacheKey && text) setSimplifyCache(cacheKey, text);
    res.json({ reply: text });
  } catch (err) {
    console.error("Simplify error:", err.message);
    res.status(500).json({ error: `Simplify failed: ${err.message}` });
  }
});


app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    model: "claude-sonnet-4-6",
    version: "2.1.0",
    db_path: DB_PATH,
    api_key_set: !!CLAUDE_API_KEY,
    uptime: process.uptime()
  });
});

// ── Image cache endpoint ──────────────────────────────
const IMAGE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const WIKI_API = "https://en.wikipedia.org/w/api.php";

app.get("/api/images", async (req, res) => {
  const query = (req.query.q || "").trim().slice(0, 200);
  if (!query) return res.json({ images: [] });

  // 1. Check DB cache (valid for 30 days)
  try {
    const cached = db.prepare("SELECT images_json, fetched_at FROM image_cache WHERE query=?").get(query);
    if (cached && (Date.now() - cached.fetched_at) < IMAGE_CACHE_TTL) {
      return res.json({ images: JSON.parse(cached.images_json), cached: true });
    }
  } catch(e) {}

  // 2. Fetch from Wikipedia
  try {
    const sr = await fetch(`${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=2&format=json&origin=*`);
    const sd = await sr.json();
    const pages = sd.query?.search;
    if (!pages?.length) { db.prepare("INSERT OR REPLACE INTO image_cache (query,images_json,fetched_at) VALUES (?,?,?)").run(query,"[]",Date.now()); return res.json({images:[]}); }

    const topTitle = pages[0].title.toLowerCase();
    const qWords = query.toLowerCase().split(/\s+/).filter(w=>w.length>3);
    if (!qWords.some(w=>topTitle.includes(w))) { db.prepare("INSERT OR REPLACE INTO image_cache (query,images_json,fetched_at) VALUES (?,?,?)").run(query,"[]",Date.now()); return res.json({images:[]}); }

    const ir = await fetch(`${WIKI_API}?action=query&titles=${encodeURIComponent(pages[0].title)}&prop=images&imlimit=12&format=json&origin=*`);
    const id = await ir.json();
    const pd = Object.values(id.query?.pages||{})[0];
    const imgTitles = ((pd?.images)||[]).filter(i=>{
      const n = i.title.toLowerCase();
      return /\.(jpg|jpeg|png)$/i.test(i.title) && !/icon|logo|flag|map|symbol|seal|coat|signature|arrow|button|blank|commons|wiki|portal|portrait|aircraft|airplane|boeing|airbus/i.test(n);
    }).slice(0,6);

    if (!imgTitles.length) { db.prepare("INSERT OR REPLACE INTO image_cache (query,images_json,fetched_at) VALUES (?,?,?)").run(query,"[]",Date.now()); return res.json({images:[]}); }

    const titles = imgTitles.map(i=>i.title).join("|");
    const inr = await fetch(`${WIKI_API}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=400&format=json&origin=*`);
    const ind = await inr.json();
    const imgs = Object.values(ind.query?.pages||{}).map(p=>{
      const info = p.imageinfo?.[0]; if (!info?.url) return null;
      const cap = ((info.extmetadata?.ImageDescription?.value)||"").replace(/<[^>]*>/g,"").slice(0,120);
      return { src: info.url, caption: cap || (p.title||"").replace("File:","").replace(/\.[^.]+$/,"") };
    }).filter(Boolean).slice(0,4);

    // Store in DB cache
    db.prepare("INSERT OR REPLACE INTO image_cache (query,images_json,fetched_at) VALUES (?,?,?)").run(query, JSON.stringify(imgs), Date.now());
    res.json({ images: imgs, cached: false });
  } catch(e) {
    console.error("Image fetch error:", e.message);
    res.json({ images: [] });
  }
});

// ── Simplify cache helper ─────────────────────────────
const SIMPLIFY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSimplifyCache(key) {
  try {
    const row = db.prepare("SELECT reply, created_at FROM simplify_cache WHERE cache_key=?").get(key);
    if (row && (Date.now() - row.created_at) < SIMPLIFY_CACHE_TTL) return row.reply;
  } catch(e) {}
  return null;
}

function setSimplifyCache(key, reply) {
  try {
    db.prepare("INSERT OR REPLACE INTO simplify_cache (cache_key,reply,created_at) VALUES (?,?,?)").run(key, reply, Date.now());
  } catch(e) {}
}

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

// ── Cache stats ───────────────────────────────────────
app.get("/api/cache-stats", (req, res) => {
  try {
    const explanations = db.prepare("SELECT COUNT(*) as n FROM explanations").get().n;
    const seeded = db.prepare("SELECT COUNT(*) as n FROM explanations WHERE source='seeded'").get().n;
    const userGen = db.prepare("SELECT COUNT(*) as n FROM explanations WHERE source='user'").get().n;
    const images = db.prepare("SELECT COUNT(*) as n FROM image_cache").get().n;
    const simplify = db.prepare("SELECT COUNT(*) as n FROM simplify_cache").get().n;
    const imgFresh = db.prepare("SELECT COUNT(*) as n FROM image_cache WHERE fetched_at>?").get(Date.now() - IMAGE_CACHE_TTL).n;
    res.json({ explanations, seeded, user_generated: userGen, image_cache: images, image_cache_fresh: imgFresh, simplify_cache: simplify });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Bulk seed job ─────────────────────────────────────
// Populates all tree topics across all 4 levels
// Stops when budget (USD) is exhausted or all topics done
// Tracks progress in DB so it can resume after restarts

db.exec(`
  CREATE TABLE IF NOT EXISTS seed_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT, topic TEXT, branch TEXT, level TEXT,
    status TEXT DEFAULT 'pending',
    tokens_used INTEGER DEFAULT 0,
    created_at INTEGER, completed_at INTEGER,
    UNIQUE(topic, branch, level)
  );
  CREATE TABLE IF NOT EXISTS seed_meta (
    key TEXT PRIMARY KEY, value TEXT
  );
`);

// Approximate Claude Sonnet cost: $3/M input + $15/M output tokens
// Average ~800 input + ~600 output per call ≈ ~$0.0114 per explanation
const COST_PER_CALL = 0.012; // conservative estimate in USD

function getSeedBudget(){
  const row = db.prepare("SELECT value FROM seed_meta WHERE key='budget_usd'").get();
  return row ? parseFloat(row.value) : 0;
}
function getSeedSpent(){
  const row = db.prepare("SELECT value FROM seed_meta WHERE key='spent_usd'").get();
  return row ? parseFloat(row.value) : 0;
}
function setSeedMeta(key, value){
  db.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES (?,?)").run(key, String(value));
}
function addSeedSpent(amount){
  const current = getSeedSpent();
  setSeedMeta("spent_usd", (current + amount).toFixed(4));
}

// Build the full list of all things to seed
function buildSeedQueue(){
  const TREE_SUBJECTS = {
    "Business & Economics":{"Microeconomics":["Supply & Demand Theory","Price Elasticity","Consumer Theory & Utility","Production & Cost Functions","Market Structures","Game Theory in Markets","General Equilibrium","Welfare Economics","Externalities & Public Goods","Information Asymmetry","Behavioural Microeconomics","Mechanism Design"],"Macroeconomics":["National Income Accounting","IS-LM Model","Aggregate Demand & Supply","Monetary Policy Transmission","Fiscal Policy & Multipliers","Business Cycle Theory","Open Economy Macroeconomics","Exchange Rate Determination","Solow Growth Model","Endogenous Growth Theory","DSGE Models","Macroprudential Policy"],"Financial Accounting":["Double-Entry Bookkeeping","Income Statement","Balance Sheet","Cash Flow Statement","Revenue Recognition (IFRS 15)","Lease Accounting (IFRS 16)","Financial Instruments (IFRS 9)","Consolidation & Group Accounts","Impairment Testing","Earnings Quality","Forensic Accounting","Integrated Reporting"],"Corporate Finance":["Time Value of Money","Capital Budgeting","WACC & Capital Structure","Dividend Policy","Valuation Methods","Mergers & Acquisitions","Agency Theory","Real Options","Corporate Governance","Financial Distress","Behavioural Corporate Finance","ESG & Sustainable Finance"],"Strategic Management":["SWOT & PESTLE Analysis","Porter's Five Forces","Value Chain Analysis","Resource-Based View","Dynamic Capabilities","Blue Ocean Strategy","Balanced Scorecard","Corporate Diversification","Strategic Alliances","Digital Strategy","Platform Ecosystems","Strategy as Practice"],"Supply Chain Management":["Inventory Management","Demand Forecasting","Procurement Strategy","Supplier Relationship Management","Logistics Network Design","Lean & JIT","Supply Chain Risk","Bullwhip Effect","Green Supply Chains","Blockchain in SCM","Digital Twin in Logistics","Port-Centric Logistics"],"Marketing Management":["Market Segmentation","Consumer Behaviour","Brand Management","Pricing Strategy","Digital Marketing","Marketing Analytics","Services Marketing","B2B Marketing","International Marketing","Neuromarketing","Platform Marketing","Marketing Ethics"],"Organisational Behaviour":["Motivation Theories","Leadership Styles","Group Dynamics","Organisational Culture","Change Management","Power & Politics","Conflict Resolution","Emotional Intelligence","Diversity & Inclusion","Psychological Safety","Organisational Learning","Complexity in Organisations"],"Business Ethics":["Stakeholder Theory","Corporate Social Responsibility","Ethical Decision-Making","Whistleblowing","Corporate Governance Ethics","ESG Reporting","Business & Human Rights","Ethical AI in Business","Corruption & Bribery","Sustainability Accounting","UN SDGs in Business","Ethics of Globalisation"],"Behavioural Economics":["Prospect Theory","Heuristics & Biases","Mental Accounting","Nudge Theory","Intertemporal Choice","Social Preferences","Loss Aversion","Bounded Rationality","Experimental Economics","Neuroeconomics","Behavioural Finance","Policy Applications"]},
    "Arts, Law & Education":{"Constitutional Law":["Separation of Powers","Judicial Review","Constitutional Interpretation","Federalism","Bill of Rights","Parliamentary Sovereignty","Executive Power","Constitutional Conventions","Human Rights Frameworks","Comparative Constitutionalism"],"Contract Law":["Offer & Acceptance","Consideration","Intention to Create Legal Relations","Contractual Terms","Misrepresentation","Mistake","Frustration","Remedies for Breach","Privity of Contract","Electronic Contracts","International Contract Law (CISG)"],"Criminal Law":["Elements of a Crime","Mens Rea & Actus Reus","Homicide","Assault & Battery","Defences","Sentencing Theory","Restorative Justice","White-Collar Crime","Cybercrime","International Criminal Law","Criminology Theories"],"International Law":["Sources of International Law","State Sovereignty","Treaty Law (VCLT)","International Courts","Use of Force (UN Charter)","International Humanitarian Law","Human Rights Law","Law of the Sea (UNCLOS)","International Trade Law","Environmental International Law","State Responsibility"],"Educational Psychology":["Cognitive Development (Piaget)","Constructivism","Social Learning Theory","Memory & Cognition","Motivation in Learning","Learning Disabilities","Assessment & Feedback","Inclusive Education","Digital Pedagogy","Neuroscience of Learning","Self-Regulated Learning"],"Sociology":["Social Stratification","Sociological Theory","Culture & Identity","Deviance & Social Control","Gender & Society","Race & Ethnicity","Social Institutions","Globalisation","Qualitative Research Methods","Intersectionality","Digital Sociology","Critical Theory"],"Philosophy":["Epistemology","Metaphysics","Ethics & Moral Philosophy","Logic & Argumentation","Philosophy of Mind","Political Philosophy","Existentialism","Phenomenology","Philosophy of Science","Analytic vs Continental","Philosophy of Language","Applied Ethics"]},
    "Health & Medicine":{"Human Anatomy":["Musculoskeletal System","Cardiovascular Anatomy","Respiratory Anatomy","Neuroanatomy","Digestive System","Endocrine System","Renal & Urinary System","Reproductive Anatomy","Lymphatic System","Sensory Organs","Embryological Development","Clinical Applied Anatomy"],"Physiology":["Cell Physiology","Cardiovascular Physiology","Respiratory Physiology","Renal Physiology","Neurophysiology","Endocrine Physiology","Gastrointestinal Physiology","Muscle Physiology","Exercise Physiology","Thermoregulation","Homeostasis","Pathophysiology"],"Pharmacology":["Pharmacokinetics","Pharmacodynamics","Drug-Receptor Interactions","Autonomic Pharmacology","Cardiovascular Drugs","CNS Pharmacology","Antimicrobials","Cancer Pharmacology","Drug Metabolism & Toxicity","Clinical Pharmacology","Pharmacogenomics","Drug Development"],"Immunology":["Innate Immunity","Adaptive Immunity","Antibody Structure & Function","T-Cell Biology","B-Cell Biology","MHC & Antigen Presentation","Inflammation","Autoimmunity","Immunodeficiency","Transplant Immunology","Cancer Immunology","Vaccine Immunology"],"Epidemiology":["Disease Surveillance","Study Designs","Measures of Association","Bias & Confounding","Cohort Studies","Case-Control Studies","Randomised Controlled Trials","Systematic Reviews & Meta-Analysis","Infectious Disease Epidemiology","Chronic Disease Epidemiology","Social Determinants of Health","Global Health"],"Public Health":["Health Promotion","Social Determinants","Health Policy","Environmental Health","Occupational Health","Health Systems","Global Health Governance","One Health","Health Economics","Mental Health Policy","Indigenous Health"],"Neuropsychology":["Brain Structure & Function","Cognitive Neuroscience","Memory Systems","Executive Function","Language & the Brain","Attention & Consciousness","Neurological Disorders","Rehabilitation Neuropsychology","Neuroimaging Methods","Developmental Neuropsychology","Ageing & the Brain","Neuropharmacology"]},
    "Sciences & Engineering":{"Calculus & Analysis":["Limits & Continuity","Differentiation","Integration","Fundamental Theorem of Calculus","Multivariable Calculus","Vector Calculus","Differential Equations","Series & Convergence","Complex Analysis","Fourier Analysis","Real Analysis","Functional Analysis"],"Linear Algebra":["Vectors & Matrices","Systems of Linear Equations","Determinants","Eigenvalues & Eigenvectors","Vector Spaces","Linear Transformations","Inner Product Spaces","Singular Value Decomposition","Principal Component Analysis","Tensor Algebra","Numerical Linear Algebra","Applications in ML"],"Statistics & Probability":["Probability Theory","Random Variables","Distributions","Hypothesis Testing","Confidence Intervals","Regression Analysis","Bayesian Inference","Multivariate Statistics","Time Series Analysis","Stochastic Processes","Causal Inference","Statistical Learning Theory"],"Environmental Science":["Ecology & Ecosystems","Climate Systems","Carbon Cycle","Biodiversity","Pollution & Remediation","Environmental Policy","Water Resources","Soil Science","Environmental Impact Assessment","Conservation Biology","Remote Sensing","Climate Change Adaptation"],"Climate Science":["Atmospheric Physics","Ocean-Atmosphere Interaction","Climate Modelling","Radiative Forcing","Ice & Cryosphere","Climate Projections","Extreme Weather Events","Sea Level Rise","Carbon Budgets","Climate Attribution","Mitigation Strategies"]},
    "Maritime & Logistics":{"Ship Stability":["Hydrostatics & Buoyancy","Metacentric Height (GM)","Free Surface Effect","Stability at Large Angles","Damage Stability","Dynamic Stability","Trim & Draught","Intact Stability Criteria","Loading Conditions","Grain Stability","Probabilistic Damage Stability","IMO Stability Regulations"],"Naval Architecture":["Hull Form Design","Resistance & Propulsion","Powering & Speed","Manoeuvrability","Seakeeping","Structural Design","Lightweight & Deadweight","Ship Types & Proportions","Computational Fluid Dynamics","Finite Element Analysis","Hydrodynamic Optimisation","Sustainable Ship Design"],"Port Operations Management":["Port Planning & Layout","Terminal Operations","Cargo Handling Equipment","Container Terminal Systems","Port Productivity Metrics","Gate & Yard Operations","Port Community Systems","Digitalisation in Ports","Port Safety Management","Environmental Port Management","Port Economics","Automated Terminals"],"Maritime Law":["SOLAS Convention","MARPOL Convention","UNCLOS","Bills of Lading","Charterparties","Marine Insurance","Collision Regulations (COLREGs)","Salvage & Towage","Flag State Control","Port State Control","Maritime Labour Convention (MLC)","Liability & Limitation"],"Shipping Logistics":["Container Shipping","Bulk Shipping","Tanker Operations","Freight Markets","Liner Shipping Networks","Slot Allocation","Intermodal Transport","Hinterland Connectivity","Digital Freight Platforms","Supply Chain Resilience","Decarbonisation in Shipping","Arctic Shipping Routes"],"Maritime Safety":["ISM Code","Risk Assessment at Sea","STCW Competencies","Bridge Resource Management","Emergency Procedures","Search & Rescue","Fire Safety at Sea","GMDSS","Maritime Accident Investigation","Human Factors at Sea","Cyber Security at Sea"]},
    "Marine & Antarctic Studies":{"Marine Biology":["Marine Ecosystems","Coral Reef Biology","Deep Sea Biology","Marine Mammals","Fish Biology & Fisheries","Marine Invertebrates","Plankton & Primary Production","Seagrass & Kelp Forests","Marine Microbiology","Marine Biodiversity","Species Interactions","Marine Conservation"],"Physical Oceanography":["Ocean Circulation","Thermohaline Circulation","Ocean Waves","Tides","Sea Ice Dynamics","Ocean-Atmosphere Coupling","El Niño & ENSO","Ocean Heat Content","Upwelling Systems","Salinity & Temperature","Ocean Modelling","Ocean Observation Systems"],"Antarctic Science":["Antarctic Ice Sheet","Southern Ocean","Antarctic Ecology","Ozone Layer & Antarctica","Antarctic Treaty System","Subantarctic Islands","Paleoclimate Records","Antarctic Meteorology","Krill & Food Web","Human Presence in Antarctica","Climate Change Impacts","Antarctic Research Stations"]},
    "Information & Computing":{"Machine Learning":["Supervised Learning","Unsupervised Learning","Feature Engineering","Bias-Variance Tradeoff","Decision Trees & Random Forests","Support Vector Machines","Neural Architecture","Gradient Descent","Regularisation","Model Evaluation","Transfer Learning","Generative Models"],"Deep Learning":["Neural Network Fundamentals","Backpropagation","Convolutional Neural Networks","Recurrent Neural Networks","Transformers & Attention","Generative Adversarial Networks","Variational Autoencoders","Reinforcement Learning","Large Language Models","Diffusion Models","Multimodal Learning","AI Safety & Alignment"],"Data Science":["Data Wrangling","Exploratory Data Analysis","Feature Engineering","Statistical Modelling","Data Visualisation","Big Data Technologies","SQL & NoSQL","Data Pipelines","A/B Testing","Causal ML","MLOps","Ethics in Data Science"],"Algorithms & Data Structures":["Complexity Analysis","Sorting & Searching","Trees & Graphs","Dynamic Programming","Greedy Algorithms","Hash Tables","Heaps & Priority Queues","Graph Algorithms","String Algorithms","Computational Geometry","NP-Completeness","Randomised Algorithms"],"Cybersecurity":["Network Security","Cryptography","Web Application Security","Penetration Testing","Threat Modelling","Incident Response","Identity & Access Management","Cloud Security","Malware Analysis","Social Engineering","Security Governance","Zero Trust Architecture"]},
    "Research & Methods":{"Research Design":["Ontology & Epistemology","Research Paradigms","Qualitative vs Quantitative","Mixed Methods","Case Study Design","Survey Design","Experimental Design","Longitudinal Studies","Action Research","Grounded Theory","Systematic Review Protocol","Research Ethics"],"Quantitative Methods":["Descriptive Statistics","Inferential Statistics","Regression Analysis","ANOVA","Factor Analysis","Structural Equation Modelling","Panel Data Methods","Difference-in-Differences","Instrumental Variables","Bayesian Methods","Simulation Methods","Machine Learning in Research"],"Qualitative Methods":["Interviews & Focus Groups","Ethnography","Discourse Analysis","Content Analysis","Thematic Analysis","Narrative Research","Phenomenology","Grounded Theory Method","Participatory Research","Visual Methods","Digital Qualitative Methods","Systematic Literature Review"],"DEA & Productivity Analysis":["Data Envelopment Analysis (DEA)","Input & Output Orientation","Efficiency Scores","Malmquist TFP Index","Stochastic Frontier Analysis","Luenberger Productivity","Two-Stage DEA","Network DEA","Bootstrap in DEA","DEA in Port Studies","TFP Decomposition","Productivity & Policy"],"Econometrics":["OLS Regression","Heteroskedasticity","Autocorrelation","Endogeneity","Panel Data (Fixed & Random Effects)","IV & 2SLS","Time Series Econometrics","VAR Models","Cointegration","Difference-in-Differences","Regression Discontinuity","Causal Econometrics"]},
    "CPA Australia":{"Ethics & Governance":["Professional Ethics Framework","APES 110 Code of Ethics","Independence & Objectivity","Confidentiality","Corporate Governance Principles","Board Structure & Roles","Audit Committees","Directors Duties","Remuneration Governance","Integrated Governance","ESG Governance","Whistleblower Protections"],"Strategic Management Accounting":["Cost-Volume-Profit Analysis","Activity-Based Costing","Target Costing","Balanced Scorecard","Benchmarking","Transfer Pricing","Performance Measurement","Strategic Pricing","Value Chain Costing","Customer Profitability","Rolling Forecasts","Beyond Budgeting"],"Financial Reporting":["IFRS Conceptual Framework","Revenue Recognition (IFRS 15)","Financial Instruments (IFRS 9)","Leases (IFRS 16)","Impairment (IAS 36)","Business Combinations (IFRS 3)","Consolidated Statements","Foreign Currency (IAS 21)","Provisions (IAS 37)","Share-Based Payments (IFRS 2)","Sustainability Reporting","IFRS vs AASB"],"Australian Taxation":["Income Tax Assessment Act","Assessable Income","Deductions","Capital Gains Tax","Fringe Benefits Tax","GST","Taxation of Trusts","Corporate Tax Rate","Tax Losses","International Tax","Tax Planning & Avoidance","ATO Compliance"],"Advanced Audit & Assurance":["Audit Risk Model","Materiality","Internal Controls","Substantive Procedures","Analytical Procedures","Audit of Financial Statements","Going Concern","Auditor Independence","Audit Reports","IT Audit","Forensic Audit","Audit Quality"]},
    "AMSA & STCW Certification":{"Navigational Watchkeeping":["Keeping a Safe Watch","Lookout & Collision Avoidance","Radar & ARPA Operation","ECDIS Navigation","Chart Work & Position Fixing","Celestial Navigation","Coastal Navigation","Weather Routing","Passage Planning","Bridge Resource Management","Night Operations","Restricted Visibility"],"Ship Stability & Trim":["Hydrostatics","Metacentric Height","Free Surface Correction","Loading & Stability Calculations","Damaged Stability","Grain Stability","Timber Deck Cargo","Dangerous Goods Stability","Trim Adjustment","Stability Booklet Use","Load Line Regulations","Practical Stability Management"],"Marine Engineering Watchkeeping":["Engine Room Watchkeeping","Main Engine Operation","Auxiliary Systems","Fuel Management","Bilge & Ballast Systems","Electrical Systems at Sea","Control & Automation","Engineering Emergencies","Planned Maintenance System","Environmental Compliance","Watch Handover Procedures","Remote Monitoring"],"ISM Code":["Safety Management System","Company Responsibilities","Master's Authority","Risk Assessment","Emergency Preparedness","Non-Conformities & Accidents","Internal Audits","Document Control","ISM Certification (DOC & SMC)","Port State Control & ISM","ISM & Human Factors","ISM Implementation"],"MARPOL":["Annex I — Oil Pollution","Annex II — Noxious Liquids","Annex III — Harmful Substances","Annex IV — Sewage","Annex V — Garbage","Annex VI — Air Pollution","EEDI & SEEMP","Ballast Water Convention","Special Areas","Port Reception Facilities","Surveys & Certificates","Environmental Compliance"],"COLREGs":["Rule 2 — Responsibility","Rule 5 — Lookout","Rule 6 — Safe Speed","Rule 7 & 8 — Risk & Action","Lights & Shapes","Sound & Light Signals","Narrow Channels","Traffic Separation Schemes","Vessel Interactions","Crossing & Overtaking","Give-Way & Stand-On","COLREG Case Studies"]},
    "Project Management (PMP)":{"Scope Management":["Scope Planning","Requirements Collection","Work Breakdown Structure","Scope Baseline","Scope Validation","Scope Control","Gold Plating","Scope Creep","Product vs Project Scope","User Stories in Agile","MoSCoW Prioritisation","Requirements Traceability"],"Risk Management":["Risk Identification","Qualitative Risk Analysis","Quantitative Risk Analysis","Risk Response Planning","Monte Carlo Simulation","Risk Register","Residual & Secondary Risks","Risk Appetite & Tolerance","Opportunity Management","Risk in Agile Projects","Enterprise Risk Management","Risk Reporting"],"Agile & Scrum":["Agile Manifesto","Scrum Framework","Sprint Planning","Daily Standup","Sprint Review & Retrospective","Product Backlog","Velocity & Burndown","Kanban","SAFe & LeSS","Agile Estimation","Hybrid Approaches","Agile Transformation"],"Schedule Management":["Activity Definition","Network Diagrams","Critical Path Method","PERT Analysis","Resource Levelling","Schedule Compression","Earned Value Management","Float & Slack","Agile Scheduling","Schedule Risk","Baseline Control","Schedule Reporting"],"Stakeholder Engagement":["Stakeholder Identification","Power-Interest Grid","Engagement Planning","Communication Strategies","Conflict Resolution","Change Resistance","Stakeholder Analysis Tools","Executive Stakeholders","Political Dynamics","Cultural Dimensions","Virtual Teams","Stakeholder Reporting"]},
    "GMAT & Graduate Admissions":{"Quantitative Reasoning":["Number Properties","Arithmetic Operations","Algebra","Inequalities","Geometry","Coordinate Geometry","Statistics & Probability","Word Problems","Ratio & Proportion","Permutations & Combinations","Data Sufficiency Technique","Problem-Solving Strategy"],"Verbal Reasoning":["Critical Reasoning","Reading Comprehension","Argument Analysis","Inference Questions","Strengthen & Weaken","Assumption Questions","Boldface Questions","Main Point Questions","RC Passage Types","Active Reading Techniques","Timing Strategy","Vocabulary in Context"],"Data Insights":["Table Analysis","Graphics Interpretation","Two-Part Analysis","Multi-Source Reasoning","Data Sufficiency","Integrated Reasoning Strategy","Interpreting Charts","Data Patterns","Statistical Literacy","Business Data Contexts","Timing in DI","Practice Test Strategy"],"MBA Application Strategy":["School Selection","GMAT Score Goals","Application Timeline","Essays & Personal Statement","Letters of Recommendation","Resume for MBA","Interview Preparation","Scholarship Applications","Campus Visits","Waitlist Strategy","Reapplication","Post-MBA Career Goals"]},
    "IELTS & Academic English":{"Academic Writing Task 1":["Describing Graphs & Charts","Line Graph Analysis","Bar Chart Description","Pie Chart Analysis","Table Description","Process Diagrams","Map Comparisons","Selecting Key Features","Grouping Data","Language for Trends","Cohesion in Reports","Band 7+ Features"],"Academic Writing Task 2":["Essay Structure","Argument Essays","Discussion Essays","Problem-Solution Essays","Two-Part Questions","Thesis Statements","Body Paragraph Development","Counterargument & Refutation","Cohesion & Coherence","Lexical Resource","Grammatical Range","Band 7+ Features"],"Academic Reading Skills":["Skimming & Scanning","True/False/Not Given","Matching Headings","Sentence Completion","Summary Completion","Multiple Choice","Matching Features","Reading for Detail","Inference in Texts","Academic Vocabulary","Time Management","Passage Types"],"Research Paper Writing":["Academic Argument Structure","Literature Review Writing","Methodology Section","Results & Discussion","Abstract Writing","APA & Harvard Referencing","Paraphrasing & Synthesis","Academic Hedging Language","Avoiding Plagiarism","Peer Review Process","Revision Strategies","Publishing Process"]}
  };
  const queue = [];
  for(const [subject, topics] of Object.entries(TREE_SUBJECTS)){
    for(const [topicName, subtopics] of Object.entries(topics)){
      // Add the topic itself at all 4 levels
      for(const level of LEVELS){
        queue.push({subject, topic:topicName, branch:null, level});
      }
      // Add each subtopic at all 4 levels
      for(const sub of subtopics){
        for(const level of LEVELS){
          queue.push({subject, topic:topicName, branch:sub, level});
        }
      }
    }
  }
  return queue;
}

async function runSeedJob(){
  const budget = getSeedBudget();
  if(budget <= 0){ console.log("💤 Seed job: no budget set. Use /api/admin/seed-start to begin."); return; }

  const spent = getSeedSpent();
  if(spent >= budget){ console.log(`✅ Seed job: budget exhausted (${spent.toFixed(2)} / ${budget})`); return; }

  const remaining = budget - spent;
  console.log(`🌱 Seed job running... budget ${budget}, spent ${spent.toFixed(2)}, remaining ${remaining.toFixed(2)}`);

  const queue = buildSeedQueue();
  let jobSpent = 0;
  let done = 0, skipped = 0, errors = 0;

  for(const item of queue){
    // Check budget
    if(getSeedSpent() >= budget){
      console.log(`💰 Budget reached. Stopping seed job.`); break;
    }
    // Check if already cached
    const existing = db.prepare("SELECT id FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
      .get(item.topic.toLowerCase(), item.branch, item.level);
    if(existing){ skipped++; continue; }

    // Fetch explanation
    try{
      const prevLevel = LEVELS[LEVELS.indexOf(item.level)-1];
      let prevContent = null;
      if(prevLevel){
        const prev = db.prepare("SELECT content FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
          .get(item.topic.toLowerCase(), item.branch, prevLevel);
        if(prev) prevContent = prev.content.slice(0,1400);
      }

      const response = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":CLAUDE_API_KEY,"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:2400,system:SYSTEM_PROMPT,messages:[{role:"user",content:buildPrompt(item.topic,item.level,item.branch,prevContent)}]})
      });
      const data = await response.json();
      if(data.error) throw new Error(data.error.message);

      const raw = data.content?.map(b=>b.text||"").join("")||"";
      const metaMatch = raw.match(/<META>([\s\S]*?)<\/META>/);
      let branches=[],bibliography=[],flowchart=null,conceptMap=null;
      let content = raw;
      if(metaMatch){
        try{const json=JSON.parse(metaMatch[1].trim());branches=json.branches||[];bibliography=json.bibliography||[];if(json.flowchart?.include&&json.flowchart.nodes?.length)flowchart=json.flowchart;if(json.conceptMap?.include&&json.conceptMap.nodes?.length)conceptMap=json.conceptMap;}catch(e){}
        content=raw.replace(/<META>[\s\S]*?<\/META>/,"").trim();
      }
      const visuals={};
      if(flowchart){visuals.flowchart=flowchart.nodes;visuals.flowchartTitle=flowchart.title;}
      if(conceptMap){visuals.conceptMap=conceptMap.nodes;visuals.conceptMapTitle=conceptMap.title;}

      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower,branch,level,content,branches,citations,visuals,source,created_at) VALUES (?,?,?,?,?,?,?,'seeded',?)`)
        .run(item.topic.toLowerCase(),item.branch,item.level,content,JSON.stringify(branches),JSON.stringify(bibliography),JSON.stringify(visuals),Date.now());

      // Track topic in topics table
      if(item.level==="grade5"){
        const ex=db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(item.topic.toLowerCase());
        if(!ex) db.prepare("INSERT OR IGNORE INTO topics (topic,topic_lower,category,visits,last_visited,created_at) VALUES (?,?,?,0,?,?)").run(item.topic,item.topic.toLowerCase(),item.subject,Date.now(),Date.now());
      }

      // Track cost
      const inputTokens = data.usage?.input_tokens || 800;
      const outputTokens = data.usage?.output_tokens || 600;
      const callCost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      addSeedSpent(callCost);
      jobSpent += callCost;
      done++;

      const totalSpent = getSeedSpent();
      console.log(`  ✓ [${item.level}] ${item.topic}${item.branch?" › "+item.branch:""} (${callCost.toFixed(4)}) | total: ${totalSpent.toFixed(3)} / ${budget}`);

      // Rate limit buffer — 1 second between calls
      await new Promise(r=>setTimeout(r,1000));

    }catch(err){
      errors++;
      console.error(`  ✗ [${item.level}] ${item.topic}${item.branch?" › "+item.branch:""}: ${err.message}`);
      await new Promise(r=>setTimeout(r,2000));
    }
  }

  const finalSpent = getSeedSpent();
  console.log(`\n🏁 Seed job complete. Done: ${done}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`💰 Session cost: ${jobSpent.toFixed(3)} | Total spent: ${finalSpent.toFixed(3)} / ${budget}`);
  setSeedMeta("last_run", new Date().toISOString());
  setSeedMeta("status", finalSpent >= budget ? "budget_exhausted" : "completed");
}

// ── Seed API endpoints ────────────────────────────────
app.post("/api/admin/seed-start", (req, res) => {
  const { budget_usd, secret } = req.body;
  if(secret !== ANALYTICS_SECRET) return res.status(403).json({error:"Forbidden"});
  if(!budget_usd || isNaN(budget_usd)) return res.status(400).json({error:"budget_usd required"});
  setSeedMeta("budget_usd", parseFloat(budget_usd).toFixed(2));
  setSeedMeta("spent_usd", "0");
  setSeedMeta("status", "running");
  res.json({message:`Seed job started with ${budget_usd} budget`, note:"Running in background — check /api/admin/seed-status for progress"});
  // Run in background, non-blocking
  runSeedJob().catch(console.error);
});

app.get("/api/admin/seed-status", (req, res) => {
  const secret = req.query.secret;
  if(secret !== ANALYTICS_SECRET) return res.status(403).json({error:"Forbidden"});
  const budget = getSeedBudget();
  const spent = getSeedSpent();
  const status = db.prepare("SELECT value FROM seed_meta WHERE key='status'").get()?.value || "not_started";
  const lastRun = db.prepare("SELECT value FROM seed_meta WHERE key='last_run'").get()?.value || null;
  const totalSeeded = db.prepare("SELECT COUNT(*) as n FROM explanations").get().n;
  const queue = buildSeedQueue();
  const pending = queue.filter(item=>{
    const ex = db.prepare("SELECT id FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?").get(item.topic.toLowerCase(),item.branch,item.level);
    return !ex;
  }).length;
  res.json({ budget_usd:budget, spent_usd:parseFloat(spent), remaining_usd:Math.max(0,budget-parseFloat(spent)), status, last_run:lastRun, total_seeded:totalSeeded, pending_items:pending, total_items:queue.length, pct_complete:Math.round((queue.length-pending)/queue.length*100) });
});

// ── Admin: clear cache for a specific topic ───────────
app.post("/api/admin/clear-topic", (req, res) => {
  const { topic, branch } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });
  const topicLower = topic.toLowerCase();
  const branchKey = branch ? branch.trim() : null;
  let result;
  if (branchKey) {
    result = db.prepare("DELETE FROM explanations WHERE topic_lower=? AND branch=?").run(topicLower, branchKey);
  } else {
    result = db.prepare("DELETE FROM explanations WHERE topic_lower=?").run(topicLower);
    db.prepare("DELETE FROM topics WHERE topic_lower=?").run(topicLower);
  }
  console.log(`🗑️  Cleared cache for: ${topic}${branchKey ? " / "+branchKey : ""} (${result.changes} rows)`);
  res.json({ ok: true, deleted: result.changes });
});

// ── Daily cron ────────────────────────────────────────
cron.schedule("0 0 * * *", () => { console.log("🕛 Daily cron fired"); }, { timezone:"UTC" });

app.listen(PORT, () => console.log(`Curiosity Wikipedia running on port ${PORT}`));
