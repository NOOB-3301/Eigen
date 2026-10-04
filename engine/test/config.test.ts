import { describe, expect, it } from "vitest";
import { MissingKeyError, tokenBudget, toMastraModel } from "../src/mastra/lib/models.ts";
import { AgentConfigSchema, agentEnvNames, defaultApiKeyEnv, missingKeys, newAgentConfig, referencedEnvNames, resolveAgent, startingAgentConfig } from "../src/mastra/lib/schema.ts";
import { agentConfig } from "./helpers/home.ts";

const parse = (patch: Record<string, unknown> = {}) => AgentConfigSchema.parse(agentConfig("alpha", patch));

describe("agent config (v2)", () => {
  it("fills defaults: memory on with storage, the workspace tool, no bot, no triggers", () => {
    const c = parse();
    expect(c).toMatchObject({ schemaVersion: 2, enabled: true, limits: { maxSteps: 25 }, telegram: { enabled: false, tokenEnv: "TELEGRAM_BOT_TOKEN" }, tools: { builtin: ["workspace"] }, triggers: [] });
    expect(c.memory).toMatchObject({ storage: { enabled: true }, lastMessages: { enabled: true }, workingMemory: { enabled: true }, semanticRecall: { enabled: false } });
    expect(resolveAgent(c, "Asia/Kolkata")).toMatchObject({ modelKey: "main", model: { id: "ollama/test-model" }, timezone: "Asia/Kolkata", maxSteps: 25 });
    expect(AgentConfigSchema.parse(newAgentConfig({ id: "new", name: "New", model: { id: "anthropic/claude-x" } }))).toMatchObject({ model: "main", models: { main: { id: "anthropic/claude-x" } } });
  });

  it("a new agent starts with its model and nothing else connected; a bare config keeps the defaults", () => {
    const model = { id: "anthropic/claude-x" };
    const fresh = AgentConfigSchema.parse(startingAgentConfig({ id: "new", name: "New", model }));
    expect(fresh.memory).toMatchObject({
      storage: { enabled: false },
      lastMessages: { enabled: false },
      workingMemory: { enabled: false },
      semanticRecall: { enabled: false },
      observational: { enabled: false },
      subconscious: { enabled: false },
    });
    expect(fresh).toMatchObject({ model: "main", tools: { builtin: [], mcp: {} }, skills: { enabled: [] }, soul: { enabled: false }, telegram: { enabled: false }, triggers: [] });
    // Only the model's key is ever needed: nothing else is on to ask for one.
    expect([...referencedEnvNames(fresh).keys()]).toEqual(["ANTHROPIC_API_KEY"]);
    // The builder reads a key a config leaves out from this: the schema default, which has not changed.
    expect(AgentConfigSchema.parse(newAgentConfig({ id: "bare", name: "Bare", model })).memory).toMatchObject({ storage: { enabled: true }, lastMessages: { enabled: true } });
  });

  it("rejects dangling model references, memory blocks without storage, and a subconscious without its two inputs", () => {
    expect(() => parse({ model: "ghost" })).toThrow(/models/);
    expect(() => parse({ memory: { storage: { enabled: false } } })).toThrow(/storage/);
    expect(() => parse({ memory: { subconscious: { enabled: true } } })).toThrow(/semantic recall and observational/);
    expect(() => parse({ memory: { storage: { url: "file:/etc/passwd" } } })).toThrow(/remote LibSQL/);
  });
});

describe("keys", () => {
  it("knows each provider's usual variable, and none for a local server", () => {
    expect(defaultApiKeyEnv({ id: "anthropic/claude-x" })).toBe("ANTHROPIC_API_KEY");
    expect(defaultApiKeyEnv({ id: "google/gemini" })).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(defaultApiKeyEnv({ id: "ollama/llama" })).toBeUndefined();
    expect(defaultApiKeyEnv({ id: "openai/x", url: "http://localhost:1234/v1" })).toBeUndefined();
    expect(defaultApiKeyEnv({ id: "openai/x", apiKeyEnv: "MY_KEY" })).toBe("MY_KEY");
  });

  it("lists the variables an agent uses and the ones it cannot think without", () => {
    const c = parse({
      models: { main: { id: "anthropic/claude-x" }, spare: { id: "openai/gpt-x" } },
      telegram: { enabled: true, allowedUserIds: [7] },
      tools: { mcp: { gh: { command: "x", env: { TOKEN: "env:GH_PAT", PLAIN: "x" } } } },
    });
    expect(agentEnvNames(c)).toEqual(["ANTHROPIC_API_KEY", "GH_PAT", "TELEGRAM_BOT_TOKEN"]);
    expect(referencedEnvNames(c).get("GH_PAT")).toEqual(["tools.mcp.gh"]);
    expect(missingKeys(c, () => false)).toEqual(["ANTHROPIC_API_KEY is not set in this agent's keys (models.main)"]);
    expect(missingKeys(c, (n) => n === "ANTHROPIC_API_KEY")).toEqual([]);
  });

  it("toMastraModel passes the agent's key explicitly and never falls back to process.env", () => {
    const env = new Map([["ANTHROPIC_API_KEY", "sk-own"]]);
    expect(toMastraModel({ id: "anthropic/claude-x" }, env)).toEqual({ id: "anthropic/claude-x", apiKey: "sk-own" });
    expect(toMastraModel({ id: "ollama/x", url: "http://localhost:11434/v1" }, new Map())).toEqual({ id: "ollama/x", url: "http://localhost:11434/v1" });
    process.env.OPENAI_API_KEY = "sk-shell";
    try {
      expect(() => toMastraModel({ id: "openai/gpt-x" }, new Map())).toThrow(MissingKeyError);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    expect(tokenBudget({ id: "ollama/x", contextWindow: 28000, replyReserve: 4096 })).toBe(28000 - 4096);
    expect(tokenBudget({ id: "ollama/x", replyReserve: 4096 })).toBeUndefined();
  });
});
