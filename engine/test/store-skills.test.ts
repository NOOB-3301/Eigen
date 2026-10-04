/* One agent's skill library (agents/<id>/skills/<slug>/SKILL.md): listing with `enabled`, etag writes, ClawHub read-only, trash, confinement. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { createSkill, listSkills, readSkill, SkillPathError, skillDir, trashSkill, writeSkill } from "../src/mastra/lib/store.ts";
import { validateSkillText } from "../src/mastra/lib/skillspec.ts";
import { addAgent, addSkill, emptyHome, goodSkill as good, snapshot } from "./helpers/agent-home.ts";

const setup = (skills?: unknown) => {
  const p = emptyHome();
  const a = addAgent(p, "helper", skills === undefined ? {} : { skills: { enabled: skills } });
  return { p, root: a.skillsDir };
};

describe("an agent's skill library", () => {
  it("lists user and ClawHub skills with their problems and whether the agent loads them", () => {
    const { p, root } = setup(["pdf", "@steipete/weather"]);
    addSkill(p, "helper", "pdf", good("pdf", "Read PDFs."));
    addSkill(p, "helper", "broken", "# no frontmatter\n");
    addSkill(p, "helper", "@steipete/weather", good("weather"));
    mkdirSync(join(root, "empty-folder"));
    addSkill(p, "helper", "Not A Slug", good("x"));
    addSkill(p, "helper", ".hidden", good("hidden"));

    expect(listSkills(p, "helper")).toEqual([
      { slug: "@steipete/weather", name: "weather", description: "Does a thing.", origin: "clawhub", enabled: true },
      { slug: "broken", name: "broken", description: "", origin: "user", problem: expect.stringMatching(/^frontmatter: missing/), enabled: false },
      { slug: "pdf", name: "pdf", description: "Read PDFs.", origin: "user", enabled: true },
    ]);
  });

  it('"all" (the default) enables every skill; an unknown agent has no list', () => {
    const { p } = setup();
    addSkill(p, "helper", "pdf", good("pdf"));
    expect(listSkills(p, "helper")!.map((s) => s.enabled)).toEqual([true]);
    expect(listSkills(p, "ghost")).toBeUndefined();
  });

  it("one agent never sees another agent's skills", () => {
    const { p } = setup();
    addAgent(p, "other");
    addSkill(p, "other", "secret", good("secret"));
    expect(listSkills(p, "helper")).toEqual([]);
    expect(readSkill(p, "helper", "secret")).toBeUndefined();
    expect(writeSkill(p, "helper", "secret", { text: good("secret", "pwned") }).status).toBe(404);
    expect(trashSkill(p, "helper", "secret").status).toBe(404);
    expect(readSkill(p, "other", "secret")!.text).toBe(good("secret"));
  });

  it("reads a skill with its etag, problem and the names of its other files", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "pdf", good("pdf"));
    mkdirSync(join(root, "pdf", "scripts"));
    writeFileSync(join(root, "pdf", "scripts", "extract.py"), "print(1)");
    writeFileSync(join(root, "pdf", "REFERENCE.md"), "ref");
    writeFileSync(join(root, "pdf", ".hidden"), "x");
    const s = readSkill(p, "helper", "pdf")!;
    expect(s).toMatchObject({ slug: "pdf", text: good("pdf"), origin: "user", files: ["REFERENCE.md", "scripts/extract.py"] });
    expect(s.problem).toBeUndefined();
    expect(s.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(readSkill(p, "helper", "nope")).toBeUndefined();
  });

  it("writes with an etag (409), validates first (400), and is atomic", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "pdf", good("pdf"));
    const { etag } = readSkill(p, "helper", "pdf")!;
    const file = join(root, "pdf", "SKILL.md");

    expect(writeSkill(p, "helper", "pdf", { text: good("pdf", "New."), etag: "0000000000000000" })).toMatchObject({ status: 409, body: { ok: false, etag } });
    const bad = writeSkill(p, "helper", "pdf", { text: good("other"), etag });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, issues: [expect.stringMatching(/must match the folder name "pdf"/)] });
    expect(readFileSync(file, "utf8")).toBe(good("pdf"));

    const ok = writeSkill(p, "helper", "pdf", { text: good("pdf", "New."), etag });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, slug: "pdf" } });
    expect(readSkill(p, "helper", "pdf")!.etag).toBe((ok.body as { etag: string }).etag);
    expect(readFileSync(file, "utf8")).toBe(good("pdf", "New."));
    expect(readdirSync(join(root, "pdf"))).toEqual(["SKILL.md"]);
    expect(writeSkill(p, "helper", "missing", { text: good("missing") }).status).toBe(404);
  });

  it("refuses to write or trash a ClawHub skill", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "@steipete/weather", good("weather"));
    const before = snapshot(root);
    expect(writeSkill(p, "helper", "@steipete/weather", { text: good("weather", "Mine now.") }).status).toBe(403);
    expect(trashSkill(p, "helper", "@steipete/weather").status).toBe(403);
    expect(snapshot(root)).toEqual(before);
  });

  it("creates a loadable skill once, and never under @owner/ or for an unknown agent", () => {
    const { p, root } = setup();
    const made = createSkill(p, "helper", { slug: "notes", description: 'Takes notes: "quoted", and a colon.' });
    expect(made).toMatchObject({ status: 200, body: { ok: true, slug: "notes" } });
    expect(validateSkillText("notes", readFileSync(join(root, "notes", "SKILL.md"), "utf8"))).toEqual([]);
    expect(listSkills(p, "helper")).toEqual([{ slug: "notes", name: "notes", description: 'Takes notes: "quoted", and a colon.', origin: "user", enabled: true }]);
    expect(readSkill(p, "helper", "notes")!.etag).toBe((made.body as { etag: string }).etag);

    expect(createSkill(p, "helper", { slug: "notes", description: "again" }).status).toBe(409);
    expect(createSkill(p, "helper", { slug: "with-body", description: "d", text: "# Custom\n" }).status).toBe(200);
    expect(readFileSync(join(root, "with-body", "SKILL.md"), "utf8")).toMatch(/---\n\n# Custom\n$/);
    expect(createSkill(p, "helper", { slug: "@me/mine", description: "d" }).status).toBe(400);
    expect(existsSync(join(root, "@me"))).toBe(false);
    expect(createSkill(p, "ghost", { slug: "x", description: "d" }).status).toBe(404);
    expect(existsSync(join(p.agentsDir, "ghost"))).toBe(false);
  });

  it("refuses a new skill whose name a ClawHub skill of the same agent already uses", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "@steipete/weather", good("weather"));
    const r = createSkill(p, "helper", { slug: "weather", description: "mine" });
    expect(r.status).toBe(409);
    expect((r.body as { issues: string[] }).issues[0]).toContain("@steipete/weather");
    expect(existsSync(join(root, "weather"))).toBe(false);
    expect(createSkill(p, "helper", { slug: "weather-report", description: "different name" }).status).toBe(200);
  });

  it("trashes into the agent's .trash/, outside skills/, and never erases", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "pdf", good("pdf"));
    writeFileSync(join(root, "pdf", "extra.txt"), "keep me");
    expect(trashSkill(p, "helper", "pdf")).toEqual({ status: 200 });
    expect(existsSync(join(root, "pdf"))).toBe(false);
    const trash = join(agentPaths(p, "helper").trashDir, "skills");
    const [trashed] = readdirSync(trash);
    expect(trashed).toMatch(/^pdf-\d{4}-/);
    expect(readFileSync(join(trash, trashed!, "extra.txt"), "utf8")).toBe("keep me");
    expect(listSkills(p, "helper")).toEqual([]);
    expect(trashSkill(p, "helper", "pdf").status).toBe(404);
  });

  it("rejects every slug that could leave the agent's library, touching nothing", () => {
    const { p, root } = setup();
    addSkill(p, "helper", "pdf", good("pdf"));
    addAgent(p, "other");
    addSkill(p, "other", "secret", good("secret"));
    const outside = mkdtempSync(join(tmpdir(), "eigen-outside-"));
    writeFileSync(join(outside, "SKILL.md"), good(basename(outside)));
    symlinkSync(outside, join(root, "linked"));
    symlinkSync(join(agentPaths(p, "other").skillsDir, "secret"), join(root, "theirs"));
    mkdirSync(join(root, "@evil"));
    symlinkSync(outside, join(root, "@evil", "x"));
    mkdirSync(join(root, "filelink"));
    symlinkSync(join(outside, "SKILL.md"), join(root, "filelink", "SKILL.md"));
    const before = [...snapshot(p.home), ...snapshot(outside)];

    const attempts = ["../x", "../../other/skills/secret", "@../x", "@a..b/x", "%2e%2e", "..", ".trash", "/etc/passwd", outside, "a/b", "@owner/../../x", "pdf/../pdf", "x\\..\\y", "", "@x/.y", "linked", "theirs", "@evil/x", "filelink", "PDF"];
    for (const slug of attempts) {
      expect(() => skillDir(p, "helper", slug), slug).toThrow(SkillPathError);
      expect(() => readSkill(p, "helper", slug), slug).toThrow(SkillPathError);
      expect(() => writeSkill(p, "helper", slug, { text: good(slug) }), slug).toThrow(SkillPathError);
      expect(() => trashSkill(p, "helper", slug), slug).toThrow(SkillPathError);
    }
    expect(() => createSkill(p, "helper", { slug: "linked", description: "d" })).toThrow(SkillPathError);
    expect(() => skillDir(p, "../other", "secret")).toThrow(/invalid agent id/);
    expect([...snapshot(p.home), ...snapshot(outside)]).toEqual(before);
    expect(listSkills(p, "helper")!.map((s) => s.slug)).toEqual(["pdf"]);
  });

  it("refuses a skills/ folder that is a symlink to another agent's library", () => {
    const p = emptyHome();
    addAgent(p, "other");
    addSkill(p, "other", "secret", good("secret"));
    const a = addAgent(p, "helper");
    // Replace helper's (empty) skills/ with a link to other's.
    rmdirSync(a.skillsDir);
    symlinkSync(agentPaths(p, "other").skillsDir, a.skillsDir);
    expect(listSkills(p, "helper")).toEqual([]);
    expect(() => readSkill(p, "helper", "secret")).toThrow(SkillPathError);
  });
});
