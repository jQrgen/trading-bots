import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config";
import { bytesToHex, decodeTx, encodeTx, txidOf } from "../src/chain/tx";
import { broadcastOk } from "../src/chain/swap";
import { handleBot, isPositionVoid } from "../src/bot";
import GROK_BOT from "../GROK_BOT.md";

vi.mock("../src/chain/electrum", () => ({
  electrum: vi.fn(),
  listUnspent: vi.fn(),
  DEFAULT_SERVERS: ["127.0.0.1:1"],
}));

vi.mock("../src/cauldron", async () => {
  const actual = await vi.importActual<typeof import("../src/cauldron")>("../src/cauldron");
  return { ...actual, broadcastTx: vi.fn() };
});

import { broadcastTx } from "../src/cauldron";
import { electrum } from "../src/chain/electrum";
import { broadcastAccepted, liveRoom } from "../src/live";

const electrumMock = vi.mocked(electrum);
const broadcastTxMock = vi.mocked(broadcastTx);

const hex = bytesToHex(encodeTx({
  version: 2, locktime: 0,
  inputs: [{ txid: "11".repeat(32), vout: 0, unlocking: new Uint8Array(), sequence: 0xffffffff }],
  outputs: [{ value: 1000n, script: Uint8Array.of(0x51) }],
}));
const txid = txidOf(decodeTx(hex));
const env = { ELECTRUM_SERVERS: "127.0.0.1:1" } as Env;

describe("broadcast acceptance", () => {
  beforeEach(() => {
    electrumMock.mockReset();
    broadcastTxMock.mockReset();
  });

  it("treats an empty or mismatched reply as not accepted", () => {
    expect(broadcastOk("", txid)).toBe(false);
    expect(broadcastOk(undefined, txid)).toBe(false);
    expect(broadcastOk("ab".repeat(32), txid)).toBe(false);
    expect(broadcastOk(txid, txid)).toBe(true);
  });

  it("books only after a node has the transaction", async () => {
    broadcastTxMock.mockResolvedValue(txid);
    electrumMock.mockImplementation(async (_servers, method) => {
      if (method === "blockchain.transaction.get") return "deadbeef";
      throw new Error("broadcast should not be needed");
    });
    await expect(broadcastAccepted(env, hex, 0)).resolves.toBe(txid);
  });

  it("accepts an electrum broadcast that returns the txid", async () => {
    broadcastTxMock.mockResolvedValue(txid);
    electrumMock.mockImplementation(async (_servers, method) => {
      if (method === "blockchain.transaction.get") return null;
      if (method === "blockchain.transaction.broadcast") return txid;
      throw new Error(method);
    });
    await expect(broadcastAccepted(env, hex, 0)).resolves.toBe(txid);
  });

  it("does not accept a txid echo when no node has the transaction", async () => {
    broadcastTxMock.mockResolvedValue(txid);
    electrumMock.mockImplementation(async (_servers, method) => {
      if (method === "blockchain.transaction.broadcast") throw new Error("txn-mempool-conflict");
      return null;
    });
    await expect(broadcastAccepted(env, hex, 0)).rejects.toThrow(/not accepted/);
  });

  it("does not push a transaction a node already rejected", async () => {
    broadcastTxMock.mockRejectedValue(new Error("broadcast: REJECTED dust"));
    await expect(broadcastAccepted(env, hex, 0)).rejects.toThrow(/REJECTED/);
    expect(electrumMock).not.toHaveBeenCalled();
  });
});

describe("void position", () => {
  it("recognises void: true and amount 0", () => {
    expect(isPositionVoid({ void: true })).toBe(true);
    expect(isPositionVoid({ amount: 0 })).toBe(true);
    expect(isPositionVoid({ amount: "0" })).toBe(true);
    expect(isPositionVoid({ amount: 10 })).toBe(false);
    expect(isPositionVoid({})).toBe(false);
  });

  it("closes an open live position at cost with no cash change", async () => {
    const db = fakeDb([
      { id: 3, token_id: "aa".repeat(32), symbol: "RES", amount: 19453130, cost_pusd: 24.88, status: "open" },
    ]);
    db.settings.set("mode", "live");
    const res = await handleBot(post({ position_id: 3, void: true, reason: "broadcast never reached the chain" }), liveEnv(db), "/api/bot/correct-position");
    expect(res.status).toBe(200);
    const body = await res.json() as { voided: boolean; pnl_pusd: number; exit_pusd: number };
    expect(body).toMatchObject({ voided: true, pnl_pusd: 0, exit_pusd: 24.88 });
    expect(db.positions[0]).toMatchObject({ status: "closed", exit_pusd: 24.88, close_reason: "voided: broadcast never reached the chain" });
    expect(db.holdings).toEqual([{ asset: "pusd", symbol: "PUSD", amount: 24767 }]);
    expect(db.trades).toEqual([{ side: "correction", amount: 0, pusd: 0, position_id: 3, reason: "voided: broadcast never reached the chain" }]);
    expect(db.events.some((e) => e.kind === "correction" && /0 P&L, no cash change/.test(e.message))).toBe(true);
    expect(db.sql.some((q) => q.includes("holdings"))).toBe(false);
  });

  it("accepts amount 0 and will not void twice", async () => {
    const db = fakeDb([{ id: 3, token_id: "aa".repeat(32), symbol: "RES", amount: 1, cost_pusd: 24.88, status: "open" }]);
    const env = liveEnv(db);
    const first = await handleBot(post({ position_id: 3, amount: 0, reason: "phantom" }), env, "/api/bot/correct-position");
    expect(first.status).toBe(200);
    const second = await handleBot(post({ position_id: 3, amount: 0, reason: "phantom" }), env, "/api/bot/correct-position");
    expect(second.status).toBe(409);
  });

  it("still refuses to reprice a live position by hand", async () => {
    const db = fakeDb([]);
    db.settings.set("mode", "live");
    const res = await handleBot(post({ position_id: 3, amount: 10, exit_pusd: 1, reason: "reprice" }), liveEnv(db), "/api/bot/correct-position");
    expect(res.status).toBe(409);
  });
});

describe("phantom position migration", () => {
  const sql = readFileSync("migrations/0010_void_phantom_res.sql", "utf8");
  const tx = "09f7b5bee1a33b3cfa5806a1528f50ab64db69bb9d209e6f7e44577b19fcb408";

  it("voids position 3 and leaves the book at 247.67 PUSD with no RES", () => {
    const db = schema();
    db.exec(`INSERT INTO positions (id, token_id, symbol, amount, cost_pusd, status) VALUES
      (3, '${"bb".repeat(32)}', 'RES', 19453130, 24.88, 'open'),
      (4, '${"cc".repeat(32)}', 'OTHER', 5, 10, 'open')`);
    db.exec(`INSERT INTO holdings (asset, symbol, amount) VALUES ('pusd', 'PUSD', 20000), ('bch', 'BCH', 50000), ('${"bb".repeat(32)}', 'RES', 19453130)`);
    db.exec(`INSERT INTO trades (id, side, position_id, pusd, reason, txid) VALUES (1, 'buy', 3, 24.88, 'thesis', '${tx}')`);
    db.exec(sql);
    const pos = db.prepare("SELECT status, exit_pusd, cost_pusd, close_reason FROM positions WHERE id = 3").get() as { status: string; exit_pusd: number; cost_pusd: number; close_reason: string };
    expect(pos.status).toBe("closed");
    expect(pos.exit_pusd).toBe(pos.cost_pusd);
    expect(pos.exit_pusd - pos.cost_pusd).toBe(0);
    expect(pos.close_reason).toMatch(/phantom/);
    expect((db.prepare("SELECT status FROM positions WHERE id = 4").get() as { status: string }).status).toBe("open");
    expect((db.prepare("SELECT amount FROM holdings WHERE asset = 'pusd'").get() as { amount: number }).amount).toBe(24767);
    expect(db.prepare("SELECT asset FROM holdings WHERE symbol = 'RES' OR asset = ?").all("bb".repeat(32))).toEqual([]);
    expect((db.prepare("SELECT amount FROM holdings WHERE asset = 'bch'").get() as { amount: number }).amount).toBe(50000);
    expect((db.prepare("SELECT pusd, reason FROM trades WHERE id = 1").get() as { pusd: number; reason: string })).toMatchObject({ pusd: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'correction'").get() as { n: number }).n).toBe(1);
  });

  it("does nothing when position 3 is not that phantom", () => {
    const db = schema();
    db.exec("INSERT INTO positions (id, token_id, symbol, amount, cost_pusd, status) VALUES (3, 'zz', 'RES', 1, 24.88, 'open')");
    db.exec("INSERT INTO holdings (asset, symbol, amount) VALUES ('pusd', 'PUSD', 100000), ('zz', 'RES', 1)");
    db.exec(sql);
    expect((db.prepare("SELECT status, exit_pusd FROM positions WHERE id = 3").get() as { status: string; exit_pusd: number | null }).status).toBe("open");
    expect((db.prepare("SELECT amount FROM holdings WHERE asset = 'pusd'").get() as { amount: number }).amount).toBe(100000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE symbol = 'RES'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(0);
  });
});

describe("grok guide", () => {
  it("documents voiding a position", () => {
    expect(GROK_BOT).toContain("POST /api/bot/correct-position");
    expect(GROK_BOT).toContain('"void": true');
    expect(GROK_BOT).toMatch(/amount.: 0/);
    expect(GROK_BOT).toMatch(/0 P&L/);
    expect(GROK_BOT).toMatch(/no cash change/);
  });

  it("tells the bot that live liquidity is broadcast", () => {
    expect(GROK_BOT).toMatch(/provide or withdraw/);
    expect(GROK_BOT).toMatch(/transaction id/);
    expect(GROK_BOT).not.toMatch(/paper-only|don't propose "provide"/);
    const note = readFileSync("src/loop.ts", "utf8");
    expect(note).toMatch(/liquidity change \(provide or withdraw\)/);
    expect(note).not.toMatch(/paper-only/);
    expect(liveRoom(40, 0, 25, 150)).toBe(25);
    expect(liveRoom(20, 140, 25, 150)).toBe(10);
    expect(liveRoom(20, 150, 25, 150)).toBe(0);
  });
});

function schema() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY, token_id TEXT, symbol TEXT, amount INTEGER, cost_pusd REAL,
      status TEXT, closed_at INTEGER, exit_pusd REAL, close_reason TEXT
    );
    CREATE TABLE holdings (asset TEXT PRIMARY KEY, symbol TEXT NOT NULL, amount INTEGER NOT NULL);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, side TEXT, position_id INTEGER, pusd REAL, reason TEXT, txid TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, cycle INTEGER, agent TEXT, kind TEXT, message TEXT, data TEXT);
  `);
  return db;
}

interface Pos { id: number; token_id: string; symbol: string; amount: number; cost_pusd: number; status: string; closed_at?: number; exit_pusd?: number; close_reason?: string }
interface Trade { side: unknown; amount: unknown; pusd: unknown; position_id: unknown; reason: unknown }
interface Ev { agent: unknown; kind: unknown; message: string }

function fakeDb(seed: Pos[]) {
  const positions = seed.map((p) => ({ ...p }));
  const settings = new Map<string, string>();
  const trades: Trade[] = [];
  const events: Ev[] = [];
  const holdings = [{ asset: "pusd", symbol: "PUSD", amount: 24767 }];
  const sql: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const query = (q: string, args: unknown[]) => {
    if (q.startsWith("SELECT value FROM settings")) {
      const v = settings.get(String(args[0]));
      return v === undefined ? null : { value: v };
    }
    if (q.startsWith("SELECT 1 FROM settings")) return settings.has(String(args[0])) ? { ok: 1 } : null;
    if (q.includes("status = 'open'")) return positions.find((p) => p.id === args[0] && p.status === "open") ?? null;
    if (q.includes("status = 'closed'")) return positions.find((p) => p.id === args[0] && p.status === "closed") ?? null;
    throw new Error("unexpected query: " + q);
  };
  const exec = (q: string, args: unknown[]) => {
    sql.push(q);
    if (q.includes("holdings")) throw new Error("cash changed: " + q);
    if (q.startsWith("INSERT OR REPLACE INTO settings") || q.startsWith("INSERT INTO settings")) {
      settings.set(String(args[0]), String(args[1]));
      return 1;
    }
    if (q.startsWith("UPDATE positions SET status = 'closed'")) {
      const p = positions.find((x) => x.id === args[3]);
      if (!p) return 0;
      p.status = "closed";
      p.closed_at = args[0] as number;
      p.exit_pusd = args[1] as number;
      p.close_reason = String(args[2]);
      return 1;
    }
    if (q.startsWith("INSERT INTO trades")) {
      trades.push({ side: args[3], amount: args[6], pusd: args[7], position_id: args[11], reason: args[12] });
      return 1;
    }
    if (q.startsWith("INSERT INTO events")) {
      events.push({ agent: args[2], kind: args[3], message: String(args[4]) });
      return 1;
    }
    throw new Error("unexpected exec: " + q);
  };
  const prepare = (raw: string) => {
    const q = norm(raw);
    let args: unknown[] = [];
    const bound = {
      bind(...a: unknown[]) { args = a; return bound; },
      async first() { return query(q, args); },
      async run() { return { meta: { changes: exec(q, args), last_row_id: 1 } }; },
      async all() { return { results: [] }; },
    };
    return bound;
  };
  return {
    prepare, sql, positions, settings, trades, events, holdings,
    async batch(stmts: { run: () => Promise<unknown> }[]) { for (const s of stmts) await s.run(); },
  };
}

function liveEnv(db: ReturnType<typeof fakeDb>): Env {
  return { DB: db, BOT_TOKEN: "test-token", MODE: "live", PAPER_START_PUSD: "1000", GROK_MODEL: "x", JOURNAL_HOUR_UTC: "21" } as unknown as Env;
}

function post(body: unknown) {
  return new Request("https://desk.example/api/bot/correct-position", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
