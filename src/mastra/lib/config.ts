import { readFileSync } from "node:fs";
import { compact, isEmpty, mapValues } from "lodash-es";
import { z } from "zod";
import { homePaths } from "./home.ts";

const posInt = z.number().int().positive();
const strMap = z.record(z.string(), z.string());

const Model = z.object({
  id: z.string().regex(/^[^/\s]+\/\S+$/, 'use "provider/model"'),
  url: z.url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  contextWindow: posInt.optional(),
  replyReserve: posInt.default(4096),
});

const mcpFlags = { enabled: z.boolean().default(true), trusted: z.boolean().default(false) };
const Stdio = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: strMap.optional(), ...mcpFlags });
const Remote = z.object({ url: z.url(), headers: strMap.optional(), transport: z.enum(["http", "sse"]).optional(), ...mcpFlags });

export const ConfigSchema = z
  .object({
    defaultModel: z.string().min(1),
    models: z.record(z.string(), Model),
    curatorModel: z.string().optional(),
    timezone: z.string().default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    telegram: z.object({
      tokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
      allowedUserIds: z.array(z.number().int()).default([]),
    }),
    limits: z.object({ maxSteps: posInt.default(25) }).prefault({}),
    sandbox: z
      .object({
        isolation: z.enum(["auto", "seatbelt", "bwrap", "none"]).default("auto"),
        allowNetwork: z.boolean().default(true),
        readWritePaths: z.array(z.string()).default([]),
        readOnlyPaths: z.array(z.string()).default([]),
        commandTimeoutMs: posInt.default(120_000),
        maxTimeoutSec: posInt.default(900),
      })
      .prefault({}),
    memory: z
      .object({
        lastMessages: posInt.default(20),
        semanticRecall: z
          .object({ enabled: z.boolean().default(true), topK: posInt.default(4), messageRange: posInt.default(2) })
          .prefault({}),
        embedder: Model.pick({ id: true, url: true, apiKeyEnv: true }).prefault({ id: "ollama/nomic-embed-text", url: "http://localhost:11434/v1" }),
        consolidationCron: z.string().default("30 3 * * *"),
      })
      .prefault({}),
    mcpServers: z.record(z.string(), z.union([Stdio, Remote])).default({}),
    mcp: z.object({ enabled: z.boolean().default(true), startupTimeoutMs: posInt.default(20_000) }).prefault({}),
  })
  .refine((c) => c.defaultModel in c.models, { path: ["defaultModel"], message: "must name an entry in models" })
  .refine((c) => !c.curatorModel || c.curatorModel in c.models, { path: ["curatorModel"], message: "must name an entry in models" });

export type Config = z.infer<typeof ConfigSchema>;
export type ModelEntry = z.infer<typeof Model>;
export type McpServer = Config["mcpServers"][string];

export const isRemote = (s: McpServer): s is z.infer<typeof Remote> => "url" in s;

export function parseConfig(raw: unknown): Config {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`config.json is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export function loadConfig(file = homePaths().configFile): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file} (${(e as Error).message}). Run: npm run setup`);
  }
  return parseConfig(raw);
}

let cached: Config | undefined;
export const getConfig = () => (cached ??= loadConfig());
export const reloadConfig = () => (cached = loadConfig());

/** Reasons the daemon must not start. */
export const bootProblems = (c: Config, env: NodeJS.ProcessEnv = process.env): string[] =>
  compact([
    isEmpty(c.telegram.allowedUserIds) && "telegram.allowedUserIds is empty (the adapter would answer anyone)",
    !env[c.telegram.tokenEnv] && `${c.telegram.tokenEnv} is not set in .env`,
  ]);

/** "env:NAME" values are read from the environment, so secrets stay out of config.json. */
export const resolveEnvRefs = (values: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env) =>
  values && mapValues(values, (v) => (v.startsWith("env:") ? (env[v.slice(4)] ?? "") : v));

export function toMastraModel(m: ModelEntry, env: NodeJS.ProcessEnv = process.env) {
  const apiKey = m.apiKeyEnv ? env[m.apiKeyEnv] : undefined;
  return m.url || apiKey ? { id: m.id as `${string}/${string}`, url: m.url, apiKey } : m.id;
}

/** Prompt budget for models whose server silently truncates (Ollama). */
export const tokenBudget = (m: ModelEntry) => m.contextWindow && m.contextWindow - m.replyReserve;
