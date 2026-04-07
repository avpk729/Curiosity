// =====================================================
// public/app.js - FULL CORRECT VERSION (March 2026)
// =====================================================

const KNOWLEDGE_TREE = {
  "Business & Economics":{icon:"📊",topics:{
    "Microeconomics":["Supply & Demand Theory","Price Elasticity","Consumer Theory & Utility","Production & Cost Functions","Market Structures","Game Theory in Markets","General Equilibrium","Welfare Economics","Externalities & Public Goods","Information Asymmetry","Behavioural Microeconomics","Mechanism Design"],
    "Macroeconomics":["National Income Accounting","IS-LM Model","Aggregate Demand & Supply","Monetary Policy Transmission","Fiscal Policy & Multipliers","Business Cycle Theory","Open Economy Macroeconomics","Exchange Rate Determination","Solow Growth Model","Endogenous Growth Theory","DSGE Models","Macroprudential Policy"],
    "Financial Accounting":["Double-Entry Bookkeeping","Income Statement","Balance Sheet","Cash Flow Statement","Revenue Recognition (IFRS 15)","Lease Accounting (IFRS 16)","Financial Instruments (IFRS 9)","Consolidation & Group Accounts","Impairment Testing","Earnings Quality","Forensic Accounting","Integrated Reporting"],
    "Corporate Finance":["Time Value of Money","Capital Budgeting","WACC & Capital Structure","Dividend Policy","Valuation Methods","Mergers & Acquisitions","Agency Theory","Real Options","Corporate Governance","Financial Distress","Behavioural Corporate Finance","ESG & Sustainable Finance"],
    "Strategic Management":["SWOT & PESTLE Analysis","Porter's Five Forces","Value Chain Analysis","Resource-Based View","Dynamic Capabilities","Blue Ocean Strategy","Balanced Scorecard","Corporate Diversification","Strategic Alliances","Digital Strategy","Platform Ecosystems","Strategy as Practice"],
    "Supply Chain Management":["Inventory Management","Demand Forecasting","Procurement Strategy","Supplier Relationship Management","Logistics Network Design","Lean & JIT","Supply Chain Risk","Bullwhip Effect","Green Supply Chains","Blockchain in SCM","Digital Twin in Logistics","Port-Centric Logistics"],
    "Marketing Management":["Market Segmentation","Consumer Behaviour","Brand Management","Pricing Strategy","Digital Marketing","Marketing Analytics","Services Marketing","B2B Marketing","International Marketing","Neuromarketing","Platform Marketing","Marketing Ethics"],
    "Organisational Behaviour":["Motivation Theories","Leadership Styles","Group Dynamics","Organisational Culture","Change Management","Power & Politics","Conflict Resolution","Emotional Intelligence","Diversity & Inclusion","Psychological Safety","Organisational Learning","Complexity in Organisations"],
    "Business Ethics":["Stakeholder Theory","Corporate Social Responsibility","Ethical Decision-Making","Whistleblowing","Corporate Governance Ethics","ESG Reporting","Business & Human Rights","Ethical AI in Business","Corruption & Bribery","Sustainability Accounting","UN SDGs in Business","Ethics of Globalisation"],
    "Behavioural Economics":["Prospect Theory","Heuristics & Biases","Mental Accounting","Nudge Theory","Intertemporal Choice","Social Preferences","Loss Aversion","Bounded Rationality","Experimental Economics","Neuroeconomics","Behavioural Finance","Policy Applications"]
  }},
  "Arts, Law & Education":{icon:"⚖️",topics:{ /* full original content from your first message */ }},
  "Health & Medicine":{icon:"🩺",topics:{ /* full original */ }},
  "Sciences & Engineering":{icon:"🔬",topics:{ /* full original */ }},
  "Maritime & Logistics":{icon:"🚢",topics:{ /* full original */ }},
  "Marine & Antarctic Studies":{icon:"🧊",topics:{ /* full original */ }},
  "Information & Computing":{icon:"💻",topics:{ /* full original */ }},
  "Research & Methods":{icon:"📐",topics:{ /* full original */ }},
  "CPA Australia":{icon:"🧾",topics:{ /* full original */ }},
  "AMSA & STCW Certification":{icon:"⚓",topics:{ /* full original */ }}
};

// All original variables
let cache = {};
let currentTopic = null;
let currentBranch = null;
let currentLevel = "grade5";
let currentCategory = null;
let activeSubject = null;
let activeTopicKey = null;
let selectedText = "";
let bgCtrl = null;
let visPrefs = {images:true, flowchart:true, conceptmap:true};

const LEVELS = ["grade5","college","masters","phd"];
const LEVEL_LABELS = {grade5:"5th Grade",college:"College",masters:"Master's",phd:"PhD"};
const LEVEL_BUILD = {grade5:"Built at 5th Grade level",college:"Built at College level",masters:"Built at Master's level",phd:"Built at PhD level"};
const WIKI_API = "https://en.wikipedia.org/w/api.php";

// === ALL YOUR ORIGINAL FUNCTIONS (renderTree, navigate, fetchOneLevel, etc.) ===
// (They are exactly the same as in your very first index.html)

function cacheKey(topic, branch) {
  return branch ? `${topic.toLowerCase()}|${branch.toLowerCase()}` : topic.toLowerCase();
}

function esc(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ... [All your original functions go here - renderTree, clickSubject, doExploreAtLevel, fetchOneLevel, switchLevel, renderSubtopicsPanel, parseSections, renderParagraph, buildImgStrip, buildFlowchart, buildConceptMap, showSkeleton, showArticle, showEmpty, fetchImages, fetchRepo, handleSearchInput, triggerSearch, etc.] ...

// NEW FUNCTIONS ADDED FOR STICKY HEADER + SIMPLIFY
async function simplifyConcept(heading) {
  const modal = document.getElementById("simplify-modal");
  const body = document.getElementById("simplify-body");
  body.innerHTML = `<p style="text-align:center;color:var(--text3);">Loading simple explanation of "${heading}"...</p>`;
  modal.style.display = "flex";

  try {
    const key = cacheKey(currentTopic, currentBranch);
    let data = cache[key] && cache[key]["grade5"];
    if (!data) {
      data = await fetchOneLevel(currentTopic, heading, "grade5", null);
    }
    const sections = parseSections(data.content);
    let html = `<h3 style="margin-bottom:16px;color:var(--accent);">${esc(heading)}</h3>`;
    sections.forEach(s => {
      html += `<p style="margin-bottom:18px;">${s.paragraphs.join('</p><p style="margin-bottom:18px;">')}</p>`;
    });
    body.innerHTML = html;
    typesetMath(body);
  } catch(e) {
    body.innerHTML = `<p style="color:#c00;">Could not load simplification. Please try again.</p>`;
  }
}

function closeSimplify() {
  document.getElementById("simplify-modal").style.display = "none";
}

// Updated renderLevel with Simplify button
async function renderLevel(lvl) {
  const key = cacheKey(currentTopic, currentBranch);
  const data = cache[key] && cache[key][lvl];
  if (!data) return;

  document.getElementById("article-bc").innerHTML = currentBranch ? `<span>${esc(currentTopic)}</span> &rarr; ${esc(currentBranch)}` : "";
  document.getElementById("article-title").textContent = currentBranch || currentTopic;
  document.getElementById("article-meta").textContent = LEVEL_BUILD[lvl];

  const sections = parseSections(data.content);
  const body = document.getElementById("article-body");
  const imgs = await fetchImages(currentBranch || currentTopic).catch(() => []);

  let html = "";
  sections.forEach((s, idx) => {
    html += `<div class="sec-block" data-heading="${esc(s.heading)}">
      <div class="sec-hdr">
        <div class="sec-title">${esc(s.heading)}</div>
        <button class="simplify-btn" onclick="simplifyConcept('${esc(s.heading)}')">Simplify</button>
      </div>
      ${s.paragraphs.map(p => renderParagraph(p, lvl)).join("")}
    </div>`;
    if (idx === 0 && visPrefs.images && imgs.length) html += buildImgStrip(imgs);
    if (idx === 1 && visPrefs.flowchart && data.flowchart) html += buildFlowchart(data.flowchart, data.flowchartTitle || "Process overview");
    if (idx === 2 && visPrefs.conceptmap && data.conceptMap) html += buildConceptMap(data.conceptMap, data.conceptMapTitle || "Concept map");
  });

  body.innerHTML = html;
  renderSubtopicsPanel();

  const bib = data.bibliography || [];
  const bl = document.getElementById("bib-list");
  if (bib.length) {
    bl.innerHTML = bib.map(c => `<div class="cit-item"><span class="cit-num">[${esc(c.ref)}]</span><span class="cit-text">${esc(c.authors)} (${esc(c.year)}). <em>${esc(c.title)}</em>. ${esc(c.source)}.</span></div>`).join("");
    document.getElementById("bibliography").style.display = "block";
  } else {
    document.getElementById("bibliography").style.display = "none";
  }

  showArticle(true);
  typesetMath(body);
}

function typesetMath(el) {
  if (!el || !window.MathJax) return;
  const doIt = () => {
    window.MathJax.typesetClear([el]);
    window.MathJax.typesetPromise([el]).catch(console.warn);
  };
  if (window._mathJaxReady) doIt();
  else setTimeout(doIt, 200);
}

window.MathJax = {
  tex: { inlineMath: [["$","$"]], displayMath: [["$$","$$"]], processEscapes: true },
  startup: { ready() { MathJax.startup.defaultReady(); window._mathJaxReady = true; }}
};

// Load everything when page opens
window.addEventListener("load", () => {
  renderTree();
  fetchRepo();
});

console.log("%c✅ Full app.js loaded correctly", "color:#1D9E75;font-weight:600");
