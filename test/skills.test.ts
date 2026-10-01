import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import { CLAWHUB_VERSION, reconcileSkills, reportFile } from "../src/mastra/lib/skills.ts";
import { makeWorkspace } from "../src/mastra/lib/workspace.ts";
import { fakeLlm, type Turn } from "./helpers/fake-llm.ts";
import { tmpHome } from "./helpers/home.ts";

type P = ReturnType<typeof tmpHome>;

/** Writes root/<rel>/SKILL.md with the given raw frontmatter lines. */
function skill(root: string, rel: string, frontmatter: string, body = "Do the thing.") {
  const file = join(root, rel, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`);
  return file;
}
const agentSkill = (p: P, rel: string, fm: string) => skill(p.sandboxSkillsDir, rel, fm);
const userSkill = (p: P, rel: string, fm: string) => skill(p.userSkillsDir, rel, fm);
const read = (f: string) => readFileSync(f, "utf8");

describe("reconcileSkills", () => {
  it("leaves a real ClawHub-style skill alone (nested under @owner, JSON metadata)", () => {
    const p = tmpHome();
    const f = agentSkill(p, "@steipete/weather", `name: weather\ndescription: Get weather.\nhomepage: https://wttr.in\nmetadata: {"clawdbot":{"requires":{"bins":["curl"]}}}`);
    const before = read(f);
    expect(reconcileSkills(p)).toEqual({ fixed: [], quarantined: [] });
    expect(read(f)).toBe(before);
    expect(existsSync(reportFile(p))).toBe(false);
  });

  it("sets the name to the folder and keeps every other field", () => {
    const p = tmpHome();
    const f = agentSkill(p, "@o/weather", `name: Weather Forecast\ndescription: Get weather.\nhomepage: https://x.dev\nmetadata: {"a":{"b":1}}`);
    const { fixed } = reconcileSkills(p);
    expect(fixed).toEqual(["@o/weather: adjusted name to meet the skill format"]);
    expect(read(f)).toMatch(/^---\nname: weather\n/);
    expect(read(f)).toContain("homepage: https://x.dev");
    expect(read(f)).toContain("Do the thing.");
  });

  it("shortens an over-long description", () => {
    const p = tmpHome();
    const f = agentSkill(p, "@o/wordy", `name: wordy\ndescription: ${"word ".repeat(400)}`);
    reconcileSkills(p);
    expect(read(f).match(/description: (.*)/)![1]!.length).toBeLessThanOrEqual(1024);
  });

  it("quarantines broken skills, symlinks and bad folder names, and says why", () => {
    const p = tmpHome();
    agentSkill(p, "@o/no-desc", "name: no-desc");
    const bare = join(p.sandboxSkillsDir, "@o/bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "SKILL.md"), "no frontmatter at all");
    agentSkill(p, "@o/My_Skill", "name: My_Skill\ndescription: bad folder name");
    const linked = agentSkill(p, "@o/linky", "name: linky\ndescription: has a symlink");
    symlinkSync("/etc/hostname", join(dirname(linked), "leak"));

    const { quarantined } = reconcileSkills(p);
    expect(Object.fromEntries(quarantined.map((q) => [q.skill, q.reason]))).toEqual({
      "@o/no-desc": "missing description",
      "@o/bare": "missing frontmatter",
      "@o/My_Skill": expect.stringContaining("not a valid skill name"),
      "@o/linky": "contains a symbolic link",
    });
    expect(existsSync(join(p.sandboxSkillsDir, "@o/linky"))).toBe(false);
    expect(existsSync(join(p.sandboxQuarantineDir, "@o__linky"))).toBe(true);
    expect(read(reportFile(p))).toContain("REJECTED @o/linky: contains a symbolic link");
  });

  it("your skills win a name clash, and are never modified", () => {
    const p = tmpHome();
    const mine = userSkill(p, "weather", "name: weather\ndescription: mine");
    const invalid = userSkill(p, "Odd Name", "name: Odd Name\ndescription: yours, even if odd");
    agentSkill(p, "@o/weather", "name: weather\ndescription: theirs");
    const { quarantined } = reconcileSkills(p);
    expect(quarantined).toEqual([{ skill: "@o/weather", reason: 'the name "weather" is already used by one of your skills' }]);
    expect(read(mine)).toContain("description: mine");
    expect(read(invalid)).toContain("name: Odd Name");
  });

  it("between two agent installs with the same name, the older one stays", () => {
    const p = tmpHome();
    const old = agentSkill(p, "@a/weather", "name: weather\ndescription: first");
    const newer = agentSkill(p, "@b/weather", "name: weather\ndescription: second");
    utimesSync(dirname(old), new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(dirname(newer), new Date("2026-06-01"), new Date("2026-06-01"));
    const { quarantined } = reconcileSkills(p);
    expect(quarantined.map((q) => q.skill)).toEqual(["@b/weather"]);
    expect(existsSync(old)).toBe(true);
  });

  it("uses ClawHub's recorded install time over folder mtime", () => {
    const p = tmpHome();
    const a = agentSkill(p, "@a/dup", "name: dup\ndescription: a");
    const b = agentSkill(p, "@b/dup", "name: dup\ndescription: b");
    mkdirSync(join(dirname(a), ".clawhub"));
    mkdirSync(join(dirname(b), ".clawhub"));
    writeFileSync(join(dirname(a), ".clawhub/origin.json"), JSON.stringify({ installedAt: 2000 }));
    writeFileSync(join(dirname(b), ".clawhub/origin.json"), JSON.stringify({ installedAt: 1000 }));
    expect(reconcileSkills(p).quarantined.map((q) => q.skill)).toEqual(["@a/dup"]);
  });
});

describe("Mastra's real skill loader on the reconciled set", () => {
  it("lists both roots with unique names, and every name resolves", async () => {
    const p = tmpHome();
    userSkill(p, "mine", "name: mine\ndescription: yours");
    agentSkill(p, "@o/good", "name: good\ndescription: fine");
    agentSkill(p, "@o/renamed", "name: Some Other Name\ndescription: gets fixed");
    agentSkill(p, "@o/mine", "name: mine\ndescription: clashes with yours");
    agentSkill(p, "@o/broken", "name: broken");
    reconcileSkills(p);

    const ws = makeWorkspace(p, loadConfig(p.configFile), "none");
    await ws.init();
    const names = (await ws.skills!.list()).map((s) => s.name).sort();
    expect(names).toEqual(["good", "mine", "renamed"]);
    for (const n of names) await expect(ws.skills!.get(n)).resolves.toBeTruthy();
  });
});

describe("prompt notes", () => {
  it("shows skill_notes only while there is something to report", () => {
    const p = tmpHome();
    expect(buildInstructions(p, "UTC")).not.toContain("<skill_notes>");
    agentSkill(p, "@o/oops", "name: oops");
    reconcileSkills(p);
    expect(buildInstructions(p, "UTC")).toMatch(/<skill_notes>\n- REJECTED @o\/oops: missing description/);
  });
});

describe("skill manager hook (real agent, fake model)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  async function run(turns: Turn[], prepare?: (p: P) => void) {
    const p = tmpHome();
    prepare?.(p);
    const llm = await fakeLlm(turns);
    closers.push(llm.close);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, workspace: makeWorkspace(p, loadConfig(p.configFile), "none") });
    await agent.generate("go", { maxSteps: 6 });
    return { p, llm };
  }

  it("a skill the agent writes is usable on its very next step", async () => {
    const content = "---\nname: demo\ndescription: A freshly written skill.\n---\n\nSteps.";
    const { llm } = await run([{ calls: [{ name: "write", args: { path: "skills/@me/demo/SKILL.md", content } }] }, { text: "done" }]);
    expect(JSON.stringify(llm.requests[0])).not.toContain("freshly written");
    expect(JSON.stringify(llm.requests[1])).toContain("freshly written");
  });

  it("a clawhub command triggers reconcile, so a broken install is quarantined at once", async () => {
    const { p } = await run([{ calls: [{ name: "bash", args: { description: "list", command: "echo clawhub list" } }] }, { text: "ok" }], (p) => agentSkill(p, "@o/broken", "name: broken"));
    expect(existsSync(join(p.sandboxSkillsDir, "@o/broken"))).toBe(false);
    expect(read(reportFile(p))).toContain("REJECTED @o/broken");
  });

  it("unrelated commands do not touch skills", async () => {
    const { p } = await run([{ calls: [{ name: "bash", args: { description: "ls", command: "ls" } }] }, { text: "ok" }], (p) => agentSkill(p, "@o/broken", "name: broken"));
    expect(existsSync(join(p.sandboxSkillsDir, "@o/broken"))).toBe(true);
  });
});

describe("built-in clawhub skill", () => {
  const file = resolve(import.meta.dirname, "../src/mastra/agents/eigen/skills/clawhub/SKILL.md");

  it("has the required frontmatter and pins the same CLI version as the code", () => {
    const text = read(file);
    expect(text).toMatch(/^---\nname: clawhub\ndescription: .+\n---/);
    expect(text).toContain(`clawhub@${CLAWHUB_VERSION}`);
    expect(text.match(/clawhub@[\d.]+/g)!.every((v) => v === `clawhub@${CLAWHUB_VERSION}`)).toBe(true);
  });
});
