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

// Reserved for the MCP milestone: validated now so config files stay forward-compatible.
export const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const ConfigSchema = z
  .object({
    defaultModel: z.string().min(1),
    models: z.record(z.string(), ModelEntrySchema),
    telegram: TelegramSchema,
    limits: LimitsSchema.prefault({}),
    mcpServers: z.record(z.string(), McpServerSchema).default({}),
    mcp: z.record(z.string(), z.unknown()).default({}),
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
