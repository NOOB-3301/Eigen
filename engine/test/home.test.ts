import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentMdFile, agentPaths, backupOldLayout, ensureAgentDirs, homePaths, readyHome } from "../src/mastra/lib/home.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "eigen-home-"));

describe("home layout", () => {
  it("keeps agents and the engine's own files apart", () => {
    const p = homePaths("/h");
    expect(p).toMatchObject({ agentsDir: "/h/agents", engineDbFile: "/h/engine/mastra.db", logFile: "/h/engine/logs/eigen.log", layoutFile: "/h/engine/layout.json", trashDir: "/h/agents/.trash" });
    const a = agentPaths(p, "alpha");
    expect(a).toMatchObject({ dir: "/h/agents/alpha", envFile: "/h/agents/alpha/.env", memoryDbFile: "/h/agents/alpha/memory.db", triggersDir: "/h/agents/alpha/data/triggers" });
  });

  it("readyHome creates the folders of an empty home and no agent", () => {
    const p = readyHome(tmp());
    for (const d of [p.agentsDir, p.engineDir, p.logsDir]) expect(existsSync(d)).toBe(true);
    expect(readdirSync(p.agentsDir)).toEqual([]);
    expect(existsSync(p.backupDir)).toBe(false);
  });

  it("ensureAgentDirs creates an empty 0600 .env and never overwrites one", () => {
    const a = agentPaths(readyHome(tmp()), "alpha");
    ensureAgentDirs(a);
    expect(statSync(a.envFile).mode & 0o777).toBe(0o600);
    writeFileSync(a.envFile, "KEY=v\n");
    ensureAgentDirs(a);
    expect(readFileSync(a.envFile, "utf8")).toBe("KEY=v\n");
  });
});

describe("backupOldLayout", () => {
  it("copies the old text files once, leaves the originals, and never reads them again", () => {
    const home = tmp();
    writeFileSync(join(home, "config.json"), '{"old":true}');
    writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:a\n");
    mkdirSync(join(home, "prompts"));
    writeFileSync(join(home, "prompts", "system.md"), "old prompt");
    const p = readyHome(home);
    const [v1, ...rest] = readdirSync(p.backupDir);
    expect(rest).toEqual([]);
    expect(v1).toMatch(/^v1-/);
    expect(readFileSync(join(p.backupDir, v1!, "prompts", "system.md"), "utf8")).toBe("old prompt");
    expect(statSync(join(p.backupDir, v1!, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe('{"old":true}');
    expect(backupOldLayout(p)).toBeUndefined();
    expect(readdirSync(p.agentsDir)).toEqual([]);
  });
});

describe("agentMdFile", () => {
  it("resolves a plain .md name inside the agent folder, and nothing else", () => {
    expect(agentMdFile("/h/agents/a", "instructions.md")).toBe("/h/agents/a/instructions.md");
    for (const bad of ["../b/instructions.md", ".env", "config.json", "sub/x.md", "/etc/x.md", "..md", ".hidden.md", "x.md/"]) expect(agentMdFile("/h/agents/a", bad), bad).toBeUndefined();
  });
});
