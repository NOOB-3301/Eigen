import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isEmpty, sortBy, truncate } from "lodash-es";
import { parse, parseDocument } from "yaml";
import type { AgentPaths } from "./home.ts";

/** The folders of one agent that hold skills: its library (skills/) and the ones it installed or wrote itself (sandbox/skills/). */
export type SkillPaths = Pick<AgentPaths, "skillsDir" | "sandboxSkillsDir" | "sandboxQuarantineDir">;

export const CLAWHUB_VERSION = "0.23.3";

/**
 * The engine's built-in skills (engine/defaults/skills), loaded read-only by every agent with the workspace tool. Found from this file in the source
 * tree, or from the working directory when Mastra runs a bundle (engine/ in dev, engine/.mastra/output after a build). EIGEN_BUILTIN_SKILLS overrides.
 */
export function builtinSkillsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const here = typeof import.meta.dirname === "string" ? [resolve(import.meta.dirname, "../../../defaults/skills")] : [];
  const candidates = [...(env.EIGEN_BUILTIN_SKILLS ? [env.EIGEN_BUILTIN_SKILLS] : []), ...here, resolve("defaults/skills"), resolve("../../defaults/skills"), resolve("../../../defaults/skills")];
  return candidates.find((d) => existsSync(join(d, "clawhub", "SKILL.md")) || (d === env.EIGEN_BUILTIN_SKILLS && existsSync(d)));
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export type Report = { fixed: string[]; quarantined: Array<{ skill: string; reason: string }> };

const skillFiles = (root: string, depth = 4): string[] =>
  depth < 0 || !existsSync(root)
    ? []
    : readdirSync(root, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() && !e.name.startsWith(".") ? skillFiles(join(root, e.name), depth - 1) : e.isFile() && e.name === "SKILL.md" ? [join(root, e.name)] : [],
      );

const hasSymlink = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((e) => e.isSymbolicLink() || (e.isDirectory() && hasSymlink(join(dir, e.name))));

function readSkill(file: string): { name?: string; description?: string; error?: string } {
  const m = FRONTMATTER.exec(readFileSync(file, "utf8"));
  if (!m) return { error: "missing frontmatter" };
  try {
    const fm = (parse(m[1]!) ?? {}) as Record<string, unknown>;
    return { name: typeof fm.name === "string" ? fm.name : undefined, description: typeof fm.description === "string" ? fm.description : undefined };
  } catch {
    return { error: "unreadable frontmatter" };
  }
}

/** Mastra silently skips skills that break its rules, so fix what is safe to fix and report the rest. */
function assess(s: ReturnType<typeof readSkill>, slug: string) {
  const edits: Record<string, string> = {};
  if (s.error) return { problem: s.error, edits };
  if (!s.description?.trim()) return { problem: "missing description", edits };
  if (s.description.length > MAX_DESC) edits.description = truncate(s.description, { length: MAX_DESC });
  if (s.name !== slug) edits.name = slug;
  const name = edits.name ?? s.name!;
  if (!NAME_RE.test(name) || name.length > MAX_NAME) return { problem: `"${name}" is not a valid skill name (lowercase letters, digits, single hyphens)`, edits };
  return { name, edits };
}

function applyEdits(file: string, edits: Record<string, string>) {
  const m = FRONTMATTER.exec(readFileSync(file, "utf8"))!;
  const doc = parseDocument(m[1]!);
  Object.entries(edits).forEach(([k, v]) => doc.set(k, v));
  writeFileSync(file, `---\n${doc.toString().trimEnd()}\n---\n${m[2]}`);
}

const installedAt = (dir: string) => {
  try {
    return Number(JSON.parse(readFileSync(join(dir, ".clawhub", "origin.json"), "utf8")).installedAt);
  } catch {
    return statSync(dir).mtimeMs;
  }
};

function quarantine(p: SkillPaths, dir: string, id: string) {
  const dest = join(p.sandboxQuarantineDir, id.replaceAll("/", "__"));
  mkdirSync(p.sandboxQuarantineDir, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(dir, dest);
  try {
    rmdirSync(dirname(dir)); // drop an emptied @owner folder
  } catch {}
}

export const reportFile = (p: Pick<AgentPaths, "sandboxQuarantineDir">) => join(p.sandboxQuarantineDir, "REPORT.md");

const safe = (s: string) => s.replace(/[^\w@./ ",()'-]/g, "?");

/**
 * Makes the skills the agent installed in its sandbox loadable: fixes names and long descriptions, quarantines skills that are
 * broken, contain symlinks, or reuse a name (yours win, then the oldest install), and records what happened.
 */
export function reconcileSkills(p: SkillPaths): Report {
  const taken = new Map<string, string>();
  for (const f of skillFiles(p.skillsDir)) {
    const { name } = readSkill(f);
    if (name) taken.set(name, "one of your skills");
  }
  const report: Report = { fixed: [], quarantined: [] };
  for (const file of sortBy(skillFiles(p.sandboxSkillsDir), (f) => installedAt(dirname(f)))) {
    const dir = dirname(file);
    const id = relative(p.sandboxSkillsDir, dir);
    const { problem, name, edits } = hasSymlink(dir) ? { problem: "contains a symbolic link", name: undefined, edits: {} } : { name: undefined, ...assess(readSkill(file), basename(dir)) };
    const clash = !problem && name && taken.get(name);
    const reason = problem ?? (clash ? `the name "${name}" is already used by ${clash}` : undefined);
    if (reason) {
      quarantine(p, dir, id);
      report.quarantined.push({ skill: id, reason });
      continue;
    }
    if (!isEmpty(edits)) {
      applyEdits(file, edits);
      report.fixed.push(`${id}: adjusted ${Object.keys(edits).join(" and ")} to meet the skill format`);
    }
    taken.set(name!, id);
  }
  const lines = [...report.fixed.map((f) => `- ${safe(f)}`), ...report.quarantined.map((q) => `- REJECTED ${safe(q.skill)}: ${safe(q.reason)}`)];
  if (lines.length) {
    mkdirSync(p.sandboxQuarantineDir, { recursive: true });
    appendFileSync(reportFile(p), `${lines.join("\n")}\n`);
  }
  return report;
}
