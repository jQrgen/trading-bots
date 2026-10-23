import { describe, expect, it } from "vitest";
import { RISK_DEFAULTS } from "../src/config";
import { parseRiskLimits, SEED } from "../src/knowledge";

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
});

describe("seed knowledge", () => {
  it("has every agent role, the strategy, market notes, team and limits", () => {
    const keys = SEED.map((d) => d.key);
    for (const k of ["strategy", "market", "shared", "team", "risk-limits", "role:nova", "role:orin", "role:vela", "role:kade", "role:rune", "role:zara"]) expect(keys).toContain(k);
    for (const d of SEED.filter((x) => x.format === "json")) expect(() => JSON.parse(d.body)).not.toThrow();
    expect(SEED.every((d) => d.body.length > 20)).toBe(true);
  });
});
