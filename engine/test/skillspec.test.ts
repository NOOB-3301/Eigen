import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileSkills } from "../src/mastra/lib/skills.ts";
import { skillFolderName, validateSkillText } from "../src/mastra/lib/skillspec.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

const fm = (lines: string, body = "Do the thing.\n") => `---\n${lines}\n---\n\n${body}`;

/** [label, folder slug, SKILL.md text, the issue we expect first (undefined = valid)] */
const CASES: Array<[string, string, string, RegExp | undefined]> = [
  ["valid", "pdf-tools", fm("name: pdf-tools\ndescription: Read PDFs."), undefined],
  ["valid with extra keys and JSON metadata", "weather", fm(`name: weather\ndescription: Get weather.\nhomepage: https://wttr.in\nmetadata: {"a":{"b":["c"]}}`), undefined],
  ["valid, CRLF line ends", "crlf", "---\r\nname: crlf\r\ndescription: Windows.\r\n---\r\nBody\r\n", undefined],
  ["valid, description of exactly 1024", "long-ok", fm(`name: long-ok\ndescription: ${"x".repeat(1024)}`), undefined],
  ["no frontmatter", "plain", "# Just markdown\n", /^frontmatter: missing/],
  ["frontmatter not closed", "open", "---\nname: open\ndescription: d\n", /^frontmatter: missing/],
  ["frontmatter not YAML", "broken", fm("name: [broken\ndescription: d"), /^frontmatter: unreadable/],
  ["no description", "nodesc", fm("name: nodesc"), /^description: missing/],
  ["blank description", "blank", fm('name: blank\ndescription: "   "'), /^description: missing/],
  ["description not a string", "numdesc", fm("name: numdesc\ndescription: 42"), /^description: missing/],
  ["description too long", "toolong", fm(`name: toolong\ndescription: ${"x".repeat(1025)}`), /^description: 1025 characters/],
  ["no name", "noname", fm("description: d"), /^name: missing; it must be "noname"/],
  ["name differs from the folder", "folder", fm("name: other\ndescription: d"), /^name: "other" must match the folder name "folder"/],
  ["name with capitals", "Caps", fm("name: Caps\ndescription: d"), /not a valid skill name/],
  ["name with a double hyphen", "a--b", fm("name: a--b\ndescription: d"), /not a valid skill name/],
  ["name too long", "n".repeat(65), fm(`name: ${"n".repeat(65)}\ndescription: d`), /not a valid skill name/],
];

describe("validateSkillText", () => {
  it.each(CASES)("%s", (_label, slug, text, first) => {
    const issues = validateSkillText(slug, text);
    if (first) expect(issues[0]).toMatch(first);
    else expect(issues).toEqual([]);
  });

  it("checks a ClawHub skill's name against the last segment", () => {
    expect(skillFolderName("@steipete/weather")).toBe("weather");
    expect(validateSkillText("@steipete/weather", fm("name: weather\ndescription: d"))).toEqual([]);
    expect(validateSkillText("@steipete/weather", fm("name: steipete\ndescription: d"))[0]).toMatch(/must match the folder name "weather"/);
  });

  // The engine's own check (lib/skills.ts) runs on the agent's installed skills: it leaves a skill alone only if it would load as is.
  // Whatever the editor calls valid must be exactly what the engine leaves alone, and vice versa.
  it.each(CASES)("agrees with the engine's reconcileSkills: %s", (_label, slug, text) => {
    const p = tmpAgent().paths;
    mkdirSync(join(p.sandboxSkillsDir, slug), { recursive: true });
    writeFileSync(join(p.sandboxSkillsDir, slug, "SKILL.md"), text);
    const report = reconcileSkills(p);
    const engineAccepts = report.fixed.length === 0 && report.quarantined.length === 0;
    expect(engineAccepts).toBe(validateSkillText(slug, text).length === 0);
    if (engineAccepts) expect(existsSync(join(p.sandboxSkillsDir, slug, "SKILL.md"))).toBe(true);
  });
});
