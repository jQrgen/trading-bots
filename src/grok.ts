import type { Env } from "./config";
import SHARED from "../bots/SHARED.md";
import STRATEGY from "../bots/STRATEGY.md";
import MARKET from "../bots/MARKET.md";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

export const hasGrok = (env: Env) => Boolean(env.XAI_API_KEY);

const systemPrompt = (role: string) => `${SHARED}\n\n${MARKET}\n\n## STRATEGY (from the owner)\n\n${STRATEGY}\n\n## YOUR ROLE\n\n${role}`;

/**
 * Ask one agent for a JSON answer. The role file is the system prompt.
 * With search, Grok may look things up on X and the web first (xAI server-side tools).
 */
export async function askAgent<T>(env: Env, role: string, task: string, input: unknown, opts: { search?: boolean } = {}): Promise<T> {
  if (opts.search) {
    try {
      return await askWithSearch<T>(env, role, task, input);
    } catch {
      // Search is a bonus; fall back to a plain call.
    }
  }
  const res = await fetch(XAI_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROK_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(role) },
        { role: "user", content: `${task}\n\nINPUT:\n${JSON.stringify(input)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseJson<T>(body.choices[0]?.message?.content ?? "");
}

async function askWithSearch<T>(env: Env, role: string, task: string, input: unknown): Promise<T> {
  const res = await fetch(XAI_RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROK_MODEL,
      input: [
        { role: "system", content: systemPrompt(role) },
        { role: "user", content: `${task}\nUse X search to check what real people say about each token before deciding. Finish with the JSON only.\n\nINPUT:\n${JSON.stringify(input)}` },
      ],
      tools: [{ type: "x_search" }, { type: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`grok responses ${res.status}`);
  const body = (await res.json()) as { output_text?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text =
    body.output_text ??
    (body.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? "")
      .join("\n");
  return parseJson<T>(text);
}

export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
