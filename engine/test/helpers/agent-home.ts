import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPaths, ensureAgentDirs, ensureHome, homePaths, type HomePaths } from "../../src/mastra/lib/home.ts";

/** An empty v2 home in a temp dir (agents/, engine/), never the real ~/.eigen. */
export function emptyHome(): HomePaths {
  const p = homePaths(mkdtempSync(join(tmpdir(), "eigen-store-")));
  ensureHome(p);
  return p;
}

/** A minimal valid agent config; `patch` is shallow-merged. */
export const agentConfig = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  name: id,
  models: { main: { id: "anthropic/claude-sonnet-5-5" } },
  model: "main",
  ...patch,
});

/** Writes an agent folder by hand (as a user editing files would), with instructions.md. Returns its paths. */
export function addAgent(p: HomePaths, id: string, patch: Record<string, unknown> = {}, opts: { instructions?: string; raw?: string } = {}) {
  const a = agentPaths(p, id);
  ensureAgentDirs(a);
  writeFileSync(join(a.dir, "instructions.md"), opts.instructions ?? "Do work.\n");
  writeFileSync(a.configFile, opts.raw ?? JSON.stringify(agentConfig(id, patch)));
  return a;
}

/** One skill folder with SKILL.md, under an agent's skills/. */
export function addSkill(p: HomePaths, id: string, slug: string, text: string) {
  const dir = join(agentPaths(p, id).skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}

export const goodSkill = (name: string, description = "Does a thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

/** Every file under a folder with its size, so a refused request can be shown to have touched nothing. */
export const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .map((e) => `${join(e.parentPath, e.name)}:${e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8").length : "d"}`)
    .sort();
