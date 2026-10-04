import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { scanAgentDir } from "../src/mastra/lib/agents.ts";
import { parseConfig, toMastraModel, type Config } from "../src/mastra/lib/config.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import { liveMemory, makeMemory } from "../src/mastra/lib/memory.ts";
import { AgentConfigSchema, resolveAgent, type AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";

const example = JSON.parse(readFileSync(`${DEFAULTS}/config.example.json`, "utf8"));

/** The root config with memory overrides, as the studio's root editor would leave it. */
const rootWith = (llmUrl: string | undefined, memory: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Config =>
  parseConfig({
    ...example,
    models: { local: { id: "fake/model", url: llmUrl ?? "http://localhost:11434/v1" }, small: { id: "fake/small", url: llmUrl } },
    defaultModel: "local",
    curatorModel: undefined,
    ...rest,
    memory: { ...example.memory, embedder: { id: "fake/embed", url: llmUrl ?? "http://localhost:11434/v1" }, ...memory },
  });

/** The memory an agent with these overrides ends up with (what the factory hands to makeMemory). */
const effective = (root: Config, memory: AgentConfigInput["memory"]): Config => {
  const agent = AgentConfigSchema.parse({ id: "a", name: "a", role: "r", description: "d", memory });
  return { ...root, memory: resolveAgent(agent, root).memory };
};

/** What Mastra actually received: the merged options of the built Memory. */
const options = (p: HomePaths, cfg: Config) => {
  const memory = makeMemory(p, cfg);
  return { memory, opts: memory.getMergedThreadConfig({}) };
};

describe("memory options built from the switches", () => {
  it("lastMessages 0 turns the recent history off (Mastra's false); a number is kept", () => {
    const p = tmpHome();
    const root = rootWith(undefined);
    expect(options(p, effective(root, { lastMessages: 0 })).opts.lastMessages).toBe(false);
    expect(options(p, effective(root, { lastMessages: 7 })).opts.lastMessages).toBe(7);
    expect(options(p, effective(root, {})).opts.lastMessages).toBe(20); // the root default
  });

  it("semantic recall off builds no vector store and no embedder; on builds both", () => {
    const p = tmpHome();
    const root = rootWith(undefined);
    const off = options(p, effective(root, { semanticRecall: { enabled: false } }));
    expect(off.opts.semanticRecall).toBe(false);
    expect(off.memory.vector).toBeUndefined();
    expect(off.memory.embedder).toBeUndefined();

    const on = options(p, effective(root, {}));
    expect(on.opts.semanticRecall).toMatchObject({ topK: 4, messageRange: 2, scope: "resource" });
    expect(on.memory.vector).toBeDefined();
    expect(on.memory.embedder).toBeDefined();
  });

  it("observational off builds no Observer even when the root turned it on; on builds one", () => {
    const p = tmpHome();
    const root = rootWith(undefined, { observational: { enabled: true } });
    expect(options(p, effective(root, { observational: { enabled: false } })).opts.observationalMemory).toBeFalsy();
    expect(options(p, effective(root, {})).opts.observationalMemory).toBeTruthy();
    expect(options(p, effective(rootWith(undefined), { observational: { enabled: true } })).opts.observationalMemory).toBeTruthy();
  });

  it("an agent that turns semantic recall off still builds when the root enabled knowledge (it needs the vector store)", () => {
    const p = tmpHome();
    const root = rootWith(undefined, { observational: { enabled: true }, knowledge: { enabled: true } });
    const shared = effective(root, { scope: "shared", semanticRecall: { enabled: false } });
    expect(shared.memory.knowledge.enabled).toBe(true);
    expect(() => makeMemory(p, shared)).not.toThrow();
    expect(() => makeMemory(p, effective(root, { scope: "shared" }))).not.toThrow();
  });

  it("each switch is independent of the other two", () => {
    const p = tmpHome();
    const root = rootWith(undefined, { observational: { enabled: true } });
    const { opts } = options(p, effective(root, { lastMessages: 0, semanticRecall: { enabled: false }, observational: { enabled: false } }));
    expect(opts).toMatchObject({ lastMessages: false, semanticRecall: false });
    expect(opts.observationalMemory).toBeFalsy();
    expect(opts.workingMemory).toMatchObject({ enabled: true }); // working memory is not one of the switches
  });
});

describe("toggling a memory switch reloads the agent", () => {
  function scan(memory: AgentConfigInput["memory"]) {
    const p = tmpHome();
    const dir = join(p.agentsDir, "a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "instructions.md"), "x");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ id: "a", name: "a", role: "r", description: "d", memory }));
    return scanAgentDir(dir, rootWith(undefined)).hash;
  }

  it("changes the version hash for each switch, and leaves it alone for the same config", () => {
    const base = scan({});
    expect(base).toBeDefined();
    expect(scan({})).toBe(base);
    const variants = [{ lastMessages: 0 }, { semanticRecall: { enabled: false } }, { observational: { enabled: true } }, { lastMessages: 5 }];
    const hashes = variants.map((v) => scan(v));
    expect(hashes).not.toContain(base);
    expect(new Set(hashes).size).toBe(variants.length);
  });
});

describe("what the model actually sees (real agent, fake model and embeddings)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  /** An agent whose memory follows `override` (an agent's own memory settings over the root's). */
  async function setup(override: AgentConfigInput["memory"]) {
    const p = tmpHome();
    const llm = await fakeLlm([{ text: "noted" }]);
    closers.push(llm.close);
    const root = rootWith(llm.url);
    let current = effective(root, override);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: toMastraModel(root.models.local!), memory: liveMemory(p, () => current) });
    const mastra = new Mastra({ agents: { t: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "t.db")}` }) });
    return {
      llm,
      say: (text: string) => mastra.getAgent("t").generate(text, { memory: { thread: "t1", resource: "user-1" } }),
      /** Did the last request to the model contain this text (anywhere: history, recall, working memory)? */
      saw: (text: string) => JSON.stringify(llm.requests.at(-1)).includes(text),
      retune: (next: AgentConfigInput["memory"]) => void (current = effective(root, next)),
    };
  }

  it("lastMessages 0: the next turn does not carry the earlier one; with history on it does", async () => {
    const on = await setup({ semanticRecall: { enabled: false } });
    await on.say("my favourite fruit is mango pudding");
    await on.say("what did I just say");
    expect(on.saw("mango pudding")).toBe(true);

    const off = await setup({ lastMessages: 0, semanticRecall: { enabled: false } });
    await off.say("my favourite fruit is mango pudding");
    await off.say("what did I just say");
    expect(off.saw("mango pudding")).toBe(false);
  });

  it("flipping lastMessages on a running agent takes effect on its next message, with no rebuild of the agent", async () => {
    const t = await setup({ lastMessages: 0, semanticRecall: { enabled: false } });
    await t.say("my favourite fruit is mango pudding");
    await t.say("what did I just say");
    expect(t.saw("mango pudding")).toBe(false);

    t.retune({ semanticRecall: { enabled: false } });
    await t.say("my favourite colour is teal");
    await t.say("what did I just say");
    expect(t.saw("teal")).toBe(true);

    t.retune({ lastMessages: 0, semanticRecall: { enabled: false } });
    await t.say("and now?");
    expect(t.saw("teal")).toBe(false);
  });

  it("with history off Mastra stores no messages, so semantic recall has nothing to find (the studio should say so)", async () => {
    const recall = { topK: 1, messageRange: 1 };
    const on = await setup({ lastMessages: 1, semanticRecall: recall });
    const off = await setup({ lastMessages: 0, semanticRecall: recall });
    for (const t of [on, off]) {
      await t.say("my favourite fruit is mango pudding");
      await t.say("it rained a lot today");
      await t.say("then we talked about cars");
      await t.say("what pudding fruit do i like");
    }
    expect(on.saw("mango pudding")).toBe(true); // recalled from outside the one-message window
    expect(off.saw("mango pudding")).toBe(false);
  });

  it("semantic recall off: nothing is embedded; on: the messages are", async () => {
    // Mastra caches embeddings by text for the whole process, so this test uses wording no other test does.
    const off = await setup({ lastMessages: 1, semanticRecall: { enabled: false } });
    await off.say("a zebra casserole is my favourite");
    await off.say("hello again");
    expect(off.llm.embeddings).toEqual([]);

    const on = await setup({ lastMessages: 1, semanticRecall: { topK: 1, messageRange: 1 } });
    await on.say("a zebra casserole is my favourite");
    await on.say("hello again");
    expect(on.llm.embeddings.join("\n")).toContain("zebra casserole");
  });
});

describe("liveMemory", () => {
  it("returns the same Memory until a memory setting changes, then builds a new one", () => {
    const p = tmpHome();
    let root = rootWith(undefined);
    const get = liveMemory(p, () => root);
    const first = get();
    expect(get()).toBe(first);
    root = { ...root, defaultModel: "small" }; // not a memory setting
    expect(get()).toBe(first);
    root = effective(root, { lastMessages: 0 });
    const second = get();
    expect(second).not.toBe(first);
    expect(second.getMergedThreadConfig({}).lastMessages).toBe(false);
    expect(get()).toBe(second);
    root = effective(root, { lastMessages: 5 });
    expect(get().getMergedThreadConfig({}).lastMessages).toBe(5);
  });
});
