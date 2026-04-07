const KNOWLEDGE_TREE = {
  "Business & Economics":{icon:"📊",topics:{
    "Microeconomics":["Supply & Demand Theory","Price Elasticity","Consumer Theory & Utility","Production & Cost Functions","Market Structures","Game Theory in Markets","General Equilibrium","Welfare Economics","Externalities & Public Goods","Information Asymmetry","Behavioural Microeconomics","Mechanism Design"],
    "Macroeconomics":["National Income Accounting","IS-LM Model","Aggregate Demand & Supply","Monetary Policy Transmission","Fiscal Policy & Multipliers","Business Cycle Theory","Open Economy Macroeconomics","Exchange Rate Determination","Solow Growth Model","Endogenous Growth Theory","DSGE Models","Macroprudential Policy"],
    "Financial Accounting":["Double-Entry Bookkeeping","Income Statement","Balance Sheet","Cash Flow Statement","Revenue Recognition (IFRS 15)","Lease Accounting (IFRS 16)","Financial Instruments (IFRS 9)","Consolidation & Group Accounts","Impairment Testing","Earnings Quality","Forensic Accounting","Integrated Reporting"],
    "Corporate Finance":["Time Value of Money","Capital Budgeting","WACC & Capital Structure","Dividend Policy","Valuation Methods","Mergers & Acquisitions","Agency Theory","Real Options","Corporate Governance","Financial Distress","Behavioural Corporate Finance","ESG & Sustainable Finance"],
    "Strategic Management":["SWOT & PESTLE Analysis","Porter's Five Forces","Value Chain Analysis","Resource-Based View","Dynamic Capabilities","Blue Ocean Strategy","Balanced Scorecard","Corporate Diversification","Strategic Alliances","Digital Strategy","Platform Ecosystems","Strategy as Practice"],
    "Supply Chain Management":["Inventory Management","Demand Forecasting","Procurement Strategy","Supplier Relationship Management","Logistics Network Design","Lean & JIT","Supply Chain Risk","Bullwhip Effect","Green Supply Chains","Blockchain in SCM","Digital Twin in Logistics","Port-Centric Logistics"],
    "Organisational Behaviour":["Motivation Theories","Leadership Styles","Group Dynamics","Organisational Culture","Change Management","Power & Politics","Conflict Resolution","Emotional Intelligence","Diversity & Inclusion","Psychological Safety","Organisational Learning","Complexity in Organisations"],
    "Business Ethics":["Stakeholder Theory","Corporate Social Responsibility","Ethical Decision-Making","Whistleblowing","Corporate Governance Ethics","ESG Reporting","Business & Human Rights","Ethical AI in Business","Corruption & Bribery","Sustainability Accounting","UN SDGs in Business","Ethics of Globalisation"]
  }},
  "Maritime & Logistics":{icon:"🚢",topics:{
    "Ship Stability":["Hydrostatics & Buoyancy","Metacentric Height (GM)","Free Surface Effect","Stability at Large Angles","Damage Stability"],
    "Naval Architecture":["Hull Form Design","Resistance & Propulsion","Powering & Speed","Manoeuvrability"],
    "Port Operations Management":["Port Planning & Layout","Terminal Operations","Cargo Handling Equipment","Container Terminal Systems"],
    "Maritime Law":["SOLAS Convention","MARPOL Convention","UNCLOS","Bills of Lading"]
  }},
  "Sciences & Engineering":{icon:"🔬",topics:{
    "Calculus & Analysis":["Limits & Continuity","Differentiation","Integration","Differential Equations"],
    "Statistics & Probability":["Probability Theory","Random Variables","Hypothesis Testing","Regression Analysis"],
    "Climate Science":["Atmospheric Physics","Climate Modelling","Radiative Forcing","Sea Level Rise"]
  }},
  "Health & Medicine":{icon:"🩺",topics:{
    "Immunology":["Innate Immunity","Adaptive Immunity","Antibody Structure & Function","T-Cell Biology"],
    "Epidemiology":["Disease Surveillance","Study Designs","Measures of Association","Bias & Confounding"],
    "Pharmacology":["Pharmacokinetics","Pharmacodynamics","Drug-Receptor Interactions"]
  }},
  "Research & Methods":{icon:"📐",topics:{
    "Research Design":["Ontology & Epistemology","Research Paradigms","Qualitative vs Quantitative"],
    "Quantitative Methods":["Descriptive Statistics","Inferential Statistics","Regression Analysis"],
    "Econometrics":["OLS Regression","Panel Data","IV & 2SLS"]
  }}
};

let cache = {};
let currentTopic = null;
let currentBranch = null;
let currentLevel = "grade5";
let currentCategory = null;

const LEVELS = ["grade5","college","masters","phd"];
const LEVEL_BUILD = {grade5:"Built at 5th Grade level",college:"Built at College level",masters:"Built at Master's level",phd:"Built at PhD level"};

function cacheKey(topic, branch) {
  return branch ? `${topic.toLowerCase()}|${branch.toLowerCase()}` : topic.toLowerCase();
}

function esc(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderTree() {
  const wrap = document.getElementById("tree-wrap");
  wrap.innerHTML = "";
  Object.keys(KNOWLEDGE_TREE).forEach(subject => {
    const data = KNOWLEDGE_TREE[subject];
    const subjDiv = document.createElement("div");
    subjDiv.className = "t-subject";
    subjDiv.innerHTML = `<span class="t-subject-chev">›</span><span class="t-subject-icon">${data.icon}</span><span class="t-subject-label">${subject}</span>`;
    subjDiv.onclick = () => toggleSubject(subjDiv, subject);
    wrap.appendChild(subjDiv);

    const topicsDiv = document.createElement("div");
    topicsDiv.style.display = "none";
    Object.keys(data.topics).forEach(topic => {
      const tDiv = document.createElement("div");
      tDiv.className = "t-topic";
      tDiv.innerHTML = `<span class="t-topic-dot unvisited"></span><span class="t-topic-label">${topic}</span>`;
      tDiv.onclick = (e) => { e.stopImmediatePropagation(); exploreTopic(subject, topic); };
      topicsDiv.appendChild(tDiv);
    });
    wrap.appendChild(topicsDiv);
  });
}

function toggleSubject(el, subject) {
  const next = el.nextElementSibling;
  if (next) {
    next.style.display = next.style.display === "none" ? "block" : "none";
    el.querySelector(".t-subject-chev").classList.toggle("open");
  }
}

async function exploreTopic(subject, topic) {
  currentTopic = topic;
  currentBranch = null;
  currentCategory = subject;
  await doExploreAtLevel("grade5");
}

async function doExploreAtLevel(level) {
  currentLevel = level;
  const key = cacheKey(currentTopic, currentBranch);
  if (!cache[key] || !cache[key][level]) {
    const data = await fetchOneLevel(currentTopic, currentBranch, level);
    if (!cache[key]) cache[key] = {};
    cache[key][level] = data;
  }
  renderLevel(level);
}

async function fetchOneLevel(topic, branch, level) {
  try {
    const res = await fetch("/api/explore", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({topic, branch, level, category: currentCategory})
    });
    const result = await res.json();
    return result.levels[level] || {content: "No content available", branches: [], bibliography: []};
  } catch (e) {
    console.error(e);
    return {content: "Error loading content. Please try again.", branches: [], bibliography: []};
  }
}

function parseSections(content) {
  const sections = [];
  const parts = content.split(/\[HEADING:\s*(.+?)\]/);
  let heading = "Overview";
  for (let i = 1; i < parts.length; i += 2) {
    heading = parts[i].trim();
    const text = (parts[i+1] || "").trim();
    if (text) sections.push({heading, paragraphs: text.split("\n\n").filter(p => p.trim())});
  }
  return sections.length ? sections : [{heading: "Overview", paragraphs: [content]}];
}

function renderLevel(lvl) {
  const key = cacheKey(currentTopic, currentBranch);
  const data = cache[key] && cache[key][lvl];
  if (!data) return;

  document.getElementById("article-bc").innerHTML = currentBranch ? `<span>${esc(currentTopic)}</span> &rarr; ${esc(currentBranch)}` : "";
  document.getElementById("article-title").textContent = currentBranch || currentTopic;
  document.getElementById("article-meta").textContent = LEVEL_BUILD[lvl];

  const sections = parseSections(data.content || "");
  const body = document.getElementById("article-body");
  let html = "";
  sections.forEach(s => {
    html += `<div class="sec-block" data-heading="${esc(s.heading)}">
      <div class="sec-hdr">
        <div class="sec-title">${esc(s.heading)}</div>
        <button class="simplify-btn" onclick="simplifyConcept('${esc(s.heading)}')">Simplify</button>
      </div>
      ${s.paragraphs.map(p => `<p>${p}</p>`).join("")}
    </div>`;
  });
  body.innerHTML = html;

  document.getElementById("article").style.display = "block";
  document.getElementById("empty").style.display = "none";
}

async function simplifyConcept(heading) {
  const modal = document.getElementById("simplify-modal");
  const body = document.getElementById("simplify-body");
  body.innerHTML = `<p style="text-align:center;color:var(--text3);">Loading simple explanation...</p>`;
  modal.style.display = "flex";
  try {
    const key = cacheKey(currentTopic, currentBranch);
    let data = cache[key] && cache[key]["grade5"];
    if (!data) data = await fetchOneLevel(currentTopic, null, "grade5");
    const sections = parseSections(data.content);
    let html = `<h3 style="margin-bottom:16px;color:var(--accent);">${esc(heading)}</h3>`;
    sections.forEach(s => html += `<p style="margin-bottom:18px;">${s.paragraphs.join("</p><p style=\"margin-bottom:18px;\">")}</p>`);
    body.innerHTML = html;
  } catch(e) {
    body.innerHTML = `<p style="color:#c00;">Could not load simplification.</p>`;
  }
}

function closeSimplify() {
  document.getElementById("simplify-modal").style.display = "none";
}

function switchLevel(lvl) {
  document.querySelectorAll(".level-tab").forEach(t => t.classList.remove("active"));
  document.getElementById(`tab-${lvl}`).classList.add("active");
  doExploreAtLevel(lvl);
}

function handleSearchKey(e) { if (e.key === "Enter") triggerSearch(); }
function handleSearchInput() {}
function triggerSearch() {
  const q = document.getElementById("tree-search").value.trim();
  if (q) { currentTopic = q; currentBranch = null; doExploreAtLevel("grade5"); }
}
function exploreSelection() {}

window.addEventListener("load", () => {
  renderTree();
  console.log("%c✅ Curiosity Wikipedia frontend ready", "color:#1D9E75;font-weight:600");
});
