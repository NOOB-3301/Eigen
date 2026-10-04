/**
 * A model entry of one agent + that agent's .env -> what Mastra's model router takes. The key is always passed explicitly, so the router never
 * falls back to process.env: an agent without its own key fails with a clear message instead of quietly using someone else's.
 *
 * Checked against @mastra/core 1.73 (ModelRouterLanguageModel.resolveAuth, ModelRouterEmbeddingModel): with a `url` the router uses `apiKey ?? ""`
 * and never reads the environment; without a `url` it reads the provider's variable from process.env only when `apiKey` is empty. So every
 * entry handed to Mastra has a `url` or an `apiKey`.
 */
import { defaultApiKeyEnv, type ModelEntry } from "./schema.ts";

export type MastraModel = { id: `${string}/${string}`; url?: string; apiKey?: string };

export class MissingKeyError extends Error {}

/**
 * Where a keyless local provider listens when its entry has no `url`. Mastra's registry does not know "ollama" at all (a bare "ollama/x" does not
 * resolve) and knows "lmstudio" only with a LMSTUDIO_API_KEY it would read from process.env; an explicit url avoids both.
 */
export const LOCAL_PROVIDER_URL: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

export function toMastraModel(m: Pick<ModelEntry, "id" | "url" | "apiKeyEnv">, env: ReadonlyMap<string, string>): MastraModel {
  const name = defaultApiKeyEnv(m);
  const apiKey = name ? env.get(name) : undefined;
  if (name && !apiKey) throw new MissingKeyError(`${name} is not set in this agent's keys`);
  const url = m.url ?? (apiKey ? undefined : LOCAL_PROVIDER_URL[m.id.slice(0, m.id.indexOf("/"))]);
  // Neither a key nor a url would make the router look in process.env. defaultApiKeyEnv names a key for every provider it does not know as local.
  if (!url && !apiKey) throw new MissingKeyError(`${m.id}: no key and no url; set apiKeyEnv or url`);
  return { id: m.id as `${string}/${string}`, ...(url && { url }), ...(apiKey && { apiKey }) };
}

/** Prompt budget for models whose server silently truncates (Ollama). */
export const tokenBudget = (m: ModelEntry) => m.contextWindow && m.contextWindow - m.replyReserve;
