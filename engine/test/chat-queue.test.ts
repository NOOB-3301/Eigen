import { describe, expect, it } from "vitest";
import { makeChatQueue } from "../src/mastra/lib/chat-queue.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chat queue", () => {
  it("runs a chat's jobs one at a time, in order, without blocking the caller", async () => {
    const log: string[] = [];
    const q = makeChatQueue();
    q.push("a", async () => (await sleep(30), void log.push("a1")));
    q.push("a", async () => void log.push("a2"));
    expect(log).toEqual([]);
    await sleep(80);
    expect(log).toEqual(["a1", "a2"]);
  });

  it("keeps chats independent", async () => {
    const log: string[] = [];
    const q = makeChatQueue();
    q.push("a", async () => (await sleep(40), void log.push("a")));
    q.push("b", async () => void log.push("b"));
    await sleep(80);
    expect(log).toEqual(["b", "a"]);
  });

  it("clear drops waiting jobs but not later ones", async () => {
    const log: string[] = [];
    const q = makeChatQueue();
    q.push("a", async () => (await sleep(30), void log.push("running")));
    q.push("a", async () => void log.push("dropped"));
    await sleep(5); // the first job is now running
    q.clear("a");
    q.push("a", async () => void log.push("after"));
    await sleep(80);
    expect(log).toEqual(["running", "after"]);
  });

  it("a failing job is reported and does not stop the queue", async () => {
    const errors: unknown[] = [];
    const log: string[] = [];
    const q = makeChatQueue((e) => errors.push(e));
    q.push("a", async () => Promise.reject(new Error("boom")));
    q.push("a", async () => void log.push("next"));
    await sleep(30);
    expect(errors).toHaveLength(1);
    expect(log).toEqual(["next"]);
  });
});
