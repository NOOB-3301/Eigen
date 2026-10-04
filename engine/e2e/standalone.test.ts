import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import { agentPaths } from "../src/mastra/lib/home.ts";
import type { ChatHistoryResponse, GetAgentRuntimeResponse, ListAgentsResponse, RunTriggerResponse, TelegramCheckResponse } from "../src/mastra/lib/schema.ts";
import { eventually, sleep, startEigen, tokenOf, waitFor, type Eigen } from "./harness.ts";

let eigen: Eigen | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const SESSION = "e2e-session-0001";
const detail = async (id: string) => (await eigen!.get<GetAgentRuntimeResponse>(`/eigen/agents/${id}`)).body;
const replied = (id: string, text: string) => () => eigen!.tg.sent(tokenOf(id)).some((t) => t.includes(text));
const editConfig = (id: string, patch: Record<string, unknown>) => {
  const file = agentPaths(eigen!.p, id).configFile;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};
/** The text of a studio chat reply (AI SDK UI-message stream). */
async function chat(id: string, text: string) {
  const res = await fetch(`${eigen!.url}/eigen/chat/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] } }),
  });
  const body = await res.text();
  const deltas = body.split("\n").flatMap((l) => (l.startsWith("data: {") ? [JSON.parse(l.slice(6)) as { type: string; delta?: string }] : []));
  return { status: res.status, text: deltas.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("") };
}

describe("an empty home", () => {
  it("starts with zero agents and serves", async () => {
    eigen = await startEigen([], { port: 4191 });
    const { status, body } = await eigen.get<ListAgentsResponse>("/eigen/agents");
    expect(status).toBe(200);
    expect(body).toMatchObject({ agents: [], fleetProblems: [], topology: { nodes: [], edges: [] } });
    expect((await eigen.get("/eigen/agents/nobody")).status).toBe(404);
  });
});

describe("standalone agents (built server, fake Telegram, one fake model per agent)", () => {
  it("two agents with two bots answer independently and never see each other's messages", async () => {
    eigen = await startEigen([{ id: "alpha" }, { id: "beta" }]);
    eigen.tg.say("alpha, remember the word pineapple", 7, 7, "private", tokenOf("alpha"));
    await waitFor(replied("alpha", "hi from alpha"));
    eigen.tg.say("beta, what do you know", 7, 7, "private", tokenOf("beta"));
    await waitFor(replied("beta", "hi from beta"));

    expect(eigen.tg.sent(tokenOf("alpha")).join()).not.toContain("hi from beta");
    expect(eigen.tg.sent(tokenOf("beta")).join()).not.toContain("hi from alpha");
    expect(JSON.stringify(eigen.llms.alpha!.requests)).not.toContain("what do you know");
    expect(JSON.stringify(eigen.llms.beta!.requests)).not.toContain("pineapple");
    expect(eigen.tg.maxPollers(tokenOf("alpha"))).toBe(1);
  });

  it("an .env change rebuilds only that agent, and a config edit hot reloads, with one poller per bot throughout", async () => {
    eigen = await startEigen([{ id: "alpha" }, { id: "beta" }]);
    const before = { alpha: (await detail("alpha")).runtime.loadedHash, beta: (await detail("beta")).runtime.loadedHash };

    const rotated = "777777:tok-alpha-rotated";
    setSecret(agentPaths(eigen.p, "alpha").envFile, "TELEGRAM_BOT_TOKEN", rotated);
    await eventually(async () => (await detail("alpha")).runtime.loadedHash !== before.alpha);
    await waitFor(() => eigen!.tg.callsFor(rotated, "getUpdates").length > 0);
    expect((await detail("beta")).runtime.loadedHash).toBe(before.beta);
    await eventually(async () => eigen!.tg.pollers(tokenOf("alpha")) === 0);

    editConfig("beta", { description: "Edited while running." });
    await eventually(async () => (await detail("beta")).resolved?.description === "Edited while running.");
    eigen.tg.say("still there?", 7, 7, "private", tokenOf("beta"));
    await waitFor(replied("beta", "hi from beta"));
    expect(eigen.tg.maxPollers(tokenOf("beta"))).toBe(1);
  });

  it("the same token in two agents: the first by id keeps the bot, the second loads without one", async () => {
    const shared = tokenOf("aaa");
    eigen = await startEigen([{ id: "aaa" }, { id: "bbb", telegram: false }]);
    editConfig("bbb", { telegram: { enabled: true, allowedUserIds: [7] } });
    setSecret(agentPaths(eigen.p, "bbb").envFile, "TELEGRAM_BOT_TOKEN", shared);
    await eventually(async () => (await detail("bbb")).runtime.telegram?.state === "error");
    expect((await detail("bbb")).runtime).toMatchObject({ status: "loaded", telegram: { error: 'this bot token is also used by "aaa"; one token serves one agent' } });
    await sleep(1500);
    expect(eigen.tg.maxPollers(shared)).toBe(1);
    expect(eigen.tg.conflicts(shared)).toBe(0);
  });

  it("studio chat answers from the agent's own model, keeps history, and an agent with storage off has none", async () => {
    const off = { memory: { storage: { enabled: false }, lastMessages: { enabled: false }, workingMemory: { enabled: false } } };
    eigen = await startEigen([{ id: "alpha" }, { id: "nomem", telegram: false, config: off }]);
    expect(await chat("alpha", "hello from the studio")).toEqual({ status: 200, text: "hi from alpha" });
    const h = (await eigen.get<ChatHistoryResponse>(`/eigen/chat/alpha/${SESSION}`)).body;
    expect(h).toMatchObject({ model: "main", memory: { telegramUserId: 7 } });
    expect(JSON.stringify(h.messages)).toContain("hello from the studio");

    expect(await chat("nomem", "remember me")).toEqual({ status: 200, text: "hi from nomem" });
    expect((await eigen.get<ChatHistoryResponse>(`/eigen/chat/nomem/${SESSION}`)).body.messages).toEqual([]);
    expect((await chat("ghost", "hi")).status).toBe(404);
  });

  it("a cron trigger runs with the agent's model and delivers to the agent's own bot", async () => {
    const triggers = [{ id: "daily", type: "cron", cron: "0 9 * * *", timezone: "UTC", prompt: "Write the daily note" }];
    eigen = await startEigen([{ id: "alpha", config: { triggers } as never }, { id: "beta" }]);
    const res = (await eigen.post<RunTriggerResponse>("/eigen/agents/alpha/triggers/daily/run", {})).body;
    expect(res).toMatchObject({ ok: true, run: { status: "ok", reply: "hi from alpha", delivered: true } });
    expect(eigen.tg.sent(tokenOf("alpha")).some((t) => t.startsWith("Trigger daily - manual"))).toBe(true);
    expect(eigen.tg.sent(tokenOf("beta"))).toEqual([]);
    expect(JSON.stringify(eigen.llms.beta!.requests)).not.toContain("daily note");
    expect((await eigen.post("/eigen/agents/alpha/triggers/nope/run", {})).status).toBe(404);
  });

  it("checks read the token from that agent's .env only, and never return it", async () => {
    eigen = await startEigen([{ id: "alpha" }, { id: "beta", telegram: false }]);
    const ok = await eigen.post<TelegramCheckResponse>("/eigen/agents/alpha/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN" });
    expect(ok.body).toEqual({ ok: true, username: `bot_${tokenOf("alpha").replace(/\W/g, "_")}` });
    expect((await eigen.post<TelegramCheckResponse>("/eigen/agents/beta/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN" })).body).toEqual({ ok: false, error: "that variable is not set in this agent's keys" });
    expect((await eigen.post("/eigen/agents/alpha/telegram/check", { tokenEnv: "OPENAI_API_KEY" })).status).toBe(400);
    expect((await eigen.post("/eigen/agents/ghost/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN" })).status).toBe(404);
    expect((await eigen.post("/eigen/agents/alpha/models/main/test", {})).body).toMatchObject({ ok: true, reply: "hi from alpha" });
    expect((await eigen.post("/eigen/agents/alpha/models/ghost/test", {})).status).toBe(404);
  });
});
