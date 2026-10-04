/**
 * Probes the studio calls from its server: "is this bot token good?" and "does this model answer?".
 * Neither ever returns a secret: errors are scrubbed of the token / key and run through `redact`.
 */
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { truncate } from "lodash-es";
import { toMastraModel, type Config } from "./config.ts";
import type { ModelTestResponse, TelegramCheckResponse } from "./schema.ts";
import { redact } from "./secrets.ts";

const scrub = (e: unknown, secrets: Array<string | undefined>) => {
  let text = redact(String((e as Error)?.message ?? e));
  for (const s of secrets) if (s) text = text.split(s).join("[redacted]");
  return truncate(text, { length: 300 });
};

/** Which env variables the token check may read: anything named TELEGRAM_*, or a variable some config names as a bot token. Never an arbitrary secret. */
export const telegramEnvAllowed = (name: string, known: string[]) => name.startsWith("TELEGRAM_") || known.includes(name);

/** getMe with this token. `api` is the Bot API base (TELEGRAM_API_BASE_URL in tests). */
export async function checkTelegramToken(token: string | undefined, api = "https://api.telegram.org", fetchFn: typeof fetch = fetch): Promise<TelegramCheckResponse> {
  if (!token) return { ok: false, error: "that variable is not set in .env" };
  try {
    const res = await fetchFn(`${api}/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: { username?: string }; description?: string } | undefined;
    if (res.ok && body?.ok) return { ok: true, username: body.result?.username };
    return { ok: false, error: `Telegram rejected the token: ${scrub(body?.description ?? `HTTP ${res.status}`, [token])}` };
  } catch (e) {
    return { ok: false, error: `could not reach Telegram: ${scrub(e, [token])}` };
  }
}

/** One tiny prompt to a model from the root catalog. */
export async function testModel(key: string, root: Pick<Config, "models">, env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<ModelTestResponse> {
  const m = root.models[key];
  const started = Date.now();
  const ms = () => Date.now() - started;
  if (!m) return { ok: false, ms: 0, error: `no model "${key}" in config.json` };
  const secrets = [m.apiKeyEnv ? env[m.apiKeyEnv] : undefined];
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
