import type { Config } from "@eigen/engine/config";
import { getPath } from "@/components/inspector/fields";

type Obj = Record<string, unknown>;

export type Problems = Record<string, string>;

export const SECTION_OF: Array<[prefix: string, section: "models" | "telegram" | "memory" | "sandbox" | "tools" | "advanced"]> = [
  ["defaultModel", "models"],
  ["curatorModel", "models"],
  ["models", "models"],
  ["telegram", "telegram"],
  ["memory", "memory"],
  ["sandbox", "sandbox"],
  ["mcpServers", "tools"],
  ["timezone", "advanced"],
  ["limits", "advanced"],
  ["mcp", "advanced"],
];

export const sectionOfPath = (path: string) => SECTION_OF.find(([p]) => path === p || path.startsWith(`${p}.`))?.[1];

const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
const isUrl = (s: unknown) => typeof s === "string" && URL.canParse(s);
export const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

const POS_INT_PATHS = [
  "limits.maxSteps",
  "mcp.startupTimeoutMs",
  "memory.lastMessages",
  "memory.semanticRecall.topK",
  "memory.semanticRecall.messageRange",
  "memory.observational.messageTokens",
  "memory.observational.reflectionTokens",
  "memory.knowledge.maxPins",
  "memory.knowledge.maxCharacters",
  "sandbox.commandTimeoutMs",
  "sandbox.maxTimeoutSec",
];

/** Mirrors ConfigSchema's rules in the browser (the schema itself pulls in node:fs). The server's answer on save is still the authority. */
export function validateRoot(config: Obj, defaults: Config, base: Obj = {}): Problems {
  const out: Problems = {};
  const add = (path: string, msg: string) => void (out[path] ??= msg);
  const models = (config.models && typeof config.models === "object" ? config.models : {}) as Record<string, Obj>;
  const keys = Object.keys(models);
  const savedKeys = new Set(Object.keys((base.models ?? {}) as Obj));

  if (!keys.length) add("models", "add at least one model");
  if (typeof config.defaultModel !== "string" || !config.defaultModel) add("defaultModel", "pick the default model");
  else if (!(config.defaultModel in models)) add("defaultModel", "must be one of the models");
  for (const p of ["curatorModel", "memory.observational.model", "memory.knowledge.model"]) {
    const v = getPath(config, p);
    if (v !== undefined && !(typeof v === "string" && v in models)) add(p, "must be one of the models");
  }

  for (const [k, m] of Object.entries(models)) {
    // Only new names are held to the tidy format; a name already in the file stays valid whatever it looks like.
    if (!savedKeys.has(k) && !MODEL_KEY.test(k)) add(`models.${k}`, "key: letters, digits, '.', '_' or '-' (max 48), starting with a letter or digit");
    if (typeof m?.id !== "string" || !/^[^/\s]+\/\S+$/.test(m.id)) add(`models.${k}.id`, 'use "provider/model", e.g. openai/gpt-4o-mini');
    if (m?.url !== undefined && !isUrl(m.url)) add(`models.${k}.url`, "not a valid URL");
    if (m?.apiKeyEnv !== undefined && (typeof m.apiKeyEnv !== "string" || !m.apiKeyEnv)) add(`models.${k}.apiKeyEnv`, "name of an environment variable, or leave empty");
    for (const f of ["contextWindow", "replyReserve"]) if (m?.[f] !== undefined && !isPosInt(m[f])) add(`models.${k}.${f}`, "must be a positive whole number");
  }

  for (const p of POS_INT_PATHS) {
    const v = getPath(config, p);
    if (v !== undefined && !isPosInt(v)) add(p, "must be a positive whole number");
  }

  const ids = getPath(config, "telegram.allowedUserIds");
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((n) => !Number.isInteger(n)))) add("telegram.allowedUserIds", "one whole number per line (your Telegram user id)");
  const emb = getPath(config, "memory.embedder.url");
  if (emb !== undefined && !isUrl(emb)) add("memory.embedder.url", "not a valid URL");

  const eff = (p: string) => (getPath(config, p) ?? getPath(defaults, p)) as boolean;
  if (eff("memory.knowledge.enabled") && !eff("memory.observational.enabled")) add("memory.knowledge.enabled", "needs observational memory turned on");
  if (eff("memory.knowledge.enabled") && !eff("memory.semanticRecall.enabled")) add("memory.knowledge.enabled", "needs semantic recall turned on (the knowledge index uses it)");

  const servers = (config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}) as Record<string, Obj>;
  for (const [name, s] of Object.entries(servers)) {
    if (!name.trim()) add("mcpServers", "a server needs a name");
    if (s && "url" in s) {
      if (!isUrl(s.url)) add(`mcpServers.${name}.url`, "not a valid URL");
    } else if (typeof s?.command !== "string" || !s.command.trim()) add(`mcpServers.${name}.command`, "command is required");
  }
  return out;
}

/** "path: message" -> { path: message }. Reference issues from the engine ("agent x: model "y" is not ...") are attached to the thing they name. */
export function issuesToProblems(issues: string[]): { byPath: Problems; loose: string[] } {
  const byPath: Problems = {};
  const loose: string[] = [];
  for (const raw of issues) {
    const agent = /^agent "([^"]+)": (.*)$/.exec(raw);
    if (agent) {
      const model = /model "([^"]+)"/.exec(agent[2]!)?.[1];
      const server = /"([^"]+)" is not in root mcpServers/.exec(agent[2]!)?.[1];
      const target = model ? `models.${model}` : server ? `mcpServers.${server}` : undefined;
      if (target) byPath[target] ??= `Agent "${agent[1]}" still uses this. Switch that agent first.`;
      loose.push(raw);
      continue;
    }
    const m = /^([^\s:]+): ([\s\S]*)$/.exec(raw);
    if (m && m[1] !== "config") byPath[m[1]!] ??= m[2]!;
    else loose.push(m ? m[2]! : raw);
  }
  return { byPath, loose };
}

/** Key-order-independent JSON, so "same content" means equal even after edits reordered keys. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Obj).sort(([a], [b]) => a.localeCompare(b))) : x));
}
