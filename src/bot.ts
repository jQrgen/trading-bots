import type { Env } from "./config";
import { Ledger } from "./ledger";
import { loadKnowledge } from "./knowledge";
import {
  briefing,
  decideAndExecute,
  journalStats,
  loadCtx,
  newCycle,
  proposeAndCheck,
  recordJournal,
  recordResearch,
  recordSentiment,
  recordSignals,
  research,
  type Decision,
  type ResearchNote,
  type SentimentReading,
  type Signal,
  type Verdict,
} from "./loop";
import { configureEndpoints } from "./cauldron";
import type { Proposal } from "./risk";

/*
 * The API Grok Bot uses to run the team. Grok does the thinking (as Orin, Vela, Kade, Nova and Zara);
 * the Worker supplies data, enforces the risk limits in code, executes paper trades and stores everything.
 *
 *   GET  /api/bot/briefing        start a cycle: knowledge, portfolio, market digest, new tokens, launchpad
 *   POST /api/bot/research        Orin's signals in, research packets (rug facts, candles) out
 *   POST /api/bot/proposals       Vela's research notes, X sentiment and proposals in, risk-engine verdicts out
 *   POST /api/bot/decisions       Kade's vetoes and Nova's approvals in, paper fills out
 *   POST /api/bot/journal         Zara's daily journal and lessons
 *   GET  /api/bot/journal-stats   what Zara reviews
 *   GET  /api/bot/token/<id>      research packet for any token
 *
 * All calls need `Authorization: Bearer <BOT_TOKEN>`.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const CYCLE_TTL_MS = 30 * 60 * 1000;

export async function handleBot(req: Request, env: Env, p: string): Promise<Response> {
  if (!env.BOT_TOKEN || req.headers.get("authorization") !== `Bearer ${env.BOT_TOKEN}`) return json({ error: "unauthorized: send Authorization: Bearer <BOT_TOKEN>" }, 401);
  configureEndpoints(env);
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  if (p === "/api/bot/briefing" && req.method === "GET") {
    const L = await newCycle(env);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bot_cycle', ?)").bind(JSON.stringify({ cycle: L.cycle, ts: Date.now() })).run();
    await L.log("desk", "cycle", `Grok Bot started cycle ${L.cycle}.`);
    await L.status("orin", "scanning Cauldron");
    const ctx = await loadCtx(env, L);
    const k = await loadKnowledge(env);
    return json({
      cycle: L.cycle,
      next_step: "POST /api/bot/research with Orin's signals",
      knowledge: {
        shared: k.get("shared"),
        market: k.get("market"),
        strategy: k.get("strategy"),
        roles: Object.fromEntries(["orin", "vela", "kade", "nova", "rune", "zara"].map((a) => [a, k.get(`role:${a}`)])),
      },
      ...(await briefing(env, ctx)),
    });
  }

  if (p === "/api/bot/journal-stats" && req.method === "GET") {
    const L = new Ledger(env, 0);
    return json(await journalStats(env, L));
  }

  const tok = p.match(/^\/api\/bot\/token\/([0-9a-f]{64}|bch)$/);
  if (tok && req.method === "GET") {
    const L = new Ledger(env, 0);
    const ctx = await loadCtx(env, L);
    const t = ctx.tokens.get(tok[1]);
    const packet = await research(env, L, ctx, { token_id: tok[1], symbol: t?.display_symbol ?? tok[1].slice(0, 6), signal: "lookup", why: "manual research" });
    return packet ? json(packet) : json({ error: "token not in the current Cauldron list" }, 404);
  }

  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (p === "/api/bot/journal") {
    if (typeof body.journal !== "string") return json({ error: "need journal (string), lessons (string[]), optional strategy_suggestion" }, 400);
    const L = new Ledger(env, 0);
    const lessons = Array.isArray(body.lessons) ? body.lessons.map(String).slice(0, 5) : [];
    await recordJournal(env, L, body.journal, lessons, typeof body.strategy_suggestion === "string" ? body.strategy_suggestion : undefined);
    return json({ ok: true });
  }

  // The remaining steps belong to the cycle started by the latest briefing.
  const cur = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_cycle'").first<{ value: string }>();
  const active = cur ? (JSON.parse(cur.value) as { cycle: number; ts: number }) : null;
  if (!active || Number(body.cycle) !== active.cycle || Date.now() - active.ts > CYCLE_TTL_MS)
    return json({ error: "stale or unknown cycle: GET /api/bot/briefing first and pass its cycle number", current: active?.cycle ?? null }, 409);
  const L = new Ledger(env, active.cycle);

  if (p === "/api/bot/research") {
    const signals = (Array.isArray(body.signals) ? body.signals : []).slice(0, 8) as Signal[];
    const ctx = await loadCtx(env, L);
    const valid = signals.filter((s) => s && typeof s.token_id === "string" && ctx.tokens.has(s.token_id));
    await recordSignals(L, valid, typeof body.note === "string" ? body.note : undefined, ctx.list.length);
    await L.status("vela", `researching ${valid.length} signals`);
    const packets = [];
    for (const s of valid) packets.push(await research(env, L, ctx, s));
    return json({ cycle: L.cycle, research: packets, ignored: signals.length - valid.length, next_step: "POST /api/bot/proposals with Vela's research_notes, sentiment and proposals" });
  }

  if (p === "/api/bot/proposals") {
    const ctx = await loadCtx(env, L);
    const notes = (Array.isArray(body.research_notes) ? body.research_notes : []).filter((n: ResearchNote) => n && n.token_id && n.note) as ResearchNote[];
    await recordResearch(env, L, notes.slice(0, 20));
    const readings = (Array.isArray(body.sentiment) ? body.sentiment : []).filter((r: SentimentReading) => r && r.summary !== undefined && r.score !== undefined) as SentimentReading[];
    await recordSentiment(env, L, readings.slice(0, 20));
    const raw = (Array.isArray(body.proposals) ? body.proposals : []).slice(0, 10) as Omit<Proposal, "id">[];
    const signals = (Array.isArray(body.signals) ? body.signals : []) as Signal[];
    const out = await proposeAndCheck(L, ctx, raw, signals, typeof body.note === "string" ? body.note : undefined);
    return json({ ...out, next_step: "POST /api/bot/decisions with Kade's verdicts and Nova's decisions for the proposals that passed" });
  }

  if (p === "/api/bot/decisions") {
    const ctx = await loadCtx(env, L);
    const kade = (Array.isArray(body.kade) ? body.kade : []) as Verdict[];
    const nova = (Array.isArray(body.nova) ? body.nova : []) as Decision[];
    const out = await decideAndExecute(env, L, ctx, kade, nova, typeof body.note === "string" ? body.note : undefined);
    for (const a of ["orin", "vela", "kade", "nova", "rune"] as const) await L.status(a, "idle, waiting for Grok Bot");
    return json({ ...out, next_step: "cycle complete" });
  }

  return json({ error: "not found" }, 404);
}
