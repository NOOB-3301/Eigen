import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SkillsConfig } from "../config/schema.ts";
import { estimateText } from "../util/tokens.ts";
import { logger } from "../util/logger.ts";

export type SkillSource = "agent-created" | "custom";

export type SkillMeta = { created: string; updatedAt: string; version: number; uses: number; lastUsed?: string; evalScore?: number };

export type Skill = {
  slug: string;
  name: string;
  description: string;
  when?: string;
  body: string;
  scripts: string[];
  source: SkillSource;
  dir: string;
  meta: SkillMeta;
};

export type SkillDraft = { name: string; description: string; when?: string; body: string; scripts?: Array<{ path: string; content: string }> };
export type InvalidSkill = { path: string; reason: string };

const FrontmatterSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(200),
  when: z.string().max(200).optional(),
  scripts: z.array(z.string()).default([]),
  version: z.number().int().positive().default(1),
});

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

// Minimal YAML subset: `key: value` and `key: [a, b]`. A real parser would be a
// dependency for five scalar keys, and skills are written by us, not by strangers.
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trim());
  if (!m) throw new Error("missing frontmatter");
  const data: Record<string, unknown> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const raw = kv[2]!.trim().replace(/\s+#.*$/, "");
    const unquote = (v: string) => v.replace(/^["'](.*)["']$/, "$1").trim();
    if (raw.startsWith("[")) data[kv[1]!] = raw.slice(1, -1).split(",").map(unquote).filter(Boolean);
    else if (/^\d+$/.test(raw)) data[kv[1]!] = Number(raw);
    else data[kv[1]!] = unquote(raw);
  }
  return { data, body: (m[2] ?? "").trim() };
}

export function renderSkillFile(skill: Pick<Skill, "name" | "description" | "when" | "scripts" | "body"> & { version: number }): string {
  const fm = [
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    skill.when ? `when: ${skill.when}` : "",
    skill.scripts.length ? `scripts: [${skill.scripts.join(", ")}]` : "",
    `version: ${skill.version}`,
  ].filter(Boolean);
  return `---\n${fm.join("\n")}\n---\n\n${skill.body.trim()}\n`;
}

// Dice coefficient over character bigrams: enough to spot "the same skill again".
export function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const t = s.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
  };
  const [x, y] = [bigrams(a), bigrams(b)];
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return (2 * shared) / (x.size + y.size);
}

export class SkillStore {
  #home: string;
  #cfg: SkillsConfig;
  #skills = new Map<string, Skill>();
  #invalid: InvalidSkill[] = [];

  constructor(home: string, cfg: SkillsConfig) {
    this.#home = home;
    this.#cfg = cfg;
  }

  root(source?: SkillSource): string {
    const base = join(this.#home, "skills");
    return source ? join(base, source) : base;
  }

  load(): { loaded: number; invalid: InvalidSkill[] } {
    this.#skills.clear();
    this.#invalid = [];
    for (const source of ["custom", "agent-created"] as const) {
      const dir = this.root(source);
      mkdirSync(dir, { recursive: true });
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        try {
          this.#skills.set(entry.name, this.#read(skillDir, entry.name, source));
        } catch (e) {
          this.#invalid.push({ path: skillDir, reason: (e as Error).message });
        }
      }
    }
    logger.info({ evt: "skills_loaded", loaded: this.#skills.size, invalid: this.#invalid.length });
    return { loaded: this.#skills.size, invalid: this.#invalid };
  }

  #read(dir: string, slug: string, source: SkillSource): Skill {
    const { data, body } = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
    const fm = FrontmatterSchema.parse(data);
    if (!body) throw new Error("empty body");
    return { slug, ...fm, body, source, dir, meta: this.#meta(dir, fm.version) };
  }

  #meta(dir: string, version: number): SkillMeta {
    const file = join(dir, ".meta.json");
    const now = new Date().toISOString();
    try {
      return { created: now, updatedAt: now, version, uses: 0, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { created: now, updatedAt: now, version, uses: 0 };
    }
  }

  #writeMeta(skill: Skill): void {
    writeFileSync(join(skill.dir, ".meta.json"), `${JSON.stringify(skill.meta, null, 2)}\n`);
  }

  all(): Skill[] {
    return [...this.#skills.values()];
  }
  get(slug: string): Skill | undefined {
    return this.#skills.get(slug);
  }
  slugs(): string[] {
    return [...this.#skills.keys()];
  }
  invalid(): InvalidSkill[] {
    return this.#invalid;
  }
  count(): { total: number; custom: number } {
    const custom = this.all().filter((s) => s.source === "custom").length;
    return { total: this.#skills.size, custom };
  }

  // Custom first, then most-used: what the model sees is stable within a session and
  // biased toward what the user wrote and what actually gets used.
  indexText(): string {
    const sorted = this.all().sort((a, b) => (a.source === b.source ? b.meta.uses - a.meta.uses : a.source === "custom" ? -1 : 1));
    const lines: string[] = [];
    let tokens = 0;
    for (const s of sorted) {
      const line = `- ${s.slug}: ${s.description}`;
      tokens += estimateText(line);
      if (tokens > this.#cfg.indexMaxTokens) {
        logger.warn({ evt: "skill_index_truncated", shown: lines.length, total: sorted.length });
        break;
      }
      lines.push(line);
    }
    return lines.length ? `${lines.join("\n")}\n\nCall skill_read("<slug>") before doing a task one of these covers.` : "";
  }

  similarTo(description: string, threshold = 0.8): Skill | undefined {
    return this.all().find((s) => similarity(s.description, description) >= threshold);
  }

  recordUse(slug: string): void {
    const skill = this.#skills.get(slug);
    if (!skill) return;
    skill.meta.uses++;
    skill.meta.lastUsed = new Date().toISOString();
    this.#writeMeta(skill);
  }

  write(draft: SkillDraft, source: SkillSource, evalScore?: number): Skill {
    if (this.#skills.size >= this.#cfg.maxSkills) throw new Error(`skill limit reached (${this.#cfg.maxSkills}); remove one first`);
    let slug = slugify(draft.name);
    if (!slug) throw new Error("name produces an empty slug");
    if (this.#skills.has(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const dir = join(this.root(source), slug);
    mkdirSync(dir, { recursive: true });
    const scripts = (draft.scripts ?? []).map((s) => {
      const rel = s.path.replace(/^\/+/, "");
      if (rel.includes("..")) throw new Error(`script path escapes the skill directory: ${s.path}`);
      const full = join(dir, rel.startsWith("scripts/") ? rel : `scripts/${rel}`);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, s.content, { mode: 0o644 }); // never executable: the agent runs them explicitly
      return full.slice(dir.length + 1);
    });
    const now = new Date().toISOString();
    const skill: Skill = {
      slug,
      name: draft.name,
      description: draft.description,
      when: draft.when,
      body: draft.body,
      scripts,
      source,
      dir,
      meta: { created: now, updatedAt: now, version: 1, uses: 0, evalScore },
    };
    writeFileSync(join(dir, "SKILL.md"), renderSkillFile({ ...skill, version: 1 }));
    this.#writeMeta(skill);
    this.#skills.set(slug, skill);
    logger.info({ evt: "skill_written", slug, source, evalScore });
    return skill;
  }

  update(slug: string, body: string, note?: string): Skill {
    const skill = this.#skills.get(slug);
    if (!skill) throw new Error(`unknown skill "${slug}"`);
    if (skill.source === "custom" && !this.#cfg.allowCustomEdits) throw new Error(`"${slug}" is a custom skill; editing it is disabled (skills.allowCustomEdits)`);
    mkdirSync(join(skill.dir, "versions"), { recursive: true });
    writeFileSync(join(skill.dir, "versions", `v${skill.meta.version}.md`), renderSkillFile({ ...skill, version: skill.meta.version }));
    skill.body = note ? `${body.trim()}\n\n<!-- v${skill.meta.version + 1}: ${note} -->` : body.trim();
    skill.meta.version++;
    skill.meta.updatedAt = new Date().toISOString();
    writeFileSync(join(skill.dir, "SKILL.md"), renderSkillFile({ ...skill, version: skill.meta.version }));
    this.#writeMeta(skill);
    logger.info({ evt: "skill_updated", slug, version: skill.meta.version });
    return skill;
  }

  remove(slug: string): boolean {
    const skill = this.#skills.get(slug);
    if (!skill) return false;
    if (skill.source === "custom" && !this.#cfg.allowCustomEdits) throw new Error(`"${slug}" is a custom skill; delete it yourself`);
    rmSync(skill.dir, { recursive: true, force: true });
    this.#skills.delete(slug);
    logger.info({ evt: "skill_removed", slug });
    return true;
  }

  // Used by the watcher and by hot registration after a write elsewhere.
  reloadIfChanged(): boolean {
    const before = existsSync(this.root()) ? this.slugs().join(",") : "";
    this.load();
    return before !== this.slugs().join(",");
  }
}
