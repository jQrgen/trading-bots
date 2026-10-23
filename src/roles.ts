import type { Env } from "./config";
import { hasGrok } from "./grok";

export const ROLE_IDS = ["orin", "vela", "kade", "nova", "rune", "zara"] as const;
const TRADE_EVERY_MS = 15 * 60 * 1000;
/** Same window as the bot cycle: a briefing older than this is stale, and the desk shows idle. */
export const RUN_WINDOW_MS = 30 * 60 * 1000;
const GRACE_MS = 3 * 60 * 1000; // a routine a few minutes late is normal; later than that, Grok has likely stopped calling

const ROLE_SET = new Set<string>(ROLE_IDS);

/** Step shown while that role is the one working. Order is Orin, Vela, Kade, Nova, Rune, then Zara. */
export const STEP_LABEL: Record<(typeof ROLE_IDS)[number], string> = {
  orin: "Orin scan",
  vela: "Vela research",
  kade: "Kade risk",
  nova: "Nova decisions",
  rune: "Rune execution",
  zara: "Zara journal",
};

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
  cycle_running?: boolean;
  active_role?: string | null;
  active_since?: number | null;
  step?: string | null;
}

export interface CycleLive {
  cycle_running: boolean;
  cycle: number | null;
  active_role: string | null;
  active_since: number | null;
  step: string | null;
}

export interface CycleSnap {
  now: number;
  cycle: { cycle: number; ts: number } | null;
  runnerState: string | null;
  writes: { role: string; at: number }[];
  decisionsAt: number | null;
  journalSince: number | null;
}

/** Role from PUT /api/bot/files/<role>/thinking.md. Other files are not progress. */
export function roleFromThinkingPath(path: string): string | null {
  const m = /^\/?([a-z]+)\/thinking\.md$/i.exec(path.trim());
  const role = m?.[1].toLowerCase();
  return role && ROLE_SET.has(role) ? role : null;
}

const stepOf = (role: string) => STEP_LABEL[role as keyof typeof STEP_LABEL] ?? role;

/** Active role: briefing starts Orin; a thinking.md write holds until the next role writes; decisions hand off to Rune. */
export function deriveCycle(s: CycleSnap): CycleLive {
  const idle: CycleLive = { cycle_running: false, cycle: s.cycle?.cycle ?? null, active_role: null, active_since: null, step: null };
  if (s.cycle && s.runnerState === "running" && s.now - s.cycle.ts < RUN_WINDOW_MS) {
    const writes = s.writes
      .filter((w) => ROLE_SET.has(w.role) && w.at >= s.cycle!.ts && w.at <= s.now)
      .sort((a, b) => a.at - b.at);
    let role = "orin";
    let since = s.cycle.ts;
    let started = false;
    for (const w of writes) {
      if (!started && w.role === role) {
        since = w.at;
        started = true;
        continue;
      }
      started = true;
      if (w.role !== role) {
        role = w.role;
        since = w.at;
      }
    }
    const mark = s.decisionsAt;
    if (mark != null && mark >= s.cycle.ts && mark <= s.now && mark >= since && role !== "rune") {
      role = "rune";
      since = mark;
    }
    return { cycle_running: true, cycle: s.cycle.cycle, active_role: role, active_since: since, step: stepOf(role) };
  }
  if (s.journalSince != null && s.journalSince <= s.now && s.now - s.journalSince < RUN_WINDOW_MS) {
    return { cycle_running: true, cycle: s.cycle?.cycle ?? null, active_role: "zara", active_since: s.journalSince, step: STEP_LABEL.zara };
  }
  return idle;
}

export function cycleBanner(live: CycleLive, nextRunAt: number | null, now: number): string {
  if (live.cycle_running && live.step) return live.cycle != null ? `Cycle ${live.cycle} running, step ${live.step}` : `Running, step ${live.step}`;
  if (nextRunAt == null) return "idle, next run every 15 min";
  if (nextRunAt + GRACE_MS < now) return `idle, next run overdue (was due ${hhmm(nextRunAt)})`;
  if (nextRunAt > now) return `idle, next run ${hhmm(nextRunAt)}`;
  return "idle, next run due";
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

export interface DeskRoles {
  runner: RunnerInfo;
  agents: RoleView[];
  cycle_running: boolean;
  cycle: number | null;
  active_role: string | null;
  active_since: number | null;
  step: string | null;
  cycle_banner: string;
}

/** What the dashboard and the app should show for the single Cauldron Trader routine. */
export async function describeRoles(env: Env, now = Date.now()): Promise<DeskRoles> {
  const hour = Number(env.JOURNAL_HOUR_UTC) || 21;
  const [settings, statusRows, eventRows] = await Promise.all([
    env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('bot_cycle', 'runner', 'decisions_at', 'journal_since')").all<{ key: string; value: string }>(),
    env.DB.prepare("SELECT agent, status, updated_at FROM agent_status").all<{ agent: string; status: string; updated_at: number }>(),
    env.DB.prepare("SELECT ts, cycle, agent, message FROM events WHERE agent IN ('orin','vela','kade','nova','rune','zara') ORDER BY id DESC LIMIT 400").all<Ev>(),
  ]);
  const bag = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const bot = parseJson<{ cycle: number; ts: number }>(bag.bot_cycle);
  const saved = parseJson<{ state?: string }>(bag.runner);
  const decisions = parseJson<{ cycle: number; ts: number }>(bag.decisions_at);
  const writes = bot ? await thinkingWrites(env, bot.ts) : [];
  const focus = bot?.cycle ?? eventRows.results.find((e) => e.cycle != null)?.cycle ?? null;
  const running = saved?.state === "running" && !!bot && now - bot.ts < RUN_WINDOW_MS;
  const byAgent = new Map(statusRows.results.map((r) => [r.agent, r]));
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
    const row = byAgent.get(agent);
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
  const active = deriveCycle({
    now,
    cycle: bot,
    runnerState: saved?.state ?? null,
    writes,
    decisionsAt: decisions && bot && decisions.cycle === bot.cycle ? decisions.ts : null,
    journalSince: Number(bag.journal_since) || null,
  });
  const runner: RunnerInfo = {
    name: "Cauldron Trader",
    brain: brainName(env),
    cycle: focus,
    state: active.cycle_running ? "running" : state,
    updated_at: bot?.ts ?? null,
    next_run_at: nextRunAt,
    next_journal_at: journalAt,
    overdue: !active.cycle_running && nextRunAt != null && nextRunAt + GRACE_MS < now,
    cycle_running: active.cycle_running,
    active_role: active.active_role,
    active_since: active.active_since,
    step: active.step,
  };
  return { runner, agents, ...active, cycle_banner: cycleBanner(active, nextRunAt, now) };
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
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('runner', ?)").bind(JSON.stringify(runner)),
    env.DB.prepare("DELETE FROM settings WHERE key = 'journal_since'"),
  ]);
}

/** Zara writing thinking.md outside a trade cycle starts the journal step, timed from the first write. */
export async function noteJournalIfIdle(env: Env, now = Date.now()) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('runner', 'bot_cycle', 'journal_since')").all<{ key: string; value: string }>();
  const bag = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const runner = parseJson<{ state?: string }>(bag.runner);
  const bot = parseJson<{ ts?: number }>(bag.bot_cycle);
  if (runner?.state === "running" && bot?.ts && now - bot.ts < RUN_WINDOW_MS) return;
  const since = Number(bag.journal_since);
  if (since && now - since < RUN_WINDOW_MS) return;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('journal_since', ?)").bind(String(now)).run();
}

export async function clearJournal(env: Env) {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'journal_since'").run();
}

/** POST /api/bot/decisions: Kade and Nova have handed off, Rune is executing until the cycle closes. */
export async function markDecisions(env: Env, cycle: number, at = Date.now()) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('decisions_at', ?)").bind(JSON.stringify({ cycle, ts: at })).run();
}

async function thinkingWrites(env: Env, since: number) {
  const paths = ROLE_IDS.map((r) => `${r}/thinking.md`);
  const rows = await env.DB.prepare(
    `SELECT path, updated_at FROM bot_files_history WHERE updated_at >= ? AND path IN (${paths.map(() => "?").join(",")}) ORDER BY updated_at ASC`,
  )
    .bind(since, ...paths)
    .all<{ path: string; updated_at: number }>()
    .catch(() => ({ results: [] as { path: string; updated_at: number }[] }));
  return rows.results.flatMap((r) => {
    const role = roleFromThinkingPath(r.path);
    return role ? [{ role, at: r.updated_at }] : [];
  });
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
