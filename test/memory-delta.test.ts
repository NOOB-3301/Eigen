import { join } from "node:path";
import { LibSQLStore } from "@mastra/libsql";
import { describe, expect, it } from "vitest";
import { messagesSince } from "../src/mastra/lib/memory-delta.ts";
import { tmpHome } from "./helpers/home.ts";

type Part = { type: string; [k: string]: unknown };

async function seed() {
  const p = tmpHome();
  const storage = new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "t.db")}` });
  await storage.init();
  const mem = (await storage.getStore("memory"))!;
  const thread = (id: string) => mem.saveThread({ thread: { id, resourceId: "telegram:7", title: id, createdAt: new Date(), updatedAt: new Date(), metadata: {} } });
  const msg = (id: string, threadId: string, role: string, iso: string, parts: Part[]) => ({
    id,
    threadId,
    resourceId: "telegram:7",
    role,
    createdAt: new Date(iso),
    content: { format: 2 as const, parts },
  });
  return { storage, mem, thread, msg };
}

describe("messagesSince", () => {
  it("returns user/assistant text across threads, oldest first, after the cutoff", async () => {
    const { storage, mem, thread, msg } = await seed();
    await thread("a");
    await thread("b");
    await mem.saveMessages({
      messages: [
        msg("1", "a", "user", "2026-10-01T09:00:00Z", [{ type: "text", text: "old" }]),
        msg("2", "a", "user", "2026-10-02T09:00:00Z", [{ type: "text", text: "second day question" }]),
        msg("3", "b", "assistant", "2026-10-02T09:05:00Z", [{ type: "text", text: "an answer" }, { type: "tool-invocation", toolInvocation: { toolName: "bash" } }]),
        msg("4", "a", "user", "2026-10-02T08:00:00Z", [{ type: "text", text: "earlier that day" }]),
      ] as never,
    });
    const rows = await messagesSince(storage, new Date("2026-10-01T12:00:00Z"));
    expect(rows.map((r) => r.text)).toEqual(["earlier that day", "second day question", "an answer [used bash]"]);
    expect(rows.map((r) => r.role)).toEqual(["user", "user", "assistant"]);
  });

  it("is exclusive of the cutoff itself, so the same message is never folded in twice", async () => {
    const { storage, mem, thread, msg } = await seed();
    await thread("a");
    await mem.saveMessages({ messages: [msg("1", "a", "user", "2026-10-02T09:00:00Z", [{ type: "text", text: "once" }])] as never });
    expect(await messagesSince(storage, new Date("2026-10-02T09:00:00Z"))).toEqual([]);
    expect(await messagesSince(storage, new Date("2026-10-02T08:59:59Z"))).toHaveLength(1);
  });

  it("returns nothing for an empty store", async () => {
    const { storage } = await seed();
    expect(await messagesSince(storage, new Date(0))).toEqual([]);
  });
});
