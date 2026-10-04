import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryContext } from "../../src/mastra/lib/factory.ts";
import { agentPaths, ensureAgentDirs, homePaths, type AgentPaths } from "../../src/mastra/lib/home.ts";
import { AgentConfigSchema, resolveAgent, type AgentConfigInput, type ResolvedAgent } from "../../src/mastra/lib/schema.ts";

export type TmpAgent = { home: string; paths: AgentPaths; r: ResolvedAgent; other: AgentPaths };

/**
 * A temp EIGEN_HOME with one agent folder (config.json, instructions.md, .env) and a second agent "other" next to it, so tests can check that
 * nothing of "other" is reachable. `patch` is shallow-merged into a minimal config with one local (url) model and the sandbox unisolated.
 */
export function tmpAgent(patch: Partial<AgentConfigInput> = {}, { id = "a", instructions = "You are a test agent.", home = mkdtempSync(join(tmpdir(), "eigen-agent-")) } = {}): TmpAgent {
  const hp = homePaths(home);
  const paths = agentPaths(hp, id);
  const other = agentPaths(hp, "other");
  for (const p of [paths, other]) ensureAgentDirs(p);
  writeFileSync(join(paths.dir, "instructions.md"), instructions);
  writeFileSync(paths.envFile, "OWN_SECRET=own-agent-secret\n");
  writeFileSync(other.envFile, "OTHER_SECRET=other-agent-secret\n");
  writeFileSync(other.configFile, JSON.stringify({ id: "other", name: "Other", models: { main: { id: "fake/model", url: "http://127.0.0.1:9/v1" } }, model: "main" }));
  const input: AgentConfigInput = {
    id,
    name: `Agent ${id}`,
    models: { main: { id: "fake/model", url: "http://127.0.0.1:9/v1" } },
    model: "main",
    sandbox: { isolation: "none" },
    ...patch,
  };
  const config = AgentConfigSchema.parse(input);
  writeFileSync(paths.configFile, JSON.stringify(input, null, 2));
  return { home, paths, r: resolveAgent(config, "UTC"), other };
}

/** A FactoryContext for tests: no bot, a reload that counts, a log that collects. */
export function testContext(paths: AgentPaths, env: Record<string, string> = {}, extra: Partial<FactoryContext> = {}) {
  const logs: string[] = [];
  let reloads = 0;
  const ctx: FactoryContext = {
    paths,
    env: new Map(Object.entries(env)),
    reload: async () => void reloads++,
    log: (msg) => void logs.push(msg),
    ...extra,
  };
  return { ctx, logs, reloads: () => reloads };
}

/** Writes <dir>/<slug>/SKILL.md with valid frontmatter (name = the last segment of the slug). */
export function writeSkill(dir: string, slug: string, description = `Use ${slug}.`, body = `# ${slug}\n`) {
  const folder = join(dir, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${slug.slice(slug.lastIndexOf("/") + 1)}\ndescription: ${description}\n---\n${body}`);
  return folder;
}
