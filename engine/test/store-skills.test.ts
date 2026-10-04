import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSkill, listSkills, readSkill, SkillPathError, skillDir, trashSkill, writeSkill } from "../src/mastra/lib/store.ts";
import { validateSkillText } from "../src/mastra/lib/skillspec.ts";
import { tmpHome } from "./helpers/home.ts";

type P = ReturnType<typeof tmpHome>;

const skill = (p: P, slug: string, text: string) => {
  mkdirSync(join(p.userSkillsDir, slug), { recursive: true });
  writeFileSync(join(p.userSkillsDir, slug, "SKILL.md"), text);
};
const good = (name: string, description = "Does a thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;
const agent = (p: P, id: string, skills?: unknown) => {
  mkdirSync(join(p.agentsDir, id), { recursive: true });
  writeFileSync(join(p.agentsDir, id, "config.json"), JSON.stringify({ id, name: id, role: "r", description: "d", ...(skills !== undefined && { skills: { inherit: skills } }) }));
};
/** Every file under the home, so a refused request can be shown to have touched nothing. */
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .map((e) => `${join(e.parentPath, e.name)}:${e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8").length : "d"}`)
    .sort();

describe("skill library", () => {
  it("lists user and ClawHub skills with their problems and the agents that name them", () => {
    const p = tmpHome();
    skill(p, "pdf", good("pdf", "Read PDFs."));
    skill(p, "broken", "# no frontmatter\n");
    skill(p, "@steipete/weather", good("weather"));
    mkdirSync(join(p.userSkillsDir, "empty-folder"));
    mkdirSync(join(p.userSkillsDir, "Not A Slug"));
    writeFileSync(join(p.userSkillsDir, "Not A Slug", "SKILL.md"), good("x"));
    skill(p, ".trash/old-2026", good("old"));
    agent(p, "researcher", ["pdf", "@steipete/weather"]);
    agent(p, "writer", ["pdf"]);
    agent(p, "everyone", "all");

    expect(listSkills(p)).toEqual([
      { slug: "@steipete/weather", name: "weather", description: "Does a thing.", origin: "clawhub", usedBy: ["researcher"] },
      { slug: "broken", name: "broken", description: "", origin: "user", problem: expect.stringMatching(/^frontmatter: missing/), usedBy: [] },
      { slug: "pdf", name: "pdf", description: "Read PDFs.", origin: "user", usedBy: ["researcher", "writer"] },
    ]);
  });

  it("reads a skill with its etag, problem and the names of its other files", () => {
    const p = tmpHome();
    skill(p, "pdf", good("pdf"));
    mkdirSync(join(p.userSkillsDir, "pdf", "scripts"));
    writeFileSync(join(p.userSkillsDir, "pdf", "scripts", "extract.py"), "print(1)");
    writeFileSync(join(p.userSkillsDir, "pdf", "REFERENCE.md"), "ref");
    writeFileSync(join(p.userSkillsDir, "pdf", ".hidden"), "x");
    const s = readSkill(p, "pdf")!;
    expect(s).toMatchObject({ slug: "pdf", text: good("pdf"), origin: "user", files: ["REFERENCE.md", "scripts/extract.py"] });
    expect(s.problem).toBeUndefined();
    expect(s.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(readSkill(p, "nope")).toBeUndefined();
  });

  it("writes with an etag (409), validates first (400), and is atomic", () => {
    const p = tmpHome();
    skill(p, "pdf", good("pdf"));
    const { etag } = readSkill(p, "pdf")!;
    const file = join(p.userSkillsDir, "pdf", "SKILL.md");

    expect(writeSkill(p, "pdf", { text: good("pdf", "New."), etag: "0000000000000000" })).toMatchObject({ status: 409, body: { ok: false, etag } });
    const bad = writeSkill(p, "pdf", { text: good("other"), etag });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, issues: [expect.stringMatching(/must match the folder name "pdf"/)] });
    expect(readFileSync(file, "utf8")).toBe(good("pdf"));

    const ok = writeSkill(p, "pdf", { text: good("pdf", "New."), etag });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, slug: "pdf" } });
    expect(readSkill(p, "pdf")!.etag).toBe((ok.body as { etag: string }).etag);
    expect(readFileSync(file, "utf8")).toBe(good("pdf", "New."));
    expect(readdirSync(join(p.userSkillsDir, "pdf"))).toEqual(["SKILL.md"]);
    expect(writeSkill(p, "missing", { text: good("missing") }).status).toBe(404);
  });

  it("refuses to write or trash a ClawHub skill", () => {
    const p = tmpHome();
    skill(p, "@steipete/weather", good("weather"));
    const before = snapshot(p.userSkillsDir);
    expect(writeSkill(p, "@steipete/weather", { text: good("weather", "Mine now.") }).status).toBe(403);
    expect(trashSkill(p, "@steipete/weather").status).toBe(403);
    expect(snapshot(p.userSkillsDir)).toEqual(before);
  });

  it("creates a loadable skill once, and never under @owner/", () => {
    const p = tmpHome();
    const made = createSkill(p, { slug: "notes", description: 'Takes notes: "quoted", and a colon.' });
    expect(made).toMatchObject({ status: 200, body: { ok: true, slug: "notes" } });
    const text = readFileSync(join(p.userSkillsDir, "notes", "SKILL.md"), "utf8");
    expect(validateSkillText("notes", text)).toEqual([]);
    expect(listSkills(p)).toEqual([{ slug: "notes", name: "notes", description: 'Takes notes: "quoted", and a colon.', origin: "user", usedBy: [] }]);
    expect(readSkill(p, "notes")!.etag).toBe((made.body as { etag: string }).etag);

    expect(createSkill(p, { slug: "notes", description: "again" }).status).toBe(409);
    expect(createSkill(p, { slug: "with-body", description: "d", text: "# Custom\n" }).status).toBe(200);
    expect(readFileSync(join(p.userSkillsDir, "with-body", "SKILL.md"), "utf8")).toMatch(/---\n\n# Custom\n$/);
    expect(createSkill(p, { slug: "@me/mine", description: "d" }).status).toBe(400);
    expect(existsSync(join(p.userSkillsDir, "@me"))).toBe(false);
  });

  it("refuses a new skill whose name a ClawHub skill already uses (Mastra throws on two skills with one name)", () => {
    const p = tmpHome();
    skill(p, "@steipete/weather", good("weather"));
    const r = createSkill(p, { slug: "weather", description: "mine" });
    expect(r.status).toBe(409);
    expect((r.body as { issues: string[] }).issues[0]).toContain("@steipete/weather");
    expect(existsSync(join(p.userSkillsDir, "weather"))).toBe(false);
    expect(createSkill(p, { slug: "weather-report", description: "different name" }).status).toBe(200);
  });

  it("trashes into skills/.trash under a name that can never load, and never erases", () => {
    const p = tmpHome();
    skill(p, "pdf", good("pdf"));
    writeFileSync(join(p.userSkillsDir, "pdf", "extra.txt"), "keep me");
    expect(trashSkill(p, "pdf")).toEqual({ status: 200 });
    expect(existsSync(join(p.userSkillsDir, "pdf"))).toBe(false);
    const [trashed] = readdirSync(join(p.userSkillsDir, ".trash"));
    expect(trashed).toMatch(/^pdf-\d{4}-/);
    expect(readFileSync(join(p.userSkillsDir, ".trash", trashed!, "extra.txt"), "utf8")).toBe("keep me");
    // Mastra scans dot folders too; what keeps a trashed skill out is that its folder name fails the name rule.
    expect(validateSkillText(trashed!, good("pdf"))).not.toEqual([]);
    expect(listSkills(p)).toEqual([]);
    expect(trashSkill(p, "pdf").status).toBe(404);
  });

  it("rejects every slug that could leave the library, touching nothing", () => {
    const p = tmpHome();
    skill(p, "pdf", good("pdf"));
    const outside = mkdtempSync(join(tmpdir(), "eigen-outside-"));
    writeFileSync(join(outside, "SKILL.md"), good(basename(outside)));
    symlinkSync(outside, join(p.userSkillsDir, "linked"));
    mkdirSync(join(p.userSkillsDir, "@evil"));
    symlinkSync(outside, join(p.userSkillsDir, "@evil", "x"));
    mkdirSync(join(p.userSkillsDir, "filelink"));
    symlinkSync(join(outside, "SKILL.md"), join(p.userSkillsDir, "filelink", "SKILL.md"));
    const before = [...snapshot(p.home), ...snapshot(outside)];

    const attempts = ["../x", "@../x", "@a..b/x", "%2e%2e", "..", ".trash", "/etc/passwd", outside, "a/b", "@owner/../../x", "pdf/../pdf", "x\\..\\y", "", "@x/.y", "linked", "@evil/x", "filelink", "PDF"];
    for (const slug of attempts) {
      expect(() => skillDir(p, slug), slug).toThrow(SkillPathError);
      expect(() => readSkill(p, slug), slug).toThrow(SkillPathError);
      expect(() => writeSkill(p, slug, { text: good(slug) }), slug).toThrow(SkillPathError);
      expect(() => trashSkill(p, slug), slug).toThrow(SkillPathError);
    }
    expect(() => createSkill(p, { slug: "linked", description: "d" })).toThrow(SkillPathError);
    expect([...snapshot(p.home), ...snapshot(outside)]).toEqual(before);
    expect(listSkills(p).map((s) => s.slug)).toEqual(["pdf"]);
  });
});
