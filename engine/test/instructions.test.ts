import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstructions, roleText } from "../src/mastra/lib/instructions.ts";
import { clockLine } from "../src/mastra/lib/time.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

const at = new Date("2026-10-01T09:30:00Z");

describe("instructions", () => {
  it("assembles role, soul, ground rules, then the clock last, in the agent's timezone", () => {
    const t = tmpAgent({ soul: { enabled: true }, timezone: "Asia/Kolkata" }, { instructions: "You review pull requests." });
    writeFileSync(join(t.paths.dir, "soul.md"), "Voice: dry");
    const r = { ...t.r, timezone: "Asia/Kolkata" };
    const text = buildInstructions(r, t.paths, at);
    const order = ["<operating_instructions>", "<soul>", "<ground_rules>", "Current time:"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("You review pull requests.");
    expect(text.trim().endsWith("(Asia/Kolkata)")).toBe(true);
  });

  it("re-reads the files on every call, and falls back to the agent's name when the role is empty", () => {
    const t = tmpAgent({ soul: { enabled: true } });
    writeFileSync(join(t.paths.dir, "soul.md"), "Voice: dry");
    expect(buildInstructions(t.r, t.paths, at)).toContain("Voice: dry");
    writeFileSync(join(t.paths.dir, "soul.md"), "Voice: warm");
    expect(buildInstructions(t.r, t.paths, at)).toContain("Voice: warm");
    writeFileSync(join(t.paths.dir, "instructions.md"), "");
    expect(buildInstructions(t.r, t.paths, at)).toContain("You are Agent a.");
  });

  it("uses instructions.inline instead of the file", () => {
    const t = tmpAgent({ instructions: { inline: "Inline role." } });
    expect(roleText(t.r, t.paths.dir)).toBe("Inline role.");
  });

  it("never reads a role or soul from outside the agent folder, also through a symlink", () => {
    const t = tmpAgent({ soul: { enabled: true } });
    symlinkSync(t.other.envFile, join(t.paths.dir, "soul.md"));
    symlinkSync(t.paths.envFile, join(t.paths.dir, "leak.md"));
    const text = buildInstructions({ ...t.r, instructions: { file: "leak.md" } }, t.paths, at);
    expect(text).not.toContain("other-agent-secret");
    expect(text).not.toContain("own-agent-secret");
    expect(roleText({ instructions: { file: "../other/instructions.md" } }, t.paths.dir)).toBe("");
  });

  it("leaves the soul out when it is off, even if the file exists", () => {
    const t = tmpAgent();
    writeFileSync(join(t.paths.dir, "soul.md"), "Voice: dry");
    expect(buildInstructions(t.r, t.paths, at)).not.toContain("<soul>");
  });

  it("tells the agent to finish its work and never end a turn on a promise, with the clock still last", () => {
    const t = tmpAgent();
    const text = buildInstructions(t.r, t.paths, at);
    expect(text).toMatch(/<finishing>[\s\S]*Never end a turn by saying you will do something[\s\S]*every task you were given is complete[\s\S]*<\/finishing>/);
    expect(text.indexOf("<finishing>")).toBeLessThan(text.indexOf("Current time:"));
  });

  it("has no workspace sections without the workspace tool", () => {
    const t = tmpAgent({ tools: { builtin: [] } });
    const text = buildInstructions(t.r, t.paths, at);
    for (const tag of ["<ground_rules>", "<secrets>", "<skill_notes>"]) expect(text, tag).not.toContain(tag);
  });

  it("formats the clock in the agent's timezone", () => {
    expect(clockLine("Asia/Kolkata", at)).toBe("Current time: Thursday 2026-10-01 15:00 +05:30 (Asia/Kolkata)");
  });
});
