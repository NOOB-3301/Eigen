import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });
const replied = (text: string) => () => eigen!.tg.sent().some((t) => t.includes(text));
const say = async (text: string, reply: string) => {
  eigen!.tg.say(text);
  await waitFor(replied(reply));
};
const MCP_SERVER = join(import.meta.dirname, "../test/helpers/mcp-server.ts");

/** Taps Approve on the first approval card the bot posts. */
async function approve() {
  await waitFor(() => eigen!.tg.calls.some((c) => c.body.reply_markup?.inline_keyboard?.length));
  const keyboard = eigen!.tg.calls.map((c) => c.body.reply_markup?.inline_keyboard).find((k) => k?.length);
  eigen!.tg.press((keyboard.flat() as Array<{ text: string; callback_data: string }>).find((b) => /approve/i.test(b.text))!.callback_data);
}

const schedules = async () => {
  const list = await eigen!.api("/schedules");
  return (Array.isArray(list) ? list : (list.schedules ?? list.data ?? [])) as any[];
};

describe("slash commands (built server, fake Telegram, fake model)", () => {
  it("lists the commands for the owner and ignores everyone else", async () => {
    eigen = await startEigen([{ text: "x" }]);
    eigen.tg.say("/help", 999);
    await say("/help", "/status");
    await sleep(800);
    expect(eigen.tg.sent().filter((t) => t.includes("Commands:"))).toHaveLength(1);
    expect(eigen.llm.requests).toHaveLength(0);
  });

  it("answers /status while a run is still going", async () => {
    eigen = await startEigen([{ text: "slow answer", delayMs: 6000 }]);
    eigen.tg.say("think hard");
    await waitFor(() => eigen!.llm.requests.length === 1);
    eigen.tg.say("/status");
    await waitFor(replied("Model: local"), 3000);
    expect(replied("slow answer")()).toBe(false);
  });

  it("/model lists, switches, remembers the choice, and rejects unknown names", async () => {
    eigen = await startEigen([{ text: "ok" }]);
    await say("/model", "• local");
    await say("/model nope", 'No model called "nope"');
    await say("/model cloud", "Now using cloud");
    expect(JSON.parse(readFileSync(join(eigen.p.dataDir, "state.json"), "utf8"))).toEqual({ model: "cloud" });
    await say("hello", "ok");
    expect(eigen.llm.requests[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("/verbose shows tool calls only while on", async () => {
    eigen = await startEigen([call("write", { path: "a.txt", content: "x" }), { text: "done one" }, call("write", { path: "b.txt", content: "x" }), { text: "done two" }]);
    await say("/verbose on", "Verbose on.");
    await say("save a", "done one");
    expect(eigen.tg.sent().some((t) => t.includes("🔧 write"))).toBe(true);
    await say("/verbose off", "Verbose off.");
    const before = eigen.tg.sent().filter((t) => t.includes("🔧")).length;
    await say("save b", "done two");
    expect(eigen.tg.sent().filter((t) => t.includes("🔧")).length).toBe(before);
  });

  it("/new starts a fresh thread for the same chat", async () => {
    eigen = await startEigen([{ text: "first" }, { text: "second" }]);
    await say("hello", "first");
    await say("/new", "Fresh conversation");
    await say("again", "second");
    await say("/new", "Fresh conversation");
    const list = await eigen.api("/memory/threads?agentId=eigen&resourceId=telegram:7");
    expect((list.threads ?? list).length).toBe(2);
  });

  it("/reload picks up a skill dropped into your skills folder", async () => {
    eigen = await startEigen([{ text: "x" }]);
    await say("/status", "Skills installed: 0");
    mkdirSync(join(eigen.p.userSkillsDir, "tea"), { recursive: true });
    writeFileSync(join(eigen.p.userSkillsDir, "tea", "SKILL.md"), "---\nname: tea\ndescription: How to brew tea.\n---\n\nBoil water.");
    await say("/reload", "Reloaded. Skills: 1.");
    eigen.tg.say("hi");
    await waitFor(() => eigen!.llm.requests.length === 1);
    expect(JSON.stringify(eigen.llm.requests[0])).toContain("How to brew tea.");
  });

  it("tells the model about the built-in clawhub skill", async () => {
    eigen = await startEigen([{ text: "hi" }]);
    await say("hello", "hi");
    expect(JSON.stringify(eigen.llm.requests[0])).toContain("clawhub");
  });

  it("/consolidate says so when there is nothing new", async () => {
    eigen = await startEigen([{ text: "x" }]);
    await say("/consolidate", "Nothing new to add.");
  });
});

describe("MCP over Telegram", () => {
  it("/reload_mcp connects a server added to config.json, and its tools ask for approval", async () => {
    eigen = await startEigen([call("demo_echo", { text: "ping" }), { text: "tool finished" }]);
    await say("/status", "MCP: none");
    const cfg = JSON.parse(readFileSync(eigen.p.configFile, "utf8"));
    cfg.mcpServers = { demo: { command: process.execPath, args: [MCP_SERVER] } };
    writeFileSync(eigen.p.configFile, JSON.stringify(cfg));
    await say("/reload_mcp", "demo ✓");
    await say("/status", "MCP: demo ✓");

    eigen.tg.say("echo something");
    await approve();
    await waitFor(replied("tool finished"));
    const toolOutput = eigen.llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(toolOutput).toContain("ping");
  });

  it("a failing server is reported and does not stop the bot", async () => {
    eigen = await startEigen([{ text: "still here" }], { mcpServers: { broken: { command: process.execPath, args: [MCP_SERVER, "--fail"] } } });
    await say("/status", "broken ✗");
    await say("hello", "still here");
  });
});

describe("reminders", () => {
  it("asks first, then a fired reminder lands in the Telegram chat", async () => {
    const create = call("schedule", { action: "create", cron: "0 9 * * *", prompt: "Tell the user it is time to stretch", once: true });
    eigen = await startEigen([create, { text: "scheduled it" }, { text: "Time to stretch!" }]);
    eigen.tg.say("remind me to stretch at 9");
    expect((await schedules()).filter((s) => /stretch/.test(JSON.stringify(s)))).toHaveLength(0);
    await approve();
    await waitFor(replied("scheduled it"));

    const reminder = (await schedules()).find((s) => /stretch/.test(JSON.stringify(s)));
    expect(reminder, JSON.stringify(await schedules()).slice(0, 500)).toBeTruthy();
    // A reminder that fires while the previous reply is still wrapping up is handed to that run and lost, so let it settle.
    await sleep(3000);
    await eigen.api(`/schedules/${encodeURIComponent(reminder.id)}/run`, { method: "POST" });
    await waitFor(replied("Time to stretch!"));
  });
});
