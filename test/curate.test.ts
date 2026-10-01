import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdate, CAPS, commitMemory, UpdateSchema, validate, writeTimeline } from "../src/mastra/lib/curate.ts";
import { tmpHome } from "./helpers/home.ts";

const file = (name: keyof typeof CAPS, content: string) => ({ name, content });
const at = new Date("2026-10-01T09:30:00Z");

describe("validate", () => {
  it("accepts a small, clean update", () => {
    expect(validate({ files: [file("profile.md", "- Likes terse replies")], timeline: "Set up the bot." })).toEqual([]);
  });

  it("rejects over-cap, empty, duplicate and secret-bearing content", () => {
    const problems = validate({
      files: [file("profile.md", "x".repeat(CAPS["profile.md"] + 1)), file("projects.md", "  "), file("people.md", "API_KEY=abc123"), file("people.md", "dup")],
      timeline: "token: sk-abcdefghijklmnop",
    });
    expect(problems.join("\n")).toMatch(/cap is 4000/);
    expect(problems.join("\n")).toMatch(/projects\.md is empty/);
    expect(problems.join("\n")).toMatch(/people\.md contains something that looks like a secret/);
    expect(problems.join("\n")).toMatch(/only once/);
    expect(problems.join("\n")).toMatch(/timeline contains/);
  });

  it("the schema rejects files the curator may not touch", () => {
    expect(UpdateSchema.safeParse({ files: [{ name: "../.env", content: "x" }] }).success).toBe(false);
    expect(UpdateSchema.safeParse({ files: [{ name: "SOUL.md", content: "x" }] }).success).toBe(false);
  });
});

describe("applyUpdate", () => {
  it("writes only the listed files, atomically, with a trailing newline", () => {
    const p = tmpHome();
    applyUpdate(p.memoryDir, { files: [file("profile.md", "# Profile\n- Name: Sam")] }, at, "UTC");
    expect(readFileSync(join(p.memoryDir, "profile.md"), "utf8")).toBe("# Profile\n- Name: Sam\n");
    expect(readFileSync(join(p.memoryDir, "projects.md"), "utf8")).toBe("# Projects\n");
    expect(readdirSync(p.memoryDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("keeps one timeline section per day, replacing today's on re-run", () => {
    const p = tmpHome();
    writeTimeline(p.memoryDir, "Planned the rewrite.", new Date("2026-09-30T10:00:00Z"), "UTC");
    writeTimeline(p.memoryDir, "First draft.", at, "UTC");
    writeTimeline(p.memoryDir, "Final draft.", at, "UTC");
    const month = readFileSync(join(p.memoryDir, "timeline", "2026-09.md"), "utf8");
    const oct = readFileSync(join(p.memoryDir, "timeline", "2026-10.md"), "utf8");
    expect(month).toContain("Planned the rewrite.");
    expect(oct.match(/## 2026-10-01/g)).toHaveLength(1);
    expect(oct).toContain("Final draft.");
    expect(oct).not.toContain("First draft.");
  });

  it("buckets days in the owner's timezone", () => {
    const p = tmpHome();
    writeTimeline(p.memoryDir, "late night", new Date("2026-10-01T20:00:00Z"), "Asia/Kolkata");
    expect(readFileSync(join(p.memoryDir, "timeline", "2026-10.md"), "utf8")).toContain("## 2026-10-02");
  });
});

describe("commitMemory", () => {
  it("creates the repo, commits changes, and reports nothing-to-commit", () => {
    const p = tmpHome();
    expect(commitMemory(p.memoryDir, "first")).toBe(true);
    expect(existsSync(join(p.memoryDir, ".git"))).toBe(true);
    expect(commitMemory(p.memoryDir, "again")).toBe(false);
    applyUpdate(p.memoryDir, { files: [file("lessons.md", "- Be brief")] }, at, "UTC");
    expect(commitMemory(p.memoryDir, "learned")).toBe(true);
    const log = execFileSync("git", ["-C", p.memoryDir, "log", "--format=%s"], { encoding: "utf8" });
    expect(log.trim().split("\n")).toEqual(["learned", "first"]);
  });
});
