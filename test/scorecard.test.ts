import { describe, expect, it } from "vitest";
import { scorecard, sizeScale } from "../src/scorecard";

const t = (horizon: string, cost: number, exit: number, signal = "momentum") => ({ horizon, signal, cost_pusd: cost, exit_pusd: exit });

describe("scorecard", () => {
  it("groups results by horizon and signal", () => {
    const c = scorecard([t("short", 10, 12), t("short", 10, 8, "dip"), t("medium", 100, 110)], 30);
    expect(c.overall.trades).toBe(3);
    expect(c.by_horizon.short.win_rate).toBe(0.5);
    expect(c.by_signal.dip.pnl_pusd).toBe(-2);
    expect(c.by_horizon.medium.avg_pnl_pct).toBeCloseTo(10);
  });

  it("shrinks bets on a losing horizon and never enlarges", () => {
    const losing = scorecard(Array.from({ length: 6 }, (_, i) => t("short", 10, i === 0 ? 11 : 8)), 30);
    expect(sizeScale(losing, "short")).toBe(0.25);
    expect(sizeScale(losing, "medium")).toBe(1);
    const winning = scorecard(Array.from({ length: 6 }, () => t("short", 10, 12)), 30);
    expect(sizeScale(winning, "short")).toBe(1);
    expect(sizeScale(scorecard([t("short", 10, 1)], 30), "short")).toBe(1); // too few trades to judge
  });
});
