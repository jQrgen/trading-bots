import { describe, expect, it } from "vitest";
import { RISK_DEFAULTS } from "../src/config";
import { parseRiskLimits, saveKnowledge, SEED } from "../src/knowledge";

describe("parseRiskLimits", () => {
  it("merges partial owner edits over the defaults", () => {
    const r = parseRiskLimits(JSON.stringify({ maxPriceImpactPct: 2, minTvlBch: { short: 10 } }));
    expect(r.maxPriceImpactPct).toBe(2);
    expect(r.minTvlBch.short).toBe(10);
    expect(r.minTvlBch.long).toBe(RISK_DEFAULTS.minTvlBch.long);
  });

  it("rejects nonsense when the owner saves, and falls back when the bots read", () => {
    expect(() => parseRiskLimits(JSON.stringify({ maxPoolSharePct: 500 }), true)).toThrow(/maxPoolSharePct/);
    expect(() => parseRiskLimits(JSON.stringify({ maxStopPct: -1 }), true)).toThrow();
    expect(() => parseRiskLimits("not json", true)).toThrow();
    expect(parseRiskLimits(JSON.stringify({ maxPoolSharePct: 500 })).maxPoolSharePct).toBe(RISK_DEFAULTS.maxPoolSharePct);
    expect(parseRiskLimits("not json")).toEqual(RISK_DEFAULTS);
  });

  it("does not mutate the defaults", () => {
    parseRiskLimits(JSON.stringify({ maxPositionPct: { short: 1 } }));
    expect(RISK_DEFAULTS.maxPositionPct.short).toBe(3);
  });

  it("stores the single-LP rule as off and keeps the other limits", () => {
    expect(RISK_DEFAULTS.maxOwnerSharePct).toBeNull();
    expect(parseRiskLimits("{}").maxOwnerSharePct).toBeNull();
    expect(parseRiskLimits(JSON.stringify({ maxOwnerSharePct: null })).maxOwnerSharePct).toBeNull();
    expect(parseRiskLimits(JSON.stringify({ maxOwnerSharePct: 90 })).maxOwnerSharePct).toBe(90);
    expect(() => parseRiskLimits(JSON.stringify({ maxOwnerSharePct: 101 }), true)).toThrow(/maxOwnerSharePct/);
    expect(RISK_DEFAULTS.liveMaxTradePusd).toBe(25);
    expect(RISK_DEFAULTS.liveMaxDailyBuyPusd).toBe(150);
    expect(RISK_DEFAULTS.minTvlBch).toEqual({ short: 5, medium: 25, long: 100 });
    expect(RISK_DEFAULTS.maxStopPct).toBe(50);
    expect(RISK_DEFAULTS.dailyLossHaltPct).toBe(10);
    const stored = JSON.parse(SEED.find((d) => d.key === "risk-limits")!.body);
    expect(stored.maxOwnerSharePct).toBeNull();
    expect(stored.liveMaxTradePusd).toBe(25);
    expect(stored.liveMaxDailyBuyPusd).toBe(150);
  });

  it("refuses risk-limit edits from bots", async () => {
    await expect(saveKnowledge({} as never, "risk-limits", "{}", "vela")).rejects.toThrow(/owner/);
  });
});

describe("seed knowledge", () => {
  it("has every agent role, the strategy, market notes, team and limits", () => {
    const keys = SEED.map((d) => d.key);
    for (const k of ["strategy", "market", "shared", "team", "risk-limits", "role:nova", "role:orin", "role:vela", "role:kade", "role:rune", "role:zara"]) expect(keys).toContain(k);
    for (const d of SEED.filter((x) => x.format === "json")) expect(() => JSON.parse(d.body)).not.toThrow();
    expect(SEED.every((d) => d.body.length > 20)).toBe(true);
  });
});
