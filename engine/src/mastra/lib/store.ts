/**
 * Reads and writes agent folders (~/.eigen/agents/<id>/) on behalf of the studio (`@eigen/engine/store`, server-side only).
 * The engine never imports this file: its watcher picks every write up, so nothing here talks to the running engine.
 *
 * Every agent is standalone, so every function here takes the agent id and stays inside that one folder: an id, a skill slug or a
 * file name from a config or a request can never reach another agent's folder, its .env or its memory. Writes are atomic (tmp + rename)
 * and guarded by an etag so two editors cannot silently overwrite each other.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { secretStatuses, setSecret, unsetSecret } from "./envfile.ts";
import { agentMdFile, agentPaths, ensureAgentDirs, type HomePaths } from "./home.ts";
import {
  AgentConfigSchema,
  AgentId,
  agentProblems,
  ENV_NAME,
  fleetProblems,
  startingAgentConfig,
  referencedEnvNames,
  SkillSlug,
  type AgentConfig,
  type AgentConfigInput,
  type CreateAgentRequest,
  type CreateSkillRequest,
  type GetSkillResponse,
  type SecretStatus,
  type SkillSummary,
  type SkillWriteResponse,
  type UpdateAgentConfigRequest,
  type UpdateAgentConfigResponse,
  type WriteSkillRequest,
} from "./schema.ts";
import { isClawhubSlug, parseSkillText, SKILL_FILE, validateSkillText } from "./skillspec.ts";

type Paths = Pick<HomePaths, "agentsDir">;

export type StoreResult = { status: number; body: UpdateAgentConfigResponse };

export type RawAgent = { id: string; config: AgentConfigInput; instructionsText: string | null; soulText: string | null; etag: string; parseError?: string };

const etagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/**
 * The agent's version covers the three files one save writes (config, instructions, soul), so a concurrent edit of any of them conflicts.
 * The NUL separator keeps "a" + "bc" apart from "ab" + "c".
 */
const agentEtag = (configText: string, instructionsText: string | null, soulText: string | null) => etagOf([configText, instructionsText ?? "", soulText ?? ""].join("\0"));
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");
const inside = (root: string, full: string) => {
  const rel = relative(root, full);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The deepest part of `full` that exists, resolved through symlinks. */
function realExisting(full: string): string {
  let cur = full;
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
  return join(realpathSync(cur), relative(cur, full));
}

/** The id is a slug (no dots, no slashes), so it cannot leave the agents folder. Throws for anything else. */
export function agentDir(p: Paths, id: string) {
  const ok = AgentId.safeParse(id);
  if (!ok.success) throw new Error(`invalid agent id "${String(id).slice(0, 40)}"`);
  return agentPaths(p, ok.data).dir;
}

/** An agent folder exists, is a real folder and has a config.json. A symlinked agent folder is not an agent: it could point at another agent. */
export function agentExists(p: Paths, id: string) {
  const dir = agentDir(p, id);
  return existsSync(dir) && !isSymlink(dir) && existsSync(join(dir, "config.json"));
}

/**
 * A markdown file the config names (instructions.file, soul.file), inside the agent folder (agentMdFile) and not a symlink, so a config
 * can never point the studio at .env, another agent's folder, or anything else on the machine.
 */
function mdFile(dir: string, name: unknown): string | undefined {
  const file = typeof name === "string" ? agentMdFile(dir, name) : undefined;
  return file && !isSymlink(file) ? file : undefined;
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

const readOrNull = (file: string | undefined) => (file && existsSync(file) ? readFileSync(file, "utf8") : null);

/** Folders under agents/ that can be agents: valid ids, real folders. `.trash`, `_drafts` and symlinks are skipped. */
export const listAgentIds = (p: Paths) =>
  existsSync(p.agentsDir)
    ? readdirSync(p.agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !ignoredDir(e.name) && AgentId.safeParse(e.name).success)
        .map((e) => e.name)
        .sort()
    : [];

const fileField = (config: unknown, key: "instructions" | "soul", fallback: string): unknown => {
  const v = (config as Record<string, { file?: unknown } | undefined> | null)?.[key]?.file;
  return v === undefined ? fallback : v;
};

/** The files as the editor sees them. A config.json that is not JSON comes back as `{}` with the reason in `parseError`. */
export function readAgent(p: Paths, id: string): RawAgent | undefined {
  const dir = agentDir(p, id);
  if (isSymlink(dir)) return undefined;
  const configText = readOrNull(join(dir, "config.json"));
  if (configText === null) return undefined;
  let config: unknown = {};
  let parseError: string | undefined;
  try {
    config = JSON.parse(configText);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const instructionsText = readOrNull(mdFile(dir, fileField(config, "instructions", "instructions.md")));
  const soulText = readOrNull(mdFile(dir, fileField(config, "soul", "soul.md")));
  return { id, config: (config ?? {}) as AgentConfigInput, instructionsText, soulText, etag: agentEtag(configText, instructionsText, soulText), ...(parseError && { parseError }) };
}

/** Every other agent whose config parses: what a write is checked against (two agents on one remote database). */
export function otherAgents(p: Paths, id: string): AgentConfig[] {
  return listAgentIds(p).flatMap((other) => {
    if (other === id) return [];
    const r = AgentConfigSchema.safeParse(readAgent(p, other)?.config);
    return r.success ? [r.data] : [];
  });
}

const zodIssues = (issues: Array<{ path: PropertyKey[]; message: string }>) => issues.map((i) => `${i.path.map(String).join(".") || "config"}: ${i.message}`);

/**
 * Everything that must hold before a config is written: the schema, the checks it cannot express (agentProblems), the id equal to the
 * folder, files inside the folder, and nothing shared with another agent. `instructionsText` / `soulText`: what the same request is about
 * to write, so turning the soul on and writing its first soul.md can be one save. `others` defaults to every other agent on disk.
 */
export function validateAgent(
  p: Paths,
  id: string,
  config: unknown,
  opts: { instructionsText?: string; soulText?: string; others?: AgentConfig[] } = {},
): { issues: string[]; parsed?: AgentConfig } {
  const dir = agentDir(p, id);
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) return { issues: zodIssues(r.error.issues) };
  const a = r.data;
  const issues = agentProblems(a);
  if (a.id !== id) issues.push(`id: "${a.id}" must equal the folder name "${id}"`);
  if (!a.instructions.inline) {
    const file = mdFile(dir, a.instructions.file);
    if (!file) issues.push("instructions.file: must be a .md file in the agent folder");
    else if (opts.instructionsText === undefined && !existsSync(file)) issues.push(`instructions.file: ${a.instructions.file} does not exist; write the instructions or set instructions.inline`);
  }
  const soul = mdFile(dir, a.soul.file);
  if (!soul) issues.push("soul.file: must be a .md file in the agent folder");
  else if (a.soul.enabled && opts.soulText === undefined && !existsSync(soul)) issues.push(`soul: no ${a.soul.file} yet; write this agent's soul or turn the soul off`);
  // Pairwise, so the clash is reported on the agent being saved whichever id sorts first.
  for (const o of opts.others ?? otherAgents(p, id)) if (Object.keys(fleetProblems([a, o])).length) issues.push(`memory.storage.url: already used by "${o.id}"; agents never share storage`);
  return { issues, parsed: a };
}

/** POST /api/agents/:id/config */
export function writeAgent(p: Paths, id: string, req: UpdateAgentConfigRequest): StoreResult {
  const dir = agentDir(p, id);
  const current = readAgent(p, id);
  if (!current) return { status: 404, body: { ok: false, issues: [`no agent "${id}"`] } };
  if (req.etag && req.etag !== current.etag) return { status: 409, body: { ok: false, etag: current.etag, issues: ["the agent's files changed since you opened them"] } };

  const { issues, parsed } = validateAgent(p, id, req.config, { instructionsText: req.instructionsText, soulText: req.soulText });
  if (issues.length || !parsed) return { status: 400, body: { ok: false, issues } };

  // Soul and instructions first: if a write fails midway, config.json never names a file that is not there yet.
  const soulFile = mdFile(dir, parsed.soul.file)!;
  const soulText = req.soulText !== undefined ? writeAtomic(soulFile, req.soulText) : readOrNull(soulFile);
  const instructionsFile = mdFile(dir, parsed.instructions.file);
  const instructionsText = req.instructionsText !== undefined && !parsed.instructions.inline ? writeAtomic(instructionsFile!, req.instructionsText) : readOrNull(instructionsFile);
  const next = writeAtomic(join(dir, "config.json"), `${JSON.stringify(req.config, null, 2)}\n`);
  return { status: 200, body: { ok: true, etag: agentEtag(next, instructionsText, soulText) } };
}

const starterInstructions = (name: string, description: string) =>
  `You are ${name}.${description ? ` ${description}` : ""}\n\nBe concise. Say so when you are not sure, and ask before doing anything that cannot be undone.\n`;

/**
 * POST /api/agents: a new standalone agent. The folder is claimed with a non-recursive mkdir, so two requests for one id cannot both
 * succeed; then the empty 0600 .env, skills/, sandbox/, data/, instructions.md and, last, config.json (startingAgentConfig: everything but the model and the instructions switched off).
 */
export function createAgent(p: Paths, req: CreateAgentRequest): StoreResult {
  if (!AgentId.safeParse(req.id).success) return { status: 400, body: { ok: false, issues: ['id: must be a lowercase slug (a-z, 0-9, "-", max 32)'] } };
  const ap = agentPaths(p, req.id);
  if (existsSync(ap.dir) || isSymlink(ap.dir)) return { status: 409, body: { ok: false, issues: [`agent "${req.id}" already exists`] } };
  const config = startingAgentConfig({ id: req.id, name: req.name, role: req.role, description: req.description, model: req.model });
  const instructions = req.instructionsText?.trim() ? req.instructionsText : starterInstructions(req.name, req.description ?? "");
  const { issues } = validateAgent(p, req.id, config, { instructionsText: instructions });
  if (issues.length) return { status: 400, body: { ok: false, issues } };

  mkdirSync(p.agentsDir, { recursive: true });
  try {
    mkdirSync(ap.dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { status: 409, body: { ok: false, issues: [`agent "${req.id}" already exists`] } };
    throw e;
  }
  ensureAgentDirs(ap);
  const instructionsText = writeAtomic(join(ap.dir, "instructions.md"), instructions);
  // config.json last: the engine's watcher only sees an agent once its config is there, and by then everything it names exists.
  const text = writeAtomic(ap.configFile, `${JSON.stringify(config, null, 2)}\n`);
  return { status: 200, body: { ok: true, etag: agentEtag(text, instructionsText, null) } };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** DELETE /api/agents/:id. Moves the whole folder (config, .env, memory, skills, sandbox) to agents/.trash/<id>-<time>; nothing is erased. */
export function trashAgent(p: Pick<HomePaths, "agentsDir" | "trashDir">, id: string): { status: number; error?: string } {
  const dir = agentDir(p, id);
  if (!agentExists(p, id)) return { status: 404, error: `no agent "${id}"` };
  const dest = join(p.trashDir, `${id}-${stamp()}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  return { status: 200 };
}

/* ------------------------------------------------------------------------------------------------ */
/* Secrets: the agent's own .env, write-only                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** The agent's .env. A symlinked .env is refused: writing through it could change another agent's keys. */
function envFileOf(p: Paths, id: string) {
  const file = agentPaths(p, id).envFile;
  if (isSymlink(file)) throw new Error("this agent's .env is a symlink; replace it with a plain file");
  return file;
}

/**
 * GET /api/agents/:id/secrets: every name the agent's config uses (referencedEnvNames), names set in its .env that nothing uses
 * (usedBy: []), and `extra` names typed into a form but not saved yet. Never a value. Undefined when there is no such agent.
 */
export function agentSecrets(p: Paths, id: string, extra: string[] = []): SecretStatus[] | undefined {
  const a = readAgent(p, id);
  if (!a) return undefined;
  const r = AgentConfigSchema.safeParse(a.config);
  const refs = r.success ? referencedEnvNames(r.data) : new Map<string, string[]>();
  for (const n of extra) if (ENV_NAME.test(n) && !refs.has(n)) refs.set(n, []);
  return secretStatuses(envFileOf(p, id), refs);
}

/** PUT /api/agents/:id/secrets/:name. 404 for an unknown agent (no folder is ever created for it). Throws on a value .env cannot hold. */
export function setAgentSecret(p: Paths, id: string, name: string, value: string): { status: number } {
  if (!agentExists(p, id)) return { status: 404 };
  setSecret(envFileOf(p, id), name, value);
  return { status: 200 };
}

/** DELETE /api/agents/:id/secrets/:name. `removed` is false when the name was not set. */
export function unsetAgentSecret(p: Paths, id: string, name: string): { status: number; removed?: boolean } {
  if (!agentExists(p, id)) return { status: 404 };
  return { status: 200, removed: unsetSecret(envFileOf(p, id), name) };
}

/* ------------------------------------------------------------------------------------------------ */
/* Skills: the agent's own library, skills/<slug>/SKILL.md                                           */
/* ------------------------------------------------------------------------------------------------ */
/*
 * The slug comes from a URL, so it is checked three ways before any file is touched: the SkillSlug pattern, no ".." or leading dot in
 * any segment, and every path component from agents/ down (the agent folder, skills/, each slug segment) is a real folder, never a
 * symlink, whose resolved path stays inside this agent's skills/.
 */

export type SkillResult = { status: number; body: SkillWriteResponse };

export class SkillPathError extends Error {}

/** The folder of one of this agent's skills, or throws SkillPathError (an invalid agent id throws too). Never follows a symlink. */
export function skillDir(p: Paths, id: string, slug: string): string {
  agentDir(p, id);
  const bad = () => new SkillPathError(`invalid skill slug "${String(slug).slice(0, 100)}"`);
  if (!SkillSlug.safeParse(slug).success || slug.includes("..") || slug.split("/").some((s) => s.startsWith("."))) throw bad();
  const root = agentPaths(p, id).skillsDir;
  const dir = resolve(root, slug);
  if (!inside(root, dir)) throw bad();
  let cur = p.agentsDir;
  for (const part of relative(p.agentsDir, join(dir, SKILL_FILE)).split(sep)) {
    cur = join(cur, part);
    if (isSymlink(cur)) throw bad();
    if (!existsSync(cur)) break;
  }
  if (existsSync(root) && !inside(realpathSync(root), realExisting(dir))) throw bad();
  return dir;
}

/** Slugs of every folder holding a SKILL.md: <slug>/ and @owner/<slug>/. Dot and underscore folders and symlinks are skipped. */
function skillSlugs(root: string): string[] {
  const dirs = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !ignoredDir(e.name)).map((e) => e.name) : []);
  const slugs = dirs(root).flatMap((name) => (name.startsWith("@") ? dirs(join(root, name)).map((s) => `${name}/${s}`) : [name]));
  // A folder whose name is not a valid slug cannot be addressed (and Mastra rejects its name anyway).
  return slugs.filter((s) => SkillSlug.safeParse(s).success && !isSymlink(join(root, s, SKILL_FILE)) && existsSync(join(root, s, SKILL_FILE))).sort();
}

/** Whether the agent loads a skill: skills.enabled is "all" (the default) or lists it. Read leniently, so an invalid config still lists its skills. */
function enabledTest(config: unknown): (slug: string) => boolean {
  const enabled = (config as { skills?: { enabled?: unknown } } | null)?.skills?.enabled;
  if (Array.isArray(enabled)) return (slug) => enabled.includes(slug);
  return () => enabled === undefined || enabled === "all";
}

/** GET /api/agents/:id/skills. Undefined when there is no such agent. */
export function listSkills(p: Paths, id: string): SkillSummary[] | undefined {
  const a = readAgent(p, id);
  if (!a) return undefined;
  const root = agentPaths(p, id).skillsDir;
  if (isSymlink(root)) return [];
  const on = enabledTest(a.config);
  return skillSlugs(root).map((slug) => {
    const text = readFileSync(join(root, slug, SKILL_FILE), "utf8");
    const s = parseSkillText(text);
    const problem = validateSkillText(slug, text)[0];
    return { slug, name: s.name ?? slug, description: s.description ?? "", origin: isClawhubSlug(slug) ? "clawhub" : "user", ...(problem && { problem }), enabled: on(slug) };
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

/** GET /api/agents/:id/skills/:slug. Undefined when there is no such agent or skill. */
export function readSkill(p: Paths, id: string, slug: string): GetSkillResponse | undefined {
  const dir = skillDir(p, id, slug);
  if (!agentExists(p, id)) return undefined;
  const text = readOrNull(join(dir, SKILL_FILE));
  if (text === null) return undefined;
  const problem = validateSkillText(slug, text)[0];
  return { slug, text, etag: etagOf(text), origin: isClawhubSlug(slug) ? "clawhub" : "user", files: otherFiles(dir), ...(problem && { problem }) };
}

/** PUT /api/agents/:id/skills/:slug. Replaces SKILL.md only if it still loads afterwards. */
export function writeSkill(p: Paths, id: string, slug: string, req: WriteSkillRequest): SkillResult {
  const dir = skillDir(p, id, slug);
  if (!agentExists(p, id)) return { status: 404, body: { ok: false, issues: [`no agent "${id}"`] } };
  if (isClawhubSlug(slug)) return { status: 403, body: { ok: false, issues: ["ClawHub skills are managed by clawhub; edit a copy instead"] } };
  const current = readOrNull(join(dir, SKILL_FILE));
  if (current === null) return { status: 404, body: { ok: false, issues: [`no skill "${slug}"`] } };
  if (req.etag && req.etag !== etagOf(current)) return { status: 409, body: { ok: false, etag: etagOf(current), issues: ["SKILL.md changed since you opened it"] } };
  const issues = validateSkillText(slug, req.text);
  if (issues.length) return { status: 400, body: { ok: false, issues } };
  return { status: 200, body: { ok: true, etag: etagOf(writeAtomic(join(dir, SKILL_FILE), req.text)), slug } };
}

const starterBody = (slug: string) => `# ${slug}\n\nWhen to use this skill, and the steps to follow.\n`;

/** POST /api/agents/:id/skills. `text` is the body under the generated frontmatter; omitted, a starter body. */
export function createSkill(p: Paths, id: string, req: CreateSkillRequest): SkillResult {
  if (isClawhubSlug(req.slug)) return { status: 400, body: { ok: false, issues: ["slug: new skills cannot use @owner/ (that is ClawHub's layout)"] } };
  const dir = skillDir(p, id, req.slug);
  if (!agentExists(p, id)) return { status: 404, body: { ok: false, issues: [`no agent "${id}"`] } };
  if (existsSync(dir)) return { status: 409, body: { ok: false, issues: [`skill "${req.slug}" already exists`] } };
  // Mastra identifies a skill by its name (the last folder segment): two with one name make it throw when it loads one of them.
  const clash = skillSlugs(agentPaths(p, id).skillsDir).find((s) => basename(s) === req.slug);
  if (clash) return { status: 409, body: { ok: false, issues: [`the name "${req.slug}" is already used by "${clash}"; Mastra cannot load two skills with one name`] } };
  const text = `---\n${stringify({ name: req.slug, description: req.description }).trimEnd()}\n---\n\n${req.text ?? starterBody(req.slug)}`;
  const issues = validateSkillText(req.slug, text);
  if (issues.length) return { status: 400, body: { ok: false, issues } };
  return { status: 200, body: { ok: true, etag: etagOf(writeAtomic(join(dir, SKILL_FILE), text)), slug: req.slug } };
}

/** DELETE /api/agents/:id/skills/:slug. Moves the folder to the agent's .trash/skills/<slug>-<time>, outside skills/, so it never loads again. */
export function trashSkill(p: Paths, id: string, slug: string): { status: number; error?: string } {
  const dir = skillDir(p, id, slug);
  if (!agentExists(p, id)) return { status: 404, error: `no agent "${id}"` };
  if (isClawhubSlug(slug)) return { status: 403, error: "ClawHub skills are managed by clawhub; remove them with the clawhub CLI" };
  if (!existsSync(join(dir, SKILL_FILE))) return { status: 404, error: `no skill "${slug}"` };
  const dest = join(agentPaths(p, id).trashDir, "skills", `${slug}-${stamp()}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  return { status: 200 };
}

/* ------------------------------------------------------------------------------------------------ */
/* Canvas positions: outside the agent folders, so dragging a node never reloads an agent             */
/* ------------------------------------------------------------------------------------------------ */

export type TopologyLayout = Record<string, { x: number; y: number }>;

export function readLayout(p: Pick<HomePaths, "layoutFile">): TopologyLayout {
  try {
    return JSON.parse(readFileSync(p.layoutFile, "utf8"));
  } catch {
    return {};
  }
}

export function writeLayout(p: Pick<HomePaths, "layoutFile">, layout: TopologyLayout) {
  writeAtomic(p.layoutFile, JSON.stringify(layout));
}
