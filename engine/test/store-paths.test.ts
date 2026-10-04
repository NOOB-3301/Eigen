/* Confinement: an agent id, a file name in a config, or a symlink can never take the store out of one agent's folder. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { agentDir, agentExists, listAgentIds, readAgent, trashAgent, writeAgent } from "../src/mastra/lib/store.ts";
import { addAgent, agentConfig, emptyHome, snapshot } from "./helpers/agent-home.ts";

describe("agent ids", () => {
  it("only lowercase slugs address a folder; anything else throws before a file is touched", () => {
    const p = emptyHome();
    for (const bad of ["..", "../x", ".trash", "_drafts", "A", "a/b", "a\\b", "", "x".repeat(33), "%2e%2e"]) {
      expect(() => agentDir(p, bad), bad).toThrow(/invalid agent id/);
      expect(() => readAgent(p, bad), bad).toThrow(/invalid agent id/);
      expect(() => writeAgent(p, bad, { config: {} }), bad).toThrow(/invalid agent id/);
      expect(() => trashAgent(p, bad), bad).toThrow(/invalid agent id/);
    }
  });

  it("lists real agent folders only: no dot or underscore folders, no symlinks, no invalid names", () => {
    const p = emptyHome();
    addAgent(p, "alpha");
    mkdirSync(join(p.agentsDir, "_drafts"));
    mkdirSync(join(p.agentsDir, "Not An Id"));
    mkdirSync(p.trashDir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "eigen-outside-"));
    writeFileSync(join(outside, "config.json"), JSON.stringify(agentConfig("linked")));
    symlinkSync(outside, join(p.agentsDir, "linked"));
    expect(listAgentIds(p)).toEqual(["alpha"]);
    // Addressed directly, a symlinked folder is not an agent either.
    expect(readAgent(p, "linked")).toBeUndefined();
    expect(agentExists(p, "linked")).toBe(false);
    expect(writeAgent(p, "linked", { config: agentConfig("linked") }).status).toBe(404);
    expect(trashAgent(p, "linked").status).toBe(404);
  });
});

describe("instruction files", () => {
  it("create and write refuse a file outside the folder (400) and touch nothing", () => {
    const p = emptyHome();
    addAgent(p, "helper");
    const other = addAgent(p, "other", {}, { instructions: "Other's prompt.\n" });
    const before = snapshot(p.home);
    for (const file of ["../other/instructions.md", "../../x.md", "/etc/hosts.md", "notes/role.md", ".env", "config.json"]) {
      const w = writeAgent(p, "helper", { config: agentConfig("helper", { instructions: { file } }), instructionsText: "pwned" });
      expect(w.status, file).toBe(400);
    }
    expect(snapshot(p.home)).toEqual(before);
    expect(readFileSync(join(other.dir, "instructions.md"), "utf8")).toBe("Other's prompt.\n");
  });

  it("reading never follows an escaping or symlinked instructions file", () => {
    const p = emptyHome();
    const other = addAgent(p, "other", {}, { instructions: "secret prompt" });
    const a = addAgent(p, "helper", {}, { raw: JSON.stringify(agentConfig("helper", { instructions: { file: "../other/instructions.md" } })) });
    expect(readAgent(p, "helper")!.instructionsText).toBeNull();
    symlinkSync(join(other.dir, "instructions.md"), join(a.dir, "linked.md"));
    writeFileSync(a.configFile, JSON.stringify(agentConfig("helper", { instructions: { file: "linked.md" } })));
    expect(readAgent(p, "helper")!.instructionsText).toBeNull();
    // ... and writing through it is refused, so the other agent's prompt stays as it was.
    expect(writeAgent(p, "helper", { config: agentConfig("helper", { instructions: { file: "linked.md" } }), instructionsText: "pwned" }).status).toBe(400);
    expect(readFileSync(join(other.dir, "instructions.md"), "utf8")).toBe("secret prompt");
  });

  it("an inline prompt needs no file", () => {
    const p = emptyHome();
    const a = addAgent(p, "helper");
    expect(writeAgent(p, "helper", { config: agentConfig("helper", { instructions: { inline: "Be brief." } }) }).status).toBe(200);
    expect(existsSync(agentPaths(p, "helper").configFile) && existsSync(a.dir)).toBe(true);
  });
});
