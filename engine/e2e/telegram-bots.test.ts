import { request } from "node:http";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentEvent, GetAgentRuntimeResponse, ListAgentsResponse, ModelTestResponse, TelegramCheckResponse } from "../src/mastra/lib/schema.ts";
import { PRIMARY_TOKEN } from "../test/helpers/fake-telegram.ts";
import type { Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MCP_SERVER = join(import.meta.dirname, "../test/helpers/mcp-server.ts");
const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });

function addAgent(p: HomePaths, id: string, patch: Record<string, unknown> = {}, instructions = `You are the ${id} bot.`) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), instructions);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `Does ${id} work.`, ...patch }));
}

const get = async <T,>(path: string) => {
  const r = await fetch(`${eigen!.url}${path}`);
  return { status: r.status, body: (await r.json()) as T };
};
const post = async <T,>(path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
  const r = await fetch(`${eigen!.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
};
/** waitFor for checks that need a request. */
async function eventually(check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for condition");
}
const telegramOf = async (id: string) => (await get<GetAgentRuntimeResponse>(`/eigen/agents/${id}`)).body.runtime.telegram;

/** Collects SSE events from /eigen/agents/events until stopped. */
async function subscribe() {
  const ctl = new AbortController();
  const res = await fetch(`${eigen!.url}/eigen/agents/events`, { signal: ctl.signal });
  const events: AgentEvent[] = [];
  let raw = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      raw += dec.decode(chunk, { stream: true });
      for (const m of raw.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]!));
      raw = raw.slice(raw.lastIndexOf("\n\n") + 2);
    }
  })().catch(() => undefined);
  return { events, close: () => ctl.abort() };
}

/** A request with an arbitrary Host header (fetch will not let a test lie about it). */
const rawRequest = (port: number, method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end(body);
  });

const replied = (token: string, text: string) => () => eigen!.tg.sent(token).some((t) => t.includes(text));
const OWN = { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_RESEARCHER" };

describe("a specialist with a Telegram bot of its own (built server, fake Telegram, fake model)", () => {
  it("is switched on from .env while the engine runs, answers in its own chat, follows token rotation and edits with exactly one poller, and stops when removed", async () => {
    eigen = await startEigen([{ text: "Researcher bot reporting" }], {}, { port: 4194, prepare: (p) => addAgent(p, "researcher", { telegram: OWN }) });
    const tg = eigen.tg;
    const A = "321:researcher-a";
    const B = "321:researcher-b";

    // 1. Enabled, but the token is not in .env yet.
    expect(await telegramOf("researcher")).toEqual({ state: "missing-token", error: "TELEGRAM_BOT_TOKEN_RESEARCHER is not set in .env" });
    await eventually(async () => (await telegramOf("eigen"))?.state === "polling", 10_000);
    expect(await telegramOf("eigen")).toEqual({ state: "polling", username: "eigen_test_bot" });

    // 2. The studio writes the token to .env: the bot starts without a restart.
    const sse = await subscribe();
    setSecret(eigen.p, "TELEGRAM_BOT_TOKEN_RESEARCHER", A);
    await waitFor(() => sse.events.some((e) => e.type === "agent.telegram" && e.id === "researcher" && e.telegram.state === "polling"), 20_000);
    expect(await telegramOf("researcher")).toEqual({ state: "polling", username: "bot_321_researcher_a" });
    expect(JSON.stringify(sse.events)).not.toContain(A);

    // 3. It answers on its own bot only, with its own instructions; the primary bot stays silent.
    tg.say("hello researcher", 7, 7, "private", A);
    await waitFor(replied(A, "Researcher bot reporting"), 30_000);
    expect(tg.sent(PRIMARY_TOKEN).some((t) => t.includes("Researcher bot reporting"))).toBe(false);
    const system = eigen.llm.requests[0]!.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    expect(system).toContain("You are the researcher bot.");
    // Only the harmless commands exist on a specialist's bot.
    tg.say("/model cloud", 7, 7, "private", A);
    await waitFor(replied(A, "/model is only available on the main bot."), 20_000);
    tg.say("/help", 7, 7, "private", A);
    await waitFor(replied(A, "/status"), 20_000);
    expect(tg.sent(A).find((t) => t.startsWith("Commands:"))).not.toContain("/consolidate");

    // 4. Token rotated in .env: the old poller stops, the new one polls, nobody gets a 409.
    setSecret(eigen.p, "TELEGRAM_BOT_TOKEN_RESEARCHER", B);
    await waitFor(() => sse.events.some((e) => e.type === "agent.telegram" && e.id === "researcher" && e.telegram.username === "bot_321_researcher_b" && e.telegram.state === "polling"), 20_000);
    await waitFor(() => tg.pollers(A) === 0, 5000);
    const oldPolls = tg.callsFor(A, "getUpdates").length;
    await sleep(3000);
    expect(tg.callsFor(A, "getUpdates").length).toBe(oldPolls);
    expect(tg.callsFor(B, "getUpdates").length).toBeGreaterThan(0);
    expect([tg.conflicts(A), tg.conflicts(B), tg.maxPollers(A), tg.maxPollers(B)]).toEqual([0, 0, 1, 1]);

    // 5. An edit rebuilds the agent: afterwards still exactly one poller, still no conflict, and one answer per message.
    const hashBefore = (await get<GetAgentRuntimeResponse>("/eigen/agents/researcher")).body.runtime.loadedHash;
    addAgent(eigen.p, "researcher", { description: "Edited description.", telegram: OWN });
    await waitFor(() => sse.events.filter((e) => e.type === "agent.loaded" && e.id === "researcher").some((e) => e.type === "agent.loaded" && e.hash !== hashBefore), 20_000);
    await eventually(async () => (await telegramOf("researcher"))?.state === "polling", 20_000);
    const posts = () => tg.callsFor(B, "sendMessage").length; // a streamed answer is one post plus edits
    const [postsBefore, runsBefore] = [posts(), eigen.llm.requests.length];
    tg.say("after the edit", 7, 7, "private", B);
    await waitFor(() => posts() > postsBefore, 30_000);
    await sleep(2500);
    expect([posts() - postsBefore, eigen.llm.requests.length - runsBefore]).toEqual([1, 1]);
    expect([tg.conflicts(A), tg.conflicts(B), tg.maxPollers(B)]).toEqual([0, 0, 1]);

    // 6. The folder is moved to .trash: the poller stops and the agent is gone.
    mkdirSync(join(eigen.p.agentsDir, ".trash"), { recursive: true });
    renameSync(join(eigen.p.agentsDir, "researcher"), join(eigen.p.agentsDir, ".trash", "researcher-gone"));
    await waitFor(() => sse.events.some((e) => e.type === "agent.removed" && e.id === "researcher"), 20_000);
    await waitFor(() => tg.pollers(B) === 0, 5000);
    const polls = tg.callsFor(B, "getUpdates").length;
    await sleep(3000);
    expect(tg.callsFor(B, "getUpdates").length).toBe(polls);
    expect((await get("/eigen/agents/researcher")).status).toBe(404);
    expect(tg.conflicts(B)).toBe(0);
    sse.close();
  });

  it("a second agent on the same bot token is not started, and its problem is reported; the primary is never the one flagged", async () => {
    const SAME = "999:same-bot";
    eigen = await startEigen([{ text: "never sent" }], {}, {
      port: 4195,
      prepare: (p) => {
        writeFileSync(p.envFile, `TELEGRAM_BOT_TOKEN_AAA=${SAME}\nTELEGRAM_BOT_TOKEN_BBB=${SAME}\n`);
        addAgent(p, "aaa", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_AAA" } });
        addAgent(p, "bbb", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_BBB" } });
        // Same env NAME as aaa (and as nobody's but a typo away from the primary's): invalid outright.
        addAgent(p, "ccc", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_AAA" } });
        addAgent(p, "zzz", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN" } });
      },
    });
    await eventually(async () => (await telegramOf("aaa"))?.state === "polling", 15_000);
    const list = (await get<ListAgentsResponse>("/eigen/agents")).body;
    const by = Object.fromEntries(list.agents.map((a) => [a.id, a]));
    expect(by.eigen!.runtime.status).toBe("loaded");
    expect(by.aaa!.runtime.telegram).toMatchObject({ state: "polling" });
    expect(by.bbb!.runtime).toMatchObject({ status: "loaded", telegram: { state: "error", error: expect.stringContaining('already used by "aaa"') } });
    expect(by.ccc!.runtime.status).toBe("invalid");
    expect(by.ccc!.runtime.problems.join()).toMatch(/tokenEnv "TELEGRAM_BOT_TOKEN_AAA" is already used by "aaa"/);
    expect(by.zzz!.runtime.status).toBe("invalid");
    expect(by.zzz!.runtime.problems.join()).toMatch(/tokenEnv "TELEGRAM_BOT_TOKEN" is already used by "eigen"/);
    await sleep(3000);
    expect([eigen.tg.maxPollers(SAME), eigen.tg.conflicts(SAME), eigen.tg.maxPollers(PRIMARY_TOKEN), eigen.tg.conflicts(PRIMARY_TOKEN)]).toEqual([1, 0, 1, 0]);
  });

  it("asks for approval with Approve/Deny buttons on the specialist's own bot, and runs the tool once approved", async () => {
    const TOKEN = "555:tooly";
    eigen = await startEigen([call("demo_echo", { text: "ping" }), { text: "tooly is done" }], { mcpServers: { demo: { command: process.execPath, args: [MCP_SERVER] } } }, {
      port: 4196,
      prepare: (p) => {
        writeFileSync(p.envFile, `TELEGRAM_BOT_TOKEN_TOOLY=${TOKEN}\n`);
        addAgent(p, "tooly", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_TOOLY" }, tools: { mcp: { inherit: ["demo"] } } });
      },
    });
    await eventually(async () => (await telegramOf("tooly"))?.state === "polling", 30_000);
    eigen.tg.say("echo ping please", 7, 7, "private", TOKEN);
    await waitFor(() => eigen!.tg.callsFor(TOKEN).some((c) => c.body.reply_markup?.inline_keyboard?.length), 30_000);
    const keyboard = eigen.tg.callsFor(TOKEN).map((c) => c.body.reply_markup?.inline_keyboard).find((k) => k?.length);
    const buttons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
    expect(buttons.map((b) => b.text.toLowerCase()).join()).toMatch(/approve/);
    expect(buttons.map((b) => b.text.toLowerCase()).join()).toMatch(/deny/);
    expect(eigen.llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool"))).toHaveLength(0); // nothing ran before the tap
    // The card went out on the specialist's bot, never the primary's.
    expect(eigen.tg.callsFor(PRIMARY_TOKEN).some((c) => c.body.reply_markup?.inline_keyboard?.length)).toBe(false);

    eigen.tg.press(buttons.find((b) => /approve/i.test(b.text))!.callback_data, 7, 7, TOKEN);
    await waitFor(replied(TOKEN, "tooly is done"), 30_000);
    expect(eigen.llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content))).join("\n")).toContain("ping");
  });
});

describe("probes and the loopback guard (built server)", () => {
  it("checks a bot token, tests a model, refuses to read other secrets, and rejects foreign hosts and browser POSTs", async () => {
    eigen = await startEigen([{ text: "ok" }], {}, {
      port: 4197,
      prepare: (p) => writeFileSync(p.envFile, "ANTHROPIC_API_KEY=decoy-anthropic-secret\nTELEGRAM_BOT_TOKEN_BAD=888:revoked\n"),
    });
    eigen.tg.reject("888:revoked", 401, "Unauthorized");

    // The primary's own token variable is checkable; a variable written just now is too (the probe re-reads .env first).
    expect((await post<TelegramCheckResponse>("/eigen/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN" })).body).toEqual({ ok: true, username: "eigen_test_bot" });
    setSecret(eigen.p, "TELEGRAM_BOT_TOKEN_NEW", "777:new-bot");
    expect((await post<TelegramCheckResponse>("/eigen/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN_NEW" })).body).toEqual({ ok: true, username: "bot_777_new_bot" });

    const bad = await post<TelegramCheckResponse>("/eigen/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN_BAD" });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/Unauthorized/);
    expect(JSON.stringify(bad.body)).not.toContain("888:revoked");
    expect((await post<TelegramCheckResponse>("/eigen/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN_UNSET" })).body).toEqual({ ok: false, error: "that variable is not set in .env" });

    // Any other variable: 400, and it is never sent to Telegram.
    for (const name of ["ANTHROPIC_API_KEY", "PATH", "lower_case", "../x"]) {
      const r = await post<TelegramCheckResponse>("/eigen/telegram/check", { tokenEnv: name });
      expect(r.status, name).toBe(400);
      expect(r.body.ok, name).toBe(false);
    }
    expect(eigen.tg.calls.some((c) => c.token.includes("decoy-anthropic-secret"))).toBe(false);

    // Model test: works for a model in config.json (the fake answers "ok"), 404 for one that is not.
    const model = await post<ModelTestResponse>("/eigen/models/local/test", {});
    expect(model.body).toMatchObject({ ok: true, reply: "ok" });
    expect(model.body.ms).toBeGreaterThanOrEqual(0);
    expect((await post<ModelTestResponse>("/eigen/models/nope/test", {})).status).toBe(404);

    // Loopback guard on every /eigen route.
    const port = 4197;
    for (const [method, path] of [["GET", "/eigen/agents"], ["GET", "/eigen/agents/eigen"], ["POST", "/eigen/telegram/check"], ["POST", "/eigen/models/local/test"]] as const) {
      const headers = { host: `evil.example:${port}`, "content-type": "application/json" };
      expect((await rawRequest(port, method, path, headers, method === "POST" ? "{}" : undefined)).status, `${method} ${path} foreign host`).toBe(403);
      expect((await rawRequest(port, method, path, { ...headers, host: `127.0.0.1:${port + 1}` }, method === "POST" ? "{}" : undefined)).status, `${method} ${path} wrong port`).toBe(403);
    }
    expect((await rawRequest(port, "GET", "/eigen/agents", { host: `localhost:${port}` })).status).toBe(200);
    expect((await post("/eigen/telegram/check", { tokenEnv: "TELEGRAM_BOT_TOKEN" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await rawRequest(port, "POST", "/eigen/telegram/check", { host: `127.0.0.1:${port}`, "content-type": "application/json", origin: "https://evil.example" }, JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" }))).status).toBe(403);
    await sleep(200);
  });
});
