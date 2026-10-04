import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig, toMastraModel } from "../src/mastra/lib/config.ts";
import { makeMemory } from "../src/mastra/lib/memory.ts";
import { AgentConfigSchema, resolveAgent } from "../src/mastra/lib/schema.ts";
import { createTriggerManager, generateUnattended } from "../src/mastra/lib/triggers.ts";
import { fakeClock } from "./helpers/fake-clock.ts";
import { fakeLlm, type Turn } from "./helpers/fake-llm.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });

/** A real agent with memory and a tool that needs approval, behind a scripted model. */
async function setup(turns: Turn[]) {
  const p = tmpHome();
  const llm = await fakeLlm(turns);
  closers.push(llm.close);
  const example = JSON.parse(readFileSync(`${DEFAULTS}/config.example.json`, "utf8"));
  const cfg = parseConfig({
    ...example,
    telegram: { ...example.telegram, allowedUserIds: [7] },
    models: { local: { id: "fake/model", url: llm.url } },
    defaultModel: "local",
    curatorModel: undefined,
    memory: { lastMessages: 5, semanticRecall: { topK: 1, messageRange: 1 }, embedder: { id: "fake/embed", url: llm.url } },
  });
  const ran: string[] = [];
  const risky = createTool({
    id: "risky",
    description: "does something that needs a yes",
    inputSchema: z.object({ what: z.string() }),
    requireApproval: true,
    execute: async ({ what }) => (ran.push(what), { done: what }),
  });
  const safe = createTool({ id: "safe", description: "needs no yes", inputSchema: z.object({ what: z.string() }), execute: async ({ what }) => (ran.push(`safe:${what}`), { done: what }) });
  const agent = new Agent({ id: "t", name: "t", instructions: "you are t", model: toMastraModel(cfg.models.local!), memory: makeMemory(p, cfg), tools: { risky, safe } });
  const mastra = new Mastra({ agents: { t: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "t.db")}` }) });
  const toolMessages = () => llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)));
  return { p, cfg, llm, ran, agent: mastra.getAgent("t"), mastra, toolMessages };
}

const input = (agent: Agent, o: Partial<Parameters<typeof generateUnattended>[0]> = {}) => ({ agent, prompt: "do the thing", threadId: "trigger-t-daily", resourceId: "agent-t", maxSteps: 6, signal: new AbortController().signal, ...o });

describe("an unattended run (real agent, scripted model)", () => {
  it("declines a tool call that needs approval instead of hanging, tells the model, and carries on to an answer", async () => {
    const { agent, llm, ran, toolMessages } = await setup([call("risky", { what: "delete everything" }), { text: "I was not allowed to do that." }]);
    const out = await generateUnattended(input(agent));
    expect(out).toEqual({ text: "I was not allowed to do that.", declined: ["risky"] });
    expect(ran).toEqual([]); // the tool never ran
    expect(llm.requests).toHaveLength(2);
    expect(toolMessages().join("\n")).toMatch(/Nobody is available to approve/);
  });

  it("declines every one of several, runs the tools that need no approval, and keeps the conversation in the trigger's own thread", async () => {
    const { agent, ran, llm } = await setup([call("safe", { what: "a" }), call("risky", { what: "one" }), call("risky", { what: "two" }), { text: "Did what I could." }]);
    const out = await generateUnattended(input(agent));
    expect(out).toEqual({ text: "Did what I could.", declined: ["risky", "risky"] });
    expect(ran).toEqual(["safe:a"]);
    expect(llm.requests).toHaveLength(4);
    const thread = await (await agent.getMemory())!.getThreadById({ threadId: "trigger-t-daily" });
    expect(thread).toMatchObject({ id: "trigger-t-daily", resourceId: "agent-t" });
  });

  it("is cut off by the abort signal while the model call hangs", async () => {
    const { agent } = await setup([{ text: "too late", delayMs: 10_000 }]);
    const started = Date.now();
    await expect(Promise.race([generateUnattended(input(agent, { signal: AbortSignal.timeout(150) })), new Promise((_, rej) => setTimeout(() => rej(new Error("did not stop")), 4000))])).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("through the trigger manager: the run is ok, the reply says what was declined, and nothing was executed", async () => {
    const { agent, ran, p, cfg } = await setup([call("risky", { what: "rm everything" }), { text: "I could not do that." }]);
    const resolved = resolveAgent(AgentConfigSchema.parse({ id: "t", name: "t", role: "r", description: "d", memory: { scope: "isolated" }, triggers: [{ id: "daily", type: "cron", cron: "0 9 * * *", timezone: "UTC", prompt: "Do the daily thing", deliverToTelegram: false }] }), cfg);
    const mgr = createTriggerManager({ paths: p, clock: fakeClock("2026-10-04T08:00:00Z").clock, timezone: () => "UTC", agentOf: () => agent, botOf: () => undefined });
    closers.push(() => mgr.close());
    mgr.sync("t", resolved);
    const res = await mgr.runNow("t", "daily");
    expect(res).toMatchObject({ ok: true, run: { status: "ok", subject: "manual" } });
    expect(res!.run!.reply).toContain("I could not do that.");
    expect(res!.run!.reply).toContain("1 tool call (risky) needed approval");
    expect(ran).toEqual([]);
  });
});
