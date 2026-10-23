import { describe, expect, it } from "vitest";
import { hhmm, nextJournalAt, roleLine, tradeNextLabel } from "../src/roles";

describe("role status lines", () => {
  const now = Date.UTC(2026, 9, 23, 16, 5, 0);

  it("names the cycle, the conclusion, and the next run", () => {
    expect(roleLine(27, "Scanned 40 tokens, 8 signals.", "next 16:20 UTC")).toBe("Cycle 27: Scanned 40 tokens, 8 signals. · next 16:20 UTC");
    expect(roleLine(27, null, "journal 21:00 UTC")).toBe("Cycle 27: no action this cycle · journal 21:00 UTC");
    expect(roleLine(null, null, "every 15 min")).toBe("Waiting for Cauldron Trader · every 15 min");
  });

  it("schedules the next trade 15 minutes after the last briefing and the journal at 21:00 UTC", () => {
    const last = now - 5 * 60 * 1000;
    expect(tradeNextLabel(last, now)).toBe(`next ${hhmm(last + 15 * 60 * 1000)}`);
    expect(tradeNextLabel(now - 16 * 60 * 1000, now)).toBe("next run due");
    expect(tradeNextLabel(now - 20 * 60 * 1000, now)).toBe(`next run overdue (was due ${hhmm(now - 5 * 60 * 1000)})`);
    expect(hhmm(nextJournalAt(21, now))).toBe("21:00 UTC");
  });
});
