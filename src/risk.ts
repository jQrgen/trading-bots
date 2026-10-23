import { RISK_DEFAULTS, ROUND_TRIP_FEE_PCT, type Horizon, type RiskLimits } from "./config";

export interface Proposal {
  id: string;
  action: "buy" | "sell" | "provide" | "withdraw";
  token_id: string;
  symbol: string;
  horizon: Horizon;
  size_pct: number;
  target_pct: number;
  stop_pct: number;
  thesis: string;
  bull_case?: string;
  bear_case?: string;
  signal?: string;
}

export interface TokenFacts {
  tvlBch: number;
  poolAgeHours: number;
  topOwnerSharePct: number; // share of the token's liquidity owned by its largest LP
  canQuote: boolean;
  feeAprPct?: number; // estimated fee APR of the token's pools, for liquidity proposals
}

export interface Book {
  totalPusd: number;
  byHorizonPusd: Record<Horizon, number>;
  heldPusd: number; // existing position in this token
  openShort: number;
  dayChangePct: number;
  bchPusd: number;
  buysToday?: number;
}

export interface RiskVerdict {
  pass: boolean;
  allowedPusd: number;
  reasons: string[];
}

/** Deterministic pre-trade checks. Can only shrink or reject a proposal, never enlarge it. */
export function checkBuy(p: Proposal, facts: TokenFacts | undefined, book: Book, halted: boolean, RISK: RiskLimits = RISK_DEFAULTS): RiskVerdict {
  const reasons: string[] = [];
  if (halted) reasons.push("desk is halted");
  if (book.dayChangePct <= -RISK.dailyLossHaltPct) reasons.push(`down ${book.dayChangePct.toFixed(1)}% in 24h, buying paused`);
  if (!facts) reasons.push("no market data for token");
  if (!["short", "medium", "long"].includes(p.horizon)) reasons.push(`unknown horizon ${p.horizon}`);
  if (!(p.stop_pct > 0) || p.stop_pct > RISK.maxStopPct) reasons.push(`stop must be between 0 and ${RISK.maxStopPct}%`);
  if (!(p.target_pct > 0)) reasons.push("target must be positive");
  if (reasons.length) return { pass: false, allowedPusd: 0, reasons };

  const h = p.horizon;
  const f = facts!;
  if (!f.canQuote) reasons.push("router can't quote this token");
  if (f.tvlBch < RISK.minTvlBch[h]) reasons.push(`liquidity ${f.tvlBch.toFixed(1)} BCH below ${RISK.minTvlBch[h]} BCH for ${h}`);
  if (f.poolAgeHours < RISK.minPoolAgeHours[h]) reasons.push(`pool age ${f.poolAgeHours.toFixed(0)}h below ${RISK.minPoolAgeHours[h]}h for ${h}`);
  if (f.topOwnerSharePct > RISK.maxOwnerSharePct) reasons.push(`one LP owns ${f.topOwnerSharePct.toFixed(0)}% of liquidity (rug risk)`);
  if (h === "short" && book.heldPusd === 0 && book.openShort >= RISK.maxOpenShort) reasons.push(`already ${book.openShort} open short-term bets`);
  if ((book.buysToday ?? 0) >= RISK.maxBuysPerDay) reasons.push(`already ${book.buysToday} buys in 24h (limit ${RISK.maxBuysPerDay}); thin market, no churn`);
  if (reasons.length) return { pass: false, allowedPusd: 0, reasons };

  let allowed = (book.totalPusd * Math.max(0, p.size_pct)) / 100;
  const posCap = (book.totalPusd * RISK.maxPositionPct[h]) / 100 - book.heldPusd;
  const bookCap = (book.totalPusd * RISK.maxBookPct[h]) / 100 - book.byHorizonPusd[h];
  const poolCap = (f.tvlBch * book.bchPusd * RISK.maxPoolSharePct) / 100 - book.heldPusd;
  if (allowed > poolCap) reasons.push(`size cut to ${RISK.maxPoolSharePct}% of pool liquidity`);
  if (allowed > posCap) reasons.push(`size cut to position cap ${RISK.maxPositionPct[h]}%`);
  if (allowed > bookCap) reasons.push(`size cut to ${h} book cap ${RISK.maxBookPct[h]}%`);
  const poolPusd = f.tvlBch * book.bchPusd;
  const riskCap = stressedCap(p.stop_pct, poolPusd, (book.totalPusd * RISK.maxRiskPerTradePct[h]) / 100, RISK.stopGapPct);
  if (allowed > riskCap) reasons.push(`size cut so a stopped-out trade loses at most ${RISK.maxRiskPerTradePct[h]}% of the book`);
  allowed = Math.max(0, Math.min(allowed, posCap, bookCap, poolCap, riskCap));
  if (allowed < RISK.minTradePusd) return { pass: false, allowedPusd: 0, reasons: [...reasons, `size ${allowed.toFixed(2)} PUSD below minimum`] };
  const cost = roundTripCostPct(allowed, poolPusd);
  if (p.target_pct < RISK.minTargetToCostRatio * cost)
    return { pass: false, allowedPusd: 0, reasons: [...reasons, `target ${p.target_pct}% is less than ${RISK.minTargetToCostRatio}x the ${cost.toFixed(1)}% round-trip cost`] };
  reasons.push(`if stopped out: about ${stressedLoss(allowed, p.stop_pct, poolPusd, RISK.stopGapPct).toFixed(2)} PUSD after overshoot, fees and exit impact`);
  return { pass: true, allowedPusd: allowed, reasons };
}

/** Fees plus price impact in and out, as % of the position. Constant product: each leg costs about size / pool. */
export function roundTripCostPct(sizePusd: number, poolPusd: number): number {
  if (!(poolPusd > 0)) return Infinity;
  return ROUND_TRIP_FEE_PCT + (200 * sizePusd) / poolPusd;
}

/** What a stopped-out position really loses: the stop plus its overshoot, fees, and impact on the way in and out. */
export function stressedLoss(sizePusd: number, stopPct: number, poolPusd: number, stopGapPct: number): number {
  return (sizePusd * (stopPct * (1 + stopGapPct / 100) + roundTripCostPct(sizePusd, poolPusd))) / 100;
}

/** Largest size whose stressed loss fits the budget. Solves s*(a + 200s/P)/100 = budget for s. */
export function stressedCap(stopPct: number, poolPusd: number, budgetPusd: number, stopGapPct: number): number {
  if (!(poolPusd > 0) || !(budgetPusd > 0)) return 0;
  const a = (stopPct * (1 + stopGapPct / 100) + ROUND_TRIP_FEE_PCT) / 100;
  const k = 2 / poolPusd; // s^2 coefficient
  return (-a + Math.sqrt(a * a + 4 * k * budgetPusd)) / (2 * k);
}

export interface LpBook { totalPusd: number; lpBookPusd: number; heldInPoolPusd: number; dayChangePct: number; bchPusd: number }

/** Funding both sides costs ~1.2% (PUSD->BCH, and PUSD->BCH->token for half); withdrawing costs about the same. */
export const LP_ROUND_TRIP_FEE_PCT = 2.4;

/**
 * Checks for providing liquidity. Same rules as buying (only shrinks, never enlarges), sized for the worst case:
 * a pool whose token dumps leaves us holding the token, so the stop plus overshoot and costs must fit the budget.
 */
export function checkProvide(p: Proposal, facts: TokenFacts | undefined, book: LpBook, halted: boolean, RISK: RiskLimits = RISK_DEFAULTS): RiskVerdict {
  const reasons: string[] = [];
  const stop = p.stop_pct > 0 ? Math.min(p.stop_pct, RISK.lpStopPct) : RISK.lpStopPct;
  if (halted) reasons.push("desk is halted");
  if (book.dayChangePct <= -RISK.dailyLossHaltPct) reasons.push(`down ${book.dayChangePct.toFixed(1)}% in 24h, new risk paused`);
  if (!facts) reasons.push("no market data for token");
  if (reasons.length) return { pass: false, allowedPusd: 0, reasons };
  const f = facts!;
  if (!f.canQuote) reasons.push("router can't quote this token");
  if (f.tvlBch < RISK.minLpTvlBch) reasons.push(`liquidity ${f.tvlBch.toFixed(1)} BCH below ${RISK.minLpTvlBch} BCH for a pool`);
  if (f.poolAgeHours < RISK.minLpPoolAgeHours) reasons.push(`pool age ${f.poolAgeHours.toFixed(0)}h below ${RISK.minLpPoolAgeHours}h`);
  if (f.topOwnerSharePct > RISK.maxOwnerSharePct) reasons.push(`one LP owns ${f.topOwnerSharePct.toFixed(0)}% of liquidity (rug risk)`);
  if (f.feeAprPct !== undefined && f.feeAprPct < RISK.minLpFeeAprPct) reasons.push(`estimated fee APR ${f.feeAprPct.toFixed(1)}% below ${RISK.minLpFeeAprPct}%`);
  if (reasons.length) return { pass: false, allowedPusd: 0, reasons };

  const tvlPusd = f.tvlBch * book.bchPusd;
  const share = RISK.maxLpPoolSharePct / 100;
  let allowed = (book.totalPusd * Math.max(0, p.size_pct)) / 100;
  const posCap = (book.totalPusd * RISK.maxLpPositionPct) / 100 - book.heldInPoolPusd;
  const bookCap = (book.totalPusd * RISK.maxLpBookPct) / 100 - book.lpBookPusd;
  const shareCap = (2 * share * tvlPusd) / (1 - share) - book.heldInPoolPusd; // our BCH side vs everyone's
  const stressed = (stop * (1 + RISK.stopGapPct / 100) + LP_ROUND_TRIP_FEE_PCT) / 100;
  const riskCap = (book.totalPusd * RISK.maxRiskPerTradePct.long) / 100 / stressed;
  if (allowed > shareCap) reasons.push(`size cut to ${RISK.maxLpPoolSharePct}% of the token's liquidity`);
  if (allowed > posCap) reasons.push(`size cut to the ${RISK.maxLpPositionPct}% per-pool cap`);
  if (allowed > bookCap) reasons.push(`size cut to the ${RISK.maxLpBookPct}% liquidity book cap`);
  if (allowed > riskCap) reasons.push(`size cut so a ${stop}% stop (plus overshoot and costs) loses at most ${RISK.maxRiskPerTradePct.long}% of the book`);
  allowed = Math.max(0, Math.min(allowed, posCap, bookCap, shareCap, riskCap));
  if (allowed < RISK.minTradePusd) return { pass: false, allowedPusd: 0, reasons: [...reasons, `size ${allowed.toFixed(2)} PUSD below minimum`] };
  if (f.feeAprPct !== undefined) reasons.push(`estimated fee APR ${f.feeAprPct.toFixed(0)}% before impermanent loss`);
  return { pass: true, allowedPusd: allowed, reasons };
}

export function priceImpactPct(pre: number, post: number): number {
  if (!(pre > 0)) return Infinity;
  return (Math.abs(post - pre) / pre) * 100;
}

export type ExitReason = "stop" | "target" | null;

export function exitSignal(entry: number, now: number, targetPct: number, stopPct: number): ExitReason {
  if (!(entry > 0) || !(now > 0)) return null;
  const change = ((now - entry) / entry) * 100;
  if (change <= -stopPct) return "stop";
  if (change >= targetPct) return "target";
  return null;
}
