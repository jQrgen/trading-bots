import { describe, expect, it } from "vitest";
import { checkBuy, exitSignal, priceImpactPct, type Book, type Proposal, type TokenFacts } from "../src/risk";

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: "p1", action: "buy", token_id: "t", symbol: "T", horizon: "medium", size_pct: 5, target_pct: 20, stop_pct: 10, thesis: "x", ...o,
});
const facts = (o: Partial<TokenFacts> = {}): TokenFacts => ({ tvlBch: 100, poolAgeHours: 1000, topOwnerSharePct: 40, canQuote: true, ...o });
const book = (o: Partial<Book> = {}): Book => ({ totalPusd: 1000, byHorizonPusd: { short: 0, medium: 0, long: 0 }, heldPusd: 0, openShort: 0, dayChangePct: 0, ...o });

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

  it("rejects rug signals", () => {
    expect(checkBuy(proposal(), facts({ topOwnerSharePct: 99 }), book(), false).reasons.join()).toMatch(/rug/);
    expect(checkBuy(proposal(), facts({ tvlBch: 3 }), book(), false).pass).toBe(false);
    expect(checkBuy(proposal({ horizon: "short", size_pct: 2 }), facts({ poolAgeHours: 2 }), book(), false).pass).toBe(false);
    expect(checkBuy(proposal(), undefined, book(), false).pass).toBe(false);
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
