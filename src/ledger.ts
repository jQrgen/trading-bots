import type { Env, Horizon } from "./config";
import { modeOf, type Mode } from "./live";
import type { Proposal } from "./risk";

export type Agent = "nova" | "orin" | "vela" | "kade" | "rune" | "zara" | "desk";

export interface Holding { asset: string; symbol: string; amount: number }
export interface Position {
  id: number;
  token_id: string;
  symbol: string;
  horizon: Horizon;
  amount: number;
  cost_pusd: number;
  entry_price_pusd: number;
  target_pct: number;
  stop_pct: number;
  signal: string | null;
  thesis: string | null;
  opened_at: number;
  status: string;
}

export class Ledger {
  constructor(readonly env: Env, public cycle: number) {}
  private get db() { return this.env.DB; }
  private modeCache?: Mode;

  /** Paper or live, as the owner last set it on the desk. Read once per ledger so a cycle never mixes the two. */
  async mode(): Promise<Mode> {
    return (this.modeCache ??= await modeOf(this.env));
  }
  async live() { return (await this.mode()) === "live"; }

  async log(agent: Agent, kind: string, message: string, data?: unknown) {
    await this.db
      .prepare("INSERT INTO events (ts, cycle, agent, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), this.cycle, agent, kind, message, data === undefined ? null : JSON.stringify(data))
      .run();
  }

  async status(agent: Agent, status: string) {
    await this.db
      .prepare("INSERT INTO agent_status (agent, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at")
      .bind(agent, status, Date.now())
      .run();
  }

  async holdings(): Promise<Holding[]> {
    return (await this.db.prepare("SELECT asset, symbol, amount FROM holdings").all<Holding>()).results;
  }

  async adjust(asset: string, symbol: string, delta: number) {
    await this.db
      .prepare("INSERT INTO holdings (asset, symbol, amount) VALUES (?, ?, ?) ON CONFLICT(asset) DO UPDATE SET amount = amount + excluded.amount")
      .bind(asset, symbol, Math.round(delta))
      .run();
    await this.db.prepare("DELETE FROM holdings WHERE amount <= 0 AND asset != 'pusd'").run();
  }

  async openPositions(): Promise<Position[]> {
    return (await this.db.prepare("SELECT * FROM positions WHERE status = 'open'").all<Position>()).results;
  }

  async openPosition(p: Omit<Position, "id" | "opened_at" | "status">): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO positions (token_id, symbol, horizon, amount, cost_pusd, entry_price_pusd, target_pct, stop_pct, signal, thesis, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.token_id, p.symbol, p.horizon, p.amount, p.cost_pusd, p.entry_price_pusd, p.target_pct, p.stop_pct, p.signal, p.thesis, Date.now())
      .run();
    return Number(r.meta.last_row_id);
  }

  async saveProposal(p: Proposal, agent: string) {
    await this.db
      .prepare("INSERT OR REPLACE INTO proposals (id, ts, cycle, agent, action, token_id, symbol, horizon, size_pct, target_pct, stop_pct, signal, thesis, bull_case, bear_case, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')")
      .bind(p.id, Date.now(), this.cycle, agent, p.action, p.token_id, p.symbol, p.horizon, p.size_pct ?? null, p.target_pct ?? null, p.stop_pct ?? null, p.signal ?? null, p.thesis ?? null, p.bull_case ?? null, p.bear_case ?? null)
      .run();
  }

  async updateProposal(id: string, f: { status: string; allowed_pusd?: number; risk_notes?: string; decision_note?: string; position_id?: number | null }) {
    await this.db
      .prepare("UPDATE proposals SET status = ?, allowed_pusd = COALESCE(?, allowed_pusd), risk_notes = COALESCE(?, risk_notes), decision_note = COALESCE(?, decision_note), position_id = COALESCE(?, position_id) WHERE id = ?")
      .bind(f.status, f.allowed_pusd ?? null, f.risk_notes ?? null, f.decision_note ?? null, f.position_id ?? null, id)
      .run();
  }

  async recordTrade(t: { side: "buy" | "sell" | "lp-in" | "lp-out" | "correction" | "convert"; token_id: string; symbol: string; amount: number; pusd: number; price_pusd: number; impact_pct: number; estimated: boolean; position_id: number | null; reason: string; txid?: string }) {
    await this.db
      .prepare("INSERT INTO trades (ts, cycle, mode, side, token_id, symbol, amount, pusd, price_pusd, impact_pct, estimated, position_id, reason, txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), this.cycle, await this.mode(), t.side, t.token_id, t.symbol, t.amount, t.pusd, t.price_pusd, t.impact_pct, t.estimated ? 1 : 0, t.position_id, t.reason, t.txid ?? null)
      .run();
  }

  async recordTicks(rows: { token_id: string; symbol: string; price_pusd: number | null; tvl_bch: number; chg_24h_pct: number; volume_sats: number | null }[]) {
    const ts = Date.now();
    const stmt = this.db.prepare("INSERT OR IGNORE INTO market_ticks (ts, token_id, symbol, price_pusd, tvl_bch, chg_24h_pct, volume_sats) VALUES (?, ?, ?, ?, ?, ?, ?)");
    await this.db.batch(rows.map((r) => stmt.bind(ts, r.token_id, r.symbol, r.price_pusd, r.tvl_bch, r.chg_24h_pct, r.volume_sats)));
  }

  async closePosition(id: number, exitPusd: number, reason: string) {
    await this.db
      .prepare("UPDATE positions SET status = 'closed', closed_at = ?, exit_pusd = ?, close_reason = ? WHERE id = ?")
      .bind(Date.now(), exitPusd, reason, id)
      .run();
  }

  /** Liquidity per token at the market tick closest to msAgo, for spotting growing or draining pools. */
  async tvlAt(msAgo: number): Promise<Map<string, number>> {
    const rows = await this.db
      .prepare("SELECT token_id, tvl_bch FROM market_ticks WHERE ts = (SELECT MAX(ts) FROM market_ticks WHERE ts <= ?)")
      .bind(Date.now() - msAgo)
      .all<{ token_id: string; tvl_bch: number }>();
    return new Map(rows.results.map((r) => [r.token_id, r.tvl_bch]));
  }

  /** Closed positions in the window, for the team's scorecard. */
  async closedSince(ms: number) {
    return (
      await this.db
        .prepare(
          `SELECT horizon, signal, cost_pusd, exit_pusd, opened_at, closed_at FROM positions WHERE status = 'closed' AND closed_at >= ?1
           UNION ALL SELECT 'liquidity', 'liquidity', deposit_pusd, exit_pusd, opened_at, closed_at FROM lp_positions WHERE status = 'closed' AND closed_at >= ?1`,
        )
        .bind(Date.now() - ms)
        .all<{ horizon: string; signal: string | null; cost_pusd: number; exit_pusd: number; opened_at: number; closed_at: number }>()
    ).results;
  }

  async snapshot(totalPusd: number, bchPusd: number) {
    await this.db.prepare("INSERT OR REPLACE INTO snapshots (ts, total_pusd, bch_pusd, mode) VALUES (?, ?, ?, ?)").bind(Date.now(), totalPusd, bchPusd, await this.mode()).run();
  }

  async valueAt(msAgo: number): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT total_pusd FROM snapshots WHERE ts <= ? AND mode = ? ORDER BY ts DESC LIMIT 1")
      .bind(Date.now() - msAgo, await this.mode())
      .first<{ total_pusd: number }>();
    return row?.total_pusd ?? null;
  }

  async setting(key: string): Promise<string | null> {
    return (await this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  }
}
