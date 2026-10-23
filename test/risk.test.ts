import { describe, expect, it } from "vitest";
import { RISK_DEFAULTS } from "../src/config";
import { checkProvide } from "../src/risk";
import { feeIncomePusd, impermanentLossPct, poolValueSats, reservesAt } from "../src/lp";
import { checkBuy, exitSignal, priceImpactPct, roundTripCostPct, stressedCap, stressedLoss, type Book, type Proposal, type TokenFacts } from "../src/risk";

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: "p1", action: "buy", token_id: "t", symbol: "T", horizon: "medium", size_pct: 5, target_pct: 20, stop_pct: 10, thesis: "x", ...o,
});
const facts = (o: Partial<TokenFacts> = {}): TokenFacts => ({ tvlBch: 100, poolAgeHours: 1000, topOwnerSharePct: 40, canQuote: true, ...o });
const book = (o: Partial<Book> = {}): Book => ({ totalPusd: 1000, byHorizonPusd: { short: 0, medium: 0, long: 0 }, heldPusd: 0, openShort: 0, dayChangePct: 0, bchPusd: 300, ...o });

describe("checkBuy", () => {
  it("passes a sane proposal at the requested size", () => {
    const v = checkBuy(proposal(), facts(), book(), false);
    expect(v.pass).toBe(true);
    expect(v.allowedPusd).toBe(50);
  });

  it("never enlarges, only cuts to the position cap", () => {
    const v = checkBuy(proposal({ size_pct: 50 }), facts(), book(), false);
    expect(v.pass).toBe(true);
    expect(v.allowedPusd).toBe(100); // medium cap 10%
  });

  it("respects the horizon book cap", () => {
    const v = checkBuy(proposal({ horizon: "short", size_pct: 3 }), facts(), book({ byHorizonPusd: { short: 140, medium: 0, long: 0 } }), false);
    expect(v.allowedPusd).toBe(10);
  });

  it("rejects when halted, on big daily loss, or with a bad stop", () => {
    expect(checkBuy(proposal(), facts(), book(), true).pass).toBe(false);
    expect(checkBuy(proposal(), facts(), book({ dayChangePct: -12 }), false).pass).toBe(false);
    expect(checkBuy(proposal({ stop_pct: 0 }), facts(), book(), false).pass).toBe(false);
    expect(checkBuy(proposal({ stop_pct: 80 }), facts(), book(), false).pass).toBe(false);
  });

  it("rejects thin, young and unknown pools, and does not reject a single LP unless that rule is on", () => {
    expect(checkBuy(proposal(), facts({ topOwnerSharePct: 100 }), book(), false).pass).toBe(true);
    const on = { ...RISK_DEFAULTS, maxOwnerSharePct: 90 };
    expect(checkBuy(proposal(), facts({ topOwnerSharePct: 99 }), book(), false, on).reasons.join()).toMatch(/one LP/);
    expect(checkBuy(proposal(), facts({ tvlBch: 3 }), book(), false).pass).toBe(false);
    expect(checkBuy(proposal({ horizon: "short", size_pct: 2 }), facts({ poolAgeHours: 2 }), book(), false).pass).toBe(false);
    expect(checkBuy(proposal(), undefined, book(), false).pass).toBe(false);
  });

  it("caps size to a share of pool liquidity so we can exit", () => {
    const v = checkBuy(proposal(), facts({ tvlBch: 30 }), book({ totalPusd: 100000 }), false);
    expect(v.pass).toBe(true);
    expect(v.allowedPusd).toBeCloseTo(180); // 2% of 30 BCH * 300 PUSD/BCH
    expect(v.reasons.join()).toMatch(/pool liquidity/);
  });

  it("limits open short-term bets", () => {
    expect(checkBuy(proposal({ horizon: "short", size_pct: 2 }), facts(), book({ openShort: 5 }), false).pass).toBe(false);
  });

  it("rejects trades under the minimum size", () => {
    expect(checkBuy(proposal({ size_pct: 0.1 }), facts(), book(), false).pass).toBe(false);
  });
});

describe("exitSignal", () => {
  it("fires stop and target", () => {
    expect(exitSignal(1, 0.85, 20, 10)).toBe("stop");
    expect(exitSignal(1, 1.25, 20, 10)).toBe("target");
    expect(exitSignal(1, 1.05, 20, 10)).toBe(null);
    expect(exitSignal(0, 1, 20, 10)).toBe(null);
  });
});

describe("priceImpactPct", () => {
  it("measures relative move", () => {
    expect(priceImpactPct(100, 103)).toBeCloseTo(3);
    expect(priceImpactPct(0, 1)).toBe(Infinity);
  });
});

describe("Cauldron cost-aware sizing", () => {
  it("caps size so the stressed loss equals the budget", () => {
    const cap = stressedCap(20, 3000, 10, 50);
    expect(stressedLoss(cap, 20, 3000, 50)).toBeCloseTo(10, 6);
    expect(cap).toBeLessThan(10 / 0.2); // smaller than the naive stop-distance size
  });

  it("cuts a wide-stop position to the risk budget", () => {
    const v = checkBuy(proposal({ horizon: "long", size_pct: 30, stop_pct: 40, target_pct: 100 }), facts({ tvlBch: 500, poolAgeHours: 2000 }), book(), false);
    expect(v.pass).toBe(true);
    expect(v.allowedPusd).toBeLessThan(65); // 4% budget / (60% stressed stop + costs)
    expect(v.reasons.join()).toMatch(/stopped-out trade loses at most 4%/);
  });

  it("rejects a target that doesn't pay for the round trip", () => {
    const v = checkBuy(proposal({ target_pct: 4 }), facts(), book(), false);
    expect(v.pass).toBe(false);
    expect(v.reasons.join()).toMatch(/round-trip cost/);
    expect(roundTripCostPct(50, 30000)).toBeCloseTo(1.6 + 100 / 300, 6);
  });

  it("has no practical daily trade limit by default, but honours one the owner sets", () => {
    expect(checkBuy(proposal(), facts(), book({ buysToday: 50 }), false).pass).toBe(true);
    const tight = { ...RISK_DEFAULTS, maxBuysPerDay: 4 };
    expect(checkBuy(proposal(), facts(), book({ buysToday: 4 }), false, tight).reasons.join()).toMatch(/buys in 24h/);
  });
});

describe("liquidity providing", () => {
  it("follows x*y=k and measures impermanent loss", () => {
    const k = 1e8 * 1000; // 1 BCH and 1000 tokens at 100,000 sats per token
    expect(reservesAt(k, 1e5).bchSats).toBeCloseTo(1e8, 0);
    expect(poolValueSats(k, 4e5)).toBeCloseTo(4e8, 0); // price x4: value doubles, holding would be x2.5
    expect(impermanentLossPct(1e5, 4e5)).toBeCloseTo(-20, 1);
    expect(impermanentLossPct(1e5, 2e5)).toBeCloseTo(-5.72, 1);
    expect(impermanentLossPct(1e5, 1e5)).toBeCloseTo(0, 6);
  });

  it("earns fees in proportion to its share of liquidity", () => {
    const day = 86400000;
    // our 1 BCH next to 9 BCH; 30 BCH volume over 30 days = 1 BCH a day; 0.3% fee; BCH = 300 PUSD
    expect(feeIncomePusd(1e8, 9e8, 30e8, day, 300)).toBeCloseTo(0.1 * 1 * 0.003 * 300, 6);
    expect(feeIncomePusd(1e8, 9e8, 0, day, 300)).toBe(0);
  });

  it("checks pools like trades and caps our share of the pool", () => {
    const lp = { totalPusd: 1000, lpBookPusd: 0, heldInPoolPusd: 0, dayChangePct: 0, bchPusd: 300 };
    const ok = checkProvide(proposal({ action: "provide", size_pct: 10, stop_pct: 20 }), facts({ feeAprPct: 30 }), lp, false);
    expect(ok.pass).toBe(true);
    expect(ok.allowedPusd).toBeLessThanOrEqual(100);
    expect(checkProvide(proposal({ action: "provide", size_pct: 10 }), facts({ topOwnerSharePct: 100, feeAprPct: 30 }), lp, false).pass).toBe(true);
    expect(checkProvide(proposal({ action: "provide", size_pct: 10 }), facts({ feeAprPct: 2 }), lp, false).reasons.join()).toMatch(/fee APR/);
    expect(checkProvide(proposal({ action: "provide", size_pct: 10 }), facts({ tvlBch: 10 }), lp, false).pass).toBe(false);
    const tiny = checkProvide(proposal({ action: "provide", size_pct: 10 }), facts({ tvlBch: 26 }), { ...lp, totalPusd: 100000 }, false);
    expect(tiny.reasons.join()).toMatch(/of the token's liquidity/);
  });
});
