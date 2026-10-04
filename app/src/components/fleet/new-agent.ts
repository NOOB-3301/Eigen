import { AgentId, CreateAgentRequest, defaultApiKeyEnv, type ModelInput } from "@eigen/engine/schema";

/* The new-agent form as pure functions: id from the name, model presets, and the request with its errors per field. */

/** A valid agent id from a display name: "Research Bot 2" -> "research-bot-2". Empty when nothing usable is left. */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");

export type ModelPreset = { key: string; label: string; id: string; url?: string; hint: string };

/** A few starting points; the id stays editable, so any provider Mastra's model router knows works. */
export const MODEL_PRESETS: ModelPreset[] = [
  { key: "anthropic", label: "Anthropic", id: "anthropic/claude-sonnet-5-5", hint: "Claude, with an Anthropic API key." },
  { key: "openrouter", label: "OpenRouter", id: "openrouter/anthropic/claude-sonnet-5-5", hint: "Any model on OpenRouter, with one key." },
  { key: "ollama", label: "Ollama (local)", id: "ollama/llama3.2", url: "http://localhost:11434/v1", hint: "A model on this machine. No key." },
  { key: "ollama-cloud", label: "Ollama Cloud", id: "ollama-cloud/gpt-oss:120b", hint: "Ollama's hosted models, with an Ollama key." },
];

export type NewAgentForm = { name: string; id: string; role: string; description: string; modelId: string; modelUrl: string; instructions: string };

/** The CreateAgentRequest the form describes, or the first error per field (keys: name, id, role, description, model, url, instructions). */
export function toCreateRequest(f: NewAgentForm, takenIds: string[] = []): { req?: CreateAgentRequest; errors: Record<string, string> } {
  const model: ModelInput = { id: f.modelId.trim(), ...(f.modelUrl.trim() && { url: f.modelUrl.trim() }) };
  const raw = {
    id: f.id.trim(),
    name: f.name.trim(),
    ...(f.role.trim() && { role: f.role.trim() }),
    ...(f.description.trim() && { description: f.description.trim() }),
    model,
    ...(f.instructions.trim() && { instructionsText: f.instructions }),
  };
  const errors: Record<string, string> = {};
  const r = CreateAgentRequest.safeParse(raw);
  if (!r.success)
    for (const i of r.error.issues) {
      const field = i.path[0] === "model" ? (i.path[1] === "url" ? "url" : "model") : i.path[0] === "instructionsText" ? "instructions" : String(i.path[0] ?? "form");
      errors[field] ??= field === "name" && !raw.name ? "give it a name" : i.message;
    }
  if (raw.id && AgentId.safeParse(raw.id).success && takenIds.includes(raw.id)) errors.id = "an agent with this id already exists";
  return Object.keys(errors).length ? { errors } : { req: raw as CreateAgentRequest, errors };
}

/** The .env variable the new agent's model will read its key from, or undefined for a local model. What to tell the user to set. */
export const keyFor = (modelId: string, url: string): string | undefined =>
  /^[^/\s]+\/\S+$/.test(modelId.trim()) ? defaultApiKeyEnv({ id: modelId.trim(), ...(url.trim() && { url: url.trim() }) }) : undefined;
