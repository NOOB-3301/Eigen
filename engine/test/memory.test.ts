import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, toMastraModel } from "../src/mastra/lib/config.ts";
import { makeMemory } from "../src/mastra/lib/memory.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";
import { readFileSync } from "node:fs";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function setup() {
  const p = tmpHome();
  const llm = await fakeLlm([{ text: "noted" }]);
  closers.push(llm.close);
  const example = JSON.parse(readFileSync(`${DEFAULTS}/config.example.json`, "utf8"));
  const cfg = parseConfig({
    ...example,
    models: { local: { id: "fake/model", url: llm.url } },
    curatorModel: undefined,
    memory: { lastMessages: 1, semanticRecall: { topK: 1, messageRange: 1 }, embedder: { id: "fake/embed", url: llm.url } },
  });
  const agent = new Agent({ id: "t", name: "t", instructions: "test", model: toMastraModel(cfg.models.local!), memory: makeMemory(p, cfg) });
  const mastra = new Mastra({ agents: { t: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "t.db")}` }) });
  const say = (text: string, thread: string) => mastra.getAgent("t").generate(text, { memory: { thread, resource: "telegram:7" } });
  const lastRequest = () => JSON.stringify(llm.requests.at(-1));
  return { llm, say, lastRequest };
}

describe("mastra memory (real agent, fake model + embeddings)", () => {
  it("offers working memory and embeds messages for recall", async () => {
    const { llm, say } = await setup();
    await say("my favourite fruit is mango pudding", "t1");
    expect(llm.requests[0]!.tools!.map((t) => t.function.name)).toContain("updateWorkingMemory");
    expect(JSON.stringify(llm.requests[0])).toContain("# About the user");
    expect(llm.embeddings.join("\n")).toContain("mango pudding");
  });

  it("recalls an old message by meaning even when it is outside the recent window", async () => {
    const { say, lastRequest } = await setup();
    await say("my favourite fruit is mango pudding", "t1");
    await say("it rained a lot today", "t1");
    await say("then we talked about cars", "t1");
    await say("what pudding fruit do i like", "t1");
    expect(lastRequest()).toContain("mango");
  });

  it("recalls across threads for the same user (resource scope)", async () => {
    const { say, lastRequest } = await setup();
    await say("my favourite fruit is mango pudding", "t1");
    await say("hello there", "t2");
    await say("what pudding fruit do i like", "t2");
    expect(lastRequest()).toContain("mango");
  });
});
