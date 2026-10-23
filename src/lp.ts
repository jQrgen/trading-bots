import { PUSD, type Env, type RiskLimits } from "./config";
import type { Ledger } from "./ledger";
import { simulateSwap, type Prices } from "./market";
import type { Proposal } from "./risk";

/*
 * Paper liquidity providing on Cauldron. Each provider on Cauldron runs their own constant-product micro-pool
 * (BCH x token = k) and earns the 0.3% pool fee on what the router sends through it. The desk models one such pool:
 * value moves with price along x*y=k (impermanent loss), and fee income is estimated from the token's traded
 * volume times our share of its liquidity. Fee income is an estimate and labelled as one everywhere.
 */

export const POOL_FEE = 0.003;
/** The indexer's trade_volume is read as volume over this many days, in sats. It is an assumption; Zara checks it. */
export const VOLUME_WINDOW_DAYS = 30;

/** Reserves of a constant-product pool at a given price (sats per whole token). */
export function reservesAt(k: number, priceSats: number) {
  return { bchSats: Math.sqrt(k * priceSats), tokens: Math.sqrt(k / priceSats) };
}

/** Pool value in sats at a price: both sides are worth the same, so it is twice the BCH side. */
export const poolValueSats = (k: number, priceSats: number) => 2 * Math.sqrt(k * priceSats);

/** Impermanent loss vs holding, as a negative %: 2*sqrt(r)/(1+r) - 1 for a price ratio r. */
export function impermanentLossPct(entryPriceSats: number, priceSats: number): number {
  const r = priceSats / entryPriceSats;
  return (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
}

/**
 * Estimated fee income in PUSD over dtMs: our share of the token's BCH-side liquidity times the token's volume
 * per ms times the 0.3% pool fee. The router prefers better prices, so this assumes volume splits by liquidity.
 */
export function feeIncomePusd(ourBchSats: number, tokenTvlSats: number, volumeSats: number, dtMs: number, bchPusd: number): number {
  if (!(ourBchSats > 0) || !(volumeSats > 0) || !(dtMs > 0)) return 0;
  const share = ourBchSats / (tokenTvlSats + ourBchSats);
  const perMs = volumeSats / (VOLUME_WINDOW_DAYS * 86400000);
  return (share * perMs * dtMs * POOL_FEE * bchPusd) / 1e8;
}

/** Fee APR a pool would earn at its current volume and liquidity, as %. Useful for choosing pools. */
export function feeAprPct(tokenTvlSats: number, volumeSats: number): number {
  if (!(tokenTvlSats > 0)) return 0;
  return ((volumeSats / VOLUME_WINDOW_DAYS) * 365 * POOL_FEE * 100) / tokenTvlSats;
}


export interface LpPosition {
  id: number;
  token_id: string;
  symbol: string;
  opened_at: number;
  deposit_pusd: number;
  bch_sats: number;
  tokens: number;
  k: number;
  entry_price_sats: number;
  stop_pct: number;
  fees_pusd: number;
  last_accrual_ts: number;
  value_pusd: number | null;
  il_pct: number | null;
  signal: string | null;
  thesis: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function openLps(env: Env): Promise<LpPosition[]> {
  return (await env.DB.prepare("SELECT * FROM lp_positions WHERE status = 'open'").all<LpPosition>()).results;
}

/** PUSD value of an open pool at today's price (pool along x*y=k, plus fees earned). Null when there is no price. */
export function lpValue(lp: LpPosition, prices: Prices): number | null {
  const price = prices.info(lp.token_id)?.price_now;
  if (!price) return null;
  return (poolValueSats(lp.k, price) * prices.bchPusd) / 1e8 + lp.fees_pusd;
}

/** Fund both sides from PUSD (half to BCH, half to the token) and open our micro-pool. */
export async function provide(L: Ledger, prices: Prices, p: Proposal, sizePusd: number, RISK: RiskLimits) {
  const half = Math.floor((sizePusd * 100) / 2);
  const toBch = await simulateSwap(PUSD, "bch", half, prices);
  const toTok = await simulateSwap(PUSD, p.token_id, half, prices);
  const impact = Math.max(toBch.impactPct, toTok.impactPct);
  if (impact > RISK.maxPriceImpactPct || toTok.amountOut <= 0) {
    await L.log("rune", "skip", `Skipped providing ${p.symbol} liquidity: price impact ${impact.toFixed(2)}% over ${RISK.maxPriceImpactPct}%.`);
    return null;
  }
  const price = prices.info(p.token_id)?.price_now ?? 0;
  const tokens = toTok.amountOut / 10 ** prices.decimals(p.token_id);
  // A pool holds equal value on both sides at the market price.
  const bchSats = Math.min(toBch.amountOut, tokens * price);
  const k = bchSats * (bchSats / price);
  await L.adjust("pusd", "PUSD", -half * 2);
  // Whatever BCH didn't fit the pool's ratio (the token leg pays more impact) stays in the wallet as BCH.
  if (toBch.amountOut - bchSats >= 1) await L.adjust("bch", "BCH", toBch.amountOut - bchSats);
  const now = Date.now();
  const r = await L.env.DB.prepare(
    "INSERT INTO lp_positions (token_id, symbol, opened_at, deposit_pusd, bch_sats, tokens, k, entry_price_sats, stop_pct, last_accrual_ts, value_pusd, il_pct, signal, thesis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
  )
    .bind(p.token_id, p.symbol, now, (half * 2) / 100, bchSats, bchSats / price, k, price, p.stop_pct > 0 ? Math.min(p.stop_pct, RISK.lpStopPct) : RISK.lpStopPct, now, (poolValueSats(k, price) * prices.bchPusd) / 1e8, p.signal ?? "liquidity", p.thesis)
    .run();
  const id = Number(r.meta.last_row_id);
  await L.recordTrade({ side: "lp-in", token_id: p.token_id, symbol: p.symbol, amount: Math.round(tokens), pusd: (half * 2) / 100, price_pusd: (price / 1e8) * prices.bchPusd, impact_pct: impact, estimated: toBch.estimated || toTok.estimated, position_id: null, reason: p.thesis });
  await L.log("rune", "fill", `PAPER LIQUIDITY ${p.symbol}: deposited ${r2((half * 2) / 100)} PUSD as ${r2(bchSats / 1e8 * 1000) / 1000} BCH + ${r2(bchSats / price)} ${p.symbol} (impact ${impact.toFixed(2)}%). Withdraw if down ${p.stop_pct || RISK.lpStopPct}%.`);
  return { side: "lp-in", symbol: p.symbol, pusd: r2((half * 2) / 100), lp_id: id, impact_pct: r2(impact) };
}

/** Withdraw both sides at today's price and sell them back to PUSD (paying exit impact). Fees are credited in PUSD. */
export async function withdraw(L: Ledger, prices: Prices, lp: LpPosition, reason: string) {
  const price = prices.info(lp.token_id)?.price_now;
  if (!price) {
    await L.log("rune", "alert", `Can't withdraw ${lp.symbol} liquidity: no price (UNAVAILABLE). Will retry next cycle.`);
    return null;
  }
  const { bchSats, tokens } = reservesAt(lp.k, price);
  const fromBch = await simulateSwap("bch", PUSD, Math.floor(bchSats), prices);
  const fromTok = await simulateSwap(lp.token_id, PUSD, Math.floor(tokens * 10 ** prices.decimals(lp.token_id)), prices);
  const out = (fromBch.amountOut + fromTok.amountOut) / 100 + lp.fees_pusd;
  await L.adjust("pusd", "PUSD", Math.round(out * 100));
  const il = impermanentLossPct(lp.entry_price_sats, price);
  await L.env.DB.prepare("UPDATE lp_positions SET status = 'closed', closed_at = ?, exit_pusd = ?, close_reason = ?, il_pct = ?, value_pusd = ? WHERE id = ?").bind(Date.now(), out, reason, il, out, lp.id).run();
  await L.recordTrade({ side: "lp-out", token_id: lp.token_id, symbol: lp.symbol, amount: Math.round(tokens), pusd: out, price_pusd: (price / 1e8) * prices.bchPusd, impact_pct: fromTok.impactPct, estimated: fromBch.estimated || fromTok.estimated, position_id: null, reason });
  const pnl = out - lp.deposit_pusd;
  await L.log("rune", "fill", `PAPER WITHDRAW ${lp.symbol} liquidity for ${r2(out)} PUSD, ${pnl >= 0 ? "+" : ""}${r2(pnl)} PUSD (fees ${r2(lp.fees_pusd)}, impermanent loss ${il.toFixed(1)}%). ${reason}.`);
  return { side: "lp-out", symbol: lp.symbol, pusd: r2(out), pnl_pusd: r2(pnl), lp_id: lp.id };
}

/**
 * Every cycle: add the fees earned since the last cycle, mark each pool, and withdraw on the stop or when the
 * token's liquidity is draining (others pulling out leaves us as everyone's exit).
 */
export async function tendLps(env: Env, L: Ledger, prices: Prices, RISK: RiskLimits, tvlDayAgo: Map<string, number>) {
  for (const lp of await openLps(env)) {
    const t = prices.info(lp.token_id);
    if (!t?.price_now) {
      await L.log("kade", "alert", `No price for ${lp.symbol}: our liquidity position's value is UNAVAILABLE this cycle, not unchanged.`);
      continue;
    }
    const now = Date.now();
    const ours = reservesAt(lp.k, t.price_now).bchSats;
    const fees = lp.fees_pusd + feeIncomePusd(ours, t.tvl_sats, t.trade_volume ?? 0, now - lp.last_accrual_ts, prices.bchPusd);
    const value = (poolValueSats(lp.k, t.price_now) * prices.bchPusd) / 1e8 + fees;
    const il = impermanentLossPct(lp.entry_price_sats, t.price_now);
    await env.DB.prepare("UPDATE lp_positions SET fees_pusd = ?, last_accrual_ts = ?, value_pusd = ?, il_pct = ? WHERE id = ?").bind(fees, now, value, il, lp.id).run();
    const tvl = t.tvl_sats / 1e8;
    const before = tvlDayAgo.get(lp.token_id);
    const drain = before ? ((before - tvl) / before) * 100 : 0;
    if (value <= lp.deposit_pusd * (1 - lp.stop_pct / 100)) await withdraw(L, prices, { ...lp, fees_pusd: fees }, `stop: value down ${r2(((lp.deposit_pusd - value) / lp.deposit_pusd) * 100)}%`);
    else if (drain >= RISK.lpDrainExitPct) await withdraw(L, prices, { ...lp, fees_pusd: fees }, `liquidity draining: ${lp.symbol} pools down ${drain.toFixed(0)}% in 24h`);
  }
}

/** Pools worth considering: enough liquidity and some volume, best estimated fee APR first. */
export function lpCandidates(list: { token_id: string; display_symbol?: string; tvl_sats: number; trade_volume?: number; first_pool_ts?: number }[], RISK: RiskLimits) {
  return list
    .filter((t) => t.token_id !== PUSD && t.tvl_sats / 1e8 >= RISK.minLpTvlBch && (t.trade_volume ?? 0) > 0)
    .map((t) => ({
      token_id: t.token_id,
      symbol: t.display_symbol ?? t.token_id.slice(0, 6),
      tvl_bch: r2(t.tvl_sats / 1e8),
      est_fee_apr_pct: r2(feeAprPct(t.tvl_sats, t.trade_volume ?? 0)),
      age_days: t.first_pool_ts ? r2((Date.now() / 1000 - t.first_pool_ts) / 86400) : null,
    }))
    .sort((a, b) => b.est_fee_apr_pct - a.est_fee_apr_pct)
    .slice(0, 10);
}
