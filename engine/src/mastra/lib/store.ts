/**
 * Reads and writes ~/.eigen/.agents/<id>/ on behalf of the web app (`@eigen/engine/store`, server-side only).
 * The engine's watcher (lib/agents.ts) picks every write up, so nothing here talks to the running engine.
 * Writes are atomic (tmp + rename) and guarded by an etag so two editors cannot silently overwrite each other.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { ConfigSchema, type Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import {
  AGENT_CONFIG_FILE,
  AgentConfigSchema,
  AgentId,
  agentProblems,
  SkillSlug,
  WriteSharedSoulRequest,
  type AgentConfig,
  type AgentConfigInput,
  type CreateSkillRequest,
  type GetRootConfigResponse,
  type GetSharedSoulResponse,
  type GetSkillResponse,
  type SharedSoulWriteResponse,
  type SkillSummary,
  type SkillWriteResponse,
  type UpdateAgentConfigRequest,
  type UpdateAgentConfigResponse,
  type UpdateRootConfigRequest,
  type WriteSkillRequest,
} from "./schema.ts";
import { isClawhubSlug, parseSkillText, SKILL_FILE, validateSkillText } from "./skillspec.ts";

export type StoreResult = { status: number; body: UpdateAgentConfigResponse };

export type RawAgent = { id: string; config: AgentConfigInput; instructionsText: string | null; soulText: string | null; etag: string };

const etagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** The agent's version covers its own soul file too, so a concurrent soul edit conflicts like a config edit. Without a soul file it is the config's etag alone. */
const agentEtag = (configText: string, soulText: string | null) => etagOf(soulText === null ? configText : `${configText}\0${soulText}`);
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");
const inside = (root: string, full: string) => {
  const rel = relative(root, full);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/** The deepest part of `full` that exists, resolved through symlinks. */
function realExisting(full: string): string {
  let cur = full;
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
  return join(realpathSync(cur), relative(cur, full));
}

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

/**
 * The agent's own soul file: a .md inside its folder, also after symlinks are resolved (a soul.md linked to ~/.eigen/.env.md
 * or a notes/ folder linked elsewhere is refused). Unlike instructions there is no shared exception: the shared soul is SOUL.md.
 */
export function soulPath(dir: string, file: string): string | undefined {
  const full = resolve(dir, file);
  if (!full.endsWith(".md") || !inside(dir, full)) return undefined;
  if (!existsSync(dir)) return full;
  return inside(realpathSync(dir), realExisting(full)) ? full : undefined;
}

/** Returns the text as written (a trailing newline is added), so callers can hash exactly what is on disk. */
function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const out = text.endsWith("\n") ? text : `${text}\n`;
  writeFileSync(tmp, out);
  renameSync(tmp, file);
  return out;
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
  const soulText = readSoul(dir, config);
  return { id, config, instructionsText: path ? readOrNull(path) : null, soulText, etag: agentEtag(text, soulText), ...(parseError && { parseError }) };
}

const soulFileOf = (config: unknown) => {
  const file = (config as { soul?: { file?: unknown } } | null)?.soul?.file;
  return typeof file === "string" ? file : "soul.md";
};

function readSoul(dir: string, config: unknown) {
  const path = soulPath(dir, soulFileOf(config));
  return path ? readOrNull(path) : null;
}

/**
 * Everything that must hold before a file is written. Fleet-wide rules (one primary, two agents on one bot token) are reported by the engine, not enforced here, so a swap of primaries can be done in two saves.
 * `soulText`: the soul the same request is about to write, so choosing source "own" and writing its first soul.md can be one save.
 */
export function validateAgent(p: HomePaths, id: string, config: unknown, root: Config, opts: { soulText?: string } = {}): { issues: string[]; parsed?: AgentConfig } {
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) return { issues: r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`) };
  const issues = agentProblems(r.data, root);
  const dir = agentDir(p, id);
  if (r.data.id !== id) issues.push(`id "${r.data.id}" must equal the folder name "${id}"`);
  if (!r.data.instructions.inline && !instructionsPath(dir, r.data.instructions.file)) issues.push("instructions.file: must stay inside the agent folder");
  const soul = soulPath(dir, r.data.soul.file);
  if (!soul) issues.push("soul.file: must be a .md file inside the agent folder");
  else if (r.data.soul.source === "own" && opts.soulText === undefined && !existsSync(/* turbopackIgnore: true */ soul))
    issues.push(`soul: no ${r.data.soul.file} yet; write this agent's soul, or set soul.source to "shared" or "none"`);
  return { issues, parsed: r.data };
}

/** POST /api/agents/:id/config */
export function writeAgent(p: HomePaths, root: Config, id: string, req: UpdateAgentConfigRequest): StoreResult {
  const dir = agentDir(p, id);
  const current = readOrNull(join(dir, AGENT_CONFIG_FILE));
  if (current === null) return { status: 404, body: { ok: false, issues: [`no agent "${id}"`] } };
  let currentConfig: unknown = null;
  try {
    currentConfig = JSON.parse(current);
  } catch {
    /* an unparsable file has no soul file to name; its etag is the config's alone */
  }
  const currentEtag = agentEtag(current, readSoul(dir, currentConfig));
  if (req.etag && req.etag !== currentEtag) return { status: 409, body: { ok: false, etag: currentEtag, issues: ["the file changed since you opened it"] } };

  const { issues, parsed } = validateAgent(p, id, req.config, root, { soulText: req.soulText });
  if (issues.length || !parsed) return { status: 400, body: { ok: false, issues } };

  // Soul and instructions first: if a write fails midway, config.json never names a file that is not there yet.
  const soul = soulPath(dir, parsed.soul.file)!;
  const soulText = req.soulText !== undefined ? writeAtomic(soul, req.soulText) : readOrNull(soul);
  if (req.instructionsText !== undefined && !parsed.instructions.inline) writeAtomic(instructionsPath(dir, parsed.instructions.file)!, req.instructionsText);
  const next = writeAtomic(join(dir, AGENT_CONFIG_FILE), `${JSON.stringify(req.config, null, 2)}\n`);
  return { status: 200, body: { ok: true, etag: agentEtag(next, soulText) } };
}

/** POST /api/agents. Creates the folder; fails if it exists. `soulText` writes the agent's own soul file (config.soul.file). */
export function createAgent(p: HomePaths, root: Config, config: AgentConfigInput, instructionsText = "", soulText?: string): StoreResult {
  const id = (config as { id?: string }).id ?? "";
  if (!AgentId.safeParse(id).success) return { status: 400, body: { ok: false, issues: [`id: must be a lowercase slug (a-z, 0-9, "-", max 32)`] } };
  const dir = agentDir(p, id);
  if (existsSync(dir)) return { status: 409, body: { ok: false, issues: [`agent "${id}" already exists`] } };
  const { issues, parsed } = validateAgent(p, id, config, root, { soulText });
  if (issues.length || !parsed) return { status: 400, body: { ok: false, issues } };
  const soul = soulText === undefined ? null : writeAtomic(soulPath(dir, parsed.soul.file)!, soulText);
  if (!parsed.instructions.inline) writeAtomic(instructionsPath(dir, parsed.instructions.file)!, instructionsText || `You are ${parsed.name}. ${parsed.description}\n`);
  const text = writeAtomic(join(dir, AGENT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  return { status: 200, body: { ok: true, etag: agentEtag(text, soul) } };
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

/* The shared soul, ~/.eigen/SOUL.md: read on every turn by each agent on soul.source "shared", so a save applies on the next message. */

export function readSharedSoul(p: HomePaths): GetSharedSoulResponse {
  const text = readOrNull(p.soulFile) ?? "";
  return { text, etag: etagOf(text) };
}

/** PUT /api/soul. A missing file reads as empty, so the first save creates it. */
export function writeSharedSoul(p: HomePaths, req: WriteSharedSoulRequest): { status: number; body: SharedSoulWriteResponse } {
  const r = WriteSharedSoulRequest.safeParse(req);
  if (!r.success) return { status: 400, body: { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) } };
  const current = readSharedSoul(p);
  if (r.data.etag && r.data.etag !== current.etag) return { status: 409, body: { ok: false, etag: current.etag, issues: ["SOUL.md changed since you opened it"] } };
  return { status: 200, body: { ok: true, etag: etagOf(writeAtomic(p.soulFile, r.data.text)) } };
}

/*
 * The skill library, ~/.eigen/skills/<slug>/SKILL.md. The slug comes from a URL, so it is checked three ways before any file is
 * touched: the SkillSlug pattern, no ".." or leading dot in any segment, and every existing path component is a real folder
 * (no symlinks) whose resolved path stays inside the library.
 */

export type SkillResult = { status: number; body: SkillWriteResponse };

export class SkillPathError extends Error {}

const TRASH = ".trash";

/** The folder of a skill, or throws SkillPathError. Never follows a symlink. */
export function skillDir(p: HomePaths, slug: string): string {
  const bad = () => new SkillPathError(`invalid skill slug "${String(slug).slice(0, 100)}"`);
  if (!SkillSlug.safeParse(slug).success || slug.includes("..") || slug.split("/").some((s) => s.startsWith("."))) throw bad();
  const root = p.userSkillsDir;
  const dir = resolve(root, slug);
  if (!inside(root, dir)) throw bad();
  let cur = root;
  for (const part of relative(root, join(dir, SKILL_FILE)).split(sep)) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isSymlink(cur)) break;
    if (isSymlink(cur)) throw bad();
  }
  if (existsSync(root) && !inside(realpathSync(root), realExisting(dir))) throw bad();
  return dir;
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const usedBy = (p: HomePaths) => {
  const out = new Map<string, string[]>();
  for (const id of listAgentIds(p)) {
    let inherit: unknown;
    try {
      inherit = (readAgent(p, id)?.config as { skills?: { inherit?: unknown } } | undefined)?.skills?.inherit;
    } catch {
      continue; // a folder name that is not an agent id
    }
    if (Array.isArray(inherit)) for (const s of inherit) if (typeof s === "string") out.set(s, [...(out.get(s) ?? []), id]);
  }
  return out;
};

/** Slugs of every folder holding a SKILL.md: <slug>/ and @owner/<slug>/. Dot and underscore folders (the trash) and symlinks are skipped. */
function skillSlugs(p: HomePaths): string[] {
  const dirs = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !ignoredDir(e.name)).map((e) => e.name) : []);
  const slugs = dirs(p.userSkillsDir).flatMap((name) => (name.startsWith("@") ? dirs(join(p.userSkillsDir, name)).map((s) => `${name}/${s}`) : [name]));
  // A folder whose name is not a valid slug cannot be addressed (and Mastra rejects its name anyway).
  return slugs.filter((s) => SkillSlug.safeParse(s).success && !isSymlink(join(p.userSkillsDir, s, SKILL_FILE)) && existsSync(join(p.userSkillsDir, s, SKILL_FILE))).sort();
}

/** GET /api/skills */
export function listSkills(p: HomePaths): SkillSummary[] {
  const users = usedBy(p);
  return skillSlugs(p).map((slug) => {
    const text = readFileSync(join(p.userSkillsDir, slug, SKILL_FILE), "utf8");
    const s = parseSkillText(text);
    const problem = validateSkillText(slug, text)[0];
    return { slug, name: s.name ?? slug, description: s.description ?? "", origin: isClawhubSlug(slug) ? "clawhub" : "user", ...(problem && { problem }), usedBy: users.get(slug) ?? [] };
  });
}

/** Other files in the skill folder (scripts, references), as relative paths. Names only: the studio never opens them. */
function otherFiles(dir: string, prefix = "", depth = 3): string[] {
  if (depth < 0) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => (e.isDirectory() ? otherFiles(join(dir, e.name), `${prefix}${e.name}/`, depth - 1) : e.isFile() && `${prefix}${e.name}` !== SKILL_FILE ? [`${prefix}${e.name}`] : []))
    .sort()
    .slice(0, 200);
}

/** GET /api/skills/:slug. Undefined when there is no such skill. */
export function readSkill(p: HomePaths, slug: string): GetSkillResponse | undefined {
  const dir = skillDir(p, slug);
  const text = readOrNull(join(dir, SKILL_FILE));
  if (text === null) return undefined;
  const problem = validateSkillText(slug, text)[0];
  return { slug, text, etag: etagOf(text), origin: isClawhubSlug(slug) ? "clawhub" : "user", files: otherFiles(dir), ...(problem && { problem }) };
}

/** PUT /api/skills/:slug. Replaces SKILL.md only if it still loads afterwards. */
export function writeSkill(p: HomePaths, slug: string, req: WriteSkillRequest): SkillResult {
  const dir = skillDir(p, slug);
  if (isClawhubSlug(slug)) return { status: 403, body: { ok: false, issues: ["ClawHub skills are managed by clawhub; edit a copy instead"] } };
  const current = readOrNull(join(dir, SKILL_FILE));
  if (current === null) return { status: 404, body: { ok: false, issues: [`no skill "${slug}"`] } };
  if (req.etag && req.etag !== etagOf(current)) return { status: 409, body: { ok: false, etag: etagOf(current), issues: ["SKILL.md changed since you opened it"] } };
  const issues = validateSkillText(slug, req.text);
  if (issues.length) return { status: 400, body: { ok: false, issues } };
  return { status: 200, body: { ok: true, etag: etagOf(writeAtomic(join(dir, SKILL_FILE), req.text)), slug } };
}

const starterBody = (slug: string) => `# ${slug}\n\nWhen to use this skill, and the steps to follow.\n`;

/** POST /api/skills. `text` is the body under the generated frontmatter; omitted, a starter body. */
export function createSkill(p: HomePaths, req: CreateSkillRequest): SkillResult {
  if (isClawhubSlug(req.slug)) return { status: 400, body: { ok: false, issues: ["slug: new skills cannot use @owner/ (that is ClawHub's layout)"] } };
  const dir = skillDir(p, req.slug);
  if (existsSync(dir)) return { status: 409, body: { ok: false, issues: [`skill "${req.slug}" already exists`] } };
  // Mastra identifies a skill by its name (the last folder segment): two with one name make it throw when it loads one of them.
  const clash = skillSlugs(p).find((s) => basename(s) === req.slug);
  if (clash) return { status: 409, body: { ok: false, issues: [`the name "${req.slug}" is already used by "${clash}"; Mastra cannot load two skills with one name`] } };
  const text = `---\n${stringify({ name: req.slug, description: req.description }).trimEnd()}\n---\n\n${req.text ?? starterBody(req.slug)}`;
  const issues = validateSkillText(req.slug, text);
  if (issues.length) return { status: 400, body: { ok: false, issues } };
  return { status: 200, body: { ok: true, etag: etagOf(writeAtomic(join(dir, SKILL_FILE), text)), slug: req.slug } };
}

/**
 * DELETE /api/skills/:slug. Moves the folder to skills/.trash/<slug>-<time>; nothing is erased. Mastra's skill glob does look into
 * dot folders, but the timestamp suffix (upper-case T and Z, a dot) can never equal a valid skill name, so a trashed skill never loads.
 */
export function trashSkill(p: HomePaths, slug: string): { status: number; error?: string } {
  const dir = skillDir(p, slug);
  if (isClawhubSlug(slug)) return { status: 403, error: "ClawHub skills are managed by clawhub; remove them with the clawhub CLI" };
  if (!existsSync(join(dir, SKILL_FILE))) return { status: 404, error: `no skill "${slug}"` };
  const dest = join(p.userSkillsDir, TRASH, `${slug}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  return { status: 200 };
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
