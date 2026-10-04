import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgentFactory, type BuiltAgent } from "../src/mastra/lib/factory.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { patchState } from "../src/mastra/lib/state.ts";
import { tmpAgent, testContext } from "./helpers/agent-folder.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const factory = makeAgentFactory({ isolation: "none", builtinSkills: undefined });
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((c) => c()));
});

async function setup(patch: (url: string) => Partial<AgentConfigInput> = () => ({}), env: Record<string, string> = {}) {
  const llm = await fakeLlm([{ text: "hello from the fake model" }]);
  cleanup.push(llm.close);
  const t = tmpAgent(patch(llm.url));
  const { ctx, logs } = testContext(t.paths, env);
  const built = await factory(t.r, ctx);
  cleanup.push(built.dispose);
  const system = () => JSON.stringify(llm.requests.at(-1)?.messages.filter((m) => m.role === "system"));
  return { ...t, llm, built, logs, system, say: (text: string) => built.agent.generate(text, { memory: { thread: "t1", resource: "user-1" } }) };
}

const local = (url: string, extra: Record<string, unknown> = {}) => ({ models: { main: { id: "fake/model", url, ...extra } } });

describe("defaultAgentFactory", () => {
  it("builds an agent from its folder that answers with its model", async () => {
    const t = await setup((url) => local(url));
    expect(t.built.agent.id).toBe("a");
    expect((await t.say("hi")).text).toBe("hello from the fake model");
    expect(t.system()).toContain("You are a test agent.");
  });

  it("re-reads the role and the soul every turn", async () => {
    const t = await setup((url) => ({ ...local(url), soul: { enabled: true } }));
    writeFileSync(join(t.paths.dir, "soul.md"), "Speaks like a pirate.");
    await t.say("one");
    expect(t.system()).toContain("Speaks like a pirate.");
    writeFileSync(join(t.paths.dir, "instructions.md"), "You are now a librarian.");
    writeFileSync(join(t.paths.dir, "soul.md"), "Whispers.");
    await t.say("two");
    expect(t.system()).toContain("You are now a librarian.");
    expect(t.system()).toContain("Whispers.");
    expect(t.system()).not.toContain("pirate");
  });

  it("sends the key from the agent's .env, never the one in process.env", async () => {
    vi.stubEnv("FAKE_KEY", "key-from-the-shell");
    const t = await setup((url) => local(url, { apiKeyEnv: "FAKE_KEY" }), { FAKE_KEY: "key-from-this-agent" });
    await t.say("hi");
    expect(t.llm.authorizations.at(-1)).toBe("Bearer key-from-this-agent");
  });

  it("a local model without a key sends none, even when the shell has one", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shell");
    const t = await setup((url) => local(url));
    await t.say("hi");
    expect(t.llm.authorizations.every((a) => !a.includes("sk-shell"))).toBe(true);
  });

  it("fails clearly when a key the agent needs is not in its .env (the shell's does not count)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-shell");
    const t = tmpAgent({ models: { main: { id: "anthropic/claude-sonnet-4-5" } } });
    await expect(factory(t.r, testContext(t.paths).ctx)).rejects.toThrow(/ANTHROPIC_API_KEY is not set in this agent's keys/);
  });

  it("switches to the model chosen with /model on the next turn, and back when the choice is gone", async () => {
    const t = await setup((url) => ({ models: { main: { id: "fake/main", url }, alt: { id: "fake/alt", url } } }));
    await t.say("one");
    expect(t.llm.requests.at(-1)?.model).toBe("main");
    patchState(t.paths.stateFile, { model: "alt" });
    await t.say("two");
    expect(t.llm.requests.at(-1)?.model).toBe("alt");
    patchState(t.paths.stateFile, { model: "deleted" });
    await t.say("three");
    expect(t.llm.requests.at(-1)?.model).toBe("main");
  });

  it("storage off: the agent has no memory at all", async () => {
    const t = await setup((url) => ({ ...local(url), memory: { storage: { enabled: false }, lastMessages: { enabled: false }, workingMemory: { enabled: false } } }));
    expect(await t.built.agent.getMemory()).toBeUndefined();
    expect((await t.say("hi")).text).toBe("hello from the fake model");
  });

  it("keeps memory in the agent's own memory.db, and dispose closes it", async () => {
    const t = await setup((url) => local(url));
    await t.say("remember the mango");
    const memory = (await t.built.agent.getMemory())!;
    const store = (await memory.storage.getStore("memory"))!;
    expect((await store.listThreads({ filter: { resourceId: "user-1" } })).threads.map((th) => th.id)).toEqual(["t1"]);
    await t.built.dispose();
    await expect(store.listThreads({ filter: { resourceId: "user-1" } })).rejects.toThrow();
  });

  it("gives the agent only the built-in tools it asked for", async () => {
    const tools = async (builtin: Array<"workspace" | "schedule">) => {
      const t = await setup((url) => ({ ...local(url), tools: { builtin } }));
      return { tools: Object.keys(await t.built.agent.listTools()), workspace: await t.built.agent.getWorkspace(), refresh: t.built.refreshSkills };
    };
    const none = await tools([]);
    expect(none.tools).toEqual([]);
    expect(none.workspace).toBeUndefined();
    expect(none.refresh).toBeUndefined();
    const both = await tools(["workspace", "schedule"]);
    expect(both.tools).toContain("schedule");
    expect(both.workspace).toBeDefined();
    expect(both.refresh).toBeTypeOf("function");
  });

  it("reports an MCP server that fails to start, and still builds", async () => {
    const t = await setup((url) => ({ ...local(url), tools: { builtin: [], mcp: { broken: { command: "/nonexistent/mcp-server" } }, mcpStartupTimeoutMs: 5000 } }));
    expect(Object.keys(t.built.mcpErrors ?? {})).toEqual(["broken"]);
  });

  it("builds no bot without a token, and one (not polling yet) with a token and allow-list", async () => {
    const llm = await fakeLlm([{ text: "x" }]);
    cleanup.push(llm.close);
    const t = tmpAgent({ ...local(llm.url), telegram: { enabled: true, allowedUserIds: [7] } });
    const without: BuiltAgent = await factory(t.r, testContext(t.paths).ctx);
    cleanup.push(without.dispose);
    expect(without.telegram).toBeUndefined();
    const withBot = await factory(t.r, testContext(t.paths, {}, { telegramToken: "123:abc" }).ctx);
    cleanup.push(withBot.dispose);
    expect(withBot.telegram?.state().state).toBe("starting");
    await withBot.dispose();
    expect(withBot.telegram?.state().state).toBe("starting"); // stopped bots keep their last state and never poll
  });
});
