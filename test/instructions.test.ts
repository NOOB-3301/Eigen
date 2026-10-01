import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInstructions, memoryBlock } from "../src/mastra/lib/instructions.ts";
import { clockLine } from "../src/mastra/lib/time.ts";
import { tmpHome } from "./helpers/home.ts";

const at = new Date("2026-10-01T09:30:00Z");

describe("instructions", () => {
  it("assembles prompt, soul, memory, then the clock last", () => {
    const p = tmpHome();
    writeFileSync(`${p.memoryDir}/profile.md`, "# Profile\n- Likes terse replies");
    const text = buildInstructions(p, "Asia/Kolkata", at);
    const order = ["<operating_instructions>", "<soul>", "<memory>", "Current time:"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Likes terse replies");
    expect(text.trim().endsWith("(Asia/Kolkata)")).toBe(true);
  });

  it("picks up edits on the next call, and falls back when files are gone", () => {
    const p = tmpHome();
    writeFileSync(p.soulFile, "Voice: dry");
    expect(buildInstructions(p, "UTC", at)).toContain("Voice: dry");
    writeFileSync(p.soulFile, "Voice: warm");
    expect(buildInstructions(p, "UTC", at)).toContain("Voice: warm");
    writeFileSync(p.systemPromptFile, "");
    expect(buildInstructions(p, "UTC", at)).toContain("You are eigen");
  });

  it("caps injected memory", () => {
    const p = tmpHome();
    writeFileSync(`${p.memoryDir}/projects.md`, "x".repeat(50_000));
    const block = memoryBlock(p.memoryDir);
    expect(block.length).toBeLessThanOrEqual(24_000);
    expect(block).toContain("[memory truncated]");
  });

  it("formats the clock in the owner's timezone", () => {
    expect(clockLine("Asia/Kolkata", at)).toBe("Current time: Thursday 2026-10-01 15:00 +05:30 (Asia/Kolkata)");
  });
});
