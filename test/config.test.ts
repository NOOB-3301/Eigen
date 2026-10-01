import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootProblems, loadConfig, parseConfig, resolveEnvRefs, tokenBudget, toMastraModel } from "../src/mastra/lib/config.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";

const example = () => JSON.parse(readFileSync(`${DEFAULTS}/config.example.json`, "utf8"));

describe("config", () => {
  it("accepts the shipped example and fills defaults", () => {
    const c = parseConfig(example());
    expect(c.limits.maxSteps).toBe(25);
    expect(c.sandbox.allowNetwork).toBe(true);
    expect(c.memory.lastMessages).toBe(20);
    expect(c.timezone).toBeTruthy();
  });

  it("rejects bad model ids and dangling model references", () => {
    expect(() => parseConfig({ ...example(), models: { local: { id: "nope" } } })).toThrow(/provider\/model/);
    expect(() => parseConfig({ ...example(), defaultModel: "ghost" })).toThrow(/models/);
    expect(() => parseConfig({ ...example(), curatorModel: "ghost" })).toThrow(/models/);
  });

  it("names the fix when config.json is missing", () => {
    expect(() => loadConfig("/nowhere/config.json")).toThrow(/npm run setup/);
    expect(loadConfig(tmpHome().configFile).defaultModel).toBe("local");
  });

  it("boot problems: empty allowlist and missing token", () => {
    const c = parseConfig(example());
    expect(bootProblems(c, {})).toHaveLength(2);
    const ok = parseConfig({ ...example(), telegram: { allowedUserIds: [1] } });
    expect(bootProblems(ok, { TELEGRAM_BOT_TOKEN: "t" })).toEqual([]);
  });

  it("resolves env: refs", () => {
    expect(resolveEnvRefs({ A: "env:X", B: "plain", C: "env:MISSING" }, { X: "secret" })).toEqual({ A: "secret", B: "plain", C: "" });
    expect(resolveEnvRefs(undefined)).toBeUndefined();
  });

  it("maps model entries to Mastra model configs", () => {
    const c = parseConfig(example());
    expect(toMastraModel(c.models.cloud!)).toBe("anthropic/claude-sonnet-5-5");
    expect(toMastraModel(c.models.local!)).toMatchObject({ id: "ollama/gemma4:e4b", url: "http://localhost:11434/v1" });
    expect(tokenBudget(c.models.local!)).toBe(28000 - 4096);
    expect(tokenBudget(c.models.cloud!)).toBeUndefined();
  });

  it("validates MCP servers (stdio or remote)", () => {
    const c = parseConfig({ ...example(), mcpServers: { fs: { command: "npx", args: ["x"] }, web: { url: "https://e.com/mcp" } } });
    expect(c.mcpServers.fs).toMatchObject({ enabled: true, trusted: false });
    expect(() => parseConfig({ ...example(), mcpServers: { bad: { args: [] } } })).toThrow();
  });
});
