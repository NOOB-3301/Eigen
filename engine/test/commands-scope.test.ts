import { describe, expect, it } from "vitest";
import { makeChatQueue } from "../src/mastra/lib/chat-queue.ts";
import { slashHandler } from "../src/mastra/lib/commands.ts";
import { readState } from "../src/mastra/lib/state.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { tmpHome } from "./helpers/home.ts";

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

async function run(command: string, { agentId, restricted, threads = [] as Thread[] }: { agentId: string; restricted?: boolean; threads?: Thread[] }) {
  const { mastra, archived } = fakeMastra(threads);
  const p = tmpHome();
  const posts: string[] = [];
  const handler = slashHandler({ paths: p, mcp: {} as Mcp, queue: makeChatQueue(), agentId, restricted });
  const event = { command, text: "", adapter: { isDM: () => true }, channel: { id: "7", post: async (t: string) => void posts.push(t) } };
  await handler(event as never, async () => undefined, { mastra } as never);
  return { posts, archived, p };
}

const threads: Thread[] = [
  { id: "primary-thread", createdAt: 20, metadata: { ...base, channel_ownerId: "eigen" } },
  { id: "researcher-thread", createdAt: 10, metadata: { ...base, channel_ownerId: "researcher" } },
];

describe("/new only touches the conversation of the bot it was typed on", () => {
  it("a specialist's /new archives its own thread, not the primary's newer one", async () => {
    const r = await run("/new", { agentId: "researcher", restricted: true, threads });
    expect(r.archived).toEqual(["researcher-thread"]);
  });
  it("the primary's /new archives the primary's thread", async () => {
    expect((await run("/new", { agentId: "eigen", threads })).archived).toEqual(["primary-thread"]);
  });
  it("a specialist with no conversation yet does not archive somebody else's", async () => {
    const r = await run("/new", { agentId: "writer", restricted: true, threads });
    expect(r.archived).toEqual([]);
    expect(r.posts).toEqual(["Already fresh."]);
  });
  it("a thread from before threads were stamped with an owner still belongs to whoever asks", async () => {
    const legacy: Thread[] = [{ id: "old-thread", createdAt: 1, metadata: { ...base } }];
    expect((await run("/new", { agentId: "eigen", threads: legacy })).archived).toEqual(["old-thread"]);
  });
});

describe("a specialist's own bot gets only the harmless commands", () => {
  it("/help lists status, stop and new; the main bot lists everything", async () => {
    const restricted = (await run("/help", { agentId: "researcher", restricted: true })).posts[0]!;
    for (const c of ["/status", "/stop", "/new", "/help"]) expect(restricted).toContain(c);
    for (const c of ["/model", "/verbose", "/reload", "/reload_mcp", "/consolidate"]) expect(restricted, c).not.toContain(c);
    const full = (await run("/help", { agentId: "eigen" })).posts[0]!;
    for (const c of ["/model", "/verbose", "/reload_mcp", "/consolidate"]) expect(full, c).toContain(c);
  });

  it("refuses the global ones without running them", async () => {
    for (const c of ["/model cloud", "/verbose on", "/reload", "/reload_mcp", "/consolidate"]) {
      const r = await run(c.split(" ")[0]!, { agentId: "researcher", restricted: true });
      expect(r.posts, c).toEqual([`${c.split(" ")[0]} is only available on the main bot.`]);
      expect(readState(r.p), c).toEqual({});
    }
  });

  it("unknown commands still say so", async () => {
    expect((await run("/nope", { agentId: "researcher", restricted: true })).posts).toEqual(["Unknown command /nope. Try /help."]);
  });
});
