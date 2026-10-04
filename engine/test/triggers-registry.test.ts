import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRegistry, type AgentFactory, type AgentRegistry } from "../src/mastra/lib/agents.ts";
import { reloadConfig } from "../src/mastra/lib/config.ts";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentConfigInput, AgentEvent, TriggerInput } from "../src/mastra/lib/schema.ts";
import type { TelegramBot } from "../src/mastra/lib/telegram.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { seenFile } from "../src/mastra/lib/trigger-runs.ts";
import { fakeGithub, pull } from "./helpers/fake-github.ts";
import { tmpHome } from "./helpers/home.ts";

const TOKEN = "gho_Tok3nThatMustNeverLeak0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("timed out");
}

function home() {
  const p = tmpHome();
  const seeded = JSON.parse(readFileSync(p.configFile, "utf8"));
  writeFileSync(p.configFile, JSON.stringify({ ...seeded, telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] } }));
  process.env.EIGEN_HOME = p.home;
  reloadConfig();
  return p;
}

function addAgent(p: HomePaths, id: string, patch: Partial<AgentConfigInput> = {}) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), `You are ${id}.`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, ...patch }));
}

const stubMcp = { load: async () => ({ tools: {}, errors: {}, servers: [] }), state: () => ({ tools: {}, errors: {}, servers: [] }), tools: () => ({}), close: async () => undefined } as unknown as Mcp;

const ghTrigger = (o: Record<string, unknown> = {}) => ({ id: "prs", type: "github-pr", repo: "acme/app", tokenEnv: "GITHUB_TOKEN", prompt: "Review {{pr.title}}", intervalSec: 60, ...o }) as TriggerInput;
const cronTrigger = (o: Record<string, unknown> = {}) => ({ id: "daily", type: "cron", cron: "0 9 * * *", timezone: "UTC", prompt: "Daily", ...o }) as TriggerInput;

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function setup(p: HomePaths, env: NodeJS.ProcessEnv = {}) {
  const gh = await fakeGithub();
  closers.push(gh.close);
  gh.setPulls("acme/app", [pull(1)]);
  const fullEnv: NodeJS.ProcessEnv = { GITHUB_TOKEN: TOKEN, GITHUB_API_BASE_URL: gh.url, ...env };
  const sent: Array<{ chat: string; text: string }> = [];
  const bot = {
    state: () => ({ state: "polling" }),
    subscribe: () => () => undefined,
    stop: async () => undefined,
    adapter: { openDM: async (id: string) => `telegram:${id}`, postMessage: async (chat: string, text: string) => void sent.push({ chat, text }) },
  } as unknown as TelegramBot;
  const stopped: string[] = [];
  const prompts: string[] = [];
  const factory: AgentFactory = async (r) => ({
    agent: { id: r.id, name: r.name, generate: async (prompt: string) => (prompts.push(prompt), { text: `reply from ${r.id}`, finishReason: "stop" }) } as unknown as Agent,
    telegram: r.telegram.enabled ? bot : undefined,
    dispose: async () => void stopped.push(r.id),
  });
  const reg: AgentRegistry = createAgentRegistry({ paths: p, rootMcp: stubMcp, factory, debounceMs: 40, env: fullEnv });
  closers.push(() => reg.close());
  const events: AgentEvent[] = [];
  reg.events.on("event", (e) => events.push(e));
  const mastra = { addAgent: () => undefined, removeAgent: () => undefined, getAgentById: () => undefined };
  await reg.attach(mastra as unknown as Mastra);
  const triggers = (id = "reviewer") => reg.detail(id)?.runtime.triggers;
  const triggerEvents = (id = "reviewer") => events.flatMap((e) => (e.type === "agent.trigger" && e.id === id ? [e.trigger] : []));
  return { reg, gh, env: fullEnv, sent, prompts, events, stopped, triggers, triggerEvents };
}

describe("triggers in the agent registry", () => {
  it("starts an agent's triggers with it, reports them in its runtime and as events, and keeps the token out of both", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [ghTrigger(), cronTrigger({ id: "off", enabled: false })] });
    const { gh, triggers, triggerEvents, reg } = await setup(p);
    await until(() => triggers()?.find((t) => t.id === "prs")?.state === "idle" && gh.pollsOf().length === 1);
    expect(triggers()!.map((t) => [t.id, t.type, t.state])).toEqual([["prs", "github-pr", "idle"], ["off", "cron", "disabled"]]);
    expect(triggers()![0]!.nextRunAt).toBeDefined();
    expect(JSON.parse(readFileSync(seenFile(p, "reviewer", "prs"), "utf8")).prs).toEqual({ 1: "sha-1-a" });
    expect(triggerEvents().length).toBeGreaterThan(0);
    expect(JSON.stringify([triggerEvents(), reg.detail("reviewer"), reg.summaries(), reg.snapshot()])).not.toContain(TOKEN);
    // an agent with no triggers has no `triggers` key at all
    expect(reg.detail("eigen")!.runtime.triggers).toBeUndefined();
  });

  it("an edit that does not touch a trigger leaves it running; an edit to the trigger restarts it with what it had seen", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [ghTrigger()] });
    const { reg, gh, triggers, triggerEvents } = await setup(p);
    await until(() => gh.pollsOf().length === 1 && triggers()?.[0]?.nextRunAt !== undefined);
    const hash = reg.detail("reviewer")!.runtime.loadedHash;

    addAgent(p, "reviewer", { description: "Edited.", triggers: [ghTrigger()] });
    reg.reload();
    await until(() => reg.detail("reviewer")!.runtime.loadedHash !== hash);
    await sleep(150);
    expect(gh.pollsOf()).toHaveLength(1); // not restarted: no new poll

    gh.addPull("acme/app", pull(2));
    addAgent(p, "reviewer", { description: "Edited.", triggers: [ghTrigger({ prompt: "Look at {{pr.title}}" })] });
    reg.reload();
    await until(() => gh.pollsOf().length === 2); // restarted: polls at once
    await until(() => triggers()![0]!.state === "idle" && triggers()![0]!.nextRunAt !== undefined);
    expect(JSON.parse(readFileSync(seenFile(p, "reviewer", "prs"), "utf8")).prs).toEqual({ 1: "sha-1-a", 2: "sha-2-a" });
    expect(triggerEvents().at(-1)).toMatchObject({ id: "prs", state: "idle" });
  });

  it("an invalid edit keeps the last good version, and its triggers keep running", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [cronTrigger()] });
    const { reg, triggers, stopped } = await setup(p);
    await until(() => triggers()?.[0]?.nextRunAt !== undefined);
    writeFileSync(join(p.agentsDir, "reviewer", "config.json"), "{ not json");
    reg.reload();
    await until(() => reg.detail("reviewer")!.runtime.status === "stale");
    expect(triggers()).toMatchObject([{ id: "daily", state: "idle", nextRunAt: expect.any(String) }]);
    // a schema-invalid edit too (the trigger is gone from the file, but the last good version still has it)
    addAgent(p, "reviewer", { name: "", triggers: [] });
    reg.reload();
    await until(() => (reg.detail("reviewer")!.runtime.problems.length ?? 0) > 0);
    expect(triggers()!.map((t) => t.id)).toEqual(["daily"]);
    expect(stopped).toEqual([]);
    // fixing the file applies it
    addAgent(p, "reviewer", { triggers: [] });
    reg.reload();
    await until(() => triggers() === undefined);
  });

  it("stops the triggers when the agent is disabled (listing them as disabled), starts them again when it is enabled, and stops them for good when it is trashed", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [cronTrigger(), ghTrigger()] });
    const { reg, gh, triggers } = await setup(p);
    await until(() => gh.pollsOf().length === 1);

    addAgent(p, "reviewer", { enabled: false, triggers: [cronTrigger(), ghTrigger()] });
    reg.reload();
    await until(() => reg.detail("reviewer")!.runtime.status === "disabled");
    expect(triggers()!.map((t) => [t.id, t.state])).toEqual([["daily", "disabled"], ["prs", "disabled"]]);
    expect(reg.runTrigger("reviewer", "daily")).toBeUndefined(); // not running, so nothing to run

    addAgent(p, "reviewer", { triggers: [cronTrigger(), ghTrigger()] });
    reg.reload();
    await until(() => gh.pollsOf().length === 2); // seen-list kept: this poll fires nothing
    await until(() => triggers()?.[1]?.state === "idle");

    mkdirSync(join(p.agentsDir, ".trash"), { recursive: true });
    renameSync(join(p.agentsDir, "reviewer"), join(p.agentsDir, ".trash", "reviewer-gone"));
    reg.reload();
    await until(() => reg.detail("reviewer") === undefined);
    expect(reg.runTrigger("reviewer", "daily")).toBeUndefined();
    expect(reg.triggerRuns("reviewer", 10)).toBeUndefined();
  });

  it("a token added to .env while the engine runs starts a trigger that was waiting for it", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [ghTrigger()] });
    const { reg, gh, triggers, env } = await setup(p, { GITHUB_TOKEN: undefined });
    reg.watch();
    await until(() => triggers()?.[0]?.state === "missing-token");
    expect(gh.requests).toEqual([]);
    setSecret(p, "GITHUB_TOKEN", TOKEN);
    await until(() => triggers()?.[0]?.state === "idle");
    expect(env.GITHUB_TOKEN).toBe(TOKEN);
    expect(gh.pollsOf()).toHaveLength(1);
    expect(gh.pollsOf()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("runs a trigger now through the registry, delivers on the agent's own bot, and lists the run newest first", async () => {
    const p = home();
    addAgent(p, "reviewer", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_REVIEWER" }, triggers: [cronTrigger()] });
    const { reg, sent, prompts } = await setup(p, { TELEGRAM_BOT_TOKEN_REVIEWER: "55:reviewer-bot" });
    const res = await reg.runTrigger("reviewer", "daily");
    expect(res).toMatchObject({ ok: true, run: { subject: "manual", status: "ok", reply: "reply from reviewer", delivered: true } });
    expect(prompts[0]!.split("\n\n")[0]).toBe("Daily");
    expect(sent).toEqual([{ chat: "telegram:7", text: "Trigger daily - manual\n\nreply from reviewer" }]);
    await reg.runTrigger("reviewer", "daily");
    expect(reg.triggerRuns("reviewer", 10)!.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(reg.triggerRuns("reviewer", 1)).toHaveLength(1);
    expect(reg.triggerRuns("nope", 10)).toBeUndefined();
    expect(reg.triggerRuns("../etc", 10)).toBeUndefined();
    expect(reg.runTrigger("reviewer", "missing")).toBeUndefined();
  });

  it("knows which env variables a github-pr trigger uses, for the check endpoint", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [ghTrigger({ tokenEnv: "REVIEW_PAT" }), cronTrigger()] });
    addAgent(p, "other", { triggers: [ghTrigger({ tokenEnv: "OTHER_PAT" })] });
    const { reg } = await setup(p);
    expect(reg.githubEnvNames().sort()).toEqual(["OTHER_PAT", "REVIEW_PAT"]);
  });

  it("close() stops every trigger", async () => {
    const p = home();
    addAgent(p, "reviewer", { triggers: [cronTrigger()] });
    const { reg, triggers } = await setup(p);
    await until(() => triggers()?.[0]?.nextRunAt !== undefined);
    await reg.close();
    expect(reg.runTrigger("reviewer", "daily")).toBeUndefined();
  });
});
