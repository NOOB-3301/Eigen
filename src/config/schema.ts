import { z } from "zod";

const posInt = z.number().int().positive();

export const ModelEntrySchema = z
  .object({
    provider: z.enum(["openai-compat", "anthropic"]),
    baseUrl: z.url(),
    apiKeyEnv: z.string().min(1).optional(),
    model: z.string().min(1),
    contextWindow: posInt,
    replyReserve: posInt,
    maxOutputTokens: posInt,
    dailyTokenCap: posInt.optional(),
    toolCalling: z.boolean(),
    vision: z.boolean(),
    promptCaching: z.boolean().default(false),
  })
  .refine((e) => e.replyReserve < e.contextWindow, {
    message: "replyReserve must be smaller than contextWindow",
  });

export const TelegramSchema = z.object({
  tokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
  allowedUserIds: z.array(z.number().int()),
  pollTimeoutSec: posInt.max(50).default(30),
  chunkSize: posInt.max(4096).default(4096),
  // Telegram drops the typing indicator after ~5s, so refresh just under that.
  typingRefreshMs: posInt.default(4000),
  sendRatePerSec: z.number().positive().default(1),
});

export const LimitsSchema = z.object({
  maxSteps: posInt.default(25),
  runTokenBudget: posInt.default(400_000),
  // Must outlive the longest single tool call (see toolMaxTimeoutMs).
  runTimeoutMs: posInt.default(30 * 60_000),
  toolTimeoutMs: posInt.default(60_000),
  // Upper bound for a tool that asks for more time (e.g. shell_exec timeoutSec for installs).
  toolMaxTimeoutMs: posInt.default(15 * 60_000),
  toolOutputMaxChars: posInt.default(20_000),
  toolArgRetryMax: z.number().int().min(0).default(2),
  modelRetryMax: z.number().int().min(0).default(3),
  imageTokenEstimate: posInt.default(1500),
});

// Secrets never live in config.json: an env value or header may be written as
// "env:VAR_NAME" and is resolved from the environment at connect time.
export const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const RemoteServerSchema = z.object({
  url: z.url(),
  transport: z.enum(["http", "sse"]).default("http"),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const McpServerSchema = z.union([StdioServerSchema, RemoteServerSchema]);

export const McpSchema = z.object({
  enabled: z.boolean().default(true),
  startupTimeoutMs: posInt.default(20_000),
  // Falls back to limits.toolTimeoutMs when unset.
  toolTimeoutMs: posInt.optional(),
});

const Thresholds = z.record(z.string(), z.number());

export const SkillsSchema = z.object({
  enabled: z.boolean().default(true),
  watch: z.boolean().default(true),
  maxSkills: posInt.default(64),
  indexMaxTokens: posInt.default(800),
  allowCustomEdits: z.boolean().default(false),
  notify: z.boolean().default(true),
  capture: z
    .object({
      enabled: z.boolean().default(true),
      // Jev's state cap; longer transcripts are clamped to their tail.
      maxStateTokens: posInt.default(32_000),
      deferWhileBusy: z.boolean().default(true),
      // Drafting runs on a possibly slow local model, but must not hang forever.
      timeoutMs: posInt.default(300_000),
      model: z.string().optional(), // defaults to the session's entry
      thresholds: Thresholds.prefault({ worthCapturing: 2, alreadyCovered: 0.5, taskSucceeded: 0.7 }),
    })
    .prefault({}),
  eval: z
    .object({
      provider: z.enum(["auto", "typesafe", "entry", "local"]).default("auto"),
      model: z.string().default("jev-latest"),
      apiKeyEnv: z.string().default("TYPESAFE_AI_API_KEY"),
      entry: z.string().optional(),
      timeoutMs: posInt.default(120_000),
      // A rubric answer is a few dozen tokens; thinking models otherwise ramble for minutes.
      maxOutputTokens: posInt.default(512),
      thresholds: Thresholds.prefault({ reusable: 2, specific: 0.7, preconditions: 0.6, redundant: 0.5 }),
    })
    .prefault({}),
});

export const ConfigSchema = z
  .object({
    defaultModel: z.string().min(1),
    models: z.record(z.string(), ModelEntrySchema),
    telegram: TelegramSchema,
    limits: LimitsSchema.prefault({}),
    mcpServers: z.record(z.string(), McpServerSchema).default({}),
    mcp: McpSchema.prefault({}),
    skills: SkillsSchema.prefault({}),
  })
  .refine((c) => c.defaultModel in c.models, {
    message: "defaultModel must name an entry in models",
    path: ["defaultModel"],
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type TelegramConfig = z.infer<typeof TelegramSchema>;
export type ProviderKind = ModelEntry["provider"];
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpServers = Config["mcpServers"];
export type McpOptions = z.infer<typeof McpSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export const isRemoteServer = (s: McpServer): s is z.infer<typeof RemoteServerSchema> => "url" in s;
