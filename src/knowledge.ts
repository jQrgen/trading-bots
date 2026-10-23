import { RISK_DEFAULTS, type Env, type RiskLimits } from "./config";
import SHARED from "../seed/SHARED.md";
import MARKET from "../seed/MARKET.md";
import STRATEGY from "../seed/STRATEGY.md";
import NOVA from "../seed/roles/nova.md";
import ORIN from "../seed/roles/orin.md";
import VELA from "../seed/roles/vela.md";
import KADE from "../seed/roles/kade.md";
import RUNE from "../seed/roles/rune.md";
import ZARA from "../seed/roles/zara.md";
import TEAM from "../seed/team.json";

export interface Doc { key: string; title: string; kind: string; format: "markdown" | "json"; body: string }

/** Starter defaults. Copied into D1 only when a key is missing; after that D1 is the source of truth. */
export const SEED: Doc[] = [
  { key: "strategy", title: "Owner's strategy", kind: "strategy", format: "markdown", body: STRATEGY },
  { key: "risk-limits", title: "Hard risk limits", kind: "limits", format: "json", body: JSON.stringify(RISK_DEFAULTS, null, 2) },
  { key: "market", title: "Market notes: Cauldron DEX", kind: "market", format: "markdown", body: MARKET },
  { key: "shared", title: "Shared rules", kind: "rules", format: "markdown", body: SHARED },
  { key: "team", title: "Team graph", kind: "team", format: "json", body: JSON.stringify(TEAM, null, 2) },
  { key: "role:nova", title: "Nova: head trader", kind: "role", format: "markdown", body: NOVA },
  { key: "role:orin", title: "Orin: market scanner", kind: "role", format: "markdown", body: ORIN },
  { key: "role:vela", title: "Vela: research", kind: "role", format: "markdown", body: VELA },
  { key: "role:kade", title: "Kade: risk officer", kind: "role", format: "markdown", body: KADE },
  { key: "role:rune", title: "Rune: executor", kind: "role", format: "markdown", body: RUNE },
  { key: "role:zara", title: "Zara: journal and alerts", kind: "role", format: "markdown", body: ZARA },
];

/** Insert seed docs whose key doesn't exist yet. Never overwrites. Returns the titles added. */
export async function seedKnowledge(env: Env): Promise<string[]> {
  const have = new Set((await env.DB.prepare("SELECT key FROM knowledge").all<{ key: string }>()).results.map((r) => r.key));
  const missing = SEED.filter((d) => !have.has(d.key));
  for (const d of missing) await saveKnowledge(env, d.key, d.body, "seed");
  return missing.map((d) => d.title);
}

export async function loadKnowledge(env: Env): Promise<Map<string, string>> {
  const map = new Map(SEED.map((d) => [d.key, d.body]));
  for (const r of (await env.DB.prepare("SELECT key, body FROM knowledge").all<{ key: string; body: string }>()).results) map.set(r.key, r.body);
  return map;
}

/** Write a new version of a knowledge entry and keep the old one in history. */
export async function saveKnowledge(env: Env, key: string, body: string, by: string): Promise<number> {
  const seed = SEED.find((d) => d.key === key);
  const cur = await env.DB.prepare("SELECT title, kind, format, version FROM knowledge WHERE key = ?").bind(key).first<{ title: string; kind: string; format: string; version: number }>();
  if (!seed && !cur) throw new Error(`unknown knowledge key ${key}`);
  if ((cur?.format ?? seed!.format) === "json") JSON.parse(body);
  if (key === "risk-limits") parseRiskLimits(body, true);
  const version = (cur?.version ?? 0) + 1;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO knowledge (key, title, kind, format, body, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    ).bind(key, cur?.title ?? seed!.title, cur?.kind ?? seed!.kind, cur?.format ?? seed!.format, body, version, by, now),
    env.DB.prepare("INSERT INTO knowledge_history (key, version, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").bind(key, version, body, by, now),
  ]);
  return version;
}

/**
 * Risk limits from D1, checked against sane bounds. Invalid values fall back to the defaults
 * (or throw when strict, which is how the owner's edits are validated before saving).
 */
export function parseRiskLimits(body: string, strict = false): RiskLimits {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    if (strict) throw e;
    return RISK_DEFAULTS;
  }
  const out = structuredClone(RISK_DEFAULTS) as unknown as Record<string, unknown>;
  const errors: string[] = [];
  for (const [k, def] of Object.entries(RISK_DEFAULTS)) {
    const v = raw[k];
    if (v === undefined) continue;
    const ok = (n: unknown) => typeof n === "number" && isFinite(n) && n >= 0 && n <= (k.includes("Pct") ? 100 : 1e6);
    if (typeof def === "number") {
      if (ok(v)) out[k] = v;
      else errors.push(k);
    } else {
      const obj = v as Record<string, unknown>;
      for (const h of ["short", "medium", "long"]) {
        if (obj?.[h] === undefined) continue;
        if (ok(obj[h])) (out[k] as Record<string, number>)[h] = obj[h] as number;
        else errors.push(`${k}.${h}`);
      }
    }
  }
  if (strict && errors.length) throw new Error(`invalid risk limits: ${errors.join(", ")}`);
  return out as unknown as RiskLimits;
}

export async function loadRiskLimits(env: Env): Promise<RiskLimits> {
  return parseRiskLimits((await loadKnowledge(env)).get("risk-limits") ?? "{}");
}
