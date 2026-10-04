import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homePaths, seedHome } from "../../src/mastra/lib/home.ts";

export const DEFAULTS = resolve(import.meta.dirname, "../../defaults");

/** A seeded home in a temp dir; `patch` is shallow-merged into the seeded config.json. */
export function tmpHome(patch: Record<string, unknown> = {}) {
  const p = homePaths(mkdtempSync(join(tmpdir(), "eigen-test-")));
  seedHome(p, DEFAULTS);
  writeFileSync(p.configFile, JSON.stringify({ ...JSON.parse(readFileSync(p.configFile, "utf8")), ...patch }));
  return p;
}
