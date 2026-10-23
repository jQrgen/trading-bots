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
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 60 * 36 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const utcClock = (ts) => new Date(ts).toISOString().slice(11, 16) + " UTC";
const get = (path) => fetch(path, { cache: "no-store" }).then((r) => r.json());

let events = [];
let lastEventId = 0;
let days = 7;

async function loadState() {
  const s = await get("/api/state");
  $("mode").textContent = s.mode === "live" ? "LIVE" : "PAPER";
  $("mode").className = "badge" + (s.mode === "live" ? " live" : "");
  $("halted").hidden = !s.halted;
  $("frozen").hidden = !s.frozen;
  deskState = s;
  const g = s.grok_bot ?? {};
  const fail = g.last_auth_failure && (!g.last_seen || g.last_auth_failure.ts > g.last_seen) ? g.last_auth_failure : null;
  $("grokstatus").textContent = g.last_seen ? `Grok Bot last connected ${ago(g.last_seen)}.` : "Grok Bot hasn't connected yet.";
  $("grokstatus").title = fail ? `Last rejected call ${ago(fail.ts)}: ${fail.reason}` : "";
  if (fail) $("grokstatus").textContent += ` Last rejected call ${ago(fail.ts)}: ${fail.reason}`;
  $("total").textContent = fmt(s.total_pusd);
  const pnl = s.total_pusd == null || !s.start_pusd ? null : s.total_pusd - s.start_pusd;
  $("pnl").textContent = pnl == null ? "–" : signed(pnl);
  $("pnl").className = cls(pnl);
  $("pnlpct").textContent = pnl == null ? "" : signed((pnl / s.start_pusd) * 100, 1) + "%" + (s.mode === "live" && s.start_pusd ? ` · ${fmt(s.start_pusd)} deposited in total` : "");
  $("winrate").textContent = s.stats.win_rate == null ? "–" : fmt(s.stats.win_rate * 100, 0) + "%";
  $("closed").textContent = `${s.stats.wins}/${s.stats.closed} trades`;
  $("bch").textContent = fmt(s.bch_pusd);
  const r = s.runner;
  $("runner").textContent = r
    ? `${r.name || "Cauldron Trader"} · ${r.cycle != null ? `cycle ${r.cycle}` : "no cycle yet"} ${r.state === "running" ? "running" : r.state === "complete" ? "done" : "waiting"} · ${r.next_run_at ? `next run ${utcClock(r.next_run_at)}` : "every 15 min"} · journal ${r.next_journal_at ? utcClock(r.next_journal_at) : "21:00 UTC"}`
    : "One Cauldron Trader runs every role, in order, every 15 minutes.";

  const status = Object.fromEntries(s.agents.map((a) => [a.agent, a]));
  $("agents").innerHTML = AGENTS.map(([id, role], i) => {
    const st = status[id];
    const last = events.find((e) => e.agent === id);
    const idle = st && /idle,\s*waiting/i.test(st.status);
    const text = !st ? "waiting for first cycle" : idle && last ? last.message : st.status;
    const when = st?.updated_at ? ago(st.updated_at) : "";
    return `<div class="agent" style="--c: var(--${id})">
      <b>0${i + 1} ${id.toUpperCase()}</b>
      <div class="role">${role}</div>
      <div class="status">${esc(text)}</div>
      <div class="when">${esc(when)}</div>
      <div class="last">${!idle && last ? esc(last.message) : ""}</div>
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

// A small line chart for any series: [{ts, <key>}].
function lineChart(el, pts, key, label, empty) {
  pts = pts.filter((p) => p[key] != null && isFinite(p[key]));
  if (pts.length < 2) {
    el.innerHTML = `<p class="empty">${empty}</p>`;
    return;
  }
  const W = el.clientWidth || 800, H = el.clientHeight || 220, P = 36;
  const xs = pts.map((p) => p.ts), ys = pts.map((p) => p[key]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-12) { y0 -= Math.abs(y0) * 0.01 || 1; y1 += Math.abs(y1) * 0.01 || 1; }
  const d = Math.abs(y1) < 0.01 ? 8 : Math.abs(y1) < 10 ? 4 : 2;
  const X = (t) => P + ((t - x0) / (x1 - x0 || 1)) * (W - P - 8);
  const Y = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (H - 32);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p[key]).toFixed(1)}`).join("");
  const color = ys[ys.length - 1] >= ys[0] ? "var(--up)" : "var(--down)";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <text x="4" y="${Y(y1) + 4}" fill="var(--muted)" font-size="11">${fmt(y1, d)}</text>
    <text x="4" y="${Y(y0) + 4}" fill="var(--muted)" font-size="11">${fmt(y0, d)}</text>
    <line x1="${P}" x2="${W - 8}" y1="${Y(y0)}" y2="${Y(y0)}" stroke="var(--line)"/>
    <path d="${line}L${X(x1)},${Y(y0)}L${X(x0)},${Y(y0)}Z" fill="${color}" opacity=".08"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="${P}" y="${H - 6}" fill="var(--muted)" font-size="11">${esc(label)} · ${new Date(x0).toLocaleString()}</text>
    <text x="${W - 8}" y="${H - 6}" fill="var(--muted)" font-size="11" text-anchor="end">${ago(x1)}</text>
  </svg>`;
}

async function loadChart() {
  lineChart($("chart"), await get(`/api/snapshots?days=${days}`), "total_pusd", "Portfolio value (PUSD)", "The chart fills in after a couple of cycles.");
}

// Team graph: the owner on top, each agent below the one it reports to.
async function loadTeam() {
  const t = await get("/api/team");
  const agents = t.agents ?? [];
  const sig = JSON.stringify(agents.map((a) => [a.id, a.reports_to, a.status]));
  if ($("teamgraph").dataset.sig === sig) return;
  $("teamgraph").dataset.sig = sig;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const owner = t.owner ?? "human";
  const depth = new Map([[owner, 0]]);
  const depthOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id) || !byId.has(id)) return 1;
    seen.add(id);
    const bosses = byId.get(id).reports_to ?? [];
    const d = 1 + (bosses.length ? Math.min(...bosses.map((b) => depthOf(b, seen))) : 0);
    depth.set(id, d);
    return d;
  };
  agents.forEach((a) => depthOf(a.id));
  const layers = [];
  for (const [id, d] of depth) (layers[d] ??= []).push(id);
  const W = 960, NW = 150, NH = 58, GAP = 34;
  const H = layers.length * (NH + GAP) + 10;
  const pos = new Map();
  layers.forEach((ids, d) => ids.forEach((id, i) => pos.set(id, { x: ((i + 0.5) * W) / ids.length, y: 10 + d * (NH + GAP) })));
  const edges = agents.flatMap((a) => (a.reports_to ?? []).filter((b) => pos.has(b)).map((b) => {
    const from = pos.get(a.id), to = pos.get(b);
    return `<path class="edge" marker-end="url(#arrow)" d="M${from.x},${from.y} C${from.x},${from.y - GAP} ${to.x},${to.y + NH + GAP} ${to.x},${to.y + NH + 2}"/>`;
  }));
  const node = (id) => {
    const p = pos.get(id), a = byId.get(id);
    const name = a ? a.name ?? id : "Owner";
    const sub = a ? a.role : "You: sets strategy";
    const st = a?.status ? a.status.slice(0, 26) : a ? "" : "";
    return `<g class="node" style="--c: var(--${esc(id)}, var(--accent))" transform="translate(${p.x - NW / 2},${p.y})">
      <title>${esc([name, sub, a?.status, a?.tools && "Tools: " + a.tools.join(", "), a?.horizons && "Horizons: " + a.horizons.join(", "), a?.veto ? "Has veto" : ""].filter(Boolean).join("\n"))}</title>
      <rect width="${NW}" height="${NH}" rx="8"/>
      <text class="name" x="10" y="18">${esc(name.toUpperCase())}${a?.veto ? " · veto" : ""}</text>
      <text class="sub" x="10" y="34">${esc(sub.slice(0, 24))}</text>
      <text class="sub" x="10" y="49">${esc(st)}</text>
    </g>`;
  };
  $("teamgraph").innerHTML = agents.length
    ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Team graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--muted)"/></marker></defs>${edges.join("")}${[...pos.keys()].map(node).join("")}</svg>`
    : `<p class="empty">No team file yet.</p>`;
  $("teamloop").textContent = t.loop?.length ? `Each cycle runs in this order: ${t.loop.join(" → ")}.` : "";
}

let mdays = 7;
let mtoken = null;
async function loadMarkets() {
  const rows = await get("/api/markets");
  if (!mtoken && rows.length) mtoken = (rows.find((r) => r.symbol !== "PUSD") ?? rows[0]).token_id;
  $("markets").innerHTML = rows.length
    ? `<table><tr><th>Token</th><th class="num">Price (PUSD)</th><th class="num">24h</th><th class="num">TVL (BCH)</th><th>Updated</th></tr>${rows
        .map((r) => `<tr class="pick${r.token_id === mtoken ? " on" : ""}" data-token="${esc(r.token_id)}" data-symbol="${esc(r.symbol)}"><td>${esc(r.symbol)}</td><td class="num">${fmt(r.price_pusd, r.price_pusd < 0.01 ? 8 : 4)}</td><td class="num ${cls(r.chg_24h_pct)}">${signed(r.chg_24h_pct, 1)}%</td><td class="num">${fmt(r.tvl_bch, 1)}</td><td>${ago(r.ts)}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">Market prices appear after the first cycle.</p>`;
  await loadMarketChart(rows.find((r) => r.token_id === mtoken)?.symbol);
}
async function loadMarketChart(symbol) {
  if (!mtoken) { $("mchart").innerHTML = ""; return; }
  lineChart($("mchart"), await get(`/api/ticks?token=${encodeURIComponent(mtoken)}&days=${mdays}`), "price_pusd", `${symbol ?? "Token"} price (PUSD)`, "Not enough price history for this token yet.");
}

async function loadClosedPositions() {
  const rows = (await get("/api/positions")).filter((p) => p.status !== "open").slice(0, 15);
  $("closedpos").innerHTML = rows.length
    ? `<table><tr><th>Token</th><th>Held</th><th class="num">Cost</th><th class="num">Exit</th><th class="num">P&amp;L</th><th>Why</th></tr>${rows
        .map((p) => {
          const pnl = (p.exit_pusd ?? 0) - p.cost_pusd;
          const held = p.closed_at ? Math.round((p.closed_at - p.opened_at) / 60000) : null;
          return `<tr title="${esc(p.thesis)}"><td>${esc(p.symbol)} <small class="hint">${esc(p.horizon)}</small></td><td>${held == null ? "–" : held < 120 ? held + "m" : Math.round(held / 60) + "h"}</td><td class="num">${fmt(p.cost_pusd)}</td><td class="num">${fmt(p.exit_pusd)}</td><td class="num ${cls(pnl)}">${signed(pnl)}</td><td>${esc(p.close_reason ?? "")}</td></tr>`;
        })
        .join("")}</table>`
    : `<p class="empty">No closed positions yet.</p>`;
}

async function loadScoreChart() {
  const rows = await get("/api/scorecards?days=90");
  lineChart($("scorechart"), rows.map((r) => ({ ts: r.ts, pnl: r.overall?.pnl_pusd })), "pnl", "30-day P&L (PUSD)", "Fills in as daily scorecards build up.");
}

let briefSig = "";
async function loadBriefing() {
  const b = await get("/api/briefing");
  const sig = b ? String(b.cycle) : "";
  if (sig === briefSig && briefSig) return;
  briefSig = sig;
  if (!b) { $("briefing").innerHTML = `<p class="empty">Grok Bot hasn't read a briefing since this view was added. It shows up after its next cycle.</p>`; return; }
  const parts = Object.entries(b).filter(([, v]) => v != null && typeof v === "object");
  const head = Object.entries(b).filter(([, v]) => v == null || typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(" · ");
  $("briefing").innerHTML = `<p class="hint">${esc(head)}</p>` + parts.map(([k, v]) => `<details><summary><code>${esc(k)}</code> <small class="hint">${Array.isArray(v) ? v.length + " items" : Object.keys(v).length + " fields"}</small></summary><pre>${esc(JSON.stringify(v, null, 2))}</pre></details>`).join("");
}

// All data: any dataset as a full table, every column.
const isTime = (k) => /(^ts$|_at$|^first_seen$|^last_seen$)/.test(k);
function cell(k, v) {
  if (v == null) return "";
  if (typeof v === "number" && isTime(k) && v > 1e12) return esc(new Date(v).toLocaleString());
  if (typeof v === "object") v = JSON.stringify(v);
  const t = String(v);
  return t.length > 80 ? `<details><summary>${esc(t.slice(0, 80))}…</summary>${esc(t)}</details>` : esc(t);
}
async function loadData() {
  let rows = await get($("dataset").value);
  if (rows && !Array.isArray(rows)) rows = rows.agents ?? [rows];
  rows = rows ?? [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  $("data").innerHTML = rows.length
    ? `<p class="hint">${rows.length} rows</p><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${cell(c, r[c])}</td>`).join("")}</tr>`).join("")}</table>`
    : `<p class="empty">No rows yet.</p>`;
}

async function loadTrades() {
  const t = await get("/api/trades");
  $("trades").innerHTML = t.length
    ? `<table><tr><th>When</th><th>Side</th><th>Token</th><th class="num">PUSD</th><th class="num">Impact</th></tr>${t
        .slice(0, 50)
        .map((r) => `<tr title="${esc(r.reason)}"><td>${new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td class="${r.side === "buy" || r.side === "lp-in" ? "up" : "down"}">${{ "lp-in": "ADD LIQ", "lp-out": "WITHDRAW", convert: "CONVERT" }[r.side] ?? r.side.toUpperCase()}${r.mode === "paper" ? " (paper)" : ""}${r.txid ? ` <a href="${explorer(r.txid)}" target="_blank" rel="noopener">tx</a>` : ""}</td><td>${esc(r.symbol)}</td><td class="num">${fmt(r.pusd)}</td><td class="num">${fmt(r.impact_pct)}%${r.estimated ? "*" : ""}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">No trades yet.</p>`;
}

async function loadJournal() {
  const [j, l, r] = await Promise.all([get("/api/journal"), get("/api/lessons"), get("/api/reviews")]);
  $("reviews").innerHTML = r.length
    ? `<h2 class="mt">Trade reviews</h2><table><tr><th>Trade</th><th>Process</th><th class="num">Outcome</th></tr>${r
        .slice(0, 8)
        .map((x) => `<tr title="${esc(x.finding)}"><td>${esc(x.symbol)} <small class="hint">${ago(x.ts)}</small></td><td><span class="chip ${x.process === "clean" ? "approved" : x.process === "major" ? "rejected" : "skipped"}">${esc(x.process)}</span></td><td class="num ${cls(x.outcome_pusd)}">${signed(x.outcome_pusd)}${x.outcome_r != null ? ` <small class="hint">${signed(x.outcome_r, 1)}R</small>` : ""}</td></tr>`)
        .join("")}</table>`
    : "";
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
        .map((f) => `<details class="call" data-path="${esc(f.path)}"${open.has(f.path) ? " open" : ""}><summary><code>${esc(f.path)}</code> <small class="hint">v${f.version} · ${esc(f.updated_by ?? "")} · ${ago(f.updated_at)} · ${fmt(f.bytes / 1024, 1)} KB</small></summary><pre class="body" data-load="${esc(f.path)}">Loading…</pre>${f.version > 1 ? `<button class="btn mt" data-hist="${esc(f.path)}">History</button><div class="hist"></div>` : ""}</details>`)
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
    d.querySelector("[data-hist]")?.addEventListener("click", async (e) => {
      const h = await get("/api/files/" + encodeURIComponent(d.dataset.path).replace(/%2F/g, "/") + "?history=1");
      e.target.nextElementSibling.innerHTML = h.map((x) => `<details><summary>Version ${x.version} · ${esc(x.updated_by ?? "")} · ${new Date(x.updated_at).toLocaleString()}</summary><pre>${esc(x.body)}</pre></details>`).join("") || `<p class="empty">No earlier versions.</p>`;
    });
    if (d.open) load();
  }
}

async function loadLiquidity() {
  const rows = await get("/api/liquidity");
  const open = rows.filter((x) => x.status === "open");
  const closed = rows.filter((x) => x.status !== "open").slice(0, 5);
  const row = (x) => {
    const value = x.status === "open" ? x.value_pusd : x.exit_pusd;
    const pnl = value - x.deposit_pusd;
    return `<tr title="${esc([x.thesis, x.close_reason].filter(Boolean).join("\n"))}"><td>${esc(x.symbol)} <small class="hint">${x.status === "open" ? ago(x.opened_at) : "closed"}</small></td><td class="num">${fmt(x.deposit_pusd)}</td><td class="num">${fmt(x.fees_pusd)}</td><td class="num ${cls(x.il_pct)}">${fmt(x.il_pct, 1)}%</td><td class="num ${cls(pnl)}">${signed(pnl)}</td></tr>`;
  };
  $("liquidity").innerHTML = rows.length
    ? `<table><tr><th>Pool</th><th class="num">Deposit</th><th class="num">Fees</th><th class="num">IL</th><th class="num">P&amp;L</th></tr>${[...open, ...closed].map(row).join("")}</table>`
    : `<p class="empty">No liquidity positions yet. The team adds liquidity to pools whose estimated fees beat impermanent loss and rug risk.</p>`;
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
  $("scorecard").innerHTML = table("Horizon", { all: c.overall, ...c.by_horizon }) + `<div class="mt"></div>` + table("Signal", c.by_signal) + (c.by_holding_time ? `<div class="mt"></div>` + table("Held for", c.by_holding_time) : "");
}

// Team knowledge: everything the bots read, with history. The owner can edit.
let kb = [];
let kbKey = "strategy";
let editing = false;
const token = {
  get: () => { try { return localStorage.getItem("desk-admin-token"); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem("desk-admin-token", v) : localStorage.removeItem("desk-admin-token"); } catch {} },
};
const GROUPS = [["strategy", "Owner"], ["limits", "Owner"], ["market", "Market"], ["rules", "Team"], ["skill", "Skills"], ["team", "Team"], ["role", "Roles"]];

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
  const r = await fetch("/api/admin/bot-token", { method: "POST", headers: { authorization: "Bearer " + token.get() } }).then((x) => x.json());
  if (!r.token) return alert(r.error || "Failed");
  const link = `${location.origin}/grok?key=${r.token}`;
  const text = `Read ${link} and set up the Cauldron trading team it describes. The access key is in the link. Run the trading cycle every 15 minutes and the journal every day at 21:00 UTC.`;
  // A real dialog with a copy button: iOS prompt() boxes make it easy to copy only part of the text.
  const box = document.createElement("div");
  box.className = "token-box";
  box.innerHTML = `<div class="panel"><h2>Connect Grok Bot</h2><p>Paste this into Grok Bot. The key is in the link, so there is nothing else to set up. It stays the same across deploys.</p><textarea readonly rows="6"></textarea><div class="row"><button class="btn primary" data-act="copy">Copy</button><button class="btn" data-act="rotate">Make a new key</button><button class="btn" data-act="close">Close</button></div></div>`;
  box.querySelector("textarea").value = text;
  box.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (act === "copy") {
      await navigator.clipboard.writeText(text).catch(() => box.querySelector("textarea").select());
      e.target.textContent = "Copied";
    }
    if (act === "rotate" && confirm("Make a new key? Grok Bot will need the new link.")) {
      box.remove();
      await fetch("/api/admin/bot-token", { method: "POST", headers: { authorization: "Bearer " + token.get(), "content-type": "application/json" }, body: '{"rotate":true}' });
      $("bottoken").click();
    }
    if (act === "close") box.remove();
  });
  document.body.append(box);
});

// Nordic Crypto's explorer; its search opens the transaction or address it finds.
const explorer = (q) => `https://explorer.nordiccrypto.no/search/?q=${encodeURIComponent(q)}&chain=bch`;

// Live wallet: address and balances for everyone; the switches for the owner only.
let deskState = null;
async function loadWallet() {
  const w = await get("/api/wallet");
  const el = $("wallet");
  if (!w.has_secret) {
    el.innerHTML = "No wallet yet. The owner adds the wallet's seed phrase as the <code>WALLET_SEED</code> GitHub secret and redeploys.";
  } else if (!w.address) {
    el.textContent = `Wallet secret can't be read: ${w.error ?? "unknown error"}`;
  } else {
    const bal = w.error ? `Balance unavailable: ${esc(w.error)}` : `<strong>${fmt(w.pusd)}</strong> PUSD · <strong>${fmt(w.bch_sats / 1e8, 5)}</strong> BCH${w.tokens?.length ? ` · ${w.tokens.length} other token${w.tokens.length > 1 ? "s" : ""}` : ""}`;
    el.innerHTML = `<p>${w.mode === "live" ? `<span class="badge live">LIVE</span> since ${new Date(w.live_since).toLocaleString()}` : `<span class="badge">NOT LIVE</span> The desk is paper trading; this wallet is untouched until the owner presses Go live.`}${w.frozen ? ' <span class="badge danger">FROZEN</span>' : ""}</p>
      <p>Address: <a href="${explorer(w.address)}" target="_blank" rel="noopener"><code>${esc(w.address)}</code></a><br><small>Token-aware: <code>${esc(w.token_address)}</code>. Send PUSD and a little BCH (for fees) here. Check it matches your own wallet app first.</small></p>
      <p>${bal}</p>`;
  }
  const ctl = $("walletctl");
  ctl.hidden = !token.get();
  const live = w.mode === "live";
  ctl.querySelector('[data-act="live"]').hidden = live || !w.address;
  ctl.querySelector('[data-act="paper"]').hidden = !live;
  // Only worth a swap when there is spare BCH above the fee reserve (0.002 BCH) plus 0.001 BCH.
  ctl.querySelector('[data-act="convert"]').hidden = !live || !(w.bch_sats > 300_000);
  ctl.querySelector('[data-act="halt"]').textContent = deskState?.halted ? "Resume buys" : "Halt buys";
  ctl.querySelector('[data-act="freeze"]').textContent = w.frozen ? "Unfreeze wallet" : "Freeze wallet";
}
$("walletctl").addEventListener("click", async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const post = (path, body) => fetch(path, { method: "POST", headers: { authorization: "Bearer " + token.get(), "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }), (e) => ({ ok: false, error: `Could not reach the desk: ${e.message}` }));
  let r;
  if (act === "halt") r = await post("/api/admin/halt", { halted: !deskState?.halted });
  if (act === "freeze") {
    const frozen = $("frozen").hidden;
    if (frozen && !confirm("Freeze the wallet? No on-chain transactions at all, not even stop-loss sells, until you unfreeze.")) return;
    r = await post("/api/admin/freeze", { frozen });
  }
  if (act === "live") {
    const typed = prompt("This switches the desk to REAL MONEY. First all BCH above a small fee reserve is swapped to PUSD, then the paper book is archived and the bots trade the wallet's funds within the live limits. Type GO LIVE to confirm.");
    if (typed === null) return;
    // Phone keyboards capitalise and add spaces; accept any case, but say so when it doesn't match.
    if (typed.trim().toUpperCase() !== "GO LIVE") return alert(`Not switched: you typed "${typed}". Type GO LIVE to confirm.`);
    const btn = e.target.closest("button");
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Converting BCH to PUSD…"; }
    r = await post("/api/admin/live", { confirm: "GO LIVE" });
    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (r.ok) alert(r.converted ? `Live. Converted ${r.converted.bch} BCH to ${r.converted.pusd} PUSD (tx ${r.converted.txid}).` : "Live.");
  }
  if (act === "convert") {
    if (!confirm("Swap all BCH above the fee reserve to PUSD now? This is a real on-chain trade.")) return;
    const btn = e.target.closest("button");
    btn.disabled = true; btn.textContent = "Converting…";
    const before = (await fetch("/api/wallet").then((x) => x.json()).catch(() => ({}))).bch_sats;
    r = await post("/api/admin/convert");
    if (!r.ok && /Could not reach/.test(r.error || "")) {
      // Phones drop long requests; the swap may still have gone through. Look at the wallet before calling it failed.
      btn.textContent = "Checking the wallet…";
      await new Promise((ok) => setTimeout(ok, 8000));
      const after = (await fetch("/api/wallet").then((x) => x.json()).catch(() => ({}))).bch_sats;
      if (before && after && after < before / 2) r = { ok: true, converted: null, landed: true };
      else r.error += ". The swap may still be running: wait a minute and reload before pressing again.";
    }
    btn.disabled = false; btn.textContent = "Convert BCH to PUSD";
    if (r.landed) alert("Converted: the BCH is now PUSD (the answer was slow to reach your phone). See the trade log for the transaction.");
    else if (r.ok) alert(r.converted ? `Converted ${r.converted.bch} BCH to ${r.converted.pusd} PUSD (tx ${r.converted.txid}).` : "Nothing to convert: no BCH above the fee reserve.");
  }
  if (act === "paper") {
    if (!confirm("Switch back to paper trading? Only possible with no live positions open. The wallet keeps its funds.")) return;
    r = await post("/api/admin/paper");
  }
  if (r && !r.ok) alert(r.error || "Failed");
  await loadState();
  await loadWallet();
});
$("owner").addEventListener("click", () => setTimeout(loadWallet, 1500));

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
$("dataset").addEventListener("change", loadData);
$("markets").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-token]");
  if (!tr) return;
  mtoken = tr.dataset.token;
  document.querySelectorAll("#markets tr").forEach((x) => x.classList.toggle("on", x === tr));
  loadMarketChart(tr.dataset.symbol);
});
$("mrange").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  mdays = Number(b.dataset.days);
  document.querySelectorAll("#mrange button").forEach((x) => x.classList.toggle("on", x === b));
  loadMarketChart(document.querySelector("#markets tr.on")?.dataset.symbol);
});
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
    await Promise.all([loadState(), loadChart(), loadTrades(), loadJournal(), loadProposals(), loadLiquidity(), loadResearch(), loadSentiment(), loadFiles(), loadScorecard(), loadKnowledge(), loadCalls(), loadTeam(), loadMarkets(), loadClosedPositions(), loadScoreChart(), loadBriefing()]);
  } catch (err) {
    console.error(err);
  }
}
refresh();
loadData();
setInterval(refresh, 15000);
// The wallet is read from the chain on each request, so poll it less often.
loadWallet().catch(() => {});
setInterval(() => loadWallet().catch(() => {}), 60000);
