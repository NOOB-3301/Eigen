/**
 * Shared contract between the engine and the web app (`@eigen/engine/schema`).
 * Pure: zod + types only, no node:* imports, so Next.js can import it from client or server code.
 *
 * Every agent is STANDALONE. Its folder ~/.eigen/agents/<id>/ holds everything it uses, and nothing is shared between agents:
 *   config.json          AgentConfigSchema below: its models, memory and storage, tools, sandbox policy, Telegram bot, triggers
 *   .env                 its secrets (model keys, bot token, storage token, GitHub token). Write-only from the studio; config.json holds only NAMES
 *   instructions.md      its role prompt
 *   soul.md              its persona, when soul.enabled
 *   skills/<slug>/       its skill library (SKILL.md per skill)
 *   sandbox/             its workspace (the only place its shell and file tools may write)
 *   memory.db            its storage, when memory.storage has no remote url
 *   data/                its run history and state
 * There is no root config.json and no root .env. Agents never call each other: wiring agents together is the next phase (workflows).
 */
import { z } from "zod";

export const AGENT_SCHEMA_VERSION = 2;
export const AGENT_CONFIG_FILE = "config.json";
/** Each agent's secrets file, inside its folder. */
export const AGENT_ENV_FILE = ".env";

const posInt = z.number().int().positive();
const strMap = z.record(z.string(), z.string());
/** Names of .env variables the studio may write (and config may reference). Upper-case so they cannot be confused with config keys. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const EnvName = (example: string) => z.string().regex(ENV_NAME, `upper-case env var name, e.g. ${example}`);
export const AgentId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase slug: a-z, 0-9, '-', max 32 chars");
/** Key of an entry in an agent's `models`. */
export const ModelKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "letters, digits, '_' or '-', max 40 chars");
/** Name of an MCP server of an agent. MCP tools are named `<server>_<tool>`. */
export const McpName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/, "letters, digits or '-', max 32 chars (no '_': tools are named <server>_<tool>)");
/** A skill folder under the agent's skills/: "pdf", or "@owner/slug" for ClawHub installs. Never contains "..", a leading dot, or a backslash. */
export const SkillSlug = z.string().max(100).regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase slug such as pdf-tools, or @owner/slug");
export const TriggerId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase slug: a-z, 0-9, '-', max 32 chars");
/** owner/name of a GitHub repo. "." and ".." are valid characters but never a name: in the API path they would climb out of /repos/. */
export const GITHUB_REPO = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const CRON_FIELDS = /^\s*\S+(\s+\S+){4}\s*$/;
/** A plain file name in the agent folder (no sub-folders, nothing to traverse). */
const FolderMd = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, "a file name ending in .md, in the agent folder");

/* ------------------------------------------------------------------------------------------------ */
/* Models (the LLM node)                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export const ModelSchema = z.object({
  /** "provider/model", as Mastra's model router spells it: "anthropic/claude-sonnet-5-5", "ollama-cloud/gpt-oss:120b", "ollama/llama3.2". */
  id: z.string().regex(/^[^/\s]+\/\S+$/, 'use "provider/model"'),
  /** An OpenAI-compatible endpoint (Ollama, LM Studio, a proxy). Omitted: the provider's own API. */
  url: z.url().optional(),
  /** Variable in THIS agent's .env that holds the key. Omitted: the provider's usual name (defaultApiKeyEnv), or no key for a model with a `url`. */
  apiKeyEnv: EnvName("ANTHROPIC_API_KEY").optional(),
  /** Prompt budget for servers that silently truncate (Ollama): the engine trims history to contextWindow - replyReserve. */
  contextWindow: posInt.optional(),
  replyReserve: posInt.default(4096),
});
export type ModelEntry = z.infer<typeof ModelSchema>;
export type ModelInput = z.input<typeof ModelSchema>;
export const EmbedderSchema = ModelSchema.pick({ id: true, url: true, apiKeyEnv: true });

/**
 * The .env variable a model's key is read from when its entry names none. A model with a `url` and no `apiKeyEnv` gets no key (a local server).
 * The engine passes this key to Mastra itself and never lets the model router fall back to the process environment, so one agent can never
 * use another agent's (or the shell's) key.
 */
export function defaultApiKeyEnv(m: Pick<ModelEntry, "id" | "url" | "apiKeyEnv">): string | undefined {
  if (m.apiKeyEnv) return m.apiKeyEnv;
  if (m.url) return undefined;
  const provider = m.id.slice(0, m.id.indexOf("/"));
  const known = PROVIDER_KEY_ENV[provider];
  return known === null ? undefined : (known ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`);
}
/**
 * Where a provider's usual key variable is not `<PROVIDER>_API_KEY`, checked against Mastra's provider registry (about 60 of its 211 providers differ;
 * these are the common ones). Only the DEFAULT name is affected: the engine always hands the key to Mastra itself, so an entry that sets
 * `apiKeyEnv` to anything works for any provider. null: a local provider, no key.
 */
const PROVIDER_KEY_ENV: Record<string, string | null> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  zai: "ZHIPU_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  huggingface: "HF_TOKEN",
  togetherai: "TOGETHER_API_KEY",
  "fireworks-ai": "FIREWORKS_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
  volcengine: "ARK_API_KEY",
  friendli: "FRIENDLI_TOKEN",
  digitalocean: "DIGITALOCEAN_ACCESS_TOKEN",
  "perplexity-agent": "PERPLEXITY_API_KEY",
  ollama: null,
  lmstudio: null,
};

/* ------------------------------------------------------------------------------------------------ */
/* Memory (the storage node and the memory blocks that plug into it)                                  */
/* ------------------------------------------------------------------------------------------------ */

export const DEFAULT_WORKING_MEMORY_TEMPLATE = `# About the user
- Name:
- Timezone:
- Preferences:
- Current focus:
- Standing instructions:
`;

/** resource: one per person, across all their chats with this agent. thread: one per conversation. */
export const MemoryScope = z.enum(["resource", "thread"]);

export const StorageSchema = z.object({
  /** Off: the agent keeps nothing between messages, and every memory block must be off too. */
  enabled: z.boolean().default(true),
  provider: z.literal("libsql").default("libsql"),
  /**
   * Omitted: memory.db in this agent's folder. Otherwise a remote LibSQL database (Turso, sqld). Never a `file:` URL: that could point at any
   * file on the machine, including another agent's memory.
   */
  url: z
    .string()
    .regex(/^(libsql|https|wss):\/\/\S+$/, "a remote LibSQL URL (libsql://, https:// or wss://); leave it out for this agent's own memory.db")
    .optional(),
  /** Variable in this agent's .env holding the remote database's auth token. */
  authTokenEnv: EnvName("LIBSQL_AUTH_TOKEN").optional(),
});

export const MemorySchema = z.object({
  storage: StorageSchema.prefault({}),
  /** The last `count` messages of the conversation, sent with every turn. */
  lastMessages: z.object({ enabled: z.boolean().default(true), count: posInt.max(500).default(20) }).prefault({}),
  /** A markdown document the agent keeps up to date about the person (Mastra working memory). The template is its starting shape. */
  workingMemory: z
    .object({ enabled: z.boolean().default(true), scope: MemoryScope.default("resource"), template: z.string().min(1).max(20_000).default(DEFAULT_WORKING_MEMORY_TEMPLATE) })
    .prefault({}),
  /** Finds old messages by meaning (vector search in the storage) and adds them, with `messageRange` messages around each. */
  semanticRecall: z
    .object({
      enabled: z.boolean().default(false),
      scope: MemoryScope.default("resource"),
      topK: posInt.max(50).default(4),
      messageRange: posInt.max(20).default(2),
      embedder: EmbedderSchema.prefault({ id: "ollama/nomic-embed-text", url: "http://localhost:11434/v1" }),
    })
    .prefault({}),
  /** Mastra Observational Memory: background Observer/Reflector agents compress old turns into observations. */
  observational: z
    .object({
      enabled: z.boolean().default(false),
      /** Key in this agent's `models`. Omitted: the agent's own model. */
      model: ModelKey.optional(),
      messageTokens: posInt.default(8000),
      reflectionTokens: posInt.default(20_000),
      activateAfterIdle: z.string().regex(/^\d+(s|m|h)$/, 'a duration such as "30m"').default("30m"),
      retrieval: z.boolean().default(true),
    })
    .prefault({}),
  /** Mastra's experimental Subconscious: a curate agent keeps durable knowledge and pins, delivered every turn. Needs semantic recall AND observational memory. */
  subconscious: z
    .object({
      enabled: z.boolean().default(false),
      /** Key in this agent's `models`. It calls tools with strict schemas, so a weak model fails it. Omitted: the observational model. */
      model: ModelKey.optional(),
      pins: z.boolean().default(true),
      tools: z.boolean().default(true),
      maxPins: posInt.max(100).default(20),
      maxCharacters: posInt.max(20_000).default(2000),
    })
    .prefault({}),
});
export type MemoryConfig = z.infer<typeof MemorySchema>;
/** The memory blocks, in canvas order. Each needs the storage node. */
export const MEMORY_BLOCKS = ["lastMessages", "workingMemory", "semanticRecall", "observational", "subconscious"] as const;
export type MemoryBlock = (typeof MEMORY_BLOCKS)[number];

/* ------------------------------------------------------------------------------------------------ */
/* Tools, sandbox, triggers                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** Tools that are code in the engine, not MCP. workspace: files + shell in the agent's sandbox, and its skills. schedule: the agent sets reminders for itself. */
export const BUILTIN_TOOLS = ["workspace", "schedule"] as const;

const mcpFlags = { enabled: z.boolean().default(true), trusted: z.boolean().default(false) };
/** `env` and `headers` values may be "env:NAME": read from this agent's .env when the server starts. */
export const McpStdioSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: strMap.optional(), ...mcpFlags });
export const McpRemoteSchema = z.object({ url: z.url(), headers: strMap.optional(), transport: z.enum(["http", "sse"]).optional(), ...mcpFlags });
export const McpServerSchema = z.union([McpStdioSchema, McpRemoteSchema]);
export type McpServer = z.infer<typeof McpServerSchema>;
export const isRemoteMcp = (s: McpServer): s is z.infer<typeof McpRemoteSchema> => "url" in s;

/** macOS only: seatbelt can read everything unless told otherwise. (On Linux the sandbox never sees your home.) */
export const DEFAULT_DENY_READ = [
  "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.config", "~/.netrc", "~/.npmrc", "~/.zsh_history", "~/.bash_history",
  "~/Library/Keychains", "~/Library/Application Support", "~/Library/Mail", "~/Library/Messages", "~/Library/Safari", "~/Library/Cookies",
  "~/Documents", "~/Desktop", "~/Downloads",
];

/**
 * The agent's shell and file tools run here. Whatever these lists say, the engine always hides the rest of ~/.eigen from the sandbox: other agents'
 * folders, and this agent's own .env, config.json and memory.db. Only its sandbox/ (read-write) and skills/ (read-only) are visible.
 */
export const SandboxSchema = z.object({
  isolation: z.enum(["auto", "seatbelt", "bwrap", "none"]).default("auto"),
  allowNetwork: z.boolean().default(true),
  readWritePaths: z.array(z.string()).default([]),
  readOnlyPaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default(DEFAULT_DENY_READ),
  commandTimeoutMs: posInt.default(120_000),
  maxTimeoutSec: posInt.default(900),
});

/**
 * What a trigger's `prompt` may reference as {{name}}. The engine fills them from the event and always wraps the event data (not the prompt) in an
 * <event> block it tells the agent to treat as untrusted DATA: a PR title or body is written by someone else and can try to give the agent orders.
 */
export const TRIGGER_PLACEHOLDERS = {
  cron: ["now", "date", "time"],
  "github-pr": ["event", "repo", "pr.number", "pr.title", "pr.url", "pr.author", "pr.base", "pr.head", "pr.draft", "pr.body"],
} as const;

const triggerCommon = {
  id: TriggerId,
  enabled: z.boolean().default(true),
  /** What to do when it fires, written as an instruction to the agent, with optional {{placeholders}} (TRIGGER_PLACEHOLDERS). */
  prompt: z.string().min(1).max(4000),
  /** Send the agent's final reply to its Telegram allow-list. Skipped (and logged) when the agent has no running bot. The run log always keeps the reply. */
  deliverToTelegram: z.boolean().default(true),
};

/**
 * Something that wakes an agent up on its own. Hot reloaded with the agent, and stopped when the agent is replaced or trashed.
 * cron: a five-field cron expression in `timezone` (default: the agent's timezone).
 * github-pr: polls the GitHub REST API for pull requests of one repo with the token in `tokenEnv` (a variable in this agent's .env).
 *   The first poll only records the PRs that are already open; it never fires for them.
 */
export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ ...triggerCommon, type: z.literal("cron"), cron: z.string().regex(CRON_FIELDS, "five fields: minute hour day-of-month month weekday"), timezone: z.string().min(1).max(64).optional() }),
  z.object({
    ...triggerCommon,
    type: z.literal("github-pr"),
    repo: z.string().regex(GITHUB_REPO, "owner/name"),
    tokenEnv: EnvName("GITHUB_TOKEN"),
    /** opened: a PR the poller has not seen. updated: a seen PR whose head commit changed. */
    events: z.array(z.enum(["opened", "updated"])).min(1).default(["opened"]),
    intervalSec: z.number().int().min(60).max(3600).default(300),
    includeDrafts: z.boolean().default(false),
  }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerInput = z.input<typeof TriggerSchema>;

/* ------------------------------------------------------------------------------------------------ */
/* The agent                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export const AgentConfigSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SCHEMA_VERSION).default(AGENT_SCHEMA_VERSION),
    /** Must equal the folder name. Also the Mastra agent id. */
    id: AgentId,
    name: z.string().min(1).max(64),
    /** Short label for the UI ("researcher", "planner"). */
    role: z.string().min(1).max(40).default("assistant"),
    /** What the agent is for, shown in the studio. */
    description: z.string().max(1000).default(""),
    enabled: z.boolean().default(true),
    /** IANA time zone for triggers, schedules and the date in the prompt. Omitted: the machine's. */
    timezone: z.string().min(1).max(64).optional(),
    /** This agent's model catalog. Keys are referenced by `model`, `memory.observational.model` and `memory.subconscious.model`. */
    models: z.record(ModelKey, ModelSchema).refine((m) => Object.keys(m).length > 0, "add at least one model"),
    /** The model the agent thinks with: a key in `models`. The /model command in chat switches between this agent's models. */
    model: ModelKey,
    instructions: z
      .object({
        /** In the agent folder. Missing file + no inline = the agent is invalid. */
        file: FolderMd.default("instructions.md"),
        /** Used instead of `file` when set. */
        inline: z.string().max(100_000).optional(),
      })
      .prefault({}),
    /** The persona block of the prompt, from `file` in the agent folder. */
    soul: z.object({ enabled: z.boolean().default(false), file: FolderMd.default("soul.md") }).prefault({}),
    memory: MemorySchema.prefault({}),
    tools: z
      .object({
        builtin: z.array(z.enum(BUILTIN_TOOLS)).default(["workspace"]),
        /** This agent's MCP servers. */
        mcp: z.record(McpName, McpServerSchema).default({}),
        mcpStartupTimeoutMs: posInt.default(20_000),
      })
      .prefault({}),
    /** Which of the agent's own skills (skills/<slug>/) it loads. Needs the workspace tool. */
    skills: z.object({ enabled: z.union([z.literal("all"), z.array(SkillSlug)]).default("all") }).prefault({}),
    sandbox: SandboxSchema.prefault({}),
    limits: z.object({ maxSteps: posInt.max(200).default(25) }).prefault({}),
    /** Chat with this agent on Telegram through its own bot (create one with @BotFather; one token serves exactly one agent). */
    telegram: z
      .object({
        enabled: z.boolean().default(false),
        /** Variable in this agent's .env holding the bot token. */
        tokenEnv: EnvName("TELEGRAM_BOT_TOKEN").default("TELEGRAM_BOT_TOKEN"),
        /** Telegram user ids allowed to talk to the bot. Never empty while enabled: the bot would answer anyone. */
        allowedUserIds: z.array(z.number().int().positive()).default([]),
      })
      .prefault({}),
    triggers: z.array(TriggerSchema).default([]),
  })
  .refine((a) => a.model in a.models, { path: ["model"], message: "must name an entry in models" })
  .refine((a) => !a.memory.observational.model || a.memory.observational.model in a.models, { path: ["memory", "observational", "model"], message: "must name an entry in models" })
  .refine((a) => !a.memory.subconscious.model || a.memory.subconscious.model in a.models, { path: ["memory", "subconscious", "model"], message: "must name an entry in models" })
  .refine((a) => a.memory.storage.enabled || MEMORY_BLOCKS.every((b) => !a.memory[b].enabled), {
    path: ["memory", "storage", "enabled"],
    message: "every memory block needs the storage: turn storage on, or the memory blocks off",
  })
  .refine((a) => !a.memory.subconscious.enabled || (a.memory.semanticRecall.enabled && a.memory.observational.enabled), {
    path: ["memory", "subconscious", "enabled"],
    message: "subconscious needs semantic recall and observational memory",
  })
  .refine((a) => !a.memory.storage.url?.startsWith("libsql://") || !!a.memory.storage.authTokenEnv, {
    path: ["memory", "storage", "authTokenEnv"],
    message: "a libsql:// database needs an auth token: name the .env variable that holds it",
  })
  .refine((a) => new Set(a.triggers.map((t) => t.id)).size === a.triggers.length, { path: ["triggers"], message: "trigger ids must be unique within an agent" });

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** The settings an agent runs with: its config with defaults filled in, its timezone decided and its model looked up. */
export type ResolvedAgent = Omit<AgentConfig, "schemaVersion" | "model" | "timezone" | "limits"> & {
  modelKey: string;
  model: ModelEntry;
  timezone: string;
  maxSteps: number;
};

export function resolveAgent(a: AgentConfig, machineTimezone: string): ResolvedAgent {
  const { schemaVersion: _version, model, timezone, limits, ...rest } = a;
  return { ...rest, modelKey: model, model: a.models[model]!, timezone: timezone ?? machineTimezone, maxSteps: limits.maxSteps };
}

const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Problems the schema cannot see. Returned instead of thrown so the studio can show all of them; any problem keeps the agent from loading. */
export function agentProblems(a: AgentConfig): string[] {
  const problems: string[] = [];
  if (a.timezone && !validTimezone(a.timezone)) problems.push(`timezone: "${a.timezone}" is not a time zone`);
  for (const t of a.triggers) if (t.type === "cron" && t.timezone && !validTimezone(t.timezone)) problems.push(`triggers.${t.id}.timezone: "${t.timezone}" is not a time zone`);
  if (a.telegram.enabled && a.telegram.allowedUserIds.length === 0) problems.push("telegram: add at least one allowed user id; without one the bot would answer anyone");
  return problems;
}

/**
 * Problems between agents, keyed by agent id. Only resources that must never be shared are checked here: two agents on one remote database.
 * (Two agents on one Telegram bot token is checked by the engine, which compares the token VALUES in each agent's .env.)
 */
export function fleetProblems(agents: AgentConfig[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const owner = new Map<string, string>();
  for (const a of [...agents].filter((x) => x.enabled).sort((x, y) => x.id.localeCompare(y.id))) {
    const url = a.memory.storage.enabled ? a.memory.storage.url : undefined;
    if (!url) continue;
    const first = owner.get(url);
    if (first) (out[a.id] ??= []).push(`memory.storage.url is already used by "${first}"; agents never share storage`);
    else owner.set(url, a.id);
  }
  return out;
}

const envRefs = (values?: Record<string, string>) => Object.values(values ?? {}).flatMap((v) => (v.startsWith("env:") ? [v.slice(4)] : []));

/**
 * The .env variable NAMES an agent uses -> where (dotted config paths), for the studio's key list and the engine's reload of an agent whose key
 * changed. Only what is in use counts: an embedder key while semantic recall is on, a bot token while Telegram is on, a model's key while some
 * part of the agent uses that model (or its entry names a variable explicitly).
 */
export function referencedEnvNames(a: AgentConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string | undefined, where: string) => name && out.set(name, [...(out.get(name) ?? []), where]);
  const observer = a.memory.observational.model ?? a.model;
  const used = new Set([a.model, ...(a.memory.observational.enabled ? [observer] : []), ...(a.memory.subconscious.enabled ? [a.memory.subconscious.model ?? observer] : [])]);
  for (const [key, m] of Object.entries(a.models)) if (used.has(key) || m.apiKeyEnv) add(defaultApiKeyEnv(m), `models.${key}`);
  if (a.memory.semanticRecall.enabled) add(defaultApiKeyEnv(a.memory.semanticRecall.embedder), "memory.semanticRecall.embedder");
  if (a.memory.storage.enabled) add(a.memory.storage.authTokenEnv, "memory.storage");
  if (a.telegram.enabled) add(a.telegram.tokenEnv, "telegram");
  for (const [n, srv] of Object.entries(a.tools.mcp)) [...envRefs("env" in srv ? srv.env : undefined), ...envRefs("headers" in srv ? srv.headers : undefined)].forEach((e) => add(e, `tools.mcp.${n}`));
  for (const t of a.triggers) if (t.type === "github-pr") add(t.tokenEnv, `triggers.${t.id}`);
  return out;
}

/**
 * Keys the agent cannot think without that its .env does not set: the models it uses, the embedder (while semantic recall is on) and the remote
 * storage token. Any of these keeps the agent from loading, with this sentence as the problem. A missing Telegram or GitHub token is not here:
 * it stops only the bot ("missing-token") or that trigger.
 */
export function missingKeys(a: AgentConfig, isSet: (name: string) => boolean): string[] {
  const observer = a.memory.observational.model ?? a.model;
  const used = new Set([a.model, ...(a.memory.observational.enabled ? [observer] : []), ...(a.memory.subconscious.enabled ? [a.memory.subconscious.model ?? observer] : [])]);
  const need = new Map<string, string[]>();
  const add = (name: string | undefined, where: string) => name && need.set(name, [...(need.get(name) ?? []), where]);
  for (const key of used) add(defaultApiKeyEnv(a.models[key]!), `models.${key}`);
  if (a.memory.storage.enabled && a.memory.semanticRecall.enabled) add(defaultApiKeyEnv(a.memory.semanticRecall.embedder), "memory.semanticRecall.embedder");
  if (a.memory.storage.enabled) add(a.memory.storage.authTokenEnv, "memory.storage");
  return [...need].filter(([name]) => !isSet(name)).map(([name, where]) => `${name} is not set in this agent's keys (${where.join(", ")})`);
}

/** What the agent's behaviour depends on in its .env. The engine hashes these VALUES (fingerprints) into the agent's version, so a rotated key rebuilds it. */
export const agentEnvNames = (a: AgentConfig): string[] => [...referencedEnvNames(a).keys()].sort();

/**
 * The smallest valid config: one model and nothing else. A key it leaves out means the schema default (memory on, the workspace tool), which is
 * what the builder shows for a hand-written config that leaves it out too.
 */
export function newAgentConfig(input: { id: string; name: string; role?: string; description?: string; model: ModelInput }): AgentConfigInput {
  return { schemaVersion: AGENT_SCHEMA_VERSION, id: input.id, name: input.name, role: input.role ?? "assistant", description: input.description ?? "", models: { main: input.model }, model: "main" };
}

/**
 * What "New agent" writes: the model it cannot answer without and its instructions, with every other part switched off, so the canvas starts
 * with the agent and its model and the person connects the rest (storage, memory blocks, soul, tools, Telegram, triggers) as they want.
 * Written out in full rather than left to the defaults, because the defaults turn memory and the workspace on.
 */
export function startingAgentConfig(input: Parameters<typeof newAgentConfig>[0]): AgentConfigInput {
  return {
    ...newAgentConfig(input),
    memory: {
      storage: { enabled: false },
      lastMessages: { enabled: false },
      workingMemory: { enabled: false },
      semanticRecall: { enabled: false },
      observational: { enabled: false },
      subconscious: { enabled: false },
    },
    tools: { builtin: [] },
    skills: { enabled: [] },
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Runtime status + API DTOs                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * loaded:   registered in Mastra with the current file contents.
 * stale:    the file changed and is invalid; the LAST GOOD version keeps running.
 * invalid:  never loaded (bad on first sight).
 * disabled: enabled=false.
 * offline:  web app could not reach the engine (status unknown).
 */
export type AgentStatus = "loaded" | "stale" | "invalid" | "disabled" | "offline";

/**
 * off:           this agent has no bot (telegram.enabled is false).
 * missing-token: enabled, but the token variable is not set in the agent's .env.
 * starting:      adapter created, first getUpdates not confirmed.
 * polling:       the bot is live; `username` is its @handle.
 * error:         token rejected by Telegram, another poller holds it (409), or another agent has the same token; `error` says which.
 */
export type TelegramState = "off" | "missing-token" | "starting" | "polling" | "error";
export type TelegramRuntime = { state: TelegramState; username?: string; error?: string };

/**
 * idle:          waiting for the next cron time / poll.
 * running:       the agent is working on a fired event right now.
 * error:         the last poll or run failed; `error` says why (the trigger keeps trying).
 * disabled:      trigger or agent has enabled=false.
 * missing-token: github-pr whose tokenEnv is not set in the agent's .env.
 */
export type TriggerState = "idle" | "running" | "error" | "disabled" | "missing-token";

/** One firing. Replies and errors are redacted (lib/secrets.ts) and truncated before they are stored or returned. */
export type TriggerRun = {
  id: string;
  agentId: string;
  triggerId: string;
  type: Trigger["type"];
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "error";
  /** What fired it: "manual", "cron 0 9 * * *", or "owner/repo#12 opened". */
  subject: string;
  reply?: string;
  error?: string;
  /** Whether the reply reached Telegram. undefined = not asked to (or still running). */
  delivered?: boolean;
  /** Why `delivered` is false, in a sentence ("the agent has no Telegram bot"). */
  deliveryError?: string;
};

export type TriggerRuntime = { id: string; type: Trigger["type"]; state: TriggerState; nextRunAt?: string; lastRun?: TriggerRun; error?: string };

export type AgentRuntime = {
  status: AgentStatus;
  telegram?: TelegramRuntime;
  /** One entry per trigger in the agent's config. */
  triggers?: TriggerRuntime[];
  problems: string[];
  /** Hash of the resolved config plus fingerprints of the .env values it uses, currently registered. */
  loadedHash?: string;
  loadedAt?: string;
  /** MCP server name -> why it failed to start. */
  mcpErrors?: Record<string, string>;
};

export type AgentSummary = Pick<AgentConfig, "id" | "name" | "role" | "description" | "enabled"> & {
  modelKey: string;
  telegram: Pick<AgentConfig["telegram"], "enabled" | "allowedUserIds">;
  runtime: AgentRuntime;
};

/** GET /api/agents */
export type ListAgentsResponse = { agents: AgentSummary[]; fleetProblems: string[]; topology: Topology; rev: string };

/** GET /api/agents/:id */
export type GetAgentResponse = {
  /** Raw file contents as parsed JSON (what the editor edits). */
  config: AgentConfigInput;
  /** Null when the config is invalid. */
  resolved: ResolvedAgent | null;
  instructionsText: string | null;
  /** The agent's soul file (config.soul.file) when it exists, else null. Written back through UpdateAgentConfigRequest.soulText. */
  soulText: string | null;
  runtime: AgentRuntime;
  /** Opaque version for optimistic concurrency (hash of the file bytes). */
  etag: string;
};

/** Engine GET /eigen/agents/:id: what is running (the web app reads the files itself). `resolved` is the last good version for a stale agent. */
export type GetAgentRuntimeResponse = { id: string; runtime: AgentRuntime; resolved: ResolvedAgent | null };

/** POST /api/agents: creates ~/.eigen/agents/<id>/ (config.json from newAgentConfig, instructions.md, empty .env, skills/, sandbox/). 409 if the id exists. */
export const CreateAgentRequest = z.object({
  id: AgentId,
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(40).optional(),
  description: z.string().max(1000).optional(),
  model: ModelSchema,
  instructionsText: z.string().max(100_000).optional(),
});
export type CreateAgentRequest = z.input<typeof CreateAgentRequest>;

/** POST /api/agents/:id/config. `etag` from the GET; omit to force. `instructionsText` / `soulText` write those files too. */
export const UpdateAgentConfigRequest = z.object({
  config: z.unknown(),
  instructionsText: z.string().max(100_000).optional(),
  /** Writes the agent's soul file (config.soul.file, inside the agent folder). Applies on the agent's next message; no reload needed. */
  soulText: z.string().max(100_000).optional(),
  etag: z.string().optional(),
});
export type UpdateAgentConfigRequest = z.infer<typeof UpdateAgentConfigRequest>;

/**
 * 200 { ok: true, etag }            written; the engine watcher picks it up (watch /api/agents/events for "loaded").
 * 400 { ok: false, issues }         schema or reference errors; nothing written.
 * 409 { ok: false, etag }           file changed since your GET; refetch and merge.
 */
export type UpdateAgentConfigResponse = { ok: true; etag: string } | { ok: false; issues?: string[]; etag?: string };

/**
 * Secrets are WRITE-ONLY and per agent: the studio can set or remove a value in ~/.eigen/agents/<id>/.env and can see whether a name is set,
 * but no endpoint ever returns a value. Config files only ever hold the NAME of the variable.
 */
export type SecretStatus = { name: string; set: boolean; usedBy: string[] };
/** GET /api/agents/:id/secrets: every name the agent's config references (referencedEnvNames), plus any other name set in its .env (usedBy: []). */
export type ListSecretsResponse = { secrets: SecretStatus[] };
/** PUT /api/agents/:id/secrets/:name (DELETE removes it). */
export const SetSecretRequest = z.object({ value: z.string().min(1).max(4096) });
export type SetSecretRequest = z.infer<typeof SetSecretRequest>;

/** GET /api/agents/events (SSE). */
export type AgentEvent =
  | { type: "agent.loaded"; id: string; hash: string }
  | { type: "agent.removed"; id: string }
  | { type: "agent.error"; id: string; problems: string[]; stale: boolean }
  | { type: "fleet.changed"; rev: string }
  /** A bot started, stopped, failed, or learned its @username. */
  | { type: "agent.telegram"; id: string; telegram: TelegramRuntime }
  /** A trigger changed state or finished a run (`trigger.lastRun`). */
  | { type: "agent.trigger"; id: string; trigger: TriggerRuntime };

/** Engine POST /eigen/agents/:id/telegram/check, studio POST /api/agents/:id/telegram/check: getMe with the token in that variable of the agent's .env. Never returns the token. */
export const TelegramCheckRequest = z.object({ tokenEnv: z.string().regex(ENV_NAME) });
export type TelegramCheckRequest = z.infer<typeof TelegramCheckRequest>;
export type TelegramCheckResponse = { ok: boolean; username?: string; error?: string };

/** Engine POST /eigen/agents/:id/models/:key/test, studio POST /api/agents/:id/models/:key/test: one tiny prompt to that model of the agent, with the agent's key, 20 s timeout. Errors are redacted. */
export type ModelTestResponse = { ok: boolean; ms: number; reply?: string; error?: string };

/** Engine POST /eigen/agents/:id/github/check, studio POST /api/agents/:id/github/check: can the token in that variable of the agent's .env read that repo's pull requests? */
export const GithubCheckRequest = z.object({ tokenEnv: z.string().regex(ENV_NAME), repo: z.string().regex(GITHUB_REPO) });
export type GithubCheckRequest = z.infer<typeof GithubCheckRequest>;
export type GithubCheckResponse = { ok: boolean; login?: string; openPulls?: number; error?: string };

/* ------------------------------------------------------------------------------------------------ */
/* Skills (per agent), triggers, chat: DTOs.                                                          */
/* The studio reads and writes agent folders itself (lib/store.ts); only runtime state comes from the engine. */
/* ------------------------------------------------------------------------------------------------ */

/** user: created in the studio or by hand under the agent's skills/<slug>/ (editable). clawhub: installed under @owner/slug (shown read-only). */
export type SkillOrigin = "user" | "clawhub";
export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Why Mastra would skip this skill (bad or missing frontmatter, name does not match the folder, ...). The editor shows it. */
  problem?: string;
  /** Whether the agent loads it (skills.enabled is "all" or lists it). */
  enabled: boolean;
};
/** GET /api/agents/:id/skills */
export type ListSkillsResponse = { skills: SkillSummary[] };
/** GET /api/agents/:id/skills/:slug (slug URL-encoded: "@owner/slug" has a slash). `files` are the other files in the folder, names only. */
export type GetSkillResponse = { slug: string; text: string; etag: string; origin: SkillOrigin; files: string[]; problem?: string };
/** PUT /api/agents/:id/skills/:slug: replaces SKILL.md. 200 { ok, etag } | 400 { ok:false, issues } | 409 changed since GET | 403 for a clawhub skill. DELETE moves it to the agent's .trash/. */
export const WriteSkillRequest = z.object({ text: z.string().min(1).max(100_000), etag: z.string().optional() });
export type WriteSkillRequest = z.infer<typeof WriteSkillRequest>;
/** POST /api/agents/:id/skills: scaffolds skills/<slug>/SKILL.md with frontmatter (name = slug) and, when `text` is omitted, a starter body. 409 if the slug exists. */
export const CreateSkillRequest = z.object({
  slug: SkillSlug.refine((s) => !s.startsWith("@"), "new skills cannot use @owner/ (that is ClawHub's layout)"),
  description: z.string().min(1).max(1024),
  text: z.string().max(100_000).optional(),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;
export type SkillWriteResponse = { ok: true; etag: string; slug?: string } | { ok: false; issues?: string[]; etag?: string };

/** Engine GET /eigen/agents/:id/triggers/runs?limit=50, studio GET /api/agents/:id/triggers/runs: newest first, at most 200. */
export type ListTriggerRunsResponse = { runs: TriggerRun[] };
/**
 * Engine POST /eigen/agents/:id/triggers/:triggerId/run, studio POST /api/agents/:id/triggers/:triggerId/run: fire it now.
 * cron: runs the prompt. github-pr: runs it for the most recently updated open PR (error if there is none), without touching the poller's seen-list.
 * Resolves when the run has finished (max 5 minutes).
 */
export type RunTriggerResponse = { ok: boolean; run?: TriggerRun; error?: string };

/**
 * Engine GET /eigen/chat/:id/:session, studio GET /api/chat/:agentId?session=: the session's earlier messages (AI SDK UI messages), newest 100.
 * The studio chat shares the agent's memory of its first allowed Telegram user (`telegramUserId`), so working memory is the same person on both.
 */
export type ChatHistoryResponse = { messages: unknown[]; model: string; memory: { telegramUserId?: number } };

/* ------------------------------------------------------------------------------------------------ */
/* Fleet view (React Flow). Agents are separate islands: an agent, its bot and its MCP servers. There  */
/* are no edges between agents. Positions are NOT here: they live in ~/.eigen/engine/layout.json.     */
/* ------------------------------------------------------------------------------------------------ */

export type TopologyNode =
  | { id: `channel:${string}`; type: "channel"; data: { channel: "telegram"; agentId: string; state: TelegramState; username?: string } }
  | { id: `agent:${string}`; type: "agent"; data: AgentSummary & { builtinTools: string[] } }
  | { id: `mcp:${string}`; type: "mcp"; data: { name: string; agentId: string; trusted: boolean; error?: string } };

export type TopologyEdge = {
  id: string;
  source: TopologyNode["id"];
  target: TopologyNode["id"];
  /** routes: an agent's bot -> the agent. uses: the agent -> one of its MCP servers. Never between two agents. */
  type: "routes" | "uses";
  label?: string;
};

export type Topology = { nodes: TopologyNode[]; edges: TopologyEdge[] };

export const agentNodeId = (id: string) => `agent:${id}` as const;
export const telegramNodeId = (agentId: string) => `channel:telegram:${agentId}` as const;
export const mcpNodeId = (agentId: string, name: string) => `mcp:${agentId}/${name}` as const;

/** Builds the fleet graph. Agents that failed to resolve still appear (as summaries) with nothing attached. */
export function buildTopology(summaries: AgentSummary[], resolved: ResolvedAgent[]): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const byId = new Map(resolved.map((r) => [r.id, r]));
  for (const s of summaries) {
    const r = byId.get(s.id);
    nodes.push({ id: agentNodeId(s.id), type: "agent", data: { ...s, builtinTools: r?.tools.builtin ?? [] } });
    if (!r?.enabled) continue;
    if (r.telegram.enabled) {
      const t = s.runtime.telegram;
      nodes.push({ id: telegramNodeId(r.id), type: "channel", data: { channel: "telegram", agentId: r.id, state: t?.state ?? "off", username: t?.username } });
      edges.push({ id: `routes:telegram->${r.id}`, source: telegramNodeId(r.id), target: agentNodeId(r.id), type: "routes" });
    }
    for (const [name, srv] of Object.entries(r.tools.mcp)) {
      if (!srv.enabled) continue;
      nodes.push({ id: mcpNodeId(r.id, name), type: "mcp", data: { name, agentId: r.id, trusted: srv.trusted, error: s.runtime.mcpErrors?.[name] } });
      edges.push({ id: `uses:${r.id}->${name}`, source: agentNodeId(r.id), target: mcpNodeId(r.id, name), type: "uses" });
    }
  }
  return { nodes, edges };
}
