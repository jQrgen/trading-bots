const AGENTS = [
  ["nova", "Head trader"],
  ["orin", "Market scanner"],
  ["vela", "Research"],
  ["kade", "Risk officer"],
  ["rune", "Executor"],
  ["zara", "Journal & alerts"],
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? "–" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (n, d = 2) => (n > 0 ? "+" : "") + fmt(n, d);
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const get = (path) => fetch(path, { cache: "no-store" }).then((r) => r.json());

let events = [];
let lastEventId = 0;
let days = 7;

async function loadState() {
  const s = await get("/api/state");
  $("mode").textContent = s.mode === "live" ? "LIVE" : "PAPER";
  $("mode").className = "badge" + (s.mode === "live" ? " live" : "");
  $("halted").hidden = !s.halted;
  $("total").textContent = fmt(s.total_pusd);
  const pnl = s.total_pusd == null ? null : s.total_pusd - s.start_pusd;
  $("pnl").textContent = pnl == null ? "–" : signed(pnl);
  $("pnl").className = cls(pnl);
  $("pnlpct").textContent = pnl == null ? "" : signed((pnl / s.start_pusd) * 100, 1) + "%";
  $("winrate").textContent = s.stats.win_rate == null ? "–" : fmt(s.stats.win_rate * 100, 0) + "%";
  $("closed").textContent = `${s.stats.wins}/${s.stats.closed} trades`;
  $("bch").textContent = fmt(s.bch_pusd);

  const status = Object.fromEntries(s.agents.map((a) => [a.agent, a]));
  $("agents").innerHTML = AGENTS.map(([id, role], i) => {
    const st = status[id];
    const last = events.find((e) => e.agent === id);
    return `<div class="agent" style="--c: var(--${id})">
      <b>0${i + 1} ${id.toUpperCase()}</b>
      <div class="role">${role}</div>
      <div class="status">${esc(st ? st.status : "waiting for first cycle")}</div>
      <div class="last">${last ? esc(last.message) : ""}</div>
    </div>`;
  }).join("");

  $("positions").innerHTML = s.positions.length
    ? `<table><tr><th>Token</th><th>Horizon</th><th class="num">Cost</th><th class="num">Value</th><th class="num">P&amp;L</th><th class="num">Target / stop</th></tr>${s.positions
        .map((p) => `<tr title="${esc(p.thesis)}"><td>${esc(p.symbol)}</td><td>${esc(p.horizon)}</td><td class="num">${fmt(p.cost_pusd)}</td><td class="num">${fmt(p.value_pusd)}</td><td class="num ${cls(p.pnl_pct)}">${signed(p.pnl_pct, 1)}%</td><td class="num">+${p.target_pct}% / -${p.stop_pct}%</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">No open positions.</p>`;

  $("holdings").innerHTML = s.holdings.length
    ? `<table><tr><th>Asset</th><th class="num">Value (PUSD)</th></tr>${s.holdings
        .sort((a, b) => b.value_pusd - a.value_pusd)
        .map((h) => `<tr><td>${esc(h.symbol)}</td><td class="num">${fmt(h.value_pusd)}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">Wallet opens on the first cycle.</p>`;
}

async function loadEvents() {
  const fresh = await get(`/api/events?after=${lastEventId}&limit=300`);
  if (fresh.length) {
    events = [...fresh, ...events].slice(0, 600);
    lastEventId = events[0].id;
  }
  renderLog();
}

function renderLog() {
  const f = $("filter").value;
  const rows = events.filter((e) => !f || e.agent === f).slice(0, 300);
  $("log").innerHTML = rows.length
    ? rows
        .map((e) => `<li style="--c: var(--${e.agent})"><time title="${new Date(e.ts).toISOString()}">${time(e.ts)}</time><span class="who">${esc(e.agent)}</span><span><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span>${esc(e.message)}</span></li>`)
        .join("")
    : `<li class="empty">Nothing yet. The team runs every 15 minutes.</li>`;
}

async function loadChart() {
  const pts = await get(`/api/snapshots?days=${days}`);
  const el = $("chart");
  if (pts.length < 2) {
    el.innerHTML = `<p class="empty">The chart fills in after a couple of cycles.</p>`;
    return;
  }
  const W = el.clientWidth || 800, H = el.clientHeight || 220, P = 36;
  const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.total_pusd);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-6) { y0 -= 1; y1 += 1; }
  const X = (t) => P + ((t - x0) / (x1 - x0)) * (W - P - 8);
  const Y = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (H - 32);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.total_pusd).toFixed(1)}`).join("");
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? "var(--up)" : "var(--down)";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value in PUSD">
    <text x="4" y="${Y(y1) + 4}" fill="var(--muted)" font-size="11">${fmt(y1)}</text>
    <text x="4" y="${Y(y0) + 4}" fill="var(--muted)" font-size="11">${fmt(y0)}</text>
    <line x1="${P}" x2="${W - 8}" y1="${Y(y0)}" y2="${Y(y0)}" stroke="var(--line)"/>
    <path d="${line}L${X(x1)},${Y(y0)}L${X(x0)},${Y(y0)}Z" fill="${color}" opacity=".08"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="${P}" y="${H - 6}" fill="var(--muted)" font-size="11">${new Date(x0).toLocaleString()}</text>
    <text x="${W - 8}" y="${H - 6}" fill="var(--muted)" font-size="11" text-anchor="end">${ago(x1)}</text>
  </svg>`;
}

async function loadTrades() {
  const t = await get("/api/trades");
  $("trades").innerHTML = t.length
    ? `<table><tr><th>When</th><th>Side</th><th>Token</th><th class="num">PUSD</th><th class="num">Impact</th></tr>${t
        .slice(0, 50)
        .map((r) => `<tr title="${esc(r.reason)}"><td>${new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td class="${r.side === "buy" ? "up" : "down"}">${r.side.toUpperCase()}${r.mode === "paper" ? " (paper)" : ""}</td><td>${esc(r.symbol)}</td><td class="num">${fmt(r.pusd)}</td><td class="num">${fmt(r.impact_pct)}%${r.estimated ? "*" : ""}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">No trades yet.</p>`;
}

async function loadJournal() {
  const [j, l] = await Promise.all([get("/api/journal"), get("/api/lessons")]);
  $("journal").innerHTML = j.length
    ? j.slice(0, 5).map((e) => `<div class="journal-entry"><time>${new Date(e.ts).toLocaleDateString()}</time>${esc(e.text)}</div>`).join("")
    : `<p class="empty">Zara writes the first journal entry tonight.</p>`;
  $("lessons").innerHTML = l.slice(0, 10).map((x) => `<li class="${esc(x.status)}">${esc(x.lesson)}</li>`).join("");
}

async function loadProposals() {
  const rows = await get("/api/proposals?limit=30");
  $("proposals").innerHTML = rows.length
    ? `<table><tr><th>When</th><th>Idea</th><th>Status</th></tr>${rows
        .map((p) => `<tr title="${esc([p.thesis, p.bull_case && "Bull: " + p.bull_case, p.bear_case && "Bear: " + p.bear_case, p.risk_notes, p.decision_note].filter(Boolean).join("\n"))}"><td>${time(p.ts)}</td><td>${esc(p.action.toUpperCase())} ${esc(p.symbol)} <small class="hint">${esc(p.horizon)} · ${esc(p.signal ?? "")}</small></td><td><span class="chip ${esc(p.status)}">${esc(p.status.replace("_", " "))}</span></td></tr>`)
        .join("")}</table>`
    : `<p class="empty">No proposals yet.</p>`;
}

async function loadResearch() {
  const [tokens, notes] = await Promise.all([get("/api/tokens"), get("/api/research")]);
  const latest = new Map();
  for (const n of notes) if (!latest.has(n.token_id)) latest.set(n.token_id, n);
  const fresh = tokens.filter((t) => t.research_status !== "researched" || latest.has(t.token_id)).slice(0, 25);
  $("research").innerHTML = fresh.length
    ? `<table><tr><th>Token</th><th>Seen</th><th>Verdict</th></tr>${fresh
        .map((t) => {
          const n = latest.get(t.token_id);
          const tip = n ? [n.note, n.opportunity && "Opportunity: " + n.opportunity].filter(Boolean).join("\n") : "Not researched yet";
          const status = n ? n.verdict : t.research_status;
          return `<tr title="${esc(tip)}"><td>${esc(t.symbol)} <small class="hint">${esc(t.name ?? "")} · ${fmt(t.last_tvl_bch, 1)} BCH</small></td><td>${ago(t.first_seen)}</td><td><span class="chip ${esc(status)}">${esc(status)}</span></td></tr>`;
        })
        .join("")}</table>`
    : `<p class="empty">No new tokens since the desk started watching. New Cauldron pools show up here and the team researches each one.</p>`;
}

async function loadSentiment() {
  const [rows, pad] = await Promise.all([get("/api/sentiment"), get("/api/launchpad")]);
  const recent = rows.filter((r) => r.ts > Date.now() - 24 * 3600 * 1000).slice(0, 20);
  $("sentiment").innerHTML = recent.length
    ? `<table><tr><th>Subject</th><th class="num">Score</th><th>Summary</th></tr>${recent
        .map((r) => `<tr><td>${esc(r.subject === "token" ? r.symbol : r.subject)} <small class="hint">${ago(r.ts)}</small></td><td class="num ${cls(r.score)}">${signed(r.score, 2)}</td><td>${esc(r.summary)}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">No sentiment readings yet. Vela searches X for held tokens, new tokens and Cauldron news every cycle.</p>`;
  $("launchpad").innerHTML = pad.length
    ? `<table><tr><th>Sale</th><th>Status</th><th>Seen</th></tr>${pad
        .map((x) => `<tr><td><code>${esc(String(x.offered_token_id).slice(0, 10))}…</code></td><td><span class="chip">${esc(x.status)}</span></td><td>${ago(x.first_seen)}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">Not launched yet. The desk checks every 15 minutes and alerts the team the moment the first sale appears.</p>`;
}

async function loadFiles() {
  const rows = await get("/api/files");
  const open = new Set([...document.querySelectorAll("#files details[open]")].map((d) => d.dataset.path));
  const sig = JSON.stringify(rows.map((r) => [r.path, r.version]));
  if ($("files").dataset.sig === sig) return;
  $("files").dataset.sig = sig;
  $("files").innerHTML = rows.length
    ? rows
        .map((f) => `<details class="call" data-path="${esc(f.path)}"${open.has(f.path) ? " open" : ""}><summary><code>${esc(f.path)}</code> <small class="hint">v${f.version} · ${esc(f.updated_by ?? "")} · ${ago(f.updated_at)} · ${fmt(f.bytes / 1024, 1)} KB</small></summary><pre class="body" data-load="${esc(f.path)}">Loading…</pre></details>`)
        .join("")
    : `<p class="empty">No files yet. The bots write their watchlists, plans and notes here.</p>`;
  for (const d of document.querySelectorAll("#files details")) {
    const load = async () => {
      const pre = d.querySelector("pre");
      if (pre.dataset.done) return;
      const f = await get("/api/files/" + encodeURIComponent(d.dataset.path).replace(/%2F/g, "/"));
      pre.textContent = f.body ?? f.error;
      pre.dataset.done = "1";
    };
    d.addEventListener("toggle", () => d.open && load());
    if (d.open) load();
  }
}

async function loadScorecard() {
  const c = await get("/api/scorecard");
  if (!c || !c.overall.trades) {
    $("scorecard").innerHTML = `<p class="empty">Fills in once positions start closing. The team uses it to size bets and pick signals.</p>`;
    return;
  }
  const table = (title, groups) => `<table><tr><th>${title}</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Avg</th><th class="num">P&amp;L</th></tr>${Object.entries(groups)
    .map(([k, b]) => `<tr><td>${esc(k)}</td><td class="num">${b.trades}</td><td class="num">${fmt(b.win_rate * 100, 0)}%</td><td class="num ${cls(b.avg_pnl_pct)}">${signed(b.avg_pnl_pct, 1)}%</td><td class="num ${cls(b.pnl_pusd)}">${signed(b.pnl_pusd)}</td></tr>`)
    .join("")}</table>`;
  $("scorecard").innerHTML = table("Horizon", { all: c.overall, ...c.by_horizon }) + `<div class="mt"></div>` + table("Signal", c.by_signal);
}

// Team knowledge: everything the bots read, with history. The owner can edit.
let kb = [];
let kbKey = "strategy";
let editing = false;
const token = {
  get: () => { try { return localStorage.getItem("desk-admin-token"); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem("desk-admin-token", v) : localStorage.removeItem("desk-admin-token"); } catch {} },
};
const GROUPS = [["strategy", "Owner"], ["limits", "Owner"], ["market", "Market"], ["rules", "Team"], ["team", "Team"], ["role", "Roles"]];

let kbSig = "";
async function loadKnowledge(force = false) {
  if (editing) return;
  const rows = await get("/api/knowledge");
  const sig = rows.map((d) => `${d.key}:${d.version}`).join();
  if (sig === kbSig && !force) return; // don't wipe an open history view on refresh
  kbSig = sig;
  kb = rows;
  let last = "";
  $("kb-list").innerHTML = GROUPS.flatMap(([kind, group]) =>
    kb.filter((d) => d.kind === kind).map((d) => {
      const head = group !== last ? `<div class="group">${group}</div>` : "";
      last = group;
      return `${head}<button data-key="${esc(d.key)}" class="${d.key === kbKey ? "on" : ""}">${esc(d.title)}</button>`;
    }),
  ).join("");
  renderDoc();
}

function renderDoc(historyRows) {
  const d = kb.find((x) => x.key === kbKey);
  if (!d) { $("kb-doc").innerHTML = `<p class="empty">Seeding the knowledge base…</p>`; return; }
  const owner = Boolean(token.get());
  const meta = `<div class="meta"><span>Version ${d.version}</span><span>by ${esc(d.updated_by)}</span><span>${new Date(d.updated_at).toLocaleString()}</span>
    <button class="btn" data-act="history">History</button>${owner ? `<button class="btn primary" data-act="edit">Edit</button>` : ""}</div>`;
  if (editing) {
    $("kb-doc").innerHTML = `<div class="meta"><span>Editing ${esc(d.title)}</span><button class="btn primary" data-act="save">Save</button><button class="btn" data-act="cancel">Cancel</button><span id="kb-err" class="err"></span></div><textarea id="kb-text" spellcheck="false">${esc(d.body)}</textarea>`;
    return;
  }
  const hist = historyRows
    ? `<h2 class="mt">History</h2>${historyRows.map((h) => `<details><summary>Version ${h.version} · ${esc(h.updated_by)} · ${new Date(h.updated_at).toLocaleString()}</summary><pre>${esc(h.body)}</pre></details>`).join("")}`
    : "";
  $("kb-doc").innerHTML = meta + `<pre>${esc(d.body)}</pre>` + hist;
}

$("kb-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-key]");
  if (!b || editing) return;
  kbKey = b.dataset.key;
  document.querySelectorAll("#kb-list button").forEach((x) => x.classList.toggle("on", x === b));
  renderDoc();
});

$("kb-doc").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "history") renderDoc(await get(`/api/knowledge/${encodeURIComponent(kbKey)}/history`));
  if (act === "edit") { editing = true; renderDoc(); }
  if (act === "cancel") { editing = false; renderDoc(); }
  if (act === "save") {
    const res = await fetch("/api/admin/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.get()}` },
      body: JSON.stringify({ key: kbKey, body: $("kb-text").value }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { $("kb-err").textContent = out.error || `Save failed (${res.status})`; return; }
    editing = false;
    await loadKnowledge(true);
  }
});

$("owner").addEventListener("click", async () => {
  if (token.get()) { token.set(null); $("owner").textContent = "Owner login"; renderDoc(); return; }
  const t = prompt("Owner token (ADMIN_TOKEN)");
  if (!t) return;
  const res = await fetch("/api/admin/check", { method: "POST", headers: { authorization: `Bearer ${t}` } });
  if (!res.ok) { alert("That token was not accepted."); return; }
  token.set(t);
  $("owner").textContent = "Owner log out";
  renderDoc();
});
if (token.get()) $("owner").textContent = "Owner log out";
const showBotButton = () => ($("bottoken").hidden = !token.get());
showBotButton();
$("owner").addEventListener("click", () => setTimeout(showBotButton, 1500));
$("bottoken").addEventListener("click", async () => {
  if (!confirm("Create a new Grok Bot token? The previous token made here stops working.")) return;
  const r = await fetch("/api/admin/bot-token", { method: "POST", headers: { authorization: "Bearer " + token.get() } }).then((x) => x.json());
  if (r.token) prompt("Give this token to Grok Bot. It is shown only once.", r.token);
  else alert(r.error || "Failed");
});

let callsSig = "";
async function loadCalls() {
  const rows = await get("/api/agent-calls?limit=20");
  const sig = rows.map((c) => c.id).join();
  if (sig === callsSig && callsSig) return; // keep expanded entries open
  callsSig = sig;
  $("calls").className = "calls";
  $("calls").innerHTML = rows.length
    ? rows
        .map((c) => `<details style="--c: var(--${c.agent})"><summary>${time(c.ts)}<span class="who">${esc(c.agent)}</span>${c.search ? "with X/web search · " : ""}${(c.ms / 1000).toFixed(1)}s${c.error ? ` · <span class="err">${esc(c.error.slice(0, 80))}</span>` : ""}</summary>
          <h3>Input</h3><pre>${esc(c.input)}</pre><h3>Reply</h3><pre>${esc(c.output ?? "")}</pre></details>`)
        .join("")
    : `<p class="empty">Grok Bot thinks inside the Grok app, so its prompts are not stored here; its decisions are in the activity log. Calls appear here only in xai-api mode.</p>`;
}

$("filter").addEventListener("change", renderLog);
$("range").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  days = Number(b.dataset.days);
  document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("on", x === b));
  loadChart();
});

async function refresh() {
  try {
    await loadEvents();
    await Promise.all([loadState(), loadChart(), loadTrades(), loadJournal(), loadProposals(), loadResearch(), loadSentiment(), loadFiles(), loadScorecard(), loadKnowledge(), loadCalls()]);
  } catch (err) {
    console.error(err);
  }
}
refresh();
setInterval(refresh, 15000);
