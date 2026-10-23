import type { Env } from "./config";
import { runCycle, runJournal } from "./loop";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await runCycle(env);
        if (new Date().getUTCHours() === Number(env.JOURNAL_HOUR_UTC)) await runJournal(env);
      })(),
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/admin/")) return admin(req, env, ctx, p);
      if (p === "/api/state") return json(await state(env));
      if (p === "/api/events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
        const rows = await env.DB.prepare("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?").bind(after, limit).all();
        return json(rows.results);
      }
      if (p === "/api/snapshots") {
        const days = Math.min(Number(url.searchParams.get("days") ?? 7), 365);
        const rows = await env.DB.prepare("SELECT ts, total_pusd, bch_pusd FROM snapshots WHERE ts >= ? ORDER BY ts").bind(Date.now() - days * 86400000).all();
        return json(rows.results);
      }
      if (p === "/api/trades") return json((await env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 500").all()).results);
      if (p === "/api/positions") return json((await env.DB.prepare("SELECT * FROM positions ORDER BY id DESC LIMIT 500").all()).results);
      if (p === "/api/journal") return json((await env.DB.prepare("SELECT * FROM journal ORDER BY id DESC LIMIT 60").all()).results);
      if (p === "/api/lessons") return json((await env.DB.prepare("SELECT * FROM lessons ORDER BY id DESC LIMIT 200").all()).results);
      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function admin(req: Request, env: Env, ctx: ExecutionContext, p: string) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (p === "/api/admin/halt") {
    const halted = body.halted !== false;
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('halted', ?)").bind(halted ? "1" : "0").run();
    await env.DB.prepare("INSERT INTO events (ts, agent, kind, message) VALUES (?, 'desk', 'admin', ?)").bind(Date.now(), halted ? "Owner HALTED the desk. Only exits will run." : "Owner resumed the desk.").run();
    return json({ halted });
  }
  if (p === "/api/admin/run") {
    ctx.waitUntil(runCycle(env));
    return json({ started: true });
  }
  if (p === "/api/admin/journal") {
    ctx.waitUntil(runJournal(env));
    return json({ started: true });
  }
  if (p === "/api/admin/deployed") {
    const sha = String(body.sha ?? "").slice(0, 12);
    const message = String(body.message ?? "").split("\n")[0].slice(0, 200);
    const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 50) : [];
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_deploy', ?)").bind(JSON.stringify({ sha, message, files, ts: Date.now() })).run();
    await env.DB.prepare("INSERT INTO events (ts, agent, kind, message, data) VALUES (?, 'desk', 'deploy', ?, ?)").bind(Date.now(), `Repo update ${sha} deployed: ${message}`, JSON.stringify({ files })).run();
    return json({ ok: true });
  }
  if (p === "/api/admin/lesson") {
    const status = body.status === "active" || body.status === "rejected" ? body.status : null;
    if (!status || typeof body.id !== "number") return json({ error: "need id and status active|rejected" }, 400);
    await env.DB.prepare("UPDATE lessons SET status = ? WHERE id = ?").bind(status, body.id).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

async function state(env: Env) {
  const db = env.DB;
  const [holdings, positions, agents, settings, closed, last] = await Promise.all([
    db.prepare("SELECT asset, symbol, amount FROM holdings").all<{ asset: string; symbol: string; amount: number }>(),
    db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC").all<Record<string, number | string>>(),
    db.prepare("SELECT * FROM agent_status").all(),
    db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>(),
    db.prepare("SELECT cost_pusd, exit_pusd FROM positions WHERE status = 'closed'").all<{ cost_pusd: number; exit_pusd: number }>(),
    db.prepare("SELECT ts, total_pusd FROM snapshots ORDER BY ts DESC LIMIT 1").first<{ ts: number; total_pusd: number }>(),
  ]);
  const s = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const marks = s.marks ? (JSON.parse(s.marks) as { prices: Record<string, number>; decimals: Record<string, number>; bch_pusd: number; ts: number }) : null;
  const value = (asset: string, amount: number) =>
    asset === "pusd" ? amount / 100 : marks?.prices[asset] ? (amount / 10 ** (marks.decimals[asset] ?? 0)) * marks.prices[asset] : 0;
  const wins = closed.results.filter((c) => c.exit_pusd > c.cost_pusd).length;
  const realized = closed.results.reduce((a, c) => a + c.exit_pusd - c.cost_pusd, 0);
  return {
    mode: env.MODE,
    halted: s.halted === "1",
    start_pusd: Number(env.PAPER_START_PUSD),
    total_pusd: last?.total_pusd ?? null,
    updated_at: last?.ts ?? null,
    bch_pusd: marks?.bch_pusd ?? null,
    holdings: holdings.results.map((h) => ({ ...h, value_pusd: value(h.asset, h.amount) })),
    positions: positions.results.map((p) => {
      const v = value(String(p.token_id), Number(p.amount));
      return { ...p, value_pusd: v, pnl_pct: ((v - Number(p.cost_pusd)) / Number(p.cost_pusd)) * 100 };
    }),
    agents: agents.results,
    stats: { closed: closed.results.length, wins, win_rate: closed.results.length ? wins / closed.results.length : null, realized_pusd: realized },
  };
}
