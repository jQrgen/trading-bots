import { PUSD, type Env, type Horizon, type RiskLimits } from "./config";
import { activePools, configureEndpoints, candles, symbolOf, topTokens, tokensByIds, type TokenInfo } from "./cauldron";
import { askAgent, hasGrok } from "./grok";
import { loadRiskLimits, seedKnowledge } from "./knowledge";
import { Ledger, type Position } from "./ledger";
import { Prices, simulateSwap } from "./market";
import { scorecard, sizeScale } from "./scorecard";
import { checkBuy, exitSignal, type Book, type Proposal, type TokenFacts } from "./risk";

interface Signal { token_id: string; symbol: string; signal: string; why: string }

const HORIZONS: Horizon[] = ["short", "medium", "long"];
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export async function runCycle(env: Env): Promise<void> {
  // One cycle at a time: a slow cycle must not overlap the next cron tick.
  const now = Date.now();
  const lock = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'lock' AND CAST(value AS INTEGER) < ?").bind(String(now), now - 10 * 60 * 1000).run();
  if (!lock.meta.changes) {
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lock', ?)").bind(String(now)).run();
    if (!inserted.meta.changes) return;
  }
  try {
    await runCycleLocked(env);
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'lock'").run();
  }
}

async function runCycleLocked(env: Env): Promise<void> {
  const cycle = Number((await env.DB.prepare("SELECT COALESCE(MAX(cycle), 0) + 1 AS c FROM events").first<{ c: number }>())?.c ?? 1);
  const L = new Ledger(env, cycle);
  configureEndpoints(env);
  try {
    await cycleBody(env, L);
  } catch (err) {
    await L.log("desk", "error", `Cycle ${cycle} failed: ${(err as Error).message}`);
  } finally {
    for (const a of ["nova", "orin", "vela", "kade", "rune", "zara"] as const) await L.status(a, "idle, next cycle in 15 min");
  }
}

async function cycleBody(env: Env, L: Ledger) {
  await ensureWallet(env, L);
  const seeded = await seedKnowledge(env);
  if (seeded.length) await L.log("desk", "knowledge", `Knowledge base seeded with defaults: ${seeded.join(", ")}.`, { seeded });
  const RISK = await loadRiskLimits(env);
  const halted = (await L.setting("halted")) === "1";

  // Market data
  await L.status("orin", "scanning Cauldron");
  const list = await topTokens(150);
  let held = await L.openPositions();
  const missing = held.map((p) => p.token_id).filter((id) => id !== "bch" && !list.some((t) => t.token_id === id));
  const tokens = new Map<string, TokenInfo>([...list, ...(await tokensByIds([PUSD, ...missing]))].map((t) => [t.token_id, t]));
  const prices = new Prices(tokens);

  // Rune: stops and targets first, always (even when halted, exits reduce risk).
  await L.status("rune", "checking stops and targets");
  for (const p of held) {
    const now = prices.tokenPusd(p.token_id);
    const reason = now === null ? null : exitSignal(p.entry_price_pusd, now, p.target_pct, p.stop_pct);
    if (reason) await closePosition(L, prices, p, reason === "stop" ? "stop hit" : "target hit");
  }
  held = await L.openPositions();

  const book = await bookOf(L, prices);
  await L.snapshot(book.total, prices.bchPusd);
  const dayAgo = await L.valueAt(24 * 3600 * 1000);
  const dayChangePct = dayAgo ? ((book.total - dayAgo) / dayAgo) * 100 : 0;
  if (dayChangePct <= -RISK.dailyLossHaltPct) await L.log("kade", "risk", `Portfolio down ${dayChangePct.toFixed(1)}% in 24h. New buys paused.`);

  // Orin: scan. Liquidity trend matters more than price on Cauldron: growing pools mean real interest.
  const tvlDayAgo = await L.tvlAt(24 * 3600 * 1000);
  const card = scorecard(await L.closedSince(30 * 86400 * 1000), 30);
  await env.DB.prepare("INSERT OR REPLACE INTO scorecards (ts, window_days, data) VALUES (?, ?, ?)").bind(Math.floor(Date.now() / 3600000) * 3600000, 30, JSON.stringify(card)).run();
  const digest = list
    .filter((t) => t.tvl_sats >= 2e8 && t.token_id !== PUSD)
    .map((t) => ({
      token_id: t.token_id,
      symbol: symbolOf(t),
      price_usd: t.price_now_usd,
      chg_24h_pct: (t.change_24h_bp ?? 0) / 100,
      chg_7d_pct: (t.change_7d_bp ?? 0) / 100,
      tvl_bch: round(t.tvl_sats / 1e8, 1),
      tvl_chg_24h_pct: tvlDayAgo.get(t.token_id) ? round(((t.tvl_sats / 1e8 - tvlDayAgo.get(t.token_id)!) / tvlDayAgo.get(t.token_id)!) * 100, 1) : null,
      age_days: t.first_pool_ts ? round((Date.now() / 1000 - t.first_pool_ts) / 86400, 1) : null,
      rank: t.score_rank,
    }));
  await L.recordTicks(list.slice(0, 60).map((t) => ({ token_id: t.token_id, symbol: symbolOf(t), price_pusd: prices.tokenPusd(t.token_id), tvl_bch: t.tvl_sats / 1e8, chg_24h_pct: (t.change_24h_bp ?? 0) / 100, volume_sats: t.trade_volume ?? null })));
  let signals: Signal[];
  if (hasGrok(env)) {
    const r = await askAgent<{ signals: Signal[]; note: string }>(env, "orin", "Scan this market digest.", { bch_usd: round(prices.bchPusd), signal_scorecard: card.by_signal, tokens: digest }, { cycle: L.cycle });
    signals = (r.signals ?? []).filter((s) => tokens.has(s.token_id)).slice(0, 5);
    await L.log("orin", "scan", r.note || `Scanned ${digest.length} tokens.`, { signals });
  } else {
    signals = digest
      .filter((t) => t.chg_24h_pct > 5 && t.chg_24h_pct < 50 && t.tvl_bch >= 5 && (t.tvl_chg_24h_pct ?? 0) >= 0)
      .sort((a, b) => b.chg_24h_pct - a.chg_24h_pct)
      .slice(0, 3)
      .map((t) => ({ token_id: t.token_id, symbol: t.symbol, signal: "momentum", why: `Up ${t.chg_24h_pct}% in 24h with ${t.tvl_bch} BCH liquidity${t.tvl_chg_24h_pct ? ` (${t.tvl_chg_24h_pct}% liquidity change)` : ""}.` }));
    await L.log("orin", "scan", `Scanned ${digest.length} tokens with liquidity, ${signals.length} momentum signals (rule-based, no Grok key).`, { signals });
  }
  for (const s of signals) await L.log("orin", "signal", `${s.symbol}: ${s.signal}. ${s.why}`, s);

  // Vela: research the signals and held positions
  await L.status("vela", `researching ${signals.length} signals`);
  const facts = new Map<string, TokenFacts>();
  const research = [];
  for (const s of signals) {
    const f = await tokenFacts(s.token_id, tokens.get(s.token_id)!);
    facts.set(s.token_id, f);
    await L.log("kade", "rug-check", rugLine(s.symbol, f, RISK), f);
    const c = await candles(s.token_id, 7, 4 * 3600).catch(() => []);
    research.push({ ...s, facts: f, closes_4h_pusd: c.map((x) => round((x.close / 1e8) * 10 ** prices.decimals(s.token_id) * prices.bchPusd, 6)) });
  }
  const portfolio = { total_pusd: round(book.total), by_horizon_pusd: book.byHorizon, positions: held.filter((p) => p.status === "open").map((p) => ({ token_id: p.token_id, symbol: p.symbol, horizon: p.horizon, cost_pusd: round(p.cost_pusd), value_pusd: round(prices.value(p.token_id, p.amount)), thesis: p.thesis })) };

  const lastDeploy = await L.setting("last_deploy");
  const repoUpdate = lastDeploy && JSON.parse(lastDeploy).ts > Date.now() - 24 * 3600 * 1000 ? JSON.parse(lastDeploy) : null;
  const lessons = (await env.DB.prepare("SELECT lesson FROM lessons WHERE status = 'active' ORDER BY ts DESC LIMIT 10").all<{ lesson: string }>()).results.map((r) => r.lesson);
  let proposals: Proposal[] = [];
  if (hasGrok(env) && (research.length || portfolio.positions.length)) {
    const r = await askAgent<{ proposals: Omit<Proposal, "id">[]; note: string }>(env, "vela", "Write trade proposals.", { research, portfolio, scorecard: card, lessons, bch_usd: round(prices.bchPusd) }, { search: true, cycle: L.cycle });
    proposals = (r.proposals ?? []).map((p, i) => ({ ...p, id: `c${L.cycle}-p${i + 1}` }));
    if (r.note) await L.log("vela", "note", r.note);
  } else if (!hasGrok(env)) {
    proposals = signals.slice(0, 2).map((s) => ({ id: `c${L.cycle}-p${s.symbol}`, action: "buy", token_id: s.token_id, symbol: s.symbol, horizon: "short", size_pct: 2, target_pct: 25, stop_pct: 12, thesis: `Rule-based momentum entry: ${s.why}` }));
  }
  for (const p of proposals) p.signal ??= signals.find((s) => s.token_id === p.token_id)?.signal ?? (held.some((h) => h.token_id === p.token_id) ? "exit-review" : "vela");
  for (const p of proposals) {
    const cases = p.bull_case ? ` Bull: ${p.bull_case} Bear: ${p.bear_case}` : "";
    await L.log("vela", "proposal", `${p.action.toUpperCase()} ${p.symbol} (${p.horizon}, ${p.size_pct}%): ${p.thesis}${cases}`, p);
    await L.saveProposal(p, "vela");
  }
  if (!proposals.length) {
    await L.log("nova", "decision", "No proposals this cycle. Holding.");
    await saveMarks(L, prices);
    return;
  }

  // Kade: deterministic risk engine, then Grok may veto
  await L.status("kade", `risk-checking ${proposals.length} proposals`);
  const verdicts = new Map<string, { pass: boolean; allowed: number; reasons: string[] }>();
  for (const p of proposals) {
    if (p.action === "sell") {
      const has = held.some((h) => h.token_id === p.token_id);
      verdicts.set(p.id, { pass: has, allowed: 0, reasons: has ? [] : ["no position to sell"] });
      continue;
    }
    if (p.token_id === PUSD) { verdicts.set(p.id, { pass: false, allowed: 0, reasons: ["PUSD is the home asset"] }); continue; }
    if (!facts.has(p.token_id) && tokens.has(p.token_id)) facts.set(p.token_id, await tokenFacts(p.token_id, tokens.get(p.token_id)!));
    const heldPusd = held.filter((h) => h.token_id === p.token_id).reduce((s, h) => s + prices.value(h.token_id, h.amount), 0);
    const b: Book = { totalPusd: book.total, byHorizonPusd: book.byHorizon, heldPusd, openShort: held.filter((h) => h.horizon === "short").length, dayChangePct, bchPusd: prices.bchPusd };
    const scale = sizeScale(card, p.horizon);
    if (scale < 1) await L.log("kade", "risk", `${p.horizon} trades are losing lately; ${p.symbol} size scaled to ${scale * 100}%.`);
    const v = checkBuy({ ...p, size_pct: p.size_pct * scale }, p.token_id === "bch" ? BCH_FACTS : facts.get(p.token_id), b, halted, RISK);
    verdicts.set(p.id, { pass: v.pass, allowed: v.allowedPusd, reasons: v.reasons });
  }
  if (hasGrok(env)) {
    const passed = proposals.filter((p) => verdicts.get(p.id)!.pass);
    if (passed.length) {
      const r = await askAgent<{ verdicts: { proposal_id: string; veto: boolean; comment: string }[] }>(env, "kade", "Review these proposals the risk engine passed.", { proposals: passed.map((p) => ({ ...p, engine: verdicts.get(p.id), facts: facts.get(p.token_id) })) }, { cycle: L.cycle });
      for (const v of r.verdicts ?? []) {
        const cur = verdicts.get(v.proposal_id);
        if (!cur) continue;
        if (v.veto) { cur.pass = false; cur.reasons.push(`Kade veto: ${v.comment}`); }
        else if (v.comment) cur.reasons.push(v.comment);
      }
    }
  }
  for (const p of proposals) {
    const v = verdicts.get(p.id)!;
    const size = p.action === "buy" && v.pass ? ` Allowed ${round(v.allowed)} PUSD.` : "";
    await L.log("kade", v.pass ? "risk-pass" : "risk-fail", `${p.symbol}: ${v.pass ? "PASS" : "FAIL"}.${size} ${v.reasons.join("; ")}`.trim(), { proposal: p.id, ...v });
    const vetoed = v.reasons.some((r) => r.startsWith("Kade veto"));
    await L.updateProposal(p.id, { status: v.pass ? "risk_passed" : vetoed ? "vetoed" : "risk_failed", allowed_pusd: v.allowed, risk_notes: v.reasons.join("; ") });
  }

  // Nova: approve
  await L.status("nova", "deciding");
  const candidates = proposals.filter((p) => verdicts.get(p.id)!.pass);
  let approved: Proposal[] = [];
  if (candidates.length && hasGrok(env)) {
    const r = await askAgent<{ decisions: { proposal_id: string; approve: boolean; reason: string }[]; note: string }>(env, "nova", "Approve or reject these risk-checked proposals.", { portfolio, scorecard: card, lessons, recent_repo_update: repoUpdate, proposals: candidates.map((p) => ({ ...p, allowed_pusd: round(verdicts.get(p.id)!.allowed) })) }, { cycle: L.cycle });
    for (const d of r.decisions ?? []) {
      const p = candidates.find((c) => c.id === d.proposal_id);
      if (!p) continue;
      await L.log("nova", "decision", `${d.approve ? "Approved" : "Rejected"} ${p.action} ${p.symbol}: ${d.reason}`, d);
      await L.updateProposal(p.id, { status: d.approve ? "approved" : "rejected", decision_note: d.reason });
      if (d.approve) approved.push(p);
    }
    if (r.note) await L.log("nova", "note", r.note);
  } else {
    approved = candidates;
    for (const p of approved) {
      await L.log("nova", "decision", `Approved ${p.action} ${p.symbol} (rule-based).`);
      await L.updateProposal(p.id, { status: "approved", decision_note: "rule-based" });
    }
  }
  if (halted) {
    for (const p of approved.filter((x) => x.action !== "sell")) await L.updateProposal(p.id, { status: "rejected", decision_note: "desk halted by owner" });
    approved = approved.filter((p) => p.action === "sell");
    await L.log("nova", "decision", "Desk is halted by the owner: only sells go through.");
  }

  // Rune: execute (paper)
  for (const p of approved.slice(RISK.maxTradesPerCycle)) await L.updateProposal(p.id, { status: "skipped", decision_note: "over the per-cycle trade limit" });
  for (const p of approved.slice(0, RISK.maxTradesPerCycle)) {
    await L.status("rune", `executing ${p.action} ${p.symbol}`);
    if (p.action === "sell") {
      for (const h of held.filter((x) => x.token_id === p.token_id)) await closePosition(L, prices, h, `Vela exit: ${p.thesis}`);
      await L.updateProposal(p.id, { status: "filled" });
    } else {
      const positionId = await openPosition(L, prices, p, verdicts.get(p.id)!.allowed, RISK);
      await L.updateProposal(p.id, positionId ? { status: "filled", position_id: positionId } : { status: "skipped", decision_note: "price impact too high at execution" });
    }
  }
  await saveMarks(L, prices);
}

/** Store current marks so the website can value positions without calling the indexer. */
async function saveMarks(L: Ledger, prices: Prices) {
  const after = await bookOf(L, prices);
  await L.snapshot(after.total, prices.bchPusd);
  const marks: Record<string, number> = { bch: prices.bchPusd };
  for (const h of await L.holdings()) {
    const p = prices.tokenPusd(h.asset);
    if (p !== null && h.asset !== "pusd") marks[h.asset] = p;
  }
  await L.setSetting("marks", JSON.stringify({ ts: Date.now(), bch_pusd: prices.bchPusd, prices: marks, decimals: Object.fromEntries(Object.keys(marks).map((k) => [k, prices.decimals(k)])) }));
}

const BCH_FACTS: TokenFacts = { tvlBch: 1e6, poolAgeHours: 1e6, topOwnerSharePct: 0, canQuote: true };

async function tokenFacts(id: string, t: TokenInfo): Promise<TokenFacts> {
  const pools = await activePools(id).catch(() => []);
  const byOwner = new Map<string, number>();
  for (const p of pools) {
    const k = p.owner_pkh ?? p.pkh ?? "?";
    byOwner.set(k, (byOwner.get(k) ?? 0) + Number(p.sats));
  }
  const total = [...byOwner.values()].reduce((a, b) => a + b, 0);
  const top = total ? (Math.max(...byOwner.values()) / total) * 100 : 100;
  return {
    tvlBch: t.tvl_sats / 1e8,
    poolAgeHours: t.first_pool_ts ? (Date.now() / 1000 - t.first_pool_ts) / 3600 : 0,
    topOwnerSharePct: round(top, 1),
    canQuote: pools.length > 0,
  };
}

function rugLine(symbol: string, f: TokenFacts, RISK: RiskLimits) {
  const flags = [];
  if (f.topOwnerSharePct > RISK.maxOwnerSharePct) flags.push(`one LP holds ${f.topOwnerSharePct}% of liquidity`);
  if (f.poolAgeHours < 24) flags.push(`pool only ${f.poolAgeHours.toFixed(0)}h old`);
  if (f.tvlBch < 5) flags.push(`thin liquidity ${f.tvlBch.toFixed(1)} BCH`);
  return `Rug check ${symbol}: ${flags.length ? "flags: " + flags.join(", ") : "no red flags"} (TVL ${f.tvlBch.toFixed(1)} BCH, top LP ${f.topOwnerSharePct}%, age ${(f.poolAgeHours / 24).toFixed(1)}d).`;
}

async function openPosition(L: Ledger, prices: Prices, p: Proposal, sizePusd: number, RISK: RiskLimits): Promise<number | null> {
  const pusdUnits = Math.floor(sizePusd * 100);
  const fill = await simulateSwap(PUSD, p.token_id, pusdUnits, prices);
  if (fill.impactPct > RISK.maxPriceImpactPct || fill.amountOut <= 0) {
    await L.log("rune", "skip", `Skipped buy ${p.symbol}: price impact ${fill.impactPct.toFixed(2)}% over ${RISK.maxPriceImpactPct}% limit.`, fill);
    return null;
  }
  const symbol = p.token_id === "bch" ? "BCH" : p.symbol;
  await L.adjust("pusd", "PUSD", -pusdUnits);
  await L.adjust(p.token_id, symbol, fill.amountOut);
  const whole = fill.amountOut / 10 ** prices.decimals(p.token_id);
  const positionId = await L.openPosition({
    token_id: p.token_id, symbol, horizon: p.horizon, amount: fill.amountOut, cost_pusd: sizePusd,
    entry_price_pusd: sizePusd / whole, target_pct: p.target_pct, stop_pct: p.stop_pct, signal: p.signal ?? null, thesis: p.thesis,
  });
  await L.recordTrade({ side: "buy", token_id: p.token_id, symbol, amount: fill.amountOut, pusd: sizePusd, price_pusd: sizePusd / whole, impact_pct: fill.impactPct, estimated: fill.estimated, position_id: positionId, reason: p.thesis });
  await L.log("rune", "fill", `PAPER BUY ${round(whole, 4)} ${symbol} for ${round(sizePusd)} PUSD (impact ${fill.impactPct.toFixed(2)}%${fill.estimated ? ", estimated" : ""}). Target +${p.target_pct}%, stop -${p.stop_pct}%.`, fill);
  return positionId;
}

async function closePosition(L: Ledger, prices: Prices, pos: Position, reason: string) {
  const fill = await simulateSwap(pos.token_id, PUSD, pos.amount, prices);
  const outPusd = fill.amountOut / 100;
  await L.adjust(pos.token_id, pos.symbol, -pos.amount);
  await L.adjust("pusd", "PUSD", fill.amountOut);
  await L.closePosition(pos.id, outPusd, reason);
  const pnl = outPusd - pos.cost_pusd;
  const whole = pos.amount / 10 ** prices.decimals(pos.token_id);
  await L.recordTrade({ side: "sell", token_id: pos.token_id, symbol: pos.symbol, amount: pos.amount, pusd: outPusd, price_pusd: whole ? outPusd / whole : 0, impact_pct: fill.impactPct, estimated: fill.estimated, position_id: pos.id, reason });
  await L.log("rune", "fill", `PAPER SELL ${pos.symbol} for ${round(outPusd)} PUSD, ${pnl >= 0 ? "+" : ""}${round(pnl)} PUSD (${round((pnl / pos.cost_pusd) * 100, 1)}%). ${reason}.`, { ...fill, pnl });
}

async function bookOf(L: Ledger, prices: Prices) {
  const holdings = await L.holdings();
  const positions = await L.openPositions();
  let total = 0;
  for (const h of holdings) total += h.asset === "pusd" ? h.amount / 100 : prices.value(h.asset, h.amount);
  const byHorizon = Object.fromEntries(HORIZONS.map((h) => [h, 0])) as Record<Horizon, number>;
  for (const p of positions) byHorizon[p.horizon] += prices.value(p.token_id, p.amount);
  return { total, byHorizon };
}

async function ensureWallet(env: Env, L: Ledger) {
  if ((await L.setting("initialized")) === "1") return;
  const start = Number(env.PAPER_START_PUSD) || 1000;
  await L.adjust("pusd", "PUSD", start * 100);
  await L.setSetting("initialized", "1");
  await L.log("desk", "start", `Paper wallet opened with ${start} PUSD. Mode: ${env.MODE.toUpperCase()}.`);
}

/** Zara's daily journal. Runs once a day from the cron. */
export async function runJournal(env: Env): Promise<void> {
  configureEndpoints(env);
  const L = new Ledger(env, 0);
  const since = Date.now() - 24 * 3600 * 1000;
  const last = await env.DB.prepare("SELECT MAX(ts) AS ts FROM journal").first<{ ts: number | null }>();
  if (last?.ts && last.ts > Date.now() - 20 * 3600 * 1000) return;
  const closed = (await env.DB.prepare("SELECT symbol, horizon, cost_pusd, exit_pusd, close_reason FROM positions WHERE status = 'closed' AND closed_at >= ?").bind(since).all()).results;
  const vetoes = (await env.DB.prepare("SELECT message FROM events WHERE kind = 'risk-fail' AND ts >= ?").bind(since).all()).results;
  const card = scorecard(await L.closedSince(30 * 86400 * 1000), 30);
  const stats = { closed, scorecard_30d: card, vetoes: vetoes.length, value_now: await L.valueAt(0), value_24h_ago: await L.valueAt(24 * 3600 * 1000) };
  await L.status("zara", "writing the daily journal");
  let text: string;
  let lessons: string[] = [];
  if (hasGrok(env)) {
    const r = await askAgent<{ journal: string; lessons: string[]; strategy_suggestion?: string }>(env, "zara", "Write today's journal.", { ...stats, strategy: "see STRATEGY in your instructions" });
    text = r.journal;
    lessons = r.lessons ?? [];
    if (r.strategy_suggestion) await L.log("zara", "suggestion", `Suggested strategy change for the owner: ${r.strategy_suggestion}`);
  } else {
    const wins = closed.filter((c) => Number(c.exit_pusd) > Number(c.cost_pusd)).length;
    text = `${closed.length} positions closed in 24h, ${wins} winners. ${vetoes.length} proposals failed risk checks. Portfolio ${round(stats.value_now ?? 0)} PUSD.`;
  }
  await env.DB.prepare("INSERT INTO journal (ts, text, lessons) VALUES (?, ?, ?)").bind(Date.now(), text, JSON.stringify(lessons)).run();
  for (const lesson of lessons) await env.DB.prepare("INSERT INTO lessons (ts, lesson) VALUES (?, ?)").bind(Date.now(), lesson).run();
  await L.log("zara", "journal", text, { lessons });
  await L.status("zara", "idle");
}
