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
  recordReviews,
  recordResearch,
  recordSentiment,
  recordSignals,
  research,
  type Decision,
  type ResearchNote,
  type Review,
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
 *   POST /api/bot/reviews         Zara's per-trade reviews (process graded apart from outcome)
 *   GET  /api/bot/journal-stats   what Zara reviews
 *   GET  /api/bot/token/<id>      research packet for any token
 *   GET  /api/bot/files           list the team's shared files (the hivemind)
 *   GET  /api/bot/files/<path>    read one file
 *   PUT  /api/bot/files/<path>    write one file: {"body": "...", "agent": "vela", "content_type"?: "text/markdown"}
 *   DELETE /api/bot/files/<path>  delete one file (history is kept)
 *
 * All calls need `Authorization: Bearer <BOT_TOKEN>`.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const CYCLE_TTL_MS = 30 * 60 * 1000;

export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The bot token is either the BOT_TOKEN secret or one the owner created on the desk (only its hash is stored). */
async function botAuthorized(req: Request, env: Env) {
  const sent = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!sent) return false;
  if (env.BOT_TOKEN && sent === env.BOT_TOKEN) return true;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_token_hash'").first<{ value: string }>();
  return Boolean(row && row.value === (await sha256(sent)));
}

/** Create a new bot token (replaces the previous desk-made one). Returned once, never stored in plain text. */
export async function newBotToken(env: Env) {
  const token = "gb_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bot_token_hash', ?)").bind(await sha256(token)).run();
  await env.DB.prepare("INSERT INTO events (ts, agent, kind, message) VALUES (?, 'desk', 'admin', 'Owner created a new Grok Bot token. The previous desk-made token no longer works.')").bind(Date.now()).run();
  return token;
}

export async function handleBot(req: Request, env: Env, p: string): Promise<Response> {
  try {
    return await route(req, env, p);
  } catch (err) {
    // Unavailable is a verdict, not "nothing happened": tell Grok plainly and don't let it guess.
    return json({ error: `UNAVAILABLE: ${(err as Error).message.replace(/\.$/, "")}. The desk can't see the market right now. Make no trades this cycle and try again next cycle.`, unavailable: true }, 503);
  }
}

async function route(req: Request, env: Env, p: string): Promise<Response> {
  if (!(await botAuthorized(req, env))) return json({ error: "unauthorized: send Authorization: Bearer <BOT_TOKEN>" }, 401);
  configureEndpoints(env);
  const body = req.method === "POST" || req.method === "PUT" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

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
        playbook: k.get("playbook"),
        market: k.get("market"),
        strategy: k.get("strategy"),
        roles: Object.fromEntries(["orin", "vela", "kade", "nova", "rune", "zara"].map((a) => [a, k.get(`role:${a}`)])),
      },
      team_files: (await env.DB.prepare("SELECT path, version, updated_by, updated_at, length(body) AS bytes FROM bot_files ORDER BY updated_at DESC LIMIT 200").all()).results,
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

  if (p === "/api/bot/files" || p.startsWith("/api/bot/files/")) return files(req, env, p.slice("/api/bot/files".length).replace(/^\//, ""), body);

  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (p === "/api/bot/journal") {
    if (typeof body.journal !== "string") return json({ error: "need journal (string), lessons (string[]), optional strategy_suggestion" }, 400);
    const L = new Ledger(env, 0);
    const lessons = Array.isArray(body.lessons) ? body.lessons.map(String).slice(0, 5) : [];
    await recordJournal(env, L, body.journal, lessons, typeof body.strategy_suggestion === "string" ? body.strategy_suggestion : undefined);
    return json({ ok: true });
  }

  if (p === "/api/bot/reviews") {
    const reviews = (Array.isArray(body.reviews) ? body.reviews : []).slice(0, 20) as Review[];
    const saved = await recordReviews(env, new Ledger(env, 0), reviews);
    return json({ ok: true, saved, ignored: reviews.length - saved });
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

const MAX_FILE = 200_000;
const MAX_FILES = 500;
const AGENTS = ["nova", "orin", "vela", "kade", "rune", "zara"];

/** The team's shared memory. Every write is versioned so the owner can see how it changed. */
async function files(req: Request, env: Env, rawPath: string, body: Record<string, unknown>): Promise<Response> {
  const path = decodeURIComponent(rawPath);
  if (!path) {
    if (req.method !== "GET") return json({ error: "name a file: /api/bot/files/<path>" }, 400);
    return json((await env.DB.prepare("SELECT path, content_type, version, updated_by, updated_at, length(body) AS bytes FROM bot_files ORDER BY path").all()).results);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(path) || path.includes("..")) return json({ error: "path: letters, digits, . _ - / only, up to 200 characters" }, 400);

  if (req.method === "GET") {
    const f = await env.DB.prepare("SELECT * FROM bot_files WHERE path = ?").bind(path).first();
    return f ? json(f) : json({ error: "no such file" }, 404);
  }
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM bot_files WHERE path = ?").bind(path).run();
    return json({ ok: true });
  }
  if (req.method !== "PUT" && req.method !== "POST") return json({ error: "use GET, PUT or DELETE" }, 405);
  if (typeof body.body !== "string") return json({ error: 'send {"body": "...", "agent": "<who>"}' }, 400);
  if (body.body.length > MAX_FILE) return json({ error: `file too large (max ${MAX_FILE} characters)` }, 413);
  const agent = AGENTS.includes(String(body.agent)) ? String(body.agent) : "grok";
  const type = typeof body.content_type === "string" ? body.content_type.slice(0, 100) : "text/markdown";
  const prev = await env.DB.prepare("SELECT version FROM bot_files WHERE path = ?").bind(path).first<{ version: number }>();
  if (!prev) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM bot_files").first<{ n: number }>())?.n ?? 0;
    if (n >= MAX_FILES) return json({ error: `the team already has ${MAX_FILES} files; delete or merge some first` }, 409);
  }
  const version = (prev?.version ?? 0) + 1;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO bot_files (path, body, content_type, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET body = excluded.body, content_type = excluded.content_type, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(path, body.body, type, version, agent, now),
    env.DB.prepare("INSERT INTO bot_files_history (path, version, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").bind(path, version, body.body, agent, now),
  ]);
  return json({ ok: true, path, version });
}
