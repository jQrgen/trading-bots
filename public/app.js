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
    await Promise.all([loadState(), loadChart(), loadTrades(), loadJournal()]);
  } catch (err) {
    console.error(err);
  }
}
refresh();
setInterval(refresh, 15000);
