import type { Env } from "./config";
import SHARED from "../bots/SHARED.md";
import STRATEGY from "../bots/STRATEGY.md";

const XAI_URL = "https://api.x.ai/v1/chat/completions";

export const hasGrok = (env: Env) => Boolean(env.XAI_API_KEY);

/** Ask one agent for a JSON answer. The role file is the system prompt. */
export async function askAgent<T>(env: Env, role: string, task: string, input: unknown): Promise<T> {
  const res = await fetch(XAI_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROK_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SHARED}\n\n## STRATEGY (from the owner)\n\n${STRATEGY}\n\n## YOUR ROLE\n\n${role}` },
        { role: "user", content: `${task}\n\nINPUT:\n${JSON.stringify(input)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseJson<T>(body.choices[0]?.message?.content ?? "");
}

export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
