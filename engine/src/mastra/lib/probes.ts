/**
 * Probes the studio calls through its server: "is this bot token good?", "does this model answer?". Each one runs with ONE agent's .env.
 * None ever returns a secret: errors are scrubbed of every value in that .env and run through `redact`.
 */
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { truncate } from "lodash-es";
import { z } from "zod";
import { toMastraModel } from "./models.ts";
import { ModelKey, ModelSchema, type ModelEntry, type ModelTestResponse, type TelegramCheckResponse } from "./schema.ts";
import { redact } from "./secrets.ts";

export const scrub = (e: unknown, secrets: Iterable<string | undefined>) => {
  let text = redact(String((e as Error)?.message ?? e));
  for (const s of secrets) if (s) text = text.split(s).join("[redacted]");
  return truncate(text, { length: 300 });
};

/** Which of an agent's variables the token check may read: anything named TELEGRAM_*, or the one its config names as its bot token. Never another secret. */
export const telegramEnvAllowed = (name: string, known: string[]) => name.startsWith("TELEGRAM_") || known.includes(name);

/** Which of an agent's variables the GitHub check may read: anything named GITHUB_*, or one its github-pr triggers name as their token. Never another secret. */
export const githubEnvAllowed = (name: string, known: string[]) => name.startsWith("GITHUB_") || known.includes(name);

/** getMe with this token. `api` is the Bot API base (TELEGRAM_API_BASE_URL in tests). */
export async function checkTelegramToken(token: string | undefined, api = "https://api.telegram.org", fetchFn: typeof fetch = fetch): Promise<TelegramCheckResponse> {
  if (!token) return { ok: false, error: "that variable is not set in this agent's keys" };
  try {
    const res = await fetchFn(`${api}/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: { username?: string }; description?: string } | undefined;
    if (res.ok && body?.ok) return { ok: true, username: body.result?.username };
    return { ok: false, error: `Telegram rejected the token: ${scrub(body?.description ?? `HTTP ${res.status}`, [token])}` };
  } catch (e) {
    return { ok: false, error: `could not reach Telegram: ${scrub(e, [token])}` };
  }
}

/** One tiny prompt to one model of an agent, with that agent's key (from its .env, never process.env). */
export async function testModel(key: string, agent: { models: Record<string, ModelEntry> }, env: ReadonlyMap<string, string>, timeoutMs = 20_000): Promise<ModelTestResponse> {
  const m = agent.models[key];
  const started = Date.now();
  const ms = () => Date.now() - started;
  if (!m) return { ok: false, ms: 0, error: `no model "${key}" in this agent's config` };
  const secrets = [...env.values()];
  try {
    // The model router itself, not an Agent: an Agent swallows connection and auth errors and just returns an empty "retry", which cannot be told from success.
    const model = new ModelRouterLanguageModel(toMastraModel(m, env) as never);
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error(`no answer after ${timeoutMs / 1000}s`)), { once: true }));
    // At runtime the result carries `content` (a V2 generate result) although the router types it as a stream result.
    const out = (await Promise.race([model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }], abortSignal: signal }), timedOut])) as unknown as { content: Array<{ type: string; text?: string }> };
    const text = out.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
    return { ok: true, ms: ms(), reply: truncate(scrub(text, secrets), { length: 120 }) };
  } catch (e) {
    return { ok: false, ms: ms(), error: scrub(e, secrets) };
  }
}

/**
 * What the checks may read, from an agent's config.json as it is on disk right now (the studio saves, then checks at once, before the
 * registry's next scan). Read leniently: a config that is invalid elsewhere still names its bot token and its models.
 */
export function checkableNames(raw: unknown): { telegram: string[]; github: string[] } {
  const c = (raw ?? {}) as { telegram?: { tokenEnv?: unknown }; triggers?: unknown };
  const telegram = typeof c.telegram?.tokenEnv === "string" ? [c.telegram.tokenEnv] : [];
  const github = Array.isArray(c.triggers) ? c.triggers.flatMap((t) => (t?.type === "github-pr" && typeof t.tokenEnv === "string" ? [t.tokenEnv as string] : [])) : [];
  return { telegram, github };
}

/** The agent's model catalog from config.json on disk, or undefined when it does not parse. */
export const modelsOf = (raw: unknown): Record<string, ModelEntry> | undefined => {
  const parsed = z.record(ModelKey, ModelSchema).safeParse((raw as { models?: unknown } | undefined)?.models);
  return parsed.success ? parsed.data : undefined;
};
