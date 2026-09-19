import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULTS_DIR = resolve(import.meta.dirname, "../../defaults");

export function eigenHome(): string {
  return process.env.EIGEN_HOME ? resolve(process.env.EIGEN_HOME) : join(homedir(), ".eigen");
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// home-relative path -> packaged default
const SEED_FILES: Array<[string, string]> = [
  ["config.json", "config.example.json"],
  [".env", "env.example"],
  ["SOUL.md", "SOUL.md"],
  ["prompts/system.md", "prompts/system.md"],
];

export type EnsureResult = { createdConfig: boolean; created: string[] };

export function ensureHome(home: string, defaultsDir = DEFAULTS_DIR): EnsureResult {
  mkdirSync(join(home, "logs"), { recursive: true });
  const created: string[] = [];
  for (const [rel, src] of SEED_FILES) {
    const dest = join(home, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(defaultsDir, src), dest);
    created.push(rel);
  }
  return { createdConfig: created.includes("config.json"), created };
}
