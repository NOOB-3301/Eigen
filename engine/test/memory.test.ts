import { existsSync } from "node:fs";
import { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentMemory } from "../src/mastra/lib/memory.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

/** A real agent on its own memory.db, with a fake model and fake embeddings. */
async function memoryAgent(memory: AgentConfigInput["memory"]) {
  const llm = await fakeLlm([{ text: "noted" }]);
  closers.push(llm.close);
  const t = tmpAgent({
    models: { main: { id: "fake/model", url: llm.url } },
    memory: { ...memory, semanticRecall: { embedder: { id: "fake/embed", url: llm.url }, ...memory?.semanticRecall } },
  });
  const mem = makeAgentMemory(t.r, t.paths, new Map());
  if (mem) closers.push(mem.close);
  const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, ...(mem && { memory: mem.memory }) });
  const say = (text: string, thread = "t1", resource = "telegram:7") => agent.generate(text, { memory: { thread, resource } });
  const lastRequest = () => JSON.stringify(llm.requests.at(-1));
  return { llm, say, lastRequest, t, mem };
}

describe("an agent's memory (real agent, fake model + embeddings)", () => {
  const recall = { lastMessages: { count: 1 }, semanticRecall: { enabled: true, topK: 1, messageRange: 1 } };

  it("offers working memory with its template and embeds messages for recall", async () => {
    const { llm, say } = await memoryAgent({ ...recall, workingMemory: { template: "# Pet facts\n- Pet name:\n" } });
    await say("my favourite fruit is mango pudding");
    expect(llm.requests[0]!.tools!.map((t) => t.function.name)).toContain("updateWorkingMemory");
    expect(JSON.stringify(llm.requests[0])).toContain("# Pet facts");
    expect(llm.embeddings.join("\n")).toContain("mango pudding");
  });

  it("recalls an old message by meaning even when it is outside the recent window", async () => {
    const { say, lastRequest } = await memoryAgent(recall);
    await say("my favourite fruit is mango pudding");
    await say("it rained a lot today");
    await say("then we talked about cars");
    await say("what pudding fruit do i like");
    expect(lastRequest()).toContain("mango");
  });

  it("resource scope recalls across threads for the same user; thread scope does not", async () => {
    const resource = await memoryAgent(recall);
    await resource.say("my favourite fruit is mango pudding", "t1");
    await resource.say("hello there", "t2");
    await resource.say("what pudding fruit do i like", "t2");
    expect(resource.lastRequest()).toContain("mango");

    const thread = await memoryAgent({ ...recall, semanticRecall: { ...recall.semanticRecall, scope: "thread" } });
    await thread.say("my favourite fruit is papaya crumble", "t1");
    await thread.say("hello there", "t2");
    await thread.say("what crumble fruit do i like", "t2");
    expect(thread.lastRequest()).not.toContain("papaya");
  });

  it("stores everything in this agent's own memory.db", async () => {
    const { say, mem, t } = await memoryAgent({});
    await say("hello");
    expect(existsSync(t.paths.memoryDbFile)).toBe(true);
    const store = (await mem!.memory.storage.getStore("memory"))!;
    expect((await store.listThreads({ filter: { resourceId: "telegram:7" } })).threads).toHaveLength(1);
  });
});
