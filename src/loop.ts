import { ROUND_TRIP_FEE_PCT, PUSD, type Env, type Horizon, type RiskLimits } from "./config";
import { activePools, configureEndpoints, candles, launchpadList, symbolOf, topTokens, tokensByIds, type TokenInfo } from "./cauldron";
import { askAgent, hasGrok } from "./grok";
import { loadKnowledge, loadRiskLimits, seedKnowledge } from "./knowledge";
import { Ledger, type Position } from "./ledger";
import { Prices, simulateSwap } from "./market";
import { scorecard, sizeScale, type Scorecard } from "./scorecard";
import { checkBuy, checkProvide, exitSignal, singleLpOver, stopSellAmount, type Book, type Proposal, type TokenFacts } from "./risk";
import { feeAprPct, lpCandidates, lpValue, openLps, provide, tendLps, withdraw } from "./lp";
import { publishRoleStatus, refreshRoles } from "./roles";
import { coinsFor, explorerTx, livePools, liveRoom, liveSpentPusd, liveSwap, loadWallet, syncHoldings, balancesOf } from "./live";
import { quotePools } from "./chain/pools";

/*
 * A trading cycle has two halves:
 *  - Mechanical (code only): market data, stops and targets, snapshots. The Worker cron always does this.
 *  - Judgement (the six agents): signals, proposals, vetoes, approvals, journal. This is the "brain".
 *
 * The brain is chosen with the BRAIN variable:
 *  - "grok-bot" (default): Grok Bot runs the agents and talks to the desk through /api/bot/* (src/bot.ts).
 *  - "xai-api": the Worker calls Grok through the xAI API on each cron tick (needs XAI_API_KEY).
 *  - "rules": simple rule-based agents, for testing without any Grok.
 * Whatever the brain, the risk engine and execution below are the same deterministic code.
 */

export interface Signal { token_id: string; symbol: string; signal: string; why: string }
export interface Verdict { proposal_id: string; veto: boolean; comment?: string }
export interface Decision { proposal_id: string; approve: boolean; reason?: string }

const HORIZONS: Horizon[] = ["short", "medium", "long"];
export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const brainOf = (env: Env) => (env.BRAIN === "xai-api" && hasGrok(env) ? "xai-api" : env.BRAIN === "rules" ? "rules" : "grok-bot");

/** Cron entry point: mechanical half always, judgement half when the Worker is the brain. */
export async function runCycle(env: Env): Promise<void> {
  await withLock(env, async () => {
    const L = await newCycle(env);
    try {
      let ctx: Ctx;
      try {
        ctx = await mechanical(env, L);
        await markSighted(env, L);
      } catch (err) {
        await markBlind(env, L, (err as Error).message);
        return;
      }
      const brain = brainOf(env);
      if (brain === "xai-api") await xaiBrain(env, L, ctx);
      else if (brain === "rules") await rulesBrain(env, L, ctx);
    } catch (err) {
      await L.log("desk", "error", `Cycle ${L.cycle} failed: ${(err as Error).message}`);
    } finally {
      await refreshRoles(env);
    }
  });
}

/**
 * "Unavailable" is a verdict of its own (lesson from HyperGrok): when market data can't be read, the desk is blind.
 * Stops can't be checked and nothing new is bought until it can see again. Silence must never look like a calm market.
 */
async function markBlind(env: Env, L: Ledger, why: string) {
  const since = await L.setting("blind_since");
  if (!since) {
    await L.setSetting("blind_since", String(Date.now()));
    await L.log("kade", "alert", `Desk is BLIND: market data unavailable (${why.replace(/\.$/, "")}). Stops can't be checked and no new trades until it can see again.`);
  } else {
    const min = Math.round((Date.now() - Number(since)) / 60000);
    await L.log("kade", "alert", `Still blind after ${min} min: ${why}`);
  }
}

async function markSighted(env: Env, L: Ledger) {
  await L.setSetting("last_market_ok", String(Date.now()));
  const since = await L.setting("blind_since");
  if (since) {
    await L.setSetting("blind_since", "");
    await L.log("kade", "alert", `Market data is back after ${Math.round((Date.now() - Number(since)) / 60000)} min blind. Stops were checked again this cycle.`);
  }
}

async function withLock(env: Env, fn: () => Promise<void>) {
  // One cycle at a time: a slow cycle must not overlap the next tick.
  const now = Date.now();
  const lock = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'lock' AND CAST(value AS INTEGER) < ?").bind(String(now), now - 10 * 60 * 1000).run();
  if (!lock.meta.changes) {
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lock', ?)").bind(String(now)).run();
    if (!inserted.meta.changes) return;
  }
  try {
    await fn();
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'lock'").run();
  }
}

export async function newCycle(env: Env): Promise<Ledger> {
  configureEndpoints(env);
  const cycle = Number((await env.DB.prepare("SELECT COALESCE(MAX(cycle), 0) + 1 AS c FROM events").first<{ c: number }>())?.c ?? 1);
  return new Ledger(env, cycle);
}

export interface Ctx {
  RISK: RiskLimits;
  halted: boolean;
  tokens: Map<string, TokenInfo>;
  list: TokenInfo[];
  prices: Prices;
  held: Position[];
  book: { total: number; byHorizon: Record<Horizon, number>; lp: number };
  dayChangePct: number;
  buysToday: number;
  card: Scorecard;
  tvlDayAgo: Map<string, number>;
  /** Real money: fills are on-chain swaps from the bots' wallet, holdings are what the chain says. */
  live: boolean;
}

/** Load prices and the book. Used by every stage so decisions always see fresh data. */
export async function loadCtx(env: Env, L: Ledger): Promise<Ctx> {
  const live = await L.live();
  if (!live) await ensureWallet(env, L);
  const seeded = await seedKnowledge(env);
  if (seeded.length) await L.log("desk", "knowledge", `Knowledge defaults added or refreshed (owner edits are never touched): ${seeded.join(", ")}.`, { seeded });
  const RISK = await loadRiskLimits(env);
  const list = await topTokens(150);
  const held = await L.openPositions();
  const missing = held.map((p) => p.token_id).filter((id) => id !== "bch" && !list.some((t) => t.token_id === id));
  const tokens = new Map<string, TokenInfo>([...list, ...(await tokensByIds([PUSD, ...missing]))].map((t) => [t.token_id, t]));
  const prices = new Prices(tokens);
  let halted = (await L.setting("halted")) === "1";
  if (live) {
    try {
      await syncHoldings(env, L, prices, await coinsFor(env, L, await loadWallet(env)));
    } catch (e) {
      // Can't see the wallet: don't add risk on top of balances we can't confirm.
      halted = true;
      await L.log("kade", "alert", `Can't read the live wallet (${(e as Error).message}). No new buys until it can be read.`);
    }
  }
  const book = await bookOf(L, prices);
  const dayAgo = await L.valueAt(24 * 3600 * 1000);
  const dayChangePct = dayAgo ? ((book.total - dayAgo) / dayAgo) * 100 : 0;
  const card = scorecard(await L.closedSince(30 * 86400 * 1000), 30);
  const tvlDayAgo = await L.tvlAt(24 * 3600 * 1000);
  const buysToday = (await env.DB.prepare("SELECT COUNT(*) AS n FROM trades WHERE side = 'buy' AND ts >= ?").bind(Date.now() - 24 * 3600 * 1000).first<{ n: number }>())?.n ?? 0;
  return { RISK, halted, tokens, list, prices, held, book, dayChangePct, buysToday, card, tvlDayAgo, live };
}

/** The code-only half: record the market, run stops and targets, snapshot the portfolio. */
export async function mechanical(env: Env, L: Ledger): Promise<Ctx> {
  await L.status("rune", "checking stops and targets");
  let ctx = await loadCtx(env, L);
  const { prices } = ctx;
  let closed = 0;
  for (const p of ctx.held) {
    const now = prices.tokenPusd(p.token_id);
    if (now === null) {
      await L.log("kade", "alert", `No price for held ${p.symbol}: its stop and target are UNAVAILABLE this cycle, not "not hit".`, { position_id: p.id });
      continue;
    }
    const reason = exitSignal(p.entry_price_pusd, now, p.target_pct, p.stop_pct);
    if (reason) {
      if (await closePosition(L, prices, p, reason === "stop" ? "stop hit" : "target hit", ctx.RISK)) closed++;
    }
  }
  await tendLps(env, L, prices, ctx.RISK, ctx.tvlDayAgo);
  ctx = { ...ctx, held: await L.openPositions(), book: await bookOf(L, prices) };
  await L.recordTicks(ctx.list.slice(0, 60).map((t) => ({ token_id: t.token_id, symbol: symbolOf(t), price_pusd: prices.tokenPusd(t.token_id), tvl_bch: t.tvl_sats / 1e8, chg_24h_pct: (t.change_24h_bp ?? 0) / 100, volume_sats: t.trade_volume ?? null })));
  await env.DB.prepare("INSERT OR REPLACE INTO scorecards (ts, window_days, data) VALUES (?, ?, ?)").bind(Math.floor(Date.now() / 3600000) * 3600000, 30, JSON.stringify(ctx.card)).run();
  await discover(env, L, ctx).catch((e) => L.log("orin", "error", `Discovery failed: ${(e as Error).message}`));
  if (ctx.dayChangePct <= -ctx.RISK.dailyLossHaltPct) await L.log("kade", "risk", `Portfolio down ${ctx.dayChangePct.toFixed(1)}% in 24h. New buys paused.`);
  await saveMarks(L, prices);
  return ctx;
}

/** Notice new Cauldron listings and launchpad sales, and keep them in D1 for research. */
async function discover(env: Env, L: Ledger, ctx: Ctx) {
  const seen = new Set((await env.DB.prepare("SELECT token_id FROM tokens_seen").all<{ token_id: string }>()).results.map((r) => r.token_id));
  const firstRun = seen.size === 0;
  const stmt = env.DB.prepare(
    "INSERT INTO tokens_seen (token_id, symbol, name, source, first_seen, first_pool_ts, last_tvl_bch, research_status) VALUES (?, ?, ?, 'cauldron', ?, ?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET last_tvl_bch = excluded.last_tvl_bch",
  );
  const fresh = ctx.list.filter((t) => !seen.has(t.token_id));
  await env.DB.batch(ctx.list.map((t) => stmt.bind(t.token_id, symbolOf(t), t.display_name ?? null, Date.now(), t.first_pool_ts ?? null, t.tvl_sats / 1e8, firstRun && !isRecent(t) ? "researched" : "new")));
  if (!firstRun) for (const t of fresh) await L.log("orin", "new-token", `New token on Cauldron: ${symbolOf(t)} with ${round(t.tvl_sats / 1e8, 1)} BCH liquidity. Queued for research.`, { token_id: t.token_id });

  const idos = await launchpadList().catch(() => null);
  if (!idos) return;
  const known = new Map((await env.DB.prepare("SELECT id, status FROM launchpad").all<{ id: string; status: string }>()).results.map((r) => [r.id, r.status]));
  if (idos.length && !known.size) await L.log("orin", "alert", `The Cauldron launchpad is live: ${idos.length} sale(s) listed. The team will research them.`);
  for (const ido of idos) {
    const id = String(ido.id ?? ido.public_id ?? ido.preinit_txid ?? "");
    if (!id) continue;
    const status = String(ido.status ?? "");
    const offered = ido.offered_token_id ?? ido.offering_token_id ?? null;
    if (!known.has(id)) await L.log("orin", "launchpad", `New launchpad sale ${id.slice(0, 8)}… (${status || "unknown status"}). Queued for research.`, ido);
    else if (known.get(id) !== status) await L.log("orin", "launchpad", `Launchpad sale ${id.slice(0, 8)}… is now ${status}.`, ido);
    await env.DB.prepare("INSERT INTO launchpad (id, offered_token_id, status, data, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at")
      .bind(id, offered === null ? null : String(offered), status, JSON.stringify(ido), Date.now(), Date.now())
      .run();
  }
}

const isRecent = (t: TokenInfo) => Boolean(t.first_pool_ts && Date.now() / 1000 - t.first_pool_ts < 7 * 86400);

/** What the agents look at: market digest, portfolio, scorecard, lessons, owner notes. */
export async function briefing(env: Env, ctx: Ctx) {
  const { prices, list, tvlDayAgo } = ctx;
  const held = (await env.DB.prepare("SELECT asset, amount FROM holdings").all<{ asset: string; amount: number }>()).results;
  const cash = {
    pusd: held.filter((h) => h.asset === "pusd").reduce((a, h) => a + h.amount / 100, 0),
    bchPusd: held.filter((h) => h.asset === "bch").reduce((a, h) => a + prices.value("bch", h.amount), 0),
  };
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
  const lessons = (await env.DB.prepare("SELECT lesson FROM lessons WHERE status = 'active' ORDER BY ts DESC LIMIT 10").all<{ lesson: string }>()).results.map((r) => r.lesson);
  const lastDeploy = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_deploy'").first<{ value: string }>();
  const deploy = lastDeploy ? JSON.parse(lastDeploy.value) : null;
  const newTokens = (await env.DB.prepare("SELECT token_id, symbol, name, source, first_seen, first_pool_ts, last_tvl_bch FROM tokens_seen WHERE research_status = 'new' ORDER BY first_seen DESC LIMIT 15").all()).results;
  const launchpad = (await env.DB.prepare("SELECT id, offered_token_id, status, data, first_seen FROM launchpad WHERE status != 'DISTRIBUTED' ORDER BY first_seen DESC LIMIT 20").all<{ data: string }>()).results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const recentSentiment = (await env.DB.prepare("SELECT ts, subject, token_id, symbol, score, mentions, summary FROM sentiment WHERE ts >= ? ORDER BY ts DESC LIMIT 30").bind(Date.now() - 24 * 3600 * 1000).all()).results;
  const blindSince = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'blind_since'").first<{ value: string }>())?.value;
  return {
    mode: ctx.live ? "live" : "paper",
    ...(ctx.live
      ? { live_note: `LIVE: real money in the bots' own wallet. Every approved buy, sell, and liquidity change (provide or withdraw) is a real Cauldron transaction. Live caps on top of the risk limits: at most ${ctx.RISK.liveMaxTradePusd} PUSD per buy or liquidity add and ${ctx.RISK.liveMaxDailyBuyPusd} PUSD of those per 24h. Slippage and the fee limit are the same as for swaps. Fees and price impact are real: prefer fewer, better trades.` }
      : {}),
    bch_usd: round(prices.bchPusd),
    halted: ctx.halted,
    desk_was_blind_since: blindSince ? Number(blindSince) : null,
    buys_last_24h: ctx.buysToday,
    costs: { round_trip_fee_pct: ROUND_TRIP_FEE_PCT, stop_overshoot_assumed_pct: ctx.RISK.stopGapPct, note: "Each leg in a pool also costs about size / pool liquidity in price impact." },
    sentiment_last_24h: recentSentiment,
    new_tokens_to_research: newTokens,
    launchpad: { live: launchpad.length > 0, sales: launchpad },
    portfolio: {
      total_pusd: round(ctx.book.total),
      // Buys are paid in PUSD only, so the spendable cash is the PUSD balance, not the total.
      cash_pusd: round(cash.pusd),
      bch_held_pusd: round(cash.bchPusd),
      ...(ctx.live ? { cash_note: `Buys spend PUSD only: ${round(cash.pusd)} PUSD is spendable. The ${round(cash.bchPusd)} PUSD of BCH is the fee reserve plus any top-up the owner hasn't converted yet; don't size buys on it.` } : {}),
      day_change_pct: round(ctx.dayChangePct, 1),
      by_horizon_pusd: Object.fromEntries(Object.entries(ctx.book.byHorizon).map(([k, v]) => [k, round(v)])),
      liquidity_pusd: round(ctx.book.lp),
      positions: ctx.held.map((p) => ({ token_id: p.token_id, symbol: p.symbol, horizon: p.horizon, cost_pusd: round(p.cost_pusd), value_pusd: round(prices.value(p.token_id, p.amount)), target_pct: p.target_pct, stop_pct: p.stop_pct, thesis: p.thesis })),
    },
    liquidity: {
      positions: (await openLps(env)).map((x) => ({ token_id: x.token_id, symbol: x.symbol, deposit_pusd: round(x.deposit_pusd), value_pusd: round(x.value_pusd ?? x.deposit_pusd), fees_pusd: round(x.fees_pusd), impermanent_loss_pct: round(x.il_pct ?? 0, 1), stop_pct: x.stop_pct, days: round((Date.now() - x.opened_at) / 86400000, 1) })),
      candidates: lpCandidates(ctx.list, ctx.RISK),
      note: "Fee APR is an estimate from the indexer's volume and our share of liquidity. Impermanent loss and rugs can exceed fees.",
    },
    scorecard: ctx.card,
    lessons,
    risk_limits: ctx.RISK,
    recent_code_update: deploy && deploy.ts > Date.now() - 24 * 3600 * 1000 ? deploy : null,
    tokens: digest,
  };
}

/** Facts, rug check and recent candles for one token, for Vela's research. */
export async function research(env: Env, L: Ledger, ctx: Ctx, s: Signal) {
  const t = ctx.tokens.get(s.token_id);
  if (!t) return null;
  const f = await tokenFacts(s.token_id, t);
  await L.log("kade", "rug-check", rugLine(s.symbol, f, ctx.RISK), f);
  const c = await candles(s.token_id, 7, 4 * 3600).catch(() => []);
  return { ...s, facts: f, closes_4h_pusd: c.map((x) => round((x.close / 1e8) * 10 ** ctx.prices.decimals(s.token_id) * ctx.prices.bchPusd, 6)) };
}

/** Log Orin's signals. */
export async function recordSignals(L: Ledger, signals: Signal[], note: string | undefined, scanned: number) {
  await L.log("orin", "scan", note || `Scanned ${scanned} tokens.`, { signals });
  for (const s of signals) await L.log("orin", "signal", `${s.symbol}: ${s.signal}. ${s.why}`, s);
}

/** Store Vela's proposals and run Kade's risk engine on them. Returns the engine verdicts. */
export async function proposeAndCheck(L: Ledger, ctx: Ctx, raw: Omit<Proposal, "id">[], signals: Signal[], note?: string) {
  if (note) await L.log("vela", "note", note);
  const proposals: Proposal[] = raw.map((p, i) => ({ ...p, id: `c${L.cycle}-p${i + 1}` }));
  for (const p of proposals) p.signal ??= signals.find((s) => s.token_id === p.token_id)?.signal ?? (ctx.held.some((h) => h.token_id === p.token_id) ? "exit-review" : "vela");
  for (const p of proposals) {
    const cases = p.bull_case ? ` Bull: ${p.bull_case} Bear: ${p.bear_case}` : "";
    await L.log("vela", "proposal", `${String(p.action).toUpperCase()} ${p.symbol} (${p.horizon}, ${p.size_pct}%): ${p.thesis}${cases}`, p);
    await L.saveProposal(p, "vela");
  }
  if (!proposals.length) await L.log("nova", "decision", "No proposals this cycle. Holding.");

  await L.status("kade", `risk-checking ${proposals.length} proposals`);
  const verdicts = [];
  for (const p of proposals) {
    let v: { pass: boolean; allowed: number; reasons: string[] };
    if (p.action === "sell") {
      const has = ctx.held.some((h) => h.token_id === p.token_id);
      v = { pass: has, allowed: 0, reasons: has ? [] : ["no position to sell"] };
    } else if (p.action === "withdraw") {
      const has = (await openLps(L.env)).some((x) => x.token_id === p.token_id);
      v = { pass: has, allowed: 0, reasons: has ? [] : ["no liquidity position in this token"] };
    } else if (p.action !== "buy" && p.action !== "provide") {
      v = { pass: false, allowed: 0, reasons: ["action must be buy, sell, provide or withdraw"] };
    } else if (p.token_id === PUSD || (p.action === "provide" && p.token_id === "bch")) {
      v = { pass: false, allowed: 0, reasons: [p.token_id === PUSD ? "PUSD is the home asset" : "pools are token/BCH; pick a token"] };
    } else if (p.action === "provide") {
      const t = ctx.tokens.get(p.token_id);
      const facts = t ? { ...(await tokenFacts(p.token_id, t)), feeAprPct: feeAprPct(t.tvl_sats, t.trade_volume ?? 0) } : undefined;
      const lps = await openLps(L.env);
      const inPool = lps.filter((x) => x.token_id === p.token_id).reduce((a, x) => a + (lpValue(x, ctx.prices) ?? x.deposit_pusd), 0);
      const r = checkProvide(p, facts, { totalPusd: ctx.book.total, lpBookPusd: ctx.book.lp, heldInPoolPusd: inPool, dayChangePct: ctx.dayChangePct, bchPusd: ctx.prices.bchPusd }, ctx.halted, ctx.RISK);
      v = { pass: r.pass, allowed: r.allowedPusd, reasons: r.reasons };
    } else {
      const facts = p.token_id === "bch" ? BCH_FACTS : ctx.tokens.has(p.token_id) ? await tokenFacts(p.token_id, ctx.tokens.get(p.token_id)!) : undefined;
      const heldPusd = ctx.held.filter((h) => h.token_id === p.token_id).reduce((s, h) => s + ctx.prices.value(h.token_id, h.amount), 0);
      const b: Book = { totalPusd: ctx.book.total, byHorizonPusd: ctx.book.byHorizon, heldPusd, openShort: ctx.held.filter((h) => h.horizon === "short").length, dayChangePct: ctx.dayChangePct, bchPusd: ctx.prices.bchPusd, buysToday: ctx.buysToday };
      const scale = HORIZONS.includes(p.horizon) ? sizeScale(ctx.card, p.horizon) : 1;
      if (scale < 1) await L.log("kade", "risk", `${p.horizon} trades are losing lately; ${p.symbol} size scaled to ${scale * 100}%.`);
      const r = checkBuy({ ...p, size_pct: Number(p.size_pct) * scale }, facts, b, ctx.halted, ctx.RISK);
      v = { pass: r.pass, allowed: r.allowedPusd, reasons: r.reasons };
    }
    const size = (p.action === "buy" || p.action === "provide") && v.pass ? ` Allowed ${round(v.allowed)} PUSD.` : "";
    await L.log("kade", v.pass ? "risk-pass" : "risk-fail", `${p.symbol}: engine ${v.pass ? "PASS" : "FAIL"}.${size} ${v.reasons.join("; ")}`.trim(), { proposal: p.id, ...v });
    await L.updateProposal(p.id, { status: v.pass ? "risk_passed" : "risk_failed", allowed_pusd: v.allowed, risk_notes: v.reasons.join("; ") });
    verdicts.push({ proposal_id: p.id, symbol: p.symbol, action: p.action, pass: v.pass, allowed_pusd: round(v.allowed), reasons: v.reasons });
  }
  return { cycle: L.cycle, proposals, verdicts };
}

/** Apply Kade's vetoes and Nova's approvals to a cycle's risk-passed proposals, then execute. */
export async function decideAndExecute(env: Env, L: Ledger, ctx: Ctx, kade: Verdict[], nova: Decision[], novaNote?: string) {
  const rows = (await env.DB.prepare("SELECT * FROM proposals WHERE cycle = ? AND status = 'risk_passed'").bind(L.cycle).all<Proposal & { allowed_pusd: number }>()).results;
  for (const v of kade) {
    const p = rows.find((r) => r.id === v.proposal_id);
    if (!p) continue;
    if (v.veto) {
      await L.log("kade", "risk-fail", `${p.symbol}: VETO. ${v.comment ?? ""}`.trim(), v);
      await L.updateProposal(p.id, { status: "vetoed", risk_notes: `Kade veto: ${v.comment ?? ""}` });
    } else if (v.comment) {
      await L.log("kade", "risk-pass", `${p.symbol}: OK. ${v.comment}`, v);
    }
  }
  const vetoed = new Set(kade.filter((v) => v.veto).map((v) => v.proposal_id));
  let approved: (Proposal & { allowed_pusd: number })[] = [];
  for (const d of nova) {
    const p = rows.find((r) => r.id === d.proposal_id);
    if (!p || vetoed.has(p.id)) continue;
    await L.log("nova", "decision", `${d.approve ? "Approved" : "Rejected"} ${p.action} ${p.symbol}: ${d.reason ?? ""}`.trim(), d);
    await L.updateProposal(p.id, { status: d.approve ? "approved" : "rejected", decision_note: d.reason ?? "" });
    if (d.approve) approved.push(p);
  }
  if (novaNote) await L.log("nova", "note", novaNote);
  if (ctx.halted) {
    const exits = (x: Proposal) => x.action === "sell" || x.action === "withdraw";
    for (const p of approved.filter((x) => !exits(x))) await L.updateProposal(p.id, { status: "rejected", decision_note: "desk halted by owner" });
    approved = approved.filter(exits);
    await L.log("nova", "decision", "Desk is halted by the owner: only sells and liquidity withdrawals go through.");
  }

  const fills = [];
  for (const p of approved.slice(ctx.RISK.maxTradesPerCycle)) await L.updateProposal(p.id, { status: "skipped", decision_note: "over the per-cycle trade limit" });
  for (const p of approved.slice(0, ctx.RISK.maxTradesPerCycle)) {
    await L.status("rune", `executing ${p.action} ${p.symbol}`);
    if (p.action === "sell") {
      let ok = true;
      for (const h of ctx.held.filter((x) => x.token_id === p.token_id)) {
        const f = await closePosition(L, ctx.prices, h, `Vela exit: ${p.thesis}`, ctx.RISK);
        if (f) fills.push(f);
        else ok = false;
      }
      await L.updateProposal(p.id, ok ? { status: "filled" } : { status: "skipped", decision_note: "the on-chain sell did not go through; see the activity log" });
    } else if (p.action === "withdraw") {
      let ok = false;
      for (const x of (await openLps(env)).filter((y) => y.token_id === p.token_id)) {
        const f = await withdraw(L, ctx.prices, x, `Vela withdraw: ${p.thesis}`, ctx.RISK);
        if (f) {
          fills.push(f);
          ok = true;
        }
      }
      await L.updateProposal(p.id, ok ? { status: "filled" } : { status: "skipped", decision_note: "the withdraw did not go through; see the activity log" });
    } else if (p.action === "provide") {
      const fill = await provide(L, ctx.prices, p, p.allowed_pusd, ctx.RISK);
      await L.updateProposal(p.id, fill ? { status: "filled" } : { status: "skipped", decision_note: "the liquidity add did not go through; see the activity log" });
      if (fill) fills.push(fill);
    } else {
      const fill = await openPosition(L, ctx.prices, p, p.allowed_pusd, ctx.RISK);
      await L.updateProposal(p.id, fill ? { status: "filled", position_id: fill.position_id } : { status: "skipped", decision_note: "not filled at execution; see the activity log" });
      if (fill) fills.push(fill);
    }
  }
  await saveMarks(L, ctx.prices);
  return { cycle: L.cycle, approved: approved.map((p) => p.id), fills };
}

export interface ResearchNote { token_id: string; symbol: string; verdict: string; opportunity?: string; note: string; sources?: string[] }

/** Store what the agents learned about tokens, and mark them researched. */
export async function recordResearch(env: Env, L: Ledger, notes: ResearchNote[], agent = "vela") {
  for (const n of notes) {
    const verdict = ["opportunity", "watch", "avoid"].includes(n.verdict) ? n.verdict : "watch";
    await env.DB.prepare("INSERT INTO research_notes (ts, cycle, agent, token_id, symbol, verdict, opportunity, note, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), L.cycle, agent, n.token_id, n.symbol, verdict, n.opportunity ?? null, n.note, n.sources ? JSON.stringify(n.sources) : null)
      .run();
    await env.DB.prepare("UPDATE tokens_seen SET research_status = ?, last_research_at = ? WHERE token_id = ?").bind(verdict === "opportunity" ? "watch" : verdict === "avoid" ? "avoid" : "researched", Date.now(), n.token_id).run();
    await L.log(agent as "vela", "research", `${n.symbol}: ${verdict.toUpperCase()}. ${n.note}${n.opportunity ? ` Opportunity: ${n.opportunity}` : ""}`, n);
  }
}

export interface SentimentReading { subject: string; token_id?: string; symbol?: string; score: number; mentions?: number; summary: string; sources?: string[] }

/** Store X sentiment readings (tokens, Cauldron news, BCH). */
export async function recordSentiment(env: Env, L: Ledger, readings: SentimentReading[]) {
  for (const r of readings) {
    const subject = ["token", "cauldron", "bch"].includes(r.subject) ? r.subject : "token";
    const score = Math.max(-1, Math.min(1, Number(r.score) || 0));
    await env.DB.prepare("INSERT INTO sentiment (ts, cycle, subject, token_id, symbol, score, mentions, summary, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), L.cycle, subject, r.token_id ?? null, r.symbol ?? null, score, r.mentions ?? null, String(r.summary).slice(0, 1000), r.sources ? JSON.stringify(r.sources.slice(0, 10)) : null)
      .run();
    const label = subject === "token" ? r.symbol ?? "token" : subject === "cauldron" ? "Cauldron news" : "BCH";
    await L.log("vela", "sentiment", `${label} sentiment on X: ${score >= 0 ? "+" : ""}${score.toFixed(2)}${r.mentions ? ` from ~${r.mentions} posts` : ""}. ${r.summary}`, r);
  }
}

/** Zara's journal entry and lessons. */
export async function recordJournal(env: Env, L: Ledger, text: string, lessons: string[], suggestion?: string) {
  await env.DB.prepare("INSERT INTO journal (ts, text, lessons) VALUES (?, ?, ?)").bind(Date.now(), text, JSON.stringify(lessons)).run();
  for (const lesson of lessons) await env.DB.prepare("INSERT INTO lessons (ts, lesson) VALUES (?, ?)").bind(Date.now(), lesson).run();
  await L.log("zara", "journal", text, { lessons });
  if (suggestion) await L.log("zara", "suggestion", `Suggested strategy change for the owner: ${suggestion}`);
}

/** Stats Zara reviews for the journal. */
/** Facts for each closed position Zara hasn't reviewed yet, computed from the records, not from memory. */
export async function positionsToReview(env: Env) {
  const rows = (
    await env.DB.prepare(
      "SELECT p.* FROM positions p LEFT JOIN trade_reviews r ON r.position_id = p.id WHERE p.status = 'closed' AND r.position_id IS NULL ORDER BY p.closed_at LIMIT 10",
    ).all<Position & { exit_pusd: number; close_reason: string; closed_at: number }>()
  ).results;
  const out = [];
  for (const p of rows) {
    const fills = (await env.DB.prepare("SELECT ts, side, pusd, impact_pct, estimated, reason FROM trades WHERE position_id = ? ORDER BY ts").bind(p.id).all()).results;
    const proposal = await env.DB.prepare("SELECT id, status, signal, thesis, bull_case, bear_case, risk_notes, decision_note, allowed_pusd FROM proposals WHERE position_id = ?").bind(p.id).first();
    const pnl = p.exit_pusd - p.cost_pusd;
    const pnlPct = (pnl / p.cost_pusd) * 100;
    const plannedRisk = (p.cost_pusd * p.stop_pct) / 100;
    out.push({
      position_id: p.id,
      symbol: p.symbol,
      horizon: p.horizon,
      signal: p.signal,
      close_reason: p.close_reason,
      cost_pusd: round(p.cost_pusd),
      exit_pusd: round(p.exit_pusd),
      outcome_pusd: round(pnl),
      outcome_pct: round(pnlPct, 1),
      outcome_r: plannedRisk > 0 ? round(pnl / plannedRisk) : null,
      stop_pct: p.stop_pct,
      target_pct: p.target_pct,
      stop_overshoot_pct: p.close_reason === "stop hit" ? round(-pnlPct - p.stop_pct, 1) : null,
      holding_hours: round((p.closed_at - p.opened_at) / 3600000, 1),
      fills,
      proposal,
    });
  }
  return out;
}

export interface Review { position_id: number; process: string; break_stage?: string; finding: string }

/** Store Zara's reviews. Outcome numbers come from the records, so a review can't flatter a trade. */
export async function recordReviews(env: Env, L: Ledger, reviews: Review[]) {
  const facts = new Map((await positionsToReview(env)).map((f) => [f.position_id, f]));
  let saved = 0;
  for (const r of reviews) {
    const f = facts.get(Number(r.position_id));
    if (!f || typeof r.finding !== "string") continue;
    const process = ["clean", "minor", "major"].includes(r.process) ? r.process : "minor";
    await env.DB.prepare("INSERT OR REPLACE INTO trade_reviews (position_id, ts, symbol, process, break_stage, outcome_pusd, outcome_r, stop_overshoot_pct, finding, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'zara')")
      .bind(f.position_id, Date.now(), f.symbol, process, r.break_stage ?? null, f.outcome_pusd, f.outcome_r, f.stop_overshoot_pct, r.finding.slice(0, 500))
      .run();
    const overshoot = f.stop_overshoot_pct !== null ? `, stop overshoot ${f.stop_overshoot_pct}%` : "";
    await L.log("zara", "review", `${f.symbol} reviewed. Process: ${process}${r.break_stage ? ` (${r.break_stage})` : ""}. Outcome: ${f.outcome_pusd} PUSD, ${f.outcome_r ?? "?"}R${overshoot}. Finding: ${r.finding}`, { ...r, facts: f });
    saved++;
  }
  return saved;
}

export async function journalStats(env: Env, L: Ledger) {
  const since = Date.now() - 24 * 3600 * 1000;
  const closed = (await env.DB.prepare("SELECT symbol, horizon, signal, cost_pusd, exit_pusd, close_reason FROM positions WHERE status = 'closed' AND closed_at >= ?").bind(since).all()).results;
  const vetoes = (await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status IN ('risk_failed', 'vetoed') AND ts >= ?").bind(since).first<{ n: number }>())?.n ?? 0;
  const overshoot = await env.DB.prepare("SELECT COUNT(*) AS n, AVG(stop_overshoot_pct) AS avg, MAX(stop_overshoot_pct) AS worst FROM trade_reviews WHERE stop_overshoot_pct IS NOT NULL").first();
  return { positions_to_review: await positionsToReview(env), stop_overshoot_so_far: overshoot, closed_24h: closed, failed_or_vetoed_24h: vetoes, scorecard_30d: scorecard(await L.closedSince(30 * 86400 * 1000), 30), value_now: await L.valueAt(0), value_24h_ago: await L.valueAt(24 * 3600 * 1000) };
}

// ---------- Worker-side brains ----------

async function xaiBrain(env: Env, L: Ledger, ctx: Ctx) {
  const brief = await briefing(env, ctx);
  await L.status("orin", "scanning Cauldron");
  const o = await askAgent<{ signals: Signal[]; note: string }>(env, "orin", "Scan this market digest.", { bch_usd: brief.bch_usd, signal_scorecard: ctx.card.by_signal, new_tokens_to_research: brief.new_tokens_to_research, launchpad: brief.launchpad, tokens: brief.tokens }, { cycle: L.cycle });
  const signals = (o.signals ?? []).filter((s) => ctx.tokens.has(s.token_id)).slice(0, 5);
  await recordSignals(L, signals, o.note, brief.tokens.length);
  await L.status("vela", `researching ${signals.length} signals`);
  const studied = (await Promise.all(signals.map((s) => research(env, L, ctx, s)))).filter(Boolean);
  if (!studied.length && !ctx.held.length && !brief.new_tokens_to_research.length) return;
  const v = await askAgent<{ proposals: Omit<Proposal, "id">[]; research_notes?: ResearchNote[]; sentiment?: SentimentReading[]; note: string }>(env, "vela", "Write trade proposals.", { research: studied, new_tokens_to_research: brief.new_tokens_to_research, launchpad: brief.launchpad, portfolio: brief.portfolio, scorecard: ctx.card, lessons: brief.lessons, bch_usd: brief.bch_usd }, { search: true, cycle: L.cycle });
  await recordResearch(env, L, (v.research_notes ?? []).slice(0, 20));
  await recordSentiment(env, L, (v.sentiment ?? []).slice(0, 20));
  const checked = await proposeAndCheck(L, ctx, v.proposals ?? [], signals, v.note);
  const passed = checked.verdicts.filter((x) => x.pass);
  if (!passed.length) return;
  const k = await askAgent<{ verdicts: Verdict[] }>(env, "kade", "Review these proposals the risk engine passed.", { proposals: passed.map((x) => ({ ...checked.proposals.find((p) => p.id === x.proposal_id), engine: x })) }, { cycle: L.cycle });
  const n = await askAgent<{ decisions: Decision[]; note: string }>(env, "nova", "Approve or reject these risk-checked proposals.", { portfolio: brief.portfolio, scorecard: ctx.card, lessons: brief.lessons, recent_code_update: brief.recent_code_update, proposals: passed.filter((x) => !(k.verdicts ?? []).some((y) => y.veto && y.proposal_id === x.proposal_id)).map((x) => ({ ...checked.proposals.find((p) => p.id === x.proposal_id), allowed_pusd: x.allowed_pusd })) }, { cycle: L.cycle });
  await decideAndExecute(env, L, ctx, k.verdicts ?? [], n.decisions ?? [], n.note);
}

async function rulesBrain(env: Env, L: Ledger, ctx: Ctx) {
  const brief = await briefing(env, ctx);
  const signals: Signal[] = brief.tokens
    .filter((t) => t.chg_24h_pct > 5 && t.chg_24h_pct < 50 && t.tvl_bch >= 5 && (t.tvl_chg_24h_pct ?? 0) >= 0)
    .sort((a, b) => b.chg_24h_pct - a.chg_24h_pct)
    .slice(0, 3)
    .map((t) => ({ token_id: t.token_id, symbol: t.symbol, signal: "momentum", why: `Up ${t.chg_24h_pct}% in 24h with ${t.tvl_bch} BCH liquidity.` }));
  await recordSignals(L, signals, `Scanned ${brief.tokens.length} tokens, ${signals.length} momentum signals (rule-based).`, brief.tokens.length);
  for (const s of signals) await research(env, L, ctx, s);
  const checked = await proposeAndCheck(L, ctx, signals.slice(0, 2).map((s) => ({ action: "buy" as const, token_id: s.token_id, symbol: s.symbol, horizon: "short" as const, size_pct: 2, target_pct: 25, stop_pct: 12, thesis: `Rule-based momentum entry: ${s.why}` })), signals);
  const ok = checked.verdicts.filter((v) => v.pass);
  await decideAndExecute(env, L, ctx, [], ok.map((v) => ({ proposal_id: v.proposal_id, approve: true, reason: "rule-based" })));
}

/** Zara's daily journal from the cron (Worker-side brains only; Grok Bot posts its own). */
export async function runJournal(env: Env): Promise<void> {
  const brain = brainOf(env);
  if (brain === "grok-bot") return;
  const L = await newCycle(env);
  const last = await env.DB.prepare("SELECT MAX(ts) AS ts FROM journal").first<{ ts: number | null }>();
  if (last?.ts && last.ts > Date.now() - 20 * 3600 * 1000) return;
  const stats = await journalStats(env, L);
  await L.status("zara", "writing the daily journal");
  if (brain === "xai-api") {
    const r = await askAgent<{ journal: string; lessons: string[]; strategy_suggestion?: string; reviews?: Review[] }>(env, "zara", "Review the closed trades, then write today's journal.", stats);
    await recordReviews(env, L, r.reviews ?? []);
    await recordJournal(env, L, r.journal, r.lessons ?? [], r.strategy_suggestion);
  } else {
    const wins = stats.closed_24h.filter((c) => Number(c.exit_pusd) > Number(c.cost_pusd)).length;
    await recordJournal(env, L, `${stats.closed_24h.length} positions closed in 24h, ${wins} winners. ${stats.failed_or_vetoed_24h} proposals failed risk checks or were vetoed. Portfolio ${round(stats.value_now ?? 0)} PUSD.`, []);
  }
  await publishRoleStatus(env);
}

// ---------- Shared helpers ----------

/** Store current marks so the website can value positions without calling the indexer. */
async function saveMarks(L: Ledger, prices: Prices) {
  const after = await bookOf(L, prices);
  await L.snapshot(after.total, prices.bchPusd);
  if ((await L.live()) && !(await L.setting("live_start_pusd"))) await L.setSetting("live_start_pusd", String(round(after.total)));
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
  if (singleLpOver(f.topOwnerSharePct, RISK.maxOwnerSharePct)) flags.push(`one LP holds ${f.topOwnerSharePct}% of liquidity`);
  if (f.poolAgeHours < 24) flags.push(`pool only ${f.poolAgeHours.toFixed(0)}h old`);
  if (f.tvlBch < 5) flags.push(`thin liquidity ${f.tvlBch.toFixed(1)} BCH`);
  return `Rug check ${symbol}: ${flags.length ? "flags: " + flags.join(", ") : "no red flags"} (TVL ${f.tvlBch.toFixed(1)} BCH, top LP ${f.topOwnerSharePct}%, age ${(f.poolAgeHours / 24).toFixed(1)}d).`;
}

async function openPosition(L: Ledger, prices: Prices, p: Proposal, sizePusd: number, RISK: RiskLimits) {
  const live = await L.live();
  const symbol = p.token_id === "bch" ? "BCH" : p.symbol;
  if (live) {
    // Real money: the live caps sit on top of every other limit.
    const spent = await liveSpentPusd(L.env);
    const capped = liveRoom(sizePusd, spent, RISK.liveMaxTradePusd, RISK.liveMaxDailyBuyPusd);
    if (capped < RISK.minTradePusd) {
      await L.log("rune", "skip", `Skipped live buy ${symbol}: ${round(spent)} of the ${RISK.liveMaxDailyBuyPusd} PUSD daily live limit already used.`);
      return null;
    }
    if (capped < sizePusd) await L.log("rune", "risk", `Live buy ${symbol} cut from ${round(sizePusd)} to ${round(capped)} PUSD by the live limits.`);
    sizePusd = capped;
  }
  const pusdUnits = Math.floor(sizePusd * 100);
  const fill = await simulateSwap(PUSD, p.token_id, pusdUnits, prices);
  if (fill.impactPct > RISK.maxPriceImpactPct || fill.amountOut <= 0) {
    await L.log("rune", "skip", `Skipped buy ${p.symbol}: price impact ${fill.impactPct.toFixed(2)}% over ${RISK.maxPriceImpactPct}% limit.`, fill);
    return null;
  }
  let amountOut = fill.amountOut;
  let costPusd = sizePusd;
  let txid: string | undefined;
  if (live) {
    if (fill.estimated) {
      await L.log("rune", "skip", `Skipped live buy ${symbol}: no router quote or pool reserves to check the price against.`, fill);
      return null;
    }
    try {
      const r = await liveSwap(L.env, L, RISK, { sell: PUSD, buy: p.token_id, amount: BigInt(pusdUnits), expectedOut: BigInt(fill.amountOut) });
      amountOut = Number(r.bought);
      costPusd = Number(r.sold) / 100;
      txid = r.txid;
      await syncHoldings(L.env, L, prices, await coinsFor(L.env, L, await loadWallet(L.env)));
    } catch (e) {
      await L.log("rune", "execution", `LIVE BUY ${symbol} failed execution, no position booked: ${(e as Error).message}`, { proposal: p.id, failed: true });
      return null;
    }
  } else {
    await L.adjust("pusd", "PUSD", -pusdUnits);
    await L.adjust(p.token_id, symbol, fill.amountOut);
  }
  const whole = amountOut / 10 ** prices.decimals(p.token_id);
  const positionId = await L.openPosition({
    token_id: p.token_id, symbol, horizon: p.horizon, amount: amountOut, cost_pusd: costPusd,
    entry_price_pusd: costPusd / whole, target_pct: p.target_pct, stop_pct: p.stop_pct, signal: p.signal ?? null, thesis: p.thesis,
  });
  await L.recordTrade({ side: "buy", token_id: p.token_id, symbol, amount: amountOut, pusd: costPusd, price_pusd: costPusd / whole, impact_pct: fill.impactPct, estimated: !live && fill.estimated, position_id: positionId, reason: p.thesis, txid });
  const how = live ? `LIVE BUY ${round(whole, 4)} ${symbol} for ${round(costPusd)} PUSD, tx ${explorerTx(txid!)}` : `PAPER BUY ${round(whole, 4)} ${symbol} for ${round(costPusd)} PUSD`;
  await L.log("rune", "fill", `${how} (impact ${fill.impactPct.toFixed(2)}%${fill.estimated ? ", estimated" : ""}${fill.reservePriced ? ", pool reserves" : ""}). Target +${p.target_pct}%, stop -${p.stop_pct}%.`, { ...fill, txid });
  return { side: "buy", symbol, pusd: round(costPusd), amount: amountOut, impact_pct: round(fill.impactPct), estimated: !live && fill.estimated, position_id: positionId, txid };
}

/** Sell a position back to PUSD. Returns null when a live sell didn't go through (the position stays open). */
async function closePosition(L: Ledger, prices: Prices, pos: Position, reason: string, RISK: RiskLimits) {
  const live = await L.live();
  let amount = pos.amount;
  if (live) {
    let have = 0;
    try {
      const bal = balancesOf(await coinsFor(L.env, L, await loadWallet(L.env)));
      have = Number(bal.get(pos.token_id) ?? 0n) - (pos.token_id === "bch" ? RISK.liveBchReserveSats : 0);
      if (have < 0) have = 0;
    } catch (e) {
      await L.log("rune", "execution", `LIVE SELL ${pos.symbol} (${reason}) failed execution, position stays open: can't read the wallet: ${(e as Error).message}`, { position_id: pos.id, failed: true });
      return null;
    }
    if (reason === "stop hit") {
      const sell = stopSellAmount(pos.amount, have);
      if (sell === null) {
        await L.log("kade", "alert", `Stop on ${pos.symbol} position ${pos.id} not sold: the wallet does not hold the tokens.`, { position_id: pos.id });
        return null;
      }
      amount = sell;
    } else {
      amount = Math.min(pos.amount, have);
      if (amount <= 0) {
        await L.log("kade", "alert", `${pos.symbol} position ${pos.id} is not in the live wallet any more. Closing it at zero; check the wallet.`, { position_id: pos.id });
        await L.closePosition(pos.id, 0, `${reason}; tokens not found in the wallet`);
        return { side: "sell", symbol: pos.symbol, pusd: 0, pnl_pusd: round(-pos.cost_pusd), position_id: pos.id };
      }
    }
  }
  const fill = await simulateSwap(pos.token_id, PUSD, amount, prices);
  let outPusd = fill.amountOut / 100;
  let txid: string | undefined;
  if (live) {
    try {
      // A stop is a way out, not a price target: give it twice the usual slippage room.
      const slippagePct = reason === "stop hit" ? RISK.liveSlippagePct * 2 : RISK.liveSlippagePct;
      const r = await liveSwap(L.env, L, RISK, { sell: pos.token_id, buy: PUSD, amount: BigInt(amount), expectedOut: BigInt(fill.amountOut), slippagePct });
      outPusd = Number(r.bought) / 100;
      txid = r.txid;
      await syncHoldings(L.env, L, prices, await coinsFor(L.env, L, await loadWallet(L.env)));
    } catch (e) {
      await L.log("rune", "execution", `LIVE SELL ${pos.symbol} (${reason}) failed execution, position stays open: ${(e as Error).message}`, { position_id: pos.id, failed: true });
      return null;
    }
  } else {
    await L.adjust(pos.token_id, pos.symbol, -pos.amount);
    await L.adjust("pusd", "PUSD", fill.amountOut);
  }
  await L.closePosition(pos.id, outPusd, reason);
  const pnl = outPusd - pos.cost_pusd;
  const whole = amount / 10 ** prices.decimals(pos.token_id);
  await L.recordTrade({ side: "sell", token_id: pos.token_id, symbol: pos.symbol, amount, pusd: outPusd, price_pusd: whole ? outPusd / whole : 0, impact_pct: fill.impactPct, estimated: !live && fill.estimated, position_id: pos.id, reason, txid });
  const how = live ? `LIVE SELL ${pos.symbol} for ${round(outPusd)} PUSD, tx ${explorerTx(txid!)}` : `PAPER SELL ${pos.symbol} for ${round(outPusd)} PUSD`;
  await L.log("rune", "fill", `${how}, ${pnl >= 0 ? "+" : ""}${round(pnl)} PUSD (${round((pnl / pos.cost_pusd) * 100, 1)}%). ${reason}${!live && fill.reservePriced ? " (priced from pool reserves)" : ""}.`, { ...fill, pnl, txid });
  return { side: "sell", symbol: pos.symbol, pusd: round(outPusd), pnl_pusd: round(pnl), position_id: pos.id, txid };
}

async function bookOf(L: Ledger, prices: Prices) {
  const holdings = await L.holdings();
  const positions = await L.openPositions();
  let total = 0;
  for (const h of holdings) total += h.asset === "pusd" ? h.amount / 100 : prices.value(h.asset, h.amount);
  const byHorizon = Object.fromEntries(HORIZONS.map((h) => [h, 0])) as Record<Horizon, number>;
  for (const p of positions) byHorizon[p.horizon] += prices.value(p.token_id, p.amount);
  let lp = 0;
  for (const x of await openLps(L.env)) lp += lpValue(x, prices) ?? x.value_pusd ?? x.deposit_pusd;
  return { total: total + lp, byHorizon, lp };
}

async function ensureWallet(env: Env, L: Ledger) {
  if ((await L.setting("initialized")) === "1") return;
  const start = Number(env.PAPER_START_PUSD) || 1000;
  await L.adjust("pusd", "PUSD", start * 100);
  await L.setSetting("initialized", "1");
  await L.log("desk", "start", `Paper wallet opened with ${start} PUSD. Mode: ${env.MODE.toUpperCase()}.`);
}

export { loadKnowledge };

/**
 * Owner's rule for going live: start from PUSD. Swaps every BCH above the fee reserve (and one swap's fee allowance)
 * into PUSD with the same build, check, sign and broadcast as any live trade. Returns null when there is nothing to swap.
 */
export async function convertBchToPusd(env: Env, RISK: RiskLimits) {
  const L = await newCycle(env);
  const bal = balancesOf(await coinsFor(env, L, await loadWallet(env), true));
  const total = Number(bal.get("bch") ?? 0n) - RISK.liveBchReserveSats;
  // Fee allowance: miner fee plus the router's 0.1% taken in BCH, with room to spare.
  const maxFeeSats = RISK.liveMaxFeeSats + Math.ceil(total * 0.003);
  const sats = total - maxFeeSats;
  if (sats < 100_000) return null; // under 0.001 BCH: not worth a swap
  const prices = new Prices(new Map((await tokensByIds([PUSD])).map((t) => [t.token_id, t])));
  // Quote from the pools' live coins (the router's view can be stale), and refuse if that is far off the indexer's price.
  const pools = await livePools(env, PUSD);
  const out = Number(quotePools(pools, true, BigInt(sats)));
  const ref = prices.info(PUSD)?.price_now; // sats per whole PUSD
  if (out <= 0) throw new Error("no live PUSD pools to quote BCH to PUSD right now; try again in a minute");
  if (ref && out < (sats / ref) * 100 * 0.95) throw new Error(`pools pay ${out / 100} PUSD for ${sats / 1e8} BCH, over 5% below the indexer price; not converting`);
  const quote = { amountOut: out, impactPct: ref ? Math.max(0, (1 - out / ((sats / ref) * 100)) * 100) : 0 };
  const r = await liveSwap(env, L, RISK, { sell: "bch", buy: PUSD, amount: BigInt(sats), expectedOut: BigInt(quote.amountOut), maxFeeSats });
  const pusd = Number(r.bought) / 100;
  return { txid: r.txid, bch: Number(r.sold) / 1e8, pusd, impactPct: quote.impactPct, cycle: L.cycle };
}

/** Record the go-live conversion once the desk is live, so it shows as a live trade with its transaction. */
export async function recordConversion(env: Env, c: NonNullable<Awaited<ReturnType<typeof convertBchToPusd>>>, why = "Go live: all BCH above the fee reserve swapped to PUSD (owner's rule)") {
  const L = new Ledger(env, c.cycle);
  await L.recordTrade({ side: "convert", token_id: "bch", symbol: "BCH", amount: Math.round(c.bch * 1e8), pusd: c.pusd, price_pusd: c.pusd / c.bch, impact_pct: c.impactPct, estimated: false, position_id: null, reason: why, txid: c.txid });
  await L.log("rune", "fill", `LIVE CONVERT ${round(c.bch, 5)} BCH to ${round(c.pusd)} PUSD (${why}), tx ${explorerTx(c.txid)}.`, c);
}
