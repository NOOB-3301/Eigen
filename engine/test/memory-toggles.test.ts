import { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentMemory, observationalOptions } from "../src/mastra/lib/memory.ts";
import { AgentConfigSchema, resolveAgent, type AgentConfigInput, type ResolvedAgent } from "../src/mastra/lib/schema.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const LOCAL = "http://127.0.0.1:9/v1";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const models = { main: { id: "fake/main", url: LOCAL }, small: { id: "fake/small", url: LOCAL }, cloud: { id: "anthropic/claude-x" } };
const embedder = { id: "fake/embed", url: LOCAL };

/** What Mastra received for these memory settings: the merged options and the built Memory. */
function built(memory: AgentConfigInput["memory"], env: Record<string, string> = {}) {
  const t = tmpAgent({ models, memory: { ...memory, semanticRecall: { embedder, ...memory?.semanticRecall } } });
  const mem = makeAgentMemory(t.r, t.paths, new Map(Object.entries(env)));
  if (mem) closers.push(mem.close);
  return { t, mem, opts: mem?.memory.getMergedThreadConfig({}) };
}

/** A resolved agent that skips the schema's cross-checks, to show the builder does not rely on them. */
const raw = (memory: Record<string, unknown>): ResolvedAgent => {
  const r = resolveAgent(AgentConfigSchema.parse({ id: "a", name: "a", models, model: "main" }), "UTC");
  return { ...r, memory: { ...r.memory, ...memory } as ResolvedAgent["memory"] };
};

describe("each memory switch reaches Mastra's options", () => {
  it("storage off: no Memory at all", () => {
    const off = { enabled: false };
    expect(built({ storage: off, lastMessages: off, workingMemory: off }).mem).toBeUndefined();
  });

  it("lastMessages: off is Mastra's false; on is the count", () => {
    expect(built({ lastMessages: { enabled: false } }).opts?.lastMessages).toBe(false);
    expect(built({ lastMessages: { count: 7 } }).opts?.lastMessages).toBe(7);
    expect(built({}).opts?.lastMessages).toBe(20);
  });

  it("working memory: template and scope reach Mastra; off is off", () => {
    const on = built({ workingMemory: { scope: "thread", template: "# Garden\n- Plants:\n" } }).opts?.workingMemory;
    expect(on).toMatchObject({ enabled: true, scope: "thread", template: "# Garden\n- Plants:\n" });
    expect(built({ workingMemory: { enabled: false } }).opts?.workingMemory).toMatchObject({ enabled: false });
  });

  it("semantic recall off builds no vector store and no embedder; on builds both with its topK, range and scope", () => {
    const off = built({});
    expect(off.opts?.semanticRecall).toBe(false);
    expect(off.mem?.memory.vector).toBeUndefined();
    expect(off.mem?.memory.embedder).toBeUndefined();
    const on = built({ semanticRecall: { enabled: true, topK: 3, messageRange: 1, scope: "thread" } });
    expect(on.opts?.semanticRecall).toMatchObject({ topK: 3, messageRange: 1, scope: "thread" });
    expect(on.mem?.memory.vector).toBeDefined();
    expect(on.mem?.memory.embedder).toBeDefined();
  });

  it("observational: off builds no Observer; on uses its own model key, else the agent's model", () => {
    expect(built({}).opts?.observationalMemory).toBeFalsy();
    const own = observationalOptions(raw({ observational: { ...raw({}).memory.observational, enabled: true, model: "small" } }), new Map());
    expect(own?.model).toMatchObject({ id: "fake/small" });
    const dflt = observationalOptions(raw({ observational: { ...raw({}).memory.observational, enabled: true } }), new Map());
    expect(dflt?.model).toMatchObject({ id: "fake/main" });
    expect(built({ observational: { enabled: true } }).opts?.observationalMemory).toBeTruthy();
  });

  it("subconscious only with semantic recall AND observational on", () => {
    const base = raw({}).memory;
    const sub = { ...base.subconscious, enabled: true };
    const obs = { ...base.observational, enabled: true };
    expect(observationalOptions(raw({ subconscious: sub, observational: obs }), new Map())).not.toHaveProperty("experimental_subconscious");
    expect(observationalOptions(raw({ subconscious: sub, observational: obs, semanticRecall: { ...base.semanticRecall, enabled: true } }), new Map())).toHaveProperty("experimental_subconscious");
    expect(observationalOptions(raw({ subconscious: sub, semanticRecall: { ...base.semanticRecall, enabled: true } }), new Map())).toBeUndefined();
  });

  it("a model key the memory needs must be in the agent's .env, or the memory is not built", () => {
    expect(() => built({ observational: { enabled: true, model: "cloud" } })).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(built({ observational: { enabled: true, model: "cloud" } }, { ANTHROPIC_API_KEY: "sk" }).opts?.observationalMemory).toBeTruthy();
  });

  it("each switch is independent of the others", () => {
    const { opts } = built({ lastMessages: { enabled: false }, workingMemory: { enabled: false }, semanticRecall: { enabled: true } });
    expect(opts).toMatchObject({ lastMessages: false, workingMemory: { enabled: false } });
    expect(opts?.semanticRecall).toMatchObject({ topK: 4 });
  });
});

describe("close() releases the database", () => {
  it("closes the store and the vector store; a closed store refuses queries", async () => {
    const { mem } = built({ semanticRecall: { enabled: true } });
    const store = (await mem!.memory.storage.getStore("memory"))!;
    await store.listThreads({ filter: { resourceId: "x" } });
    await mem!.close();
    await expect(store.listThreads({ filter: { resourceId: "x" } })).rejects.toThrow();
    await mem!.close(); // twice is fine
  });
});

describe("what the model actually sees (real agent, fake model)", () => {
  async function setup(memory: AgentConfigInput["memory"]) {
    const llm = await fakeLlm([{ text: "noted" }]);
    closers.push(llm.close);
    const t = tmpAgent({ models: { main: { id: "fake/model", url: llm.url } }, memory });
    const mem = makeAgentMemory(t.r, t.paths, new Map())!;
    closers.push(mem.close);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, memory: mem.memory });
    return {
      say: (text: string) => agent.generate(text, { memory: { thread: "t1", resource: "user-1" } }),
      saw: (text: string) => JSON.stringify(llm.requests.at(-1)).includes(text),
      llm,
    };
  }

  it("lastMessages off: the next turn does not carry the earlier one; on: it does", async () => {
    const on = await setup({});
    await on.say("my favourite fruit is mango pudding");
    await on.say("what did I just say");
    expect(on.saw("mango pudding")).toBe(true);

    const off = await setup({ lastMessages: { enabled: false } });
    await off.say("my favourite fruit is mango pudding");
    await off.say("what did I just say");
    expect(off.saw("mango pudding")).toBe(false);
  });

  it("working memory off: the model gets no working-memory tool", async () => {
    const off = await setup({ workingMemory: { enabled: false } });
    await off.say("hi");
    expect((off.llm.requests[0]!.tools ?? []).map((t) => t.function.name)).not.toContain("updateWorkingMemory");
  });
});
