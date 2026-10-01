import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { describe, expect, it } from "vitest";
import { makeScheduleTool, pruneOneShots } from "../src/mastra/lib/reminders.ts";
import { tmpHome } from "./helpers/home.ts";

function setup() {
  const p = tmpHome();
  const agent = new Agent({ id: "eigen", name: "eigen", instructions: "t", model: "openai/gpt-5-mini" });
  const mastra = new Mastra({ agents: { eigen: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "r.db")}` }) });
  const tool = makeScheduleTool(() => "Asia/Kolkata");
  const ctx = { mastra, agent: { agentId: "eigen", threadId: "thread-1", resourceId: "telegram:7", toolCallId: "c", messages: [], suspend: async () => {} } };
  const run = async (input: Record<string, unknown>) => (await tool.execute!(input as never, ctx as never)) as any;
  return { mastra, tool, run };
}

describe("schedule tool", () => {
  it("asks for approval on every action except list", () => {
    const { tool } = setup();
    const needs = tool.requireApproval as (i: { action: string }) => boolean;
    expect(["create", "pause", "resume", "delete"].map((action) => needs({ action }))).toEqual([true, true, true, true]);
    expect(needs({ action: "list" })).toBe(false);
  });

  it("creates a reminder threaded to this chat, in the owner's timezone", async () => {
    const { mastra, run } = setup();
    const made = await run({ action: "create", cron: "30 17 * * *", prompt: "Remind the user to stretch" });
    expect(made).toMatchObject({ prompt: "Remind the user to stretch", cron: "30 17 * * *", once: false, status: "active" });
    const row = (await mastra.schedules.get(made.id)) as any;
    expect(row).toMatchObject({ agentId: "eigen", threadId: "thread-1", resourceId: "telegram:7", timezone: "Asia/Kolkata" });
  });

  it("lists only reminders it created", async () => {
    const { mastra, run } = setup();
    await mastra.schedules.create({ agentId: "eigen", cron: "0 3 * * *", prompt: "not a reminder" });
    await run({ action: "create", cron: "0 9 * * 1", prompt: "weekly review" });
    expect((await run({ action: "list" })).schedules.map((s: any) => s.prompt)).toEqual(["weekly review"]);
  });

  it("pauses, resumes and deletes", async () => {
    const { mastra, run } = setup();
    const { id } = await run({ action: "create", cron: "0 9 * * 1", prompt: "weekly review" });
    expect((await run({ action: "pause", id })).status).toBe("paused");
    expect((await run({ action: "resume", id })).status).toBe("active");
    expect(await run({ action: "delete", id })).toEqual({ deleted: id });
    expect(await mastra.schedules.get(id)).toBeNull();
  });

  it("will not touch schedules it did not create", async () => {
    const { mastra, run } = setup();
    const { id } = await mastra.schedules.create({ agentId: "eigen", cron: "0 3 * * *", prompt: "nightly" });
    expect(await run({ action: "delete", id })).toEqual({ error: `no reminder with id ${id}` });
    expect(await mastra.schedules.get(id)).not.toBeNull();
  });

  it("reports bad input as an error the model can act on", async () => {
    const { run } = setup();
    expect(await run({ action: "create", prompt: "no cron" })).toEqual({ error: "create needs cron and prompt" });
    expect(await run({ action: "create", cron: "not a cron", prompt: "x" })).toMatchObject({ error: expect.stringContaining("could not create") });
    expect(await run({ action: "pause", id: "missing" })).toEqual({ error: "no reminder with id missing" });
  });

  it("removes a one-time reminder once it has fired, and keeps the rest", async () => {
    const { mastra, run } = setup();
    const once = await run({ action: "create", cron: "0 9 * * *", prompt: "once", once: true });
    const keep = await run({ action: "create", cron: "0 9 * * *", prompt: "recurring" });
    expect(await pruneOneShots(mastra.schedules)).toBe(0);
    const store = await mastra.getStorage()!.getStore("schedules");
    const { nextFireAt } = (await mastra.schedules.get(once.id)) as any;
    await store!.updateScheduleNextFire(once.id, nextFireAt, nextFireAt + 86_400_000, Date.now(), "run-1");
    expect(await pruneOneShots(mastra.schedules)).toBe(1);
    expect(await mastra.schedules.get(once.id)).toBeNull();
    expect(await mastra.schedules.get(keep.id)).not.toBeNull();
  });
});
