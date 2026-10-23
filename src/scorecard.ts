import type { Horizon } from "./config";

export interface ClosedTrade { horizon: string; signal: string | null; cost_pusd: number; exit_pusd: number }
export interface Bucket { trades: number; win_rate: number; avg_pnl_pct: number; pnl_pusd: number }
export interface Scorecard { window_days: number; overall: Bucket; by_horizon: Record<string, Bucket>; by_signal: Record<string, Bucket> }

function bucket(rows: ClosedTrade[]): Bucket {
  const pnl = rows.map((r) => r.exit_pusd - r.cost_pusd);
  const pct = rows.map((r) => ((r.exit_pusd - r.cost_pusd) / r.cost_pusd) * 100);
  return {
    trades: rows.length,
    win_rate: rows.length ? pnl.filter((x) => x > 0).length / rows.length : 0,
    avg_pnl_pct: rows.length ? pct.reduce((a, b) => a + b, 0) / rows.length : 0,
    pnl_pusd: pnl.reduce((a, b) => a + b, 0),
  };
}

function groupBy(rows: ClosedTrade[], key: (r: ClosedTrade) => string) {
  const m = new Map<string, ClosedTrade[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return Object.fromEntries([...m].map(([k, v]) => [k, bucket(v)]));
}

/** What has worked recently. Fed to the agents every cycle so the team learns from its own results. */
export function scorecard(rows: ClosedTrade[], windowDays: number): Scorecard {
  return {
    window_days: windowDays,
    overall: bucket(rows),
    by_horizon: groupBy(rows, (r) => r.horizon),
    by_signal: groupBy(rows, (r) => r.signal ?? "unknown"),
  };
}

/**
 * Size multiplier per horizon from the track record. A horizon that keeps losing gets smaller bets
 * until it recovers; one that works earns back to full size. Never above 1, so it can only shrink.
 */
export function sizeScale(card: Scorecard, horizon: Horizon): number {
  const b = card.by_horizon[horizon];
  if (!b || b.trades < 5) return 1;
  if (b.pnl_pusd >= 0) return 1;
  if (b.win_rate < 0.25) return 0.25;
  if (b.win_rate < 0.4) return 0.5;
  return 0.75;
}
