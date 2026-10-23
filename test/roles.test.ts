import { describe, expect, it } from "vitest";
import { cycleBanner, deriveCycle, hhmm, nextJournalAt, roleFromThinkingPath, roleLine, RUN_WINDOW_MS, tradeNextLabel } from "../src/roles";

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

describe("who is working", () => {
  const start = Date.UTC(2026, 9, 23, 16, 0, 0);
  const cycle = { cycle: 27, ts: start };
  const snap = (over: Partial<Parameters<typeof deriveCycle>[0]> = {}) =>
    deriveCycle({ now: start + 1000, cycle, runnerState: "running", writes: [], decisionsAt: null, journalSince: null, ...over });

  it("starts the cycle on Orin when the briefing is fetched", () => {
    const live = snap();
    expect(live).toMatchObject({ cycle_running: true, cycle: 27, active_role: "orin", active_since: start, step: "Orin scan" });
    expect(cycleBanner(live, start + 15 * 60 * 1000, start + 1000)).toBe("Cycle 27 running, step Orin scan");
    expect(roleFromThinkingPath("vela/thinking.md")).toBe("vela");
    expect(roleFromThinkingPath("Vela/thinking.md")).toBe("vela");
    expect(roleFromThinkingPath("vela/watchlist.md")).toBeNull();
    expect(roleFromThinkingPath("team/thinking.md")).toBeNull();
  });

  it("holds a role from its first thinking.md write until the next role writes", () => {
    const orin = snap({ now: start + 9000, writes: [{ role: "orin", at: start + 5000 }, { role: "orin", at: start + 8000 }] });
    expect(orin.active_role).toBe("orin");
    expect(orin.active_since).toBe(start + 5000);
    const velaAt = start + 20_000;
    const vela = snap({
      now: start + 40_000,
      writes: [
        { role: "orin", at: start + 5000 },
        { role: "vela", at: velaAt },
        { role: "vela", at: start + 30_000 },
        { role: "kade", at: start - 60_000 },
      ],
    });
    expect(vela).toMatchObject({ active_role: "vela", active_since: velaAt, step: "Vela research" });
    const novaAt = start + 50_000;
    const nova = snap({ now: novaAt + 1000, writes: [{ role: "kade", at: start + 40_000 }, { role: "nova", at: novaAt }] });
    expect(nova).toMatchObject({ active_role: "nova", active_since: novaAt, step: "Nova decisions" });
  });

  it("moves to Rune when decisions are posted and goes idle once the cycle is closed or 30 minutes old", () => {
    const at = start + 60_000;
    const exec = snap({ now: at + 1000, writes: [{ role: "nova", at: start + 50_000 }], decisionsAt: at });
    expect(exec).toMatchObject({ cycle_running: true, active_role: "rune", active_since: at, step: "Rune execution" });
    expect(cycleBanner(exec, start + 15 * 60 * 1000, at + 1000)).toBe("Cycle 27 running, step Rune execution");
    const done = snap({ now: at + 2000, runnerState: "complete", writes: [{ role: "nova", at: start + 50_000 }], decisionsAt: at });
    expect(done.cycle_running).toBe(false);
    expect(done.active_role).toBeNull();
    expect(cycleBanner(done, start + 15 * 60 * 1000, at + 2000)).toBe(`idle, next run ${hhmm(start + 15 * 60 * 1000)}`);
    const expired = snap({ now: start + RUN_WINDOW_MS });
    expect(expired.cycle_running).toBe(false);
    expect(cycleBanner(expired, start + 15 * 60 * 1000, start + RUN_WINDOW_MS)).toBe(`idle, next run overdue (was due ${hhmm(start + 15 * 60 * 1000)})`);
    expect(cycleBanner(done, start + 15 * 60 * 1000, start + 15 * 60 * 1000 + 60 * 1000)).toBe("idle, next run due");
    expect(cycleBanner(snap({ cycle: null, runnerState: null, now: start }), null, start)).toBe("idle, next run every 15 min");
  });

  it("shows Zara for the journal, including when she writes during a cycle", () => {
    const at = start + 90_000;
    const during = snap({ now: at + 1000, writes: [{ role: "zara", at }] });
    expect(during).toMatchObject({ active_role: "zara", active_since: at, step: "Zara journal" });
    expect(cycleBanner(during, null, at + 1000)).toBe("Cycle 27 running, step Zara journal");
    const journal = snap({ now: at + 1000, cycle, runnerState: "complete", journalSince: at });
    expect(journal).toMatchObject({ cycle_running: true, active_role: "zara", active_since: at, step: "Zara journal" });
    const posted = snap({ now: at + 5000, runnerState: "complete", journalSince: null });
    expect(posted.cycle_running).toBe(false);
    const stale = snap({ now: at + RUN_WINDOW_MS, runnerState: "complete", journalSince: at });
    expect(stale.cycle_running).toBe(false);
  });
});
