/**
 * Reads and writes ~/.eigen/.agents/<id>/ on behalf of the web app (`@eigen/engine/store`, server-side only).
 * The engine's watcher (lib/agents.ts) picks every write up, so nothing here talks to the running engine.
 * Writes are atomic (tmp + rename) and guarded by an etag so two editors cannot silently overwrite each other.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigSchema, type Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import {
  AGENT_CONFIG_FILE,
  AgentConfigSchema,
  AgentId,
  agentProblems,
  type AgentConfig,
  type AgentConfigInput,
  type GetRootConfigResponse,
  type UpdateAgentConfigRequest,
  type UpdateAgentConfigResponse,
  type UpdateRootConfigRequest,
} from "./schema.ts";

export type StoreResult = { status: number; body: UpdateAgentConfigResponse };

export type RawAgent = { id: string; config: AgentConfigInput; instructionsText: string | null; etag: string };

const etagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");

/** The id is a slug (no dots, no slashes), so it cannot escape the agents folder. */
export function agentDir(p: HomePaths, id: string) {
  const ok = AgentId.safeParse(id);
  if (!ok.success) throw new Error(`invalid agent id "${id}"`);
  return join(p.agentsDir, ok.data);
}

/** Instruction files live in the agent's own folder. The one exception is the primary's shared prompt, ~/.eigen/prompts/system.md. Anything else (`../../memory/x.md`, absolute paths) is refused, so the studio cannot be pointed at other files. */
export function instructionsPath(dir: string, file: string): string | undefined {
  const full = resolve(dir, file);
  const rel = relative(dir, full);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return full;
  return full === join(dir, "..", "..", "prompts", "system.md") ? full : undefined;
}

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  renameSync(tmp, file);
}

const readOrNull = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

export const listAgentIds = (p: HomePaths) =>
  existsSync(p.agentsDir) ? readdirSync(p.agentsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !ignoredDir(e.name)).map((e) => e.name).sort() : [];

/** The file as the editor sees it. `config` is null-safe: a file that is not JSON comes back as `{}` with the text in `parseError`. */
export function readAgent(p: HomePaths, id: string): (RawAgent & { parseError?: string }) | undefined {
  const dir = agentDir(p, id);
  const text = readOrNull(join(dir, AGENT_CONFIG_FILE));
  if (text === null) return undefined;
  let config: AgentConfigInput = {} as AgentConfigInput;
  let parseError: string | undefined;
  try {
    config = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const file = (config as { instructions?: { file?: string } }).instructions?.file ?? "instructions.md";
  const path = instructionsPath(dir, file);
  return { id, config, instructionsText: path ? readOrNull(path) : null, etag: etagOf(text), ...(parseError && { parseError }) };
}

/** Everything that must hold before a file is written. Fleet-wide rules (one primary, alias clashes) are reported by the engine, not enforced here, so a swap of primaries can be done in two saves. */
export function validateAgent(p: HomePaths, id: string, config: unknown, root: Config): { issues: string[]; parsed?: AgentConfig } {
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) return { issues: r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`) };
  const issues = agentProblems(r.data, root);
  if (r.data.id !== id) issues.push(`id "${r.data.id}" must equal the folder name "${id}"`);
  if (!r.data.instructions.inline && !instructionsPath(agentDir(p, id), r.data.instructions.file)) issues.push("instructions.file: must stay inside the agent folder");
  return { issues, parsed: r.data };
}

/** POST /api/agents/:id/config */
export function writeAgent(p: HomePaths, root: Config, id: string, req: UpdateAgentConfigRequest): StoreResult {
  const dir = agentDir(p, id);
  const current = readOrNull(join(dir, AGENT_CONFIG_FILE));
  if (current === null) return { status: 404, body: { ok: false, issues: [`no agent "${id}"`] } };
  if (req.etag && req.etag !== etagOf(current)) return { status: 409, body: { ok: false, etag: etagOf(current), issues: ["the file changed since you opened it"] } };

  const { issues, parsed } = validateAgent(p, id, req.config, root);
  if (issues.length || !parsed) return { status: 400, body: { ok: false, issues } };

  const next = `${JSON.stringify(req.config, null, 2)}\n`;
  if (req.instructionsText !== undefined && !parsed.instructions.inline) writeAtomic(instructionsPath(dir, parsed.instructions.file)!, req.instructionsText);
  writeAtomic(join(dir, AGENT_CONFIG_FILE), next);
  return { status: 200, body: { ok: true, etag: etagOf(next) } };
}

/** POST /api/agents. Creates the folder; fails if it exists. */
export function createAgent(p: HomePaths, root: Config, config: AgentConfigInput, instructionsText = ""): StoreResult {
  const id = (config as { id?: string }).id ?? "";
  if (!AgentId.safeParse(id).success) return { status: 400, body: { ok: false, issues: [`id: must be a lowercase slug (a-z, 0-9, "-", max 32)`] } };
  const dir = agentDir(p, id);
  if (existsSync(dir)) return { status: 409, body: { ok: false, issues: [`agent "${id}" already exists`] } };
  const { issues, parsed } = validateAgent(p, id, config, root);
  if (issues.length || !parsed) return { status: 400, body: { ok: false, issues } };
  if (!parsed.instructions.inline) writeAtomic(instructionsPath(dir, parsed.instructions.file)!, instructionsText || `You are ${parsed.name}. ${parsed.description}\n`);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  writeAtomic(join(dir, AGENT_CONFIG_FILE), text);
  return { status: 200, body: { ok: true, etag: etagOf(text) } };
}

/** DELETE /api/agents/:id. Moves the folder to .agents/.trash/ (the scanner ignores it); nothing is erased. The primary cannot be removed. */
export function trashAgent(p: HomePaths, id: string): { status: number; error?: string; trashedTo?: string } {
  const dir = agentDir(p, id);
  const a = readAgent(p, id);
  if (!a) return { status: 404, error: `no agent "${id}"` };
  if ((a.config as { primary?: boolean }).primary) return { status: 400, error: "the primary agent cannot be removed; make another agent primary first" };
  const dest = join(p.agentsDir, ".trash", `${id}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  return { status: 200, trashedTo: dest };
}

/* The shared root ~/.eigen/config.json: model catalog, telegram, sandbox policy, memory defaults, MCP catalog. */

/** The file as the editor sees it (no defaults filled in). A file that is not JSON comes back as `{}` with the reason in `parseError`. */
export function readRoot(p: HomePaths): GetRootConfigResponse | undefined {
  const text = readOrNull(p.configFile);
  if (text === null) return undefined;
  try {
    return { config: JSON.parse(text), etag: etagOf(text) };
  } catch (e) {
    return { config: {}, etag: etagOf(text), parseError: (e as Error).message };
  }
}

/** The schema, plus the references agents hold into it: removing a model or MCP server an agent still uses is refused with the agent named. */
export function validateRoot(p: HomePaths, config: unknown): { issues: string[]; parsed?: Config } {
  const r = ConfigSchema.safeParse(config);
  if (!r.success) return { issues: r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`) };
  const issues = listAgentIds(p).flatMap((id) => {
    const a = readAgent(p, id);
    const parsed = a && AgentConfigSchema.safeParse(a.config);
    return parsed?.success ? agentProblems(parsed.data, r.data).map((m) => `agent "${id}": ${m}`) : [];
  });
  return { issues, parsed: r.data };
}

/** PUT /api/root. The engine watches the file: model, telegram-allow-list and memory changes apply to running agents; MCP changes reconnect. */
export function writeRoot(p: HomePaths, req: UpdateRootConfigRequest): StoreResult {
  const current = readOrNull(p.configFile);
  if (current === null) return { status: 404, body: { ok: false, issues: ["no config.json"] } };
  if (req.etag && req.etag !== etagOf(current)) return { status: 409, body: { ok: false, etag: etagOf(current), issues: ["config.json changed since you opened it"] } };
  const { issues } = validateRoot(p, req.config);
  if (issues.length) return { status: 400, body: { ok: false, issues } };
  const next = `${JSON.stringify(req.config, null, 2)}\n`;
  writeAtomic(p.configFile, next);
  return { status: 200, body: { ok: true, etag: etagOf(next) } };
}

/* Node positions live outside the agent files, so dragging a node never reloads an agent. */
export type TopologyLayout = Record<string, { x: number; y: number }>;

export function readLayout(p: HomePaths): TopologyLayout {
  try {
    return JSON.parse(readFileSync(p.topologyLayoutFile, "utf8"));
  } catch {
    return {};
  }
}

export function writeLayout(p: HomePaths, layout: TopologyLayout) {
  writeAtomic(p.topologyLayoutFile, JSON.stringify(layout));
}
