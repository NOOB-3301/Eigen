import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigSchema } from "./schema.ts";
import type { Config } from "./schema.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadEnv(home: string): void {
  const envFile = join(home, ".env");
  // loadEnvFile does not override variables already set in the shell, which is what we want.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function parseConfig(raw: unknown): Config {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(`config.json is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export function loadConfig(home: string): Config {
  loadEnv(home);
  const file = join(home, "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
