import type { Env } from "./config";
import { loadKnowledge } from "./knowledge";

const XAI_BASE = "https://api.x.ai/v1";

export const hasGrok = (env: Env) => Boolean(env.XAI_API_KEY);

export type AgentId = "nova" | "orin" | "vela" | "kade" | "zara";

/** The system prompt is built from the knowledge base in D1, so it's exactly what the desk shows. */
async function systemPrompt(env: Env, agent: AgentId) {
  const k = await loadKnowledge(env);
  return `${k.get("shared")}\n\n${k.get("playbook")}\n\n${agent === "vela" || agent === "kade" || agent === "nova" ? k.get("skill:liquidity") : ""}\n\n${k.get("market")}\n\n## STRATEGY (from the owner)\n\n${k.get("strategy")}\n\n## YOUR ROLE\n\n${k.get(`role:${agent}`)}`;
}

/**
 * Ask one agent for a JSON answer. Every call (prompt and reply) is stored in agent_calls.
 * With search, Grok may look things up on X and the web first (xAI server-side tools).
 */
export async function askAgent<T>(env: Env, agent: AgentId, task: string, input: unknown, opts: { search?: boolean; cycle?: number } = {}): Promise<T> {
  const system = await systemPrompt(env, agent);
  const user = `${task}\n\nINPUT:\n${JSON.stringify(input)}`;
  if (opts.search) {
    try {
      return await recorded(env, agent, opts.cycle, true, system, user, () => callWithSearch(env, system, user));
    } catch {
      // Search is a bonus; fall back to a plain call.
    }
  }
  return recorded(env, agent, opts.cycle, false, system, user, () => callPlain(env, system, user));
}

async function recorded<T>(env: Env, agent: AgentId, cycle: number | undefined, search: boolean, system: string, user: string, call: () => Promise<string>): Promise<T> {
  const started = Date.now();
  let output: string | null = null;
  let error: string | null = null;
  try {
    output = await call();
    return parseJson<T>(output);
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    await env.DB.prepare("INSERT INTO agent_calls (ts, cycle, agent, model, search, system_prompt, input, output, error, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(started, cycle ?? null, agent, env.GROK_MODEL, search ? 1 : 0, system, user, output, error, Date.now() - started)
      .run()
      .catch(() => {});
  }
}

async function callPlain(env: Env, system: string, user: string): Promise<string> {
  const res = await fetch(`${env.XAI_BASE_URL || XAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROK_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0]?.message?.content ?? "";
}

async function callWithSearch(env: Env, system: string, user: string): Promise<string> {
  const res = await fetch(`${env.XAI_BASE_URL || XAI_BASE}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROK_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: `${user}\n\nUse X search to check what real people say about each token before deciding. Finish with the JSON only.` },
      ],
      tools: [{ type: "x_search" }, { type: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`grok responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { output_text?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] };
  return (
    body.output_text ??
    (body.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? "")
      .join("\n")
  );
}

export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
