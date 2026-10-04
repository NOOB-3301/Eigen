import { describe, expect, it } from "vitest";
import { makeChatQueue } from "../src/mastra/lib/chat-queue.ts";
import { COMMAND_NAMES, slashHandler } from "../src/mastra/lib/commands.ts";
import { readState } from "../src/mastra/lib/state.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

const base = { channel_platform: "telegram", channel_externalThreadId: "7" };
type Thread = { id: string; createdAt: number; metadata: Record<string, unknown> };

/** Just enough Mastra: a memory store that filters threads by metadata, newest first, and an agent whose abort does nothing. */
function fakeMastra(threads: Thread[]) {
  const archived: string[] = [];
  const store = {
    listThreads: async ({ filter, perPage }: { filter: { metadata: Record<string, unknown> }; perPage: number }) => ({
      threads: threads.filter((t) => Object.entries(filter.metadata).every(([k, v]) => t.metadata[k] === v)).sort((a, b) => b.createdAt - a.createdAt).slice(0, perPage),
    }),
    updateThreadMetadata: async ({ id }: { id: string }) => void archived.push(id),
  };
  return { archived, mastra: { getStorage: () => ({ getStore: async () => store }), getAgent: () => ({ abortThreadStream: async () => true }) } };
}

const models = { main: { id: "fake/main", url: "http://x.test/v1" }, alt: { id: "fake/alt", url: "http://x.test/v1" }, cloud: { id: "anthropic/claude-x" } };

async function run(command: string, { agentId = "a", threads = [] as Thread[], env = {} as Record<string, string> } = {}) {
  const { mastra, archived } = fakeMastra(threads);
  const t = tmpAgent({ models }, { id: agentId });
  const posts: string[] = [];
  let reloads = 0;
  const handler = slashHandler({ r: t.r, paths: t.paths, env: new Map(Object.entries(env)), queue: makeChatQueue(), mcp: () => ({ tools: {}, errors: {}, servers: [] }), reload: async () => void reloads++ });
  const [name, ...rest] = command.split(" ");
  const event = { command: name, text: rest.join(" "), adapter: { isDM: () => true }, channel: { id: "7", post: async (s: string) => void posts.push(s) } };
  await handler(event as never, async () => undefined, { mastra } as never);
  return { posts, archived, t, reloads };
}

const threads: Thread[] = [
  { id: "writer-thread", createdAt: 20, metadata: { ...base, channel_ownerId: "writer" } },
  { id: "researcher-thread", createdAt: 10, metadata: { ...base, channel_ownerId: "researcher" } },
];

describe("/new only touches the conversation of the bot it was typed on", () => {
  it("an agent's /new archives its own thread, not another agent's newer one", async () => {
    expect((await run("/new", { agentId: "researcher", threads })).archived).toEqual(["researcher-thread"]);
  });
  it("an agent with no conversation yet does not archive somebody else's", async () => {
    const r = await run("/new", { agentId: "planner", threads });
    expect(r.archived).toEqual([]);
    expect(r.posts).toEqual(["Already fresh."]);
  });
  it("a thread from before threads were stamped with an owner still belongs to whoever asks", async () => {
    const legacy: Thread[] = [{ id: "old-thread", createdAt: 1, metadata: { ...base } }];
    expect((await run("/new", { threads: legacy })).archived).toEqual(["old-thread"]);
  });
});

describe("the commands of one agent's bot", () => {
  it("/help lists this agent's commands and nothing engine-wide", async () => {
    const help = (await run("/help")).posts[0]!;
    for (const c of ["/status", "/stop", "/new", "/model", "/reload", "/verbose", "/help"]) expect(help).toContain(c);
    for (const c of ["/consolidate", "/reload_mcp"]) expect(help, c).not.toContain(c);
    expect(COMMAND_NAMES.sort()).toEqual(["model", "new", "reload", "status", "stop", "verbose"]);
  });

  it("/model lists this agent's models and switches among them, in this agent's state file", async () => {
    expect((await run("/model")).posts[0]).toMatch(/• main \(fake\/main\)[\s\S]*- alt \(fake\/alt\)/);
    const r = await run("/model alt");
    expect(r.posts).toEqual(["Now using alt (fake/alt)."]);
    expect(readState(r.t.paths.stateFile)).toEqual({ model: "alt" });
    expect(readState(r.t.other.stateFile)).toEqual({});
  });

  it("/model refuses a model that is not this agent's, or whose key is not in its .env", async () => {
    expect((await run("/model gpt")).posts).toEqual(['No model called "gpt". Try /model.']);
    expect((await run("/model __proto__")).posts).toEqual(['No model called "__proto__". Try /model.']);
    const r = await run("/model cloud");
    expect(r.posts[0]).toMatch(/Cannot use cloud: ANTHROPIC_API_KEY is not set/);
    expect(readState(r.t.paths.stateFile)).toEqual({});
    expect((await run("/model cloud", { env: { ANTHROPIC_API_KEY: "sk" } })).posts).toEqual(["Now using cloud (anthropic/claude-x)."]);
  });

  it("/reload asks the registry to re-read this agent", async () => {
    const r = await run("/reload");
    expect(r.reloads).toBe(1);
    expect(r.posts[0]).toMatch(/^Reloaded\./);
  });

  it("/verbose toggles in this agent's state", async () => {
    const r = await run("/verbose on");
    expect(r.posts).toEqual(["Verbose on."]);
    expect(readState(r.t.paths.stateFile)).toEqual({ verbose: true });
  });

  it("unknown commands, including object keys, say so", async () => {
    expect((await run("/nope")).posts).toEqual(["Unknown command /nope. Try /help."]);
    expect((await run("/constructor")).posts).toEqual(["Unknown command /constructor. Try /help."]);
  });
});
