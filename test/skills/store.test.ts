import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, similarity, SkillStore, slugify } from "../../src/skills/store.ts";
import { testConfig } from "../helpers/fake-provider.ts";

const cfg = testConfig().skills;

function store(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "eigen-skills-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(home, "skills", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  const s = new SkillStore(home, cfg);
  s.load();
  return { s, home };
}

const skillFile = (name: string, description: string, body = "x".repeat(300)) => `---\nname: ${name}\ndescription: ${description}\nwhen: someone asks\nversion: 1\n---\n\n${body}\n`;

describe("frontmatter", () => {
  it("parses scalars, arrays and numbers, ignoring comments", () => {
    const { data, body } = parseFrontmatter(`---\nname: directus-query\ndescription: Query Directus   # inline note\nscripts: [scripts/a.sh, scripts/b.sh]\nversion: 3\n---\n\n## Steps\n1. go`);
    expect(data).toEqual({ name: "directus-query", description: "Query Directus", scripts: ["scripts/a.sh", "scripts/b.sh"], version: 3 });
    expect(body).toBe("## Steps\n1. go");
  });
  it("rejects a file without frontmatter", () => {
    expect(() => parseFrontmatter("just text")).toThrow(/frontmatter/);
  });
});

describe("SkillStore", () => {
  it("loads both folders and reports invalid skills without throwing", () => {
    const { s } = store({
      "custom/deploy/SKILL.md": skillFile("deploy", "Deploy checklist for staging"),
      "agent-created/directus/SKILL.md": skillFile("directus", "Query a Directus API"),
      "custom/broken/SKILL.md": "no frontmatter here",
      "custom/empty/SKILL.md": "---\nname: x\ndescription: y\n---\n",
    });
    expect(s.slugs().sort()).toEqual(["deploy", "directus"]);
    expect(s.count()).toEqual({ total: 2, custom: 1 });
    expect(s.invalid()).toHaveLength(2);
    expect(s.invalid()[0]!.reason).toBeTruthy();
  });

  it("renders an index of slug + description, custom first then most used", () => {
    const { s } = store({
      "agent-created/a/SKILL.md": skillFile("a", "Agent one"),
      "agent-created/b/SKILL.md": skillFile("b", "Agent two"),
      "custom/c/SKILL.md": skillFile("c", "Custom one"),
    });
    s.recordUse("b");
    const lines = s.indexText().split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual(["- c: Custom one", "- b: Agent two", "- a: Agent one"]);
    expect(s.indexText()).not.toContain("x".repeat(50)); // bodies never enter the index
  });

  it("truncates the index at indexMaxTokens", () => {
    const home = mkdtempSync(join(tmpdir(), "eigen-skills-"));
    const tiny = new SkillStore(home, { ...cfg, indexMaxTokens: 10 });
    tiny.load();
    for (let i = 0; i < 5; i++) tiny.write({ name: `skill ${i}`, description: `A reasonably long description number ${i}`, body: "y".repeat(300) }, "agent-created");
    expect(tiny.indexText().split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThan(5);
  });

  it("writes a skill with meta and unique slug", () => {
    const { s, home } = store();
    const a = s.write({ name: "Directus Query", description: "Query a Directus API", when: "asked about directus", body: "z".repeat(300) }, "agent-created", 2.5);
    expect(a.slug).toBe("directus-query");
    expect(existsSync(join(home, "skills/agent-created/directus-query/SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(a.dir, ".meta.json"), "utf8"))).toMatchObject({ version: 1, uses: 0, evalScore: 2.5 });
    const b = s.write({ name: "Directus Query", description: "Another one", body: "z".repeat(300) }, "agent-created");
    expect(b.slug).not.toBe(a.slug);
  });

  it("writes scripts inside the skill dir, non-executable, and refuses escapes", () => {
    const { s } = store();
    const skill = s.write({ name: "with script", description: "Has a script", body: "z".repeat(300), scripts: [{ path: "run.sh", content: "echo hi" }] }, "agent-created");
    expect(skill.scripts).toEqual(["scripts/run.sh"]);
    expect(readFileSync(join(skill.dir, "scripts/run.sh"), "utf8")).toBe("echo hi");
    expect(() => s.write({ name: "bad", description: "Escapes", body: "z".repeat(300), scripts: [{ path: "../../evil.sh", content: "x" }] }, "agent-created")).toThrow(/escapes/);
  });

  it("update bumps the version and archives the old body", () => {
    const { s } = store({ "agent-created/a/SKILL.md": skillFile("a", "First version") });
    const updated = s.update("a", "new body ".repeat(30), "fixed the endpoint");
    expect(updated.meta.version).toBe(2);
    expect(readFileSync(join(updated.dir, "versions/v1.md"), "utf8")).toContain("version: 1");
    expect(readFileSync(join(updated.dir, "SKILL.md"), "utf8")).toContain("version: 2");
    expect(updated.body).toContain("fixed the endpoint");
  });

  it("protects custom skills from edits and deletes unless allowed", () => {
    const { s } = store({ "custom/c/SKILL.md": skillFile("c", "Custom skill") });
    expect(() => s.update("c", "y".repeat(300))).toThrow(/custom/);
    expect(() => s.remove("c")).toThrow(/custom/);
  });

  it("enforces maxSkills", () => {
    const home = mkdtempSync(join(tmpdir(), "eigen-skills-"));
    const s = new SkillStore(home, { ...cfg, maxSkills: 1 });
    s.load();
    s.write({ name: "one", description: "First skill", body: "z".repeat(300) }, "agent-created");
    expect(() => s.write({ name: "two", description: "Second skill", body: "z".repeat(300) }, "agent-created")).toThrow(/limit/);
  });

  it("finds near-duplicate descriptions", () => {
    const { s } = store({ "agent-created/a/SKILL.md": skillFile("a", "Query a Directus API for items") });
    expect(s.similarTo("Query a Directus API for items")?.slug).toBe("a");
    expect(s.similarTo("Make espresso with the machine")).toBeUndefined();
    expect(similarity("abc def", "abc def")).toBe(1);
  });

  it("slugify is filesystem-safe", () => {
    expect(slugify("Directus / Query!")).toBe("directus-query");
    expect(slugify("!!!")).toBe("");
  });
});
