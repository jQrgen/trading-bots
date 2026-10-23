import type { Env } from "./config";
import { hasGrok } from "./grok";

export const ROLE_IDS = ["orin", "vela", "kade", "nova", "rune", "zara"] as const;
const TRADE_EVERY_MS = 15 * 60 * 1000;
const RUN_WINDOW_MS = 30 * 60 * 1000;
const GRACE_MS = 3 * 60 * 1000; // a routine a few minutes late is normal; later than that, Grok has likely stopped calling

export const brainName = (env: Env) => (env.BRAIN === "xai-api" && hasGrok(env) ? "xai-api" : env.BRAIN === "rules" ? "rules" : "grok-bot");

export const clip = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "..." : t;
};

export const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16) + " UTC";

export function nextJournalAt(hourUtc: number, now = Date.now()) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0, 0);
  if (t <= now) t += 86_400_000;
  return t;
}

export function tradeNextLabel(lastTs: number | null, now = Date.now()) {
  if (!lastTs) return "every 15 min";
  const next = lastTs + TRADE_EVERY_MS;
  if (next + GRACE_MS < now) return `next run overdue (was due ${hhmm(next)})`;
  return next <= now ? "next run due" : `next ${hhmm(next)}`;
}

/** One line for a role card: which cycle, what it last concluded, when it runs again. */
export function roleLine(cycle: number | null, message: string | null, next: string) {
  if (cycle == null && !message) return `Waiting for Cauldron Trader · ${next}`;
  const head = cycle != null ? `Cycle ${cycle}` : "Last run";
  const body = message ? clip(message) : "no action this cycle";
  return `${head}: ${body} · ${next}`;
}

const isIdle = (s: string) => /^\s*idle\b/i.test(s) || /waiting for grok bot/i.test(s);

export interface RunnerInfo {
  name: "Cauldron Trader";
  brain: string;
  cycle: number | null;
  state: "waiting" | "running" | "complete";
  updated_at: number | null;
  next_run_at: number | null;
  next_journal_at: number;
  /** True when the next run is more than a few minutes past due: Grok's routine hasn't called the desk. */
  overdue?: boolean;
}

export interface RoleView {
  agent: string;
  status: string;
  updated_at: number;
}

interface Ev {
  ts: number;
  cycle: number | null;
  agent: string;
  message: string;
}

/** What the dashboard and the app should show for the single Cauldron Trader routine. */
export async function describeRoles(env: Env, now = Date.now()): Promise<{ runner: RunnerInfo; agents: RoleView[] }> {
  const hour = Number(env.JOURNAL_HOUR_UTC) || 21;
  const [settings, statusRows, eventRows] = await Promise.all([
    env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('bot_cycle', 'runner')").all<{ key: string; value: string }>(),
    env.DB.prepare("SELECT agent, status, updated_at FROM agent_status").all<{ agent: string; status: string; updated_at: number }>(),
    env.DB.prepare("SELECT ts, cycle, agent, message FROM events WHERE agent IN ('orin','vela','kade','nova','rune','zara') ORDER BY id DESC LIMIT 400").all<Ev>(),
  ]);
  const bag = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const bot = parseJson<{ cycle: number; ts: number }>(bag.bot_cycle);
  const saved = parseJson<{ state?: string }>(bag.runner);
  const focus = bot?.cycle ?? eventRows.results.find((e) => e.cycle != null)?.cycle ?? null;
  const running = saved?.state === "running" && !!bot && now - bot.ts < RUN_WINDOW_MS;
  const live = new Map(statusRows.results.map((r) => [r.agent, r]));
  const latest = new Map<string, Ev>();
  const inFocus = new Map<string, Ev>();
  for (const e of eventRows.results) {
    if (!latest.has(e.agent)) latest.set(e.agent, e);
    if (focus != null && e.cycle === focus && !inFocus.has(e.agent)) inFocus.set(e.agent, e);
  }
  const journalAt = nextJournalAt(hour, now);
  const nextRunAt = bot ? bot.ts + TRADE_EVERY_MS : null;
  const agents: RoleView[] = ROLE_IDS.map((agent) => {
    const next = agent === "zara" ? `journal ${hhmm(journalAt)}` : tradeNextLabel(bot?.ts ?? null, now);
    const row = live.get(agent);
    if (running && row && !isIdle(row.status) && bot && row.updated_at >= bot.ts - 2000) {
      const text = row.status.startsWith("Cycle ") ? row.status : roleLine(focus, row.status, next);
      return { agent, status: text, updated_at: row.updated_at };
    }
    const focused = focus != null ? inFocus.get(agent) : undefined;
    const recent = latest.get(agent);
    const ev = recent && focused && (recent.cycle ?? -1) > (focused.cycle ?? -1) ? recent : (focused ?? recent);
    return { agent, status: roleLine(ev?.cycle ?? focus, ev?.message ?? null, next), updated_at: ev?.ts ?? bot?.ts ?? now };
  });
  const state = running ? "running" : bot || eventRows.results.length ? "complete" : "waiting";
  return {
    runner: {
      name: "Cauldron Trader",
      brain: brainName(env),
      cycle: focus,
      state,
      updated_at: bot?.ts ?? null,
      next_run_at: nextRunAt,
      next_journal_at: journalAt,
      overdue: !running && nextRunAt != null && nextRunAt + GRACE_MS < now,
    },
    agents,
  };
}

export async function noteRunning(env: Env, cycle: number) {
  const now = Date.now();
  const hour = Number(env.JOURNAL_HOUR_UTC) || 21;
  const runner: RunnerInfo = {
    name: "Cauldron Trader",
    brain: brainName(env),
    cycle,
    state: "running",
    updated_at: now,
    next_run_at: now + TRADE_EVERY_MS,
    next_journal_at: nextJournalAt(hour, now),
  };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('runner', ?)").bind(JSON.stringify(runner)).run();
}

/** Write the synthesized lines into agent_status so a raw read matches the API. */
export async function publishRoleStatus(env: Env) {
  const cur = await env.DB.prepare("SELECT value FROM settings WHERE key = 'runner'").first<{ value: string }>();
  if (cur) {
    const saved = parseJson<{ state?: string }>(cur.value);
    if (saved?.state === "running") await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('runner', ?)").bind(JSON.stringify({ ...saved, state: "complete" })).run();
  }
  const { runner, agents } = await describeRoles(env);
  const done: RunnerInfo = { ...runner, state: runner.cycle != null ? "complete" : runner.state };
  await env.DB.batch([
    ...agents.map((a) =>
      env.DB.prepare("INSERT INTO agent_status (agent, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").bind(a.agent, a.status, a.updated_at),
    ),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('runner', ?)").bind(JSON.stringify(done)),
  ]);
}

/** Cron must not overwrite a routine that is still in its 30 minute window. */
export async function refreshRoles(env: Env) {
  const [runner, bot] = await Promise.all([
    env.DB.prepare("SELECT value FROM settings WHERE key = 'runner'").first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_cycle'").first<{ value: string }>(),
  ]);
  const state = parseJson<{ state?: string }>(runner?.value)?.state;
  const ts = parseJson<{ ts?: number }>(bot?.value)?.ts ?? 0;
  if (state === "running" && Date.now() - ts < RUN_WINDOW_MS) return;
  await publishRoleStatus(env);
}

const parseJson = <T>(raw: string | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
