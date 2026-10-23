import { RISK, type Horizon } from "./config";

export interface Proposal {
  id: string;
  action: "buy" | "sell";
  token_id: string;
  symbol: string;
  horizon: Horizon;
  size_pct: number;
  target_pct: number;
  stop_pct: number;
  thesis: string;
  bull_case?: string;
  bear_case?: string;
}

export interface TokenFacts {
  tvlBch: number;
  poolAgeHours: number;
  topOwnerSharePct: number; // share of the token's liquidity owned by its largest LP
  canQuote: boolean;
}

export interface Book {
  totalPusd: number;
  byHorizonPusd: Record<Horizon, number>;
  heldPusd: number; // existing position in this token
  openShort: number;
  dayChangePct: number;
}

export interface RiskVerdict {
  pass: boolean;
  allowedPusd: number;
  reasons: string[];
}

/** Deterministic pre-trade checks. Can only shrink or reject a proposal, never enlarge it. */
export function checkBuy(p: Proposal, facts: TokenFacts | undefined, book: Book, halted: boolean): RiskVerdict {
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
  if (reasons.length) return { pass: false, allowedPusd: 0, reasons };

  let allowed = (book.totalPusd * Math.max(0, p.size_pct)) / 100;
  const posCap = (book.totalPusd * RISK.maxPositionPct[h]) / 100 - book.heldPusd;
  const bookCap = (book.totalPusd * RISK.maxBookPct[h]) / 100 - book.byHorizonPusd[h];
  if (allowed > posCap) reasons.push(`size cut to position cap ${RISK.maxPositionPct[h]}%`);
  if (allowed > bookCap) reasons.push(`size cut to ${h} book cap ${RISK.maxBookPct[h]}%`);
  allowed = Math.max(0, Math.min(allowed, posCap, bookCap));
  if (allowed < RISK.minTradePusd) return { pass: false, allowedPusd: 0, reasons: [...reasons, `size ${allowed.toFixed(2)} PUSD below minimum`] };
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
