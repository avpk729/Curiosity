const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const cron = require("node-cron");
const crypto = require("crypto");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const ANALYTICS_SECRET = process.env.ANALYTICS_SECRET || "change-me-in-railway-env";
const DB_PATH = process.env.DB_PATH || "/app/data/curiosity.db";
// Your own IP hash — set ADMIN_IP in Railway env to your home/VPN IP
// Server will hash it and store as ADMIN_IP_HASH automatically on first run
const ADMIN_IP_RAW = process.env.ADMIN_IP || "";

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── DB ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    topic_lower TEXT NOT NULL UNIQUE,
    subject TEXT DEFAULT 'Discovered',
    topic_key TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    source TEXT DEFAULT 'user',
    visits INTEGER DEFAULT 0,
    last_visited INTEGER,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS tree_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    subject_icon TEXT DEFAULT '🔬',
    topic TEXT NOT NULL,
    topic_lower TEXT NOT NULL,
    subtopics TEXT DEFAULT '[]',
    source TEXT DEFAULT 'seed',
    created_at INTEGER,
    UNIQUE(subject, topic_lower)
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
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT,
    level TEXT,
    category TEXT,
    action TEXT DEFAULT 'view',
    ip_hash TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT,
    referrer TEXT,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS search_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    branch TEXT,
    searched_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    requests TEXT DEFAULT '[]',
    updated_at INTEGER,
    UNIQUE(ip_hash, endpoint)
  );
  CREATE TABLE IF NOT EXISTS image_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_lower TEXT NOT NULL UNIQUE,
    images TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS seed_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_pv_topic ON page_views(topic);
  CREATE INDEX IF NOT EXISTS idx_pv_ip ON page_views(ip_hash);
  CREATE INDEX IF NOT EXISTS idx_tn_subject ON tree_nodes(subject);
  CREATE INDEX IF NOT EXISTS idx_ss_session ON search_sessions(session_id);
`);

// Migrations — add new columns to existing tables safely
const migrate = (table, col, def) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch(e) {}
};
migrate("explanations", "visuals", "TEXT");
migrate("page_views", "country", "TEXT");
migrate("page_views", "city", "TEXT");
migrate("page_views", "is_admin", "INTEGER DEFAULT 0");
migrate("topics", "subject", "TEXT DEFAULT 'Discovered'");
migrate("topics", "topic_key", "TEXT DEFAULT ''");
migrate("topics", "source", "TEXT DEFAULT 'user'");

if (!CLAUDE_API_KEY) console.error("⚠️  CLAUDE_API_KEY not set!");

// ── Admin IP hash ──────────────────────────────────────
function hashIP(ip) {
  return crypto.createHash("sha256").update(ip + "curiosity-salt-v1").digest("hex").slice(0, 16);
}
const ADMIN_IP_HASH = ADMIN_IP_RAW ? hashIP(ADMIN_IP_RAW) : "";
if (ADMIN_IP_HASH) console.log(`🔒 Admin IP hash registered: ${ADMIN_IP_HASH}`);

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function isAdmin(req) {
  if (!ADMIN_IP_HASH) return false;
  return hashIP(getClientIP(req)) === ADMIN_IP_HASH;
}

// ── Geo lookup (ipapi.co — free, no key needed) ────────
const geoCache = {};
async function getGeo(ip) {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("::1")) return { country: "Local", city: "" };
  if (geoCache[ip]) return geoCache[ip];
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    const geo = { country: d.country_name || d.country || "", city: d.city || "" };
    geoCache[ip] = geo;
    return geo;
  } catch { return { country: "", city: "" }; }
}

// ── Rate limiter ───────────────────────────────────────
// Sliding window per IP per endpoint. Returns true if allowed.
function checkRateLimit(ipHash, endpoint, maxPerMinute, maxPerHour) {
  const now = Date.now();
  const row = db.prepare("SELECT requests FROM rate_limits WHERE ip_hash=? AND endpoint=?").get(ipHash, endpoint);
  let reqs = row ? JSON.parse(row.requests) : [];
  // Keep only last hour
  reqs = reqs.filter(t => now - t < 3600000);
  const lastMin = reqs.filter(t => now - t < 60000).length;
  const lastHour = reqs.length;
  if (lastMin >= maxPerMinute || lastHour >= maxPerHour) return false;
  reqs.push(now);
  db.prepare("INSERT OR REPLACE INTO rate_limits (ip_hash,endpoint,requests,updated_at) VALUES (?,?,?,?)")
    .run(ipHash, endpoint, JSON.stringify(reqs), now);
  return true;
}

// ── Bot detection ──────────────────────────────────────
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|curl|wget|python-requests|go-http|libwww|scrapy|headless/i;
function isBot(req) {
  const ua = req.headers["user-agent"] || "";
  return BOT_UA.test(ua);
}

// ── Constants ──────────────────────────────────────────
const LEVELS = ["grade5", "college", "masters", "phd"];
const LEVEL_LABELS = { grade5: "5th Grade", college: "College", masters: "Master's", phd: "PhD" };

const LEVEL_INSTRUCTIONS = {
  grade5: `You are a warm, brilliant teacher giving someone their very first encounter with this topic. Use simple words and vivid everyday analogies. Keep sentences short and friendly. No unexplained jargon. Begin with 1-2 sentences of essential context so the explanation stands alone.

When you mention a concept that naturally leads somewhere more advanced, mark it: [DEEPER: concept name]. Use sparingly — 2-3 per explanation maximum.

At the end of each section (just before the next [HEADING:] tag), add a single signpost sentence that bridges naturally to the next section. Mark it: [SIGNPOST: your bridging sentence here]. Keep it one sentence, conversational, and anticipate the reader's most obvious next question.`,

  college: `You are explaining this topic at undergraduate level. Begin with 1-2 sentences of essential context so the explanation stands alone. Introduce proper terminology, mechanisms, and real-world applications with clear precision.

Mark foundational concepts the reader might not know: [PREREQ: concept name]. Mark advanced concepts worth exploring: [DEEPER: concept name]. Use each 2-3 times maximum.

At the end of each section add a signpost sentence bridging to the next. Mark it: [SIGNPOST: your bridging sentence here]. One sentence, conversational.`,

  masters: `You are writing at graduate level. Begin with 2-3 sentences orienting the reader before going deep. Use full technical rigour: advanced mechanisms, theoretical frameworks, mathematical formulations (LaTeX: $...$ inline, $$...$$ block), research context.

Mark prerequisites: [PREREQ: concept name]. Mark frontier extensions: [DEEPER: concept name]. Use each 2-4 times.

At the end of each section add a signpost sentence bridging to the next. Mark it: [SIGNPOST: your bridging sentence here].`,

  phd: `You are writing a doctoral-level treatment. Open with 2-3 sentences anchoring the topic in the field. Focus on research frontiers, open problems, competing frameworks, mathematical rigour (LaTeX), seminal and recent literature.

Mark key prerequisites: [PREREQ: concept name]. Do NOT use [DEEPER]. Use [PREREQ] 3-5 times.

At the end of each section add a precise signpost sentence. Mark it: [SIGNPOST: your bridging sentence here].`
};

const SYSTEM_PROMPT = `You are Curiosity Wikipedia — an elegant, progressive academic knowledge engine. You only explain legitimate academic topics. Refuse NSFW or non-academic requests politely.

Write in narrative flowing prose grouped under clear thematic section headings. NEVER use markdown symbols like **, ##, *, or bullet points. Everything is beautiful flowing prose.

Structure every explanation as 3-5 thematic sections, each starting with [HEADING: Section Title Here].

Always cite real, verifiable academic sources inline as [1], [2] etc. and include a bibliography.`;

// ── Tree classification prompt ─────────────────────────
const CLASSIFY_PROMPT = `You are a curriculum classifier for an academic knowledge base covering STEM and Economics.

Given a topic name, determine:
1. Which subject it belongs to (must be one of: Mathematics, Physics, Chemistry, Biology, Computer Science, Engineering, Earth & Environmental Science, Economics, Maritime & Seafaring — AMC)
2. The best parent topic/course within that subject (e.g. "Quantum Mechanics" not just "Physics")
3. A display icon for the subject if it's new

Respond ONLY with JSON, no other text:
{"subject":"<subject name>","topic_key":"<parent topic>","icon":"<emoji>","is_stem_or_econ":true|false}

If the topic is NOT academic STEM or Economics (e.g. celebrity gossip, recipes, politics), set is_stem_or_econ to false.`;

function buildPrompt(topic, level, branch, prevContent) {
  const instruction = LEVEL_INSTRUCTIONS[level];
  const branchCtx = branch ? ` Focus specifically on the subtopic: "${branch}" within "${topic}".` : "";
  const prevCtx = prevContent
    ? `\n\nThe reader may or may not have read previous levels. Provide essential context in your opening sentences, then build on this foundation:\n---\n${prevContent.slice(0, 1200)}\n---\n`
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

// ── Parse Claude response ──────────────────────────────
function parseClaudeResponse(raw) {
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
    } catch (e) {}
    content = raw.replace(/<META>[\s\S]*?<\/META>/, "").trim();
  }
  const visuals = {};
  if (flowchart) { visuals.flowchart = flowchart.nodes; visuals.flowchartTitle = flowchart.title; }
  if (conceptMap) { visuals.conceptMap = conceptMap.nodes; visuals.conceptMapTitle = conceptMap.title; }
  return { content, branches, bibliography, visuals };
}

// ── Classify a user-searched topic with Claude ─────────
async function classifyTopic(topic) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system: CLASSIFY_PROMPT,
        messages: [{ role: "user", content: `Classify this topic: "${topic}"` }]
      })
    });
    const d = await r.json();
    const text = d.content?.map(b => b.text || "").join("") || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    return { subject: "Discovered", topic_key: "", icon: "🔬", is_stem_or_econ: true };
  }
}

// ── Add topic to dynamic tree ──────────────────────────
async function addToTree(topicClean, category) {
  const topicLower = topicClean.toLowerCase();
  // Check if already in tree
  const existing = db.prepare("SELECT id FROM tree_nodes WHERE topic_lower=?").get(topicLower);
  if (existing) return;

  const cls = await classifyTopic(topicClean);
  if (!cls.is_stem_or_econ) return; // Don't add non-STEM topics

  const subject = cls.subject || "Discovered";
  const topicKey = cls.topic_key || topicClean;
  const icon = cls.icon || "🔬";

  // Check if this subject+topic_key combo exists as a tree node
  const parentNode = db.prepare("SELECT id, subtopics FROM tree_nodes WHERE subject=? AND topic_lower=?")
    .get(subject, topicKey.toLowerCase());

  if (parentNode) {
    // Add as subtopic of existing node
    const subs = JSON.parse(parentNode.subtopics || "[]");
    if (!subs.includes(topicClean)) {
      subs.push(topicClean);
      db.prepare("UPDATE tree_nodes SET subtopics=? WHERE id=?").run(JSON.stringify(subs), parentNode.id);
    }
  } else {
    // Create new tree node for this topic
    db.prepare(`INSERT OR IGNORE INTO tree_nodes (subject, subject_icon, topic, topic_lower, subtopics, source, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(subject, icon, topicClean, topicLower, JSON.stringify([]), "user", Date.now());
  }

  // Update topics table with classification
  db.prepare("UPDATE topics SET subject=?, topic_key=? WHERE topic_lower=?")
    .run(subject, topicKey, topicLower);

  console.log(`🌿 Added to tree: [${subject}] ${topicClean}`);
}

// ── Explore endpoint ───────────────────────────────────
app.post("/api/explore", async (req, res) => {
  const { topic, branch, category, level, prevContent, sessionId } = req.body;
  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Invalid topic" });

  const ip = getClientIP(req);
  const ipHash = hashIP(ip);
  const admin = isAdmin(req);

  // Bot check
  if (isBot(req)) return res.status(403).json({ error: "Automated requests not permitted." });

  // Rate limit: 10/min, 60/hour per IP for explore
  if (!admin && !checkRateLimit(ipHash, "explore", 10, 60))
    return res.status(429).json({ error: "Too many requests. Please slow down." });

  const topicClean = topic.trim().slice(0, 120);
  const topicLower = topicClean.toLowerCase();
  const branchKey = branch ? branch.trim() : null;
  const lvl = level || "grade5";

  const cached = db.prepare("SELECT content,branches,citations,visuals FROM explanations WHERE topic_lower=? AND branch IS ? AND level=?")
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
      const parsed = parseClaudeResponse(raw);
      db.prepare(`INSERT OR REPLACE INTO explanations (topic_lower,branch,level,content,branches,citations,visuals,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(topicLower, branchKey, lvl, parsed.content, JSON.stringify(parsed.branches), JSON.stringify(parsed.bibliography), JSON.stringify(parsed.visuals), Date.now());
      result = { content: parsed.content, branches: parsed.branches, bibliography: parsed.bibliography, ...parsed.visuals };
    } catch (err) {
      console.error("Claude error:", err.message);
      return res.status(500).json({ error: "Failed to fetch explanation. Please try again." });
    }
  }

  // Track topic & visits
  if (lvl === "grade5") {
    const existing = db.prepare("SELECT id FROM topics WHERE topic_lower=?").get(topicLower);
    if (existing) {
      db.prepare("UPDATE topics SET visits=visits+1,last_visited=?,category=? WHERE topic_lower=?")
        .run(Date.now(), category || "general", topicLower);
    } else {
      db.prepare("INSERT INTO topics (topic,topic_lower,subject,topic_key,category,source,visits,last_visited,created_at) VALUES (?,?,?,?,?,?,1,?,?)")
        .run(topicClean, topicLower, "Discovered", "", category || "general", "user", Date.now(), Date.now());
      // Classify & add to tree in background (non-blocking)
      addToTree(topicClean, category).catch(console.error);
    }
  }

  // Save to session search history
  if (sessionId && lvl === "grade5") {
    db.prepare("INSERT INTO search_sessions (session_id,topic,branch,searched_at) VALUES (?,?,?,?)")
      .run(sessionId, topicClean, branchKey, Date.now());
  }

  // Track page view with geo (async, non-blocking)
  ;(async () => {
    const geo = admin ? { country: "Admin", city: "" } : await getGeo(ip);
    db.prepare(`INSERT INTO page_views (topic,level,category,action,ip_hash,country,city,user_agent,referrer,is_admin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(topicClean, lvl, category || "general", "explore", ipHash,
        geo.country, geo.city,
        (req.headers["user-agent"] || "").slice(0, 200),
        (req.headers.referer || "").slice(0, 200),
        admin ? 1 : 0,
        Date.now());
  })();

  res.json({ levels: { [lvl]: result } });
});

// ── Search history endpoint ────────────────────────────
app.get("/api/history", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.json({ history: [] });
  const rows = db.prepare(`
    SELECT DISTINCT topic, branch, MAX(searched_at) as last
    FROM search_sessions WHERE session_id=?
    GROUP BY topic, branch
    ORDER BY last DESC LIMIT 50
  `).all(sessionId);
  res.json({ history: rows });
});

// ── Dynamic tree endpoint ──────────────────────────────
// Returns the full tree: hardcoded base subjects + user-discovered nodes
app.get("/api/tree", (req, res) => {
  // Dynamic nodes from DB
  const nodes = db.prepare("SELECT subject, subject_icon, topic, topic_lower, subtopics, source FROM tree_nodes ORDER BY created_at ASC").all();
  // Visits per topic
  const visitMap = {};
  db.prepare("SELECT topic_lower, visits FROM topics").all().forEach(t => { visitMap[t.topic_lower] = t.visits; });
  // Build tree grouped by subject
  const tree = {};
  nodes.forEach(n => {
    if (!tree[n.subject]) tree[n.subject] = { icon: n.subject_icon, topics: {} };
    tree[n.subject].topics[n.topic] = {
      subtopics: JSON.parse(n.subtopics || "[]"),
      visits: visitMap[n.topic_lower] || 0,
      source: n.source
    };
  });
  res.json({ tree });
});

// ── Seed tree endpoint (admin) ─────────────────────────
// Called once to populate the base tree from the hardcoded list
app.post("/api/admin/seed-tree", (req, res) => {
  const { secret } = req.body;
  if (secret !== ANALYTICS_SECRET) return res.status(403).json({ error: "Forbidden" });

  const BASE_TREE = {
    "Mathematics": { icon: "∑", topics: {
      "Calculus & Analysis": ["Limits & Continuity","Differentiation","Integration","Fundamental Theorem of Calculus","Multivariable Calculus","Vector Calculus","Differential Equations","Series & Convergence","Complex Analysis","Fourier Analysis","Real Analysis","Functional Analysis"],
      "Linear Algebra": ["Vectors & Matrices","Systems of Linear Equations","Determinants","Eigenvalues & Eigenvectors","Vector Spaces","Linear Transformations","Inner Product Spaces","Singular Value Decomposition","Principal Component Analysis","Tensor Algebra","Numerical Linear Algebra","Applications in ML"],
      "Discrete Mathematics": ["Set Theory","Logic & Proof","Graph Theory","Combinatorics","Number Theory","Recurrence Relations","Algorithms & Complexity","Boolean Algebra","Formal Languages","Coding Theory","Cryptography","Category Theory"],
      "Statistics & Probability": ["Probability Theory","Random Variables","Probability Distributions","Hypothesis Testing","Confidence Intervals","Regression Analysis","Bayesian Inference","Multivariate Statistics","Time Series Analysis","Stochastic Processes","Causal Inference","Statistical Learning Theory"],
      "Optimisation": ["Linear Programming","Simplex Method","Duality Theory","Integer Programming","Convex Optimisation","Gradient Descent","Lagrange Multipliers","Dynamic Programming","Stochastic Optimisation","Network Flows","Metaheuristics","Optimisation in ML"]
    }},
    "Physics": { icon: "⚛️", topics: {
      "Classical Mechanics": ["Newton's Laws","Work, Energy & Power","Momentum & Collisions","Rotational Motion","Oscillations & Waves","Fluid Mechanics","Lagrangian Mechanics","Hamiltonian Mechanics","Celestial Mechanics","Chaos Theory","Continuum Mechanics","Non-inertial Frames"],
      "Electromagnetism": ["Coulomb's Law & Electric Fields","Gauss's Law","Electric Potential","Capacitance","Current & Resistance","Magnetic Fields & Forces","Electromagnetic Induction","Maxwell's Equations","Electromagnetic Waves","Optics","Relativity & EM","Plasma Physics"],
      "Quantum Mechanics": ["Wave-Particle Duality","Schrödinger Equation","Uncertainty Principle","Quantum States & Operators","Particle in a Box","Hydrogen Atom","Spin & Angular Momentum","Entanglement & Superposition","Perturbation Theory","Quantum Field Theory","Quantum Computing","Interpretations of QM"],
      "Thermodynamics & Statistical Mechanics": ["Zeroth & First Laws","Second Law & Entropy","Carnot Cycle","Thermodynamic Potentials","Phase Transitions","Boltzmann Statistics","Partition Functions","Quantum Statistical Mechanics","Critical Phenomena","Non-equilibrium Thermodynamics","Ising Model","Statistical Field Theory"],
      "Relativity": ["Special Relativity","Time Dilation & Length Contraction","Spacetime & Minkowski Diagrams","Mass-Energy Equivalence","General Relativity","Curved Spacetime","Gravitational Waves","Black Holes","Cosmology","Dark Matter & Dark Energy","Quantum Gravity","Observational Tests"]
    }},
    "Chemistry": { icon: "🧪", topics: {
      "General Chemistry": ["Atomic Structure","Periodic Table & Trends","Chemical Bonding","Molecular Geometry (VSEPR)","Stoichiometry","Chemical Reactions","Acids & Bases","Redox Reactions","Solutions & Solubility","Thermochemistry","Chemical Kinetics","Electrochemistry"],
      "Organic Chemistry": ["Functional Groups","Nomenclature","Stereochemistry","Nucleophilic Substitution","Elimination Reactions","Addition Reactions","Carbonyl Chemistry","Aromatic Chemistry","Polymers","Natural Products","Retrosynthesis","Green Chemistry"],
      "Physical Chemistry": ["Quantum Chemistry","Molecular Spectroscopy","Chemical Thermodynamics","Reaction Kinetics","Statistical Thermodynamics","Surface Chemistry","Photochemistry","Computational Chemistry","Reaction Dynamics","Intermolecular Forces","Solid State Chemistry","NMR Theory"],
      "Biochemistry": ["Amino Acids & Proteins","Enzyme Kinetics","Carbohydrate Chemistry","Lipids & Membranes","Nucleic Acids","Metabolic Pathways","Bioenergetics","Signal Transduction","Protein Structure & Folding","Structural Biochemistry","Systems Biochemistry","Drug-Target Interactions"]
    }},
    "Biology": { icon: "🧬", topics: {
      "Cell Biology": ["Cell Structure & Organelles","Cell Membrane & Transport","Cell Signalling","Cell Division (Mitosis & Meiosis)","Cytoskeleton","ER & Golgi Apparatus","Mitochondria & Energy","Lysosomes & Autophagy","Stem Cells","Cell Differentiation","Cancer Biology","Apoptosis"],
      "Genetics & Genomics": ["DNA Structure & Replication","Transcription & Translation","Gene Regulation","Mutations & DNA Repair","Mendelian Genetics","Epigenetics","Genomics & Sequencing","CRISPR & Gene Editing","Population Genetics","Quantitative Genetics","Comparative Genomics","Metagenomics"],
      "Molecular Biology": ["Recombinant DNA Technology","PCR & Sequencing","Cloning","Protein Expression Systems","RNA Biology","Non-coding RNA","Proteomics","Gene Networks","Synthetic Biology","Single-Cell Techniques","Structural Biology","Drug Development"],
      "Ecology & Evolution": ["Natural Selection","Speciation","Phylogenetics","Population Ecology","Community Ecology","Ecosystem Ecology","Conservation Biology","Biogeography","Coevolution","Sexual Selection","Behavioural Ecology","Macroevolution"],
      "Neuroscience": ["Neuron Structure & Function","Synaptic Transmission","Neural Circuits","Sensory Systems","Motor Systems","Learning & Memory","Sleep & Consciousness","Neurological Disorders","Brain Imaging","Developmental Neuroscience","Computational Neuroscience","Neuroethics"]
    }},
    "Computer Science": { icon: "💻", topics: {
      "Algorithms & Data Structures": ["Arrays & Linked Lists","Stacks, Queues & Heaps","Trees & Graphs","Sorting Algorithms","Searching Algorithms","Dynamic Programming","Greedy Algorithms","Graph Algorithms","String Algorithms","Computational Complexity","Approximation Algorithms","Randomised Algorithms"],
      "Artificial Intelligence": ["Search Algorithms","Knowledge Representation","Planning","Machine Learning Overview","Neural Networks","Natural Language Processing","Computer Vision","Reinforcement Learning","AI Safety & Ethics","Probabilistic AI","Robotics","Multi-Agent Systems"],
      "Machine Learning": ["Supervised Learning","Unsupervised Learning","Gradient Descent & Backpropagation","Regularisation","Ensemble Methods","Support Vector Machines","Deep Learning","Convolutional Neural Networks","Recurrent Neural Networks","Transformers & Attention","Generative Models","Evaluation & Validation"],
      "Software Engineering": ["Software Development Life Cycle","Requirements Engineering","Software Architecture","Design Patterns","Testing & Quality Assurance","Agile & DevOps","Database Design","Distributed Systems","Cloud Architecture","Security Engineering","Version Control","Software Ethics"],
      "Computer Networks": ["OSI & TCP/IP Model","Physical & Data Link Layers","IP Addressing & Routing","Transport Layer & TCP","DNS & HTTP","Network Security","Wireless Networks","Software-Defined Networking","Network Measurement","Internet Architecture","CDNs & Edge Computing","Future Networks"]
    }},
    "Engineering": { icon: "⚙️", topics: {
      "Electrical Engineering": ["Circuit Analysis","AC Circuits","Operational Amplifiers","Digital Logic","Semiconductors","Power Electronics","Control Systems","Signals & Systems","Electromagnetic Fields","Communication Systems","VLSI Design","Embedded Systems"],
      "Mechanical Engineering": ["Statics & Dynamics","Strength of Materials","Thermodynamics Applications","Fluid Mechanics","Heat Transfer","Manufacturing Processes","Machine Design","Vibrations","Finite Element Analysis","CAD & Simulation","Robotics & Mechanisms","MEMS"],
      "Civil Engineering": ["Structural Analysis","Concrete Design","Steel Design","Geotechnical Engineering","Hydraulics & Hydrology","Transportation Engineering","Construction Management","Earthquake Engineering","Bridge Design","Sustainable Infrastructure","BIM & Digital Twins","Failure Analysis"],
      "Chemical Engineering": ["Mass & Energy Balances","Fluid Flow & Pumping","Heat Exchangers","Mass Transfer & Distillation","Reaction Engineering","Process Control","Thermodynamics in ChE","Separation Processes","Process Safety","Sustainable Engineering","Bioprocess Engineering","Polymer Engineering"],
      "Environmental Engineering": ["Water Treatment","Wastewater Treatment","Air Quality Engineering","Solid Waste Management","Contaminated Site Remediation","Environmental Monitoring","Life Cycle Assessment","Climate Engineering","Environmental Law & Policy","Stormwater Management","Sustainable Design","Carbon Capture"]
    }},
    "Earth & Environmental Science": { icon: "🌍", topics: {
      "Climate Science": ["Atmospheric Physics","Ocean-Atmosphere Interaction","Climate Modelling","Radiative Forcing","Ice & Cryosphere","Paleoclimatology","Climate Projections","Extreme Weather Events","Sea Level Rise","Carbon Budgets","Climate Attribution","Mitigation Strategies"],
      "Geology": ["Plate Tectonics","Rock Cycle","Minerals & Crystallography","Igneous Rocks","Sedimentary Rocks","Metamorphic Rocks","Geological Time","Stratigraphy","Structural Geology","Volcanology","Seismology","Geomorphology"],
      "Environmental Science": ["Ecology & Ecosystems","Carbon Cycle","Biodiversity","Pollution & Remediation","Environmental Policy","Water Resources","Soil Science","Environmental Impact Assessment","Conservation Biology","Remote Sensing","Climate Change Adaptation","One Health"],
      "Oceanography": ["Physical Oceanography","Chemical Oceanography","Biological Oceanography","Ocean Circulation","Tides & Waves","Sea Level & Climate","Marine Ecosystems","Deep Sea Science","Ocean Acidification","Polar Oceans","Ocean Observation","Marine Geochemistry"]
    }},
    "Economics": { icon: "📈", topics: {
      "Microeconomics": ["Supply & Demand Theory","Price Elasticity","Consumer Theory & Utility","Production & Cost Functions","Market Structures","Game Theory in Markets","General Equilibrium","Welfare Economics","Externalities & Public Goods","Information Asymmetry","Behavioural Microeconomics","Mechanism Design"],
      "Macroeconomics": ["National Income Accounting","IS-LM Model","Aggregate Demand & Supply","Monetary Policy Transmission","Fiscal Policy & Multipliers","Business Cycle Theory","Open Economy Macroeconomics","Exchange Rate Determination","Solow Growth Model","Endogenous Growth Theory","DSGE Models","Macroprudential Policy"],
      "Econometrics": ["OLS Regression","Heteroskedasticity","Autocorrelation","Endogeneity","Panel Data (Fixed & Random Effects)","Instrumental Variables","Time Series Econometrics","VAR Models","Cointegration","Difference-in-Differences","Regression Discontinuity","Causal Econometrics"],
      "Financial Economics": ["Asset Pricing (CAPM)","Efficient Markets Hypothesis","Derivatives & Options","Fixed Income","Portfolio Theory","Behavioural Finance","Market Microstructure","Corporate Finance Theory","Banking & Financial Intermediation","Monetary Economics","International Finance","Financial Crises"],
      "Development Economics": ["Growth Theory & Evidence","Poverty & Inequality","Human Capital","Institutions & Growth","Trade & Development","Foreign Aid & Investment","Health Economics","Education Economics","Political Economy","Environmental Economics","Experimental Economics","Global Value Chains"],
      "Behavioural Economics": ["Prospect Theory","Heuristics & Biases","Mental Accounting","Nudge Theory","Intertemporal Choice","Social Preferences","Loss Aversion","Bounded Rationality","Experimental Economics","Neuroeconomics","Behavioural Finance","Policy Applications"]
    }},
    "Maritime & Seafaring — AMC": { icon: "⚓", topics: {
      "Navigation & Watchkeeping": ["Terrestrial & Coastal Navigation","Electronic Chart Display (ECDIS)","Radar & ARPA Operation","Celestial Navigation","Passage Planning & Voyage Management","Bridge Resource Management","Collision Avoidance (COLREGs)","Meteorology & Oceanography","Position Fixing Methods","Restricted Visibility Watchkeeping","GMDSS Communications","Port Approach & Pilotage"],
      "Ship Stability & Seaworthiness": ["Hydrostatics & Buoyancy","Metacentric Height (GM) & Initial Stability","Free Surface Effect","Statical Stability (GZ Curves)","Stability at Large Angles","Damage Stability & Subdivision","Dynamic Stability","Trim, Draught & Displacement","Intact Stability Criteria","Grain Stability","Probabilistic Damage Stability","IMO Stability Regulations (IS Code)"],
      "Cargo Operations": ["Cargo Planning & Stowage","Dangerous Goods (IMDG Code)","Bulk Carrier Operations","Container Ship Operations","Tanker Operations (Oil, Chemical, Gas)","Cargo Securing & Lashing","Reefer & Perishable Cargo","Heavy Lift & Project Cargo","Port State Control & Inspections","Vessel Maintenance & Surveys","Ship-Shore Interface","Loading Computer Use"],
      "Marine Engineering Systems": ["Marine Diesel Engines (2 & 4 Stroke)","Propulsion Systems & Shafting","Auxiliary Machinery","Boilers & Steam Systems","Marine Electrical Systems","Refrigeration & HVAC","Fuel Systems & Bunkering","Engine Room Resource Management","Condition Monitoring & Maintenance","LNG & Alternative Fuel Propulsion","Hybrid & Electric Ships","Decarbonisation Technologies"],
      "Naval Architecture & Ship Design": ["Hull Form & Resistance","Propeller Design & Cavitation","Powering & Speed Prediction","Manoeuvring & Ship Handling","Seakeeping & Ship Motions","Structural Design & Scantlings","Ship Types & Principal Dimensions","Computational Fluid Dynamics (CFD)","Finite Element Analysis","Hydrodynamic Optimisation","Sustainable Ship Design","Model Testing & Towing Tank"],
      "Maritime Law & Regulations": ["SOLAS Convention","MARPOL (All Annexes)","UNCLOS & Law of the Sea","STCW Convention","ISM Code & Safety Management Systems","MLC (Maritime Labour Convention)","COLREGs","Bills of Lading & Charterparties","Marine Insurance & P&I Clubs","Port State & Flag State Control","Salvage, Towage & Wreck Removal","Liability & Limitation (LLMC)"],
      "Port Operations & Management": ["Port Planning & Terminal Layout","Container Terminal Operations","Bulk & Break-Bulk Terminals","Port Productivity & KPIs","Gate Systems & Yard Management","Port Community Systems","Hinterland Connectivity & Intermodal","Port Economics & Pricing","Port Safety Management","Environmental Port Management","Automated & Smart Terminals","Port Governance & Strategy"],
      "Maritime Business & Shipping": ["Shipping Markets & Freight Economics","Liner Shipping Networks & Alliances","Tramp & Bulk Shipping","Ship Chartering & Contracts","Maritime Economics & Policy","Marine Surveying & Inspection","Marine Superintendency","International Trade & Customs","Ship Management & Operations","Shipping & Decarbonisation Policy","Maritime Safety Management","Ship Finance & Investment"],
      "Global Logistics & Supply Chain": ["Supply Chain Management Fundamentals","Procurement & Sourcing Strategy","Inventory Management","Transport Mode Selection","Freight Forwarding & Customs","Warehousing & Distribution","Business Logistics Systems","International Trade Finance","Supply Chain Risk & Resilience","Logistics Technology & Digitalisation","Sustainable Supply Chains","Port-Centric Logistics"],
      "Ocean & Marine Engineering": ["Ocean Waves & Marine Hydrodynamics","Offshore Structure Design","Subsea Technology & Pipelines","Autonomous Marine Vehicles","Offshore Renewable Energy","Marine Geotechnics","Underwater Acoustics","Marine Environmental Engineering","Corrosion & Materials at Sea","Ocean Observation Systems","Towing Tank & Model Testing","Naval Shipbuilding & Procurement"]
    }}
  };

  let inserted = 0;
  for (const [subject, def] of Object.entries(BASE_TREE)) {
    for (const [topic, subs] of Object.entries(def.topics)) {
      const r = db.prepare(`INSERT OR IGNORE INTO tree_nodes (subject, subject_icon, topic, topic_lower, subtopics, source, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(subject, def.icon, topic, topic.toLowerCase(), JSON.stringify(subs), "seed", Date.now());
      inserted += r.changes;
    }
  }
  res.json({ ok: true, inserted });
});

// ── Repository (for visit dots on tree) ───────────────
app.get("/api/repository", (req, res) => {
  const topics = db.prepare("SELECT topic,subject,topic_key,category,visits FROM topics WHERE visits>0 ORDER BY visits DESC LIMIT 200").all();
  const withBranches = topics.map(t => {
    const branches = db.prepare("SELECT DISTINCT branch FROM explanations WHERE topic_lower=? AND branch IS NOT NULL AND level='grade5' ORDER BY created_at ASC")
      .all(t.topic.toLowerCase()).map(r => r.branch);
    return { ...t, branches };
  });
  res.json({ topics: withBranches });
});

// ── Brave Image Search ─────────────────────────────────
app.get("/api/images", async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query || query.length < 2) return res.json({ images: [] });
  const queryLower = query.toLowerCase();

  if (isBot(req)) return res.json({ images: [] });

  const cached = db.prepare("SELECT images FROM image_cache WHERE query_lower=?").get(queryLower);
  if (cached) return res.json({ images: JSON.parse(cached.images) });

  if (!BRAVE_API_KEY) return res.json({ images: [] });

  try {
    const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=6&safesearch=strict&search_lang=en&country=au`;
    const r = await fetch(url, {
      headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_API_KEY }
    });
    if (!r.ok) return res.json({ images: [] });
    const data = await r.json();
    const results = (data.results || []).slice(0, 4).map(img => ({
      src: img.thumbnail?.src || img.properties?.url || "",
      fullSrc: img.properties?.url || img.thumbnail?.src || "",
      caption: img.title || "",
      sourceUrl: img.url || "",
      sourceDomain: (() => { try { return new URL(img.url || "").hostname.replace(/^www\./, ""); } catch { return ""; } })()
    })).filter(img => img.src);
    db.prepare("INSERT OR REPLACE INTO image_cache (query_lower,images,created_at) VALUES (?,?,?)").run(queryLower, JSON.stringify(results), Date.now());
    res.json({ images: results });
  } catch (err) {
    console.error("Brave image error:", err.message);
    res.json({ images: [] });
  }
});

// ── Analytics tracking ─────────────────────────────────
app.post("/api/analytics/track", async (req, res) => {
  const { topic, level, category, action } = req.body;
  if (isBot(req)) return res.json({ ok: true }); // silently ignore bots
  const ip = getClientIP(req);
  const ipHash = hashIP(ip);
  const admin = isAdmin(req);
  const ua = (req.headers["user-agent"] || "").slice(0, 200);
  const referrer = (req.headers.referer || "").slice(0, 200);
  const geo = admin ? { country: "Admin", city: "" } : await getGeo(ip);
  db.prepare(`INSERT INTO page_views (topic,level,category,action,ip_hash,country,city,user_agent,referrer,is_admin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(topic || null, level || null, category || null, action || "view", ipHash, geo.country, geo.city, ua, referrer, admin ? 1 : 0, Date.now());
  res.json({ ok: true });
});

// ── Analytics dashboard (private) ─────────────────────
app.get(`/analytics/${ANALYTICS_SECRET}`, (req, res) => {
  const now = Date.now(), day = 86400000, week = day * 7;
  // All stats EXCLUDE admin visits
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const qget = (sql, ...p) => db.prepare(sql).get(...p);

  const totalViews = qget("SELECT COUNT(*) as n FROM page_views WHERE is_admin=0").n;
  const viewsToday = qget("SELECT COUNT(*) as n FROM page_views WHERE created_at>? AND is_admin=0", now - day).n;
  const viewsWeek = qget("SELECT COUNT(*) as n FROM page_views WHERE created_at>? AND is_admin=0", now - week).n;
  const uvToday = qget("SELECT COUNT(DISTINCT ip_hash) as n FROM page_views WHERE created_at>? AND is_admin=0", now - day).n;
  const uvWeek = qget("SELECT COUNT(DISTINCT ip_hash) as n FROM page_views WHERE created_at>? AND is_admin=0", now - week).n;
  const topTopics = q("SELECT topic,COUNT(*) as views,COUNT(DISTINCT ip_hash) as uv FROM page_views WHERE topic IS NOT NULL AND is_admin=0 GROUP BY topic ORDER BY views DESC LIMIT 20");
  const countryCounts = q("SELECT country,COUNT(DISTINCT ip_hash) as uv FROM page_views WHERE country!='' AND country IS NOT NULL AND is_admin=0 GROUP BY country ORDER BY uv DESC LIMIT 15");
  const cityCounts = q("SELECT city,country,COUNT(DISTINCT ip_hash) as uv FROM page_views WHERE city!='' AND city IS NOT NULL AND is_admin=0 GROUP BY city ORDER BY uv DESC LIMIT 10");
  const recent = q("SELECT topic,level,country,city,action,created_at FROM page_views WHERE is_admin=0 ORDER BY created_at DESC LIMIT 30");
  const treeSize = qget("SELECT COUNT(*) as n FROM tree_nodes").n;
  const newTopics = q("SELECT topic,subject,created_at FROM topics WHERE source='user' ORDER BY created_at DESC LIMIT 20");

  const maxV = topTopics[0]?.views || 1, maxC = countryCounts[0]?.uv || 1;
  const bar = (v, m, c = "#1D9E75") => `<div style="display:flex;align-items:center;gap:8px;"><div style="flex:1;height:7px;background:#f0efe9;border-radius:4px;"><div style="width:${Math.round(v / m * 100)}%;height:100%;background:${c};border-radius:4px;"></div></div><span style="font-size:12px;color:#5a5a56;min-width:28px;text-align:right;">${v}</span></div>`;
  const card = (t, v, s = "") => `<div style="background:#fff;border:0.5px solid rgba(0,0,0,0.12);border-radius:10px;padding:16px 20px;"><div style="font-size:10px;font-weight:600;color:#9a9890;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${t}</div><div style="font-size:28px;font-weight:600;color:#1a1a18;">${typeof v === 'number' ? v.toLocaleString() : v}</div>${s ? `<div style="font-size:12px;color:#9a9890;margin-top:3px;">${s}</div>` : ""}</div>`;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Analytics</title><meta name="robots" content="noindex,nofollow">
<style>body{font-family:-apple-system,sans-serif;background:#f7f6f3;color:#1a1a18;padding:32px;max-width:1200px;margin:0 auto;}h1{font-size:22px;font-weight:600;margin-bottom:4px;}h2{font-size:13px;font-weight:600;color:#5a5a56;margin:28px 0 12px;text-transform:uppercase;letter-spacing:0.06em;}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}.panel{background:#fff;border:0.5px solid rgba(0,0,0,0.12);border-radius:10px;padding:20px;}.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);font-size:13px;}.row:last-child{border:none;}.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500;background:#E1F5EE;color:#0a5a40;}.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:500;background:#f0efe9;color:#5a5a56;}</style>
</head><body>
<h1>📊 Curiosity Wikipedia — Analytics</h1>
<p style="font-size:13px;color:#9a9890;margin-bottom:24px;">Private · Unique visitors only · Admin visits excluded · ${new Date().toUTCString()}</p>
<h2>Overview</h2>
<div class="g4">${card("Unique visitors today", uvToday, `${viewsToday} page views`)}${card("Unique visitors this week", uvWeek, `${viewsWeek} page views`)}${card("Total page views", totalViews, "all time, excl. admin")}${card("Tree nodes", treeSize, "topics in knowledge tree")}</div>
<div class="g3" style="margin-top:12px;">
<div><h2>Top topics</h2><div class="panel">${topTopics.map(t => `<div class="row"><span>${t.topic || "—"}</span><div style="display:flex;align-items:center;gap:8px;min-width:150px;">${bar(t.views, maxV)}<span class="tag">${t.uv}uv</span></div></div>`).join("") || "<div style='color:#9a9890;'>No data</div>"}</div></div>
<div><h2>Countries</h2><div class="panel">${countryCounts.map(c => `<div class="row"><span>${c.country}</span><div style="display:flex;align-items:center;gap:8px;min-width:120px;">${bar(c.uv, maxC, "#534AB7")}<span class="badge">${c.uv} uv</span></div></div>`).join("") || "<div style='color:#9a9890;'>No geo data yet</div>"}</div></div>
<div><h2>Cities</h2><div class="panel">${cityCounts.map(c => `<div class="row"><span>${c.city}, ${c.country}</span><span class="badge">${c.uv} uv</span></div>`).join("") || "<div style='color:#9a9890;'>No data</div>"}</div></div>
</div>
<div class="g2" style="margin-top:0;">
<div><h2>Recently discovered topics</h2><div class="panel">${newTopics.map(t => `<div class="row"><span>${t.topic}</span><span class="badge">${t.subject}</span></div>`).join("") || "<div style='color:#9a9890;'>None yet</div>"}</div></div>
<div><h2>Recent activity (non-admin)</h2><div class="panel"><table style="width:100%;border-collapse:collapse;font-size:12px;"><tr style="color:#9a9890;"><th style="padding:4px 6px;text-align:left;">Topic</th><th style="padding:4px 6px;text-align:left;">Country</th><th style="padding:4px 6px;text-align:left;">City</th><th style="padding:4px 6px;text-align:left;">Time</th></tr>${recent.map(r => `<tr style="border-bottom:0.5px solid rgba(0,0,0,0.05);"><td style="padding:4px 6px;font-weight:500;">${r.topic || "—"}</td><td style="padding:4px 6px;color:#5a5a56;">${r.country || "—"}</td><td style="padding:4px 6px;color:#5a5a56;">${r.city || "—"}</td><td style="padding:4px 6px;color:#9a9890;">${new Date(r.created_at).toLocaleString()}</td></tr>`).join("")}</table></div></div>
</div>
</body></html>`);
});

// ── Admin: clear cache ─────────────────────────────────
app.post("/api/admin/clear-topic", (req, res) => {
  const { topic, branch, secret } = req.body;
  if (secret !== ANALYTICS_SECRET) return res.status(403).json({ error: "Forbidden" });
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
  res.json({ ok: true, deleted: result.changes });
});

// ── Daily discovery cron ───────────────────────────────
// Every day at 2am UTC: use Claude to discover new STEM/Econ topics
// from Australian university courses and add them to the tree.
// This does NOT generate articles — just discovers topic names cheaply (haiku).
const DISCOVERY_PROMPT = `You are a curriculum researcher for an academic knowledge base covering STEM and Economics topics taught at Australian universities (USyd, UTAS/AMC, ANU, UNSW, Melbourne, Monash, UQ, UWA, Adelaide).

Generate 15 specific academic topics or subtopics that:
1. Are genuinely taught in STEM or Economics courses at Australian universities
2. Are NOT already in the knowledge base
3. Are specific enough to be a single focused article (not too broad)
4. Cover a range of subjects and levels

Existing subjects: Mathematics, Physics, Chemistry, Biology, Computer Science, Engineering, Earth & Environmental Science, Economics, Maritime & Seafaring — AMC

Output ONLY a JSON array of objects, no other text:
[{"topic":"<topic name>","subject":"<subject>","topic_key":"<parent course/area>","icon":"<emoji>"}]`;

async function runDiscoveryJob() {
  console.log("🔍 Discovery job running...");
  try {
    // Get existing topics to avoid duplicates
    const existing = db.prepare("SELECT topic_lower FROM tree_nodes").all().map(r => r.topic_lower);
    const existingSet = new Set(existing);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `${DISCOVERY_PROMPT}\n\nAlready in the knowledge base (skip these): ${existing.slice(0, 100).join(", ")}`
        }]
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map(b => b.text || "").join("") || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const topics = JSON.parse(clean);

    let added = 0;
    for (const t of topics) {
      if (!t.topic || existingSet.has(t.topic.toLowerCase())) continue;
      // Add to tree_nodes
      const r = db.prepare(`INSERT OR IGNORE INTO tree_nodes (subject,subject_icon,topic,topic_lower,subtopics,source,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(t.subject || "Discovered", t.icon || "🔬", t.topic, t.topic.toLowerCase(), JSON.stringify([]), "discovery", Date.now());
      if (r.changes > 0) {
        // Also check if it should be a subtopic of an existing node
        const parent = db.prepare("SELECT id,subtopics FROM tree_nodes WHERE subject=? AND topic_lower=?").get(t.subject, (t.topic_key || "").toLowerCase());
        if (parent) {
          const subs = JSON.parse(parent.subtopics || "[]");
          if (!subs.includes(t.topic)) {
            subs.push(t.topic);
            db.prepare("UPDATE tree_nodes SET subtopics=? WHERE id=?").run(JSON.stringify(subs), parent.id);
          }
        }
        added++;
        console.log(`  ✓ Discovered: [${t.subject}] ${t.topic}`);
      }
    }
    console.log(`🔍 Discovery complete: ${added} new topics added`);
    setSeedMeta("last_discovery", new Date().toISOString());
    setSeedMeta("discovery_count", String((parseInt(getSeedMeta("discovery_count") || "0") + added)));
  } catch (err) {
    console.error("Discovery error:", err.message);
  }
}

function getSeedMeta(key) {
  return db.prepare("SELECT value FROM seed_meta WHERE key=?").get(key)?.value || "";
}
function setSeedMeta(key, value) {
  db.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES (?,?)").run(key, String(value));
}

// Discovery job: runs daily at 2am UTC
cron.schedule("0 2 * * *", () => {
  if (CLAUDE_API_KEY) runDiscoveryJob().catch(console.error);
}, { timezone: "UTC" });

// Also run on startup if tree is empty
const treeCount = db.prepare("SELECT COUNT(*) as n FROM tree_nodes").get().n;
if (treeCount === 0) {
  console.log("🌱 Tree is empty — run POST /api/admin/seed-tree to populate base tree");
}

app.listen(PORT, () => console.log(`🌐 Curiosity Wikipedia running on port ${PORT} | Tree nodes: ${treeCount}`));
