import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { homePaths, seedHome } from "../src/mastra/lib/home.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";

describe("home", () => {
  it("lays out the runtime tree", () => {
    const p = homePaths("/h");
    expect(p.userSkillsDir).toBe("/h/skills");
    expect(p.sandboxSkillsDir).toBe("/h/sandbox/skills");
    expect(p.memoryDir).toBe("/h/memory");
    expect(p.dbFile).toBe("/h/data/eigen.db");
  });

  it("seeds defaults, keeps .env private, and never overwrites", () => {
    const p = tmpHome();
    for (const f of [p.configFile, p.envFile, p.soulFile, p.systemPromptFile]) expect(existsSync(f)).toBe(true);
    expect(statSync(p.envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(`${p.memoryDir}/profile.md`)).toBe(true);
    for (const d of [p.userSkillsDir, p.sandboxSkillsDir, p.sandboxHomeDir, p.logsDir]) expect(existsSync(d)).toBe(true);

    writeFileSync(p.soulFile, "mine");
    expect(seedHome(p, DEFAULTS)).toEqual([]);
    expect(readFileSync(p.soulFile, "utf8")).toBe("mine");
  });
});
