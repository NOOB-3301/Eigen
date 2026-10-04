import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setSecret } from "../../src/mastra/lib/envfile.ts";
import { agentPaths, ensureAgentDirs, readyHome, type HomePaths } from "../../src/mastra/lib/home.ts";
import type { AgentConfigInput } from "../../src/mastra/lib/schema.ts";

export const DEFAULTS = resolve(import.meta.dirname, "../../defaults");

/** An empty engine home (agents/, engine/) in a temp dir. Never the user's ~/.eigen. */
export const tmpHome = (): HomePaths => readyHome(mkdtempSync(join(tmpdir(), "eigen-test-")));

/** A valid agent config: one local model that needs no key. `patch` is shallow-merged. */
export const agentConfig = (id: string, patch: Partial<AgentConfigInput> = {}): AgentConfigInput => ({
  id,
  name: id,
  role: "specialist",
  description: `The ${id}.`,
  models: { main: { id: "ollama/test-model", url: "http://127.0.0.1:9/v1" } },
  model: "main",
  ...patch,
});

/** Writes (or rewrites) an agent folder the way the studio does: config.json, instructions.md, and the given .env values. */
export function writeAgent(
  p: Pick<HomePaths, "agentsDir">,
  id: string,
  patch: Partial<AgentConfigInput> = {},
  { instructions = `You are ${id}.`, env = {} }: { instructions?: string; env?: Record<string, string> } = {},
) {
  const a = agentPaths(p, id);
  ensureAgentDirs(a);
  writeFileSync(join(a.dir, "instructions.md"), instructions);
  writeFileSync(a.configFile, JSON.stringify(agentConfig(id, patch)));
  for (const [k, v] of Object.entries(env)) setSecret(a.envFile, k, v);
  return a;
}
