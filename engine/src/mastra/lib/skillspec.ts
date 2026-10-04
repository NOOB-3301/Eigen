/**
 * The SKILL.md rules, as a pure module (`@eigen/engine/skillspec`) so the studio's editor and the store check a skill exactly
 * the way the engine does. Mirrors lib/skills.ts (readSkill + assess), which mirrors what Mastra's workspace accepts:
 * a YAML frontmatter block, a non-empty description of at most 1024 characters, and a name that equals the folder name
 * (lowercase letters, digits, single hyphens, at most 64 characters). Mastra skips a skill that breaks any of these, silently.
 */
import { parse } from "yaml";

export const SKILL_FILE = "SKILL.md";
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The folder Mastra compares the name with: the last segment, so "@owner/pdf" must be named "pdf". */
export const skillFolderName = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1);

/** ClawHub installs live under @owner/; they are managed by the clawhub CLI, so the studio shows them read-only. */
export const isClawhubSlug = (slug: string) => slug.startsWith("@");

export function parseSkillText(text: string): { name?: string; description?: string; body: string; error?: string } {
  const m = FRONTMATTER.exec(text);
  if (!m) return { body: text, error: "missing frontmatter (the file must start with a --- block holding name and description)" };
  try {
    const fm = (parse(m[1]!) ?? {}) as Record<string, unknown>;
    return { name: typeof fm.name === "string" ? fm.name : undefined, description: typeof fm.description === "string" ? fm.description : undefined, body: m[2]! };
  } catch {
    return { body: m[2]!, error: "unreadable frontmatter (not valid YAML)" };
  }
}

/** Everything that would make the engine skip this SKILL.md, as "field: message" strings. Empty means it loads. */
export function validateSkillText(slug: string, text: string): string[] {
  const s = parseSkillText(text);
  if (s.error) return [`frontmatter: ${s.error}`];
  const issues: string[] = [];
  if (!s.description?.trim()) issues.push("description: missing; say what the skill does and when to use it");
  else if (s.description.length > MAX_SKILL_DESCRIPTION) issues.push(`description: ${s.description.length} characters; at most ${MAX_SKILL_DESCRIPTION}`);
  const folder = skillFolderName(slug);
  if (s.name === undefined) issues.push(`name: missing; it must be "${folder}"`);
  else if (s.name !== folder) issues.push(`name: "${s.name}" must match the folder name "${folder}"`);
  if (!NAME_RE.test(folder) || folder.length > MAX_SKILL_NAME) issues.push(`name: "${folder}" is not a valid skill name (lowercase letters, digits, single hyphens, at most ${MAX_SKILL_NAME})`);
  return issues;
}
