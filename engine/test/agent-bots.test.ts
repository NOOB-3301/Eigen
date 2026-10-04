import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRegistry, scanAgents, type AgentFactory, type AgentRegistry } from "../src/mastra/lib/agents.ts";
import { reloadConfig } from "../src/mastra/lib/config.ts";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import { agentEnvNames, type AgentConfigInput, type AgentEvent, type TelegramRuntime } from "../src/mastra/lib/schema.ts";
import type { TelegramBot } from "../src/mastra/lib/telegram.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { tmpHome } from "./helpers/home.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("timed out");
}

/** Root config with an allow-list (bots need one) and a model whose key lives in .env. */
function home() {
  const p = tmpHome();
  const seeded = JSON.parse(readFileSync(p.configFile, "utf8"));
  const models = { local: { id: "ollama/x", url: "http://localhost:11434/v1" }, keyed: { id: "openai/gpt-x", apiKeyEnv: "TEST_KEY_A" } };
  writeFileSync(p.configFile, JSON.stringify({ ...seeded, models, defaultModel: "local", curatorModel: "local", telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] } }));
  process.env.EIGEN_HOME = p.home;
  reloadConfig();
  return p;
}
const rootJson = (p: HomePaths) => JSON.parse(readFileSync(p.configFile, "utf8"));

function addAgent(p: HomePaths, id: string, patch: Partial<AgentConfigInput> = {}) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), `You are ${id}.`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, ...patch }));
}
const editAgent = (p: HomePaths, id: string, patch: Partial<AgentConfigInput>) => addAgent(p, id, patch);

const stubMcp = { load: async () => ({ tools: {}, errors: {}, servers: [] }), state: () => ({ tools: {}, errors: {}, servers: [] }), tools: () => ({}), close: async () => undefined } as unknown as Mcp;

/** A bot whose state the test drives. `log` records stop() in the shared order log. */
function fakeBot(label: string, order: string[]) {
  let current: TelegramRuntime = { state: "starting" };
  const subs = new Set<(t: TelegramRuntime) => void>();
  let stopped = false;
  const bot = {
    adapter: {},
    state: () => current,
    subscribe: (fn: (t: TelegramRuntime) => void) => (subs.add(fn), () => void subs.delete(fn)),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await sleep(20); // stopping takes a moment; the registry must wait for it
      order.push(`stopped:${label}`);
    },
    set(next: TelegramRuntime) {
      current = next;
      subs.forEach((f) => f(next));
    },
    get stopped() {
      return stopped;
    },
  };
  return bot as unknown as TelegramBot & { set: (t: TelegramRuntime) => void; stopped: boolean };
}

let open: AgentRegistry[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
});

function setup(p: HomePaths, env: NodeJS.ProcessEnv, debounceMs = 40) {
  const order: string[] = [];
  const bots = new Map<string, Array<ReturnType<typeof fakeBot>>>();
  const builds: Record<string, number> = {};
  const tokens: Record<string, Array<string | undefined>> = {};
  const factory: AgentFactory = async (r, _s, deps) => {
    const n = (builds[r.id] = (builds[r.id] ?? 0) + 1);
    (tokens[r.id] ??= []).push(deps.telegramToken);
    const bot = deps.telegramToken ? fakeBot(`${r.id}#${n}`, order) : undefined;
    if (bot) bots.set(r.id, [...(bots.get(r.id) ?? []), bot]);
    return { agent: { id: r.id } as unknown as Agent, telegram: bot, dispose: async () => void order.push(`disposed:${r.id}#${n}`) };
  };
  const reg = createAgentRegistry({ paths: p, rootMcp: stubMcp, factory, debounceMs, env });
  const events: AgentEvent[] = [];
  reg.events.on("event", (e) => events.push(e));
  const agents = new Map<string, Agent>();
  const mastra = {
    addAgent: (a: Agent, key: string) => (order.push(`add:${key}`), void agents.set(key, a)),
    removeAgent: (key: string) => (order.push(`remove:${key}`), agents.delete(key)),
    getAgentById: (key: string) => agents.get(key),
  };
  open.push(reg);
  return { reg, order, bots, builds, tokens, events, agents, attach: () => reg.attach(mastra as unknown as Mastra) };
}

const telegramEvents = (events: AgentEvent[], id: string) => events.flatMap((e) => (e.type === "agent.telegram" && e.id === id ? [e.telegram] : []));

describe("env values in an agent's version", () => {
  it("agentEnvNames lists exactly the variables an agent uses", () => {
    const p = home();
    addAgent(p, "alpha", { model: "keyed", telegram: { enabled: true, tokenEnv: "TG_ALPHA" }, tools: { mcp: { servers: { own: { command: "x", env: { A: "env:OWN_A", B: "plain" }, } } } } });
    addAgent(p, "beta", {});
    const { agents } = scanAgents(p.agentsDir, reloadConfig(), {});
    expect(agentEnvNames(agents.get("alpha")!.resolved!, reloadConfig())).toEqual(["OWN_A", "TEST_KEY_A", "TG_ALPHA"]);
    expect(agentEnvNames(agents.get("beta")!.resolved!, reloadConfig())).toEqual([]);
  });

  it("changes the hash of the agents that use a variable when its value changes, and nobody else's", () => {
    const p = home();
    addAgent(p, "alpha", { model: "keyed" });
    addAgent(p, "beta", {});
    addAgent(p, "gamma", { telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    const hashes = (env: NodeJS.ProcessEnv) => Object.fromEntries([...scanAgents(p.agentsDir, reloadConfig(), env).agents].map(([id, a]) => [id, a.hash]));
    const none = hashes({});
    const keyed = hashes({ TEST_KEY_A: "one" });
    const rotated = hashes({ TEST_KEY_A: "two" });
    const other = hashes({ TEST_KEY_A: "two", UNRELATED: "x" });
    expect(keyed.alpha).not.toBe(none.alpha);
    expect(rotated.alpha).not.toBe(keyed.alpha);
    expect(other).toEqual(rotated);
    for (const id of ["beta", "gamma", "eigen"]) expect([none[id], keyed[id], rotated[id]]).toEqual([none[id], none[id], none[id]]);
    expect(hashes({ TG_GAMMA: "1:a" }).gamma).not.toBe(none.gamma);
  });
});

describe("the .env watcher", () => {
  it("rebuilds only the agents whose variable changed, applies the value, and never emits it", async () => {
    const p = home();
    addAgent(p, "alpha", { model: "keyed" });
    addAgent(p, "beta", {});
    const env: NodeJS.ProcessEnv = {};
    const { reg, builds, events, attach } = setup(p, env);
    await attach();
    reg.watch();
    await sleep(150);
    expect(builds).toMatchObject({ alpha: 1, beta: 1 });

    setSecret(p, "TEST_KEY_A", "first-value-123");
    await until(() => builds.alpha === 2);
    expect(env.TEST_KEY_A).toBe("first-value-123");

    setSecret(p, "TEST_KEY_A", "second-value-456");
    await until(() => builds.alpha === 3);
    expect(env.TEST_KEY_A).toBe("second-value-456");

    setSecret(p, "SOMETHING_ELSE", "x");
    await sleep(500);
    expect(builds).toMatchObject({ alpha: 3, beta: 1 });
    expect(JSON.stringify(events)).not.toMatch(/first-value|second-value/);
    expect(JSON.stringify(reg.snapshot())).not.toMatch(/first-value|second-value/);
  });
});

describe("specialist bots in the registry", () => {
  it("says missing-token until the variable is set, then starts the bot without a restart", async () => {
    const p = home();
    addAgent(p, "gamma", { telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    const env: NodeJS.ProcessEnv = {};
    const { reg, bots, events, tokens, attach } = setup(p, env);
    await attach();
    reg.watch();
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "missing-token", error: "TG_GAMMA is not set in .env" });
    expect(tokens.gamma).toEqual([undefined]);

    setSecret(p, "TG_GAMMA", "111:token-gamma");
    await until(() => (bots.get("gamma") ?? []).length === 1);
    expect(tokens.gamma).toEqual([undefined, "111:token-gamma"]);
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "starting" });
    bots.get("gamma")![0]!.set({ state: "polling", username: "gamma_bot" });
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "polling", username: "gamma_bot" });
    expect(telegramEvents(events, "gamma").map((t) => t.state)).toEqual(["missing-token", "starting", "polling"]);
    const node = reg.snapshot().topology.nodes.find((n) => n.id === "channel:telegram:gamma");
    expect(node).toMatchObject({ data: { state: "polling", username: "gamma_bot", tokenEnv: "TG_GAMMA" } });
    expect(JSON.stringify(events)).not.toContain("111:token-gamma");
  });

  it("an agent without a bot of its own reports off", async () => {
    const p = home();
    addAgent(p, "plain", {});
    const { reg, attach } = setup(p, {});
    await attach();
    expect(reg.detail("plain")!.runtime.telegram).toEqual({ state: "off" });
  });

  it("stops the old bot completely BEFORE the replacement agent is added (one poller per token)", async () => {
    const p = home();
    addAgent(p, "gamma", { telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    const { reg, order, bots, builds, attach } = setup(p, { TG_GAMMA: "111:token-gamma" });
    await attach();
    reg.watch();
    await sleep(100);
    order.length = 0;

    editAgent(p, "gamma", { description: "Changed.", telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    await until(() => builds.gamma === 2 && order.includes("disposed:gamma#1")); // the swap is finished once the old agent's resources are released
    expect(order.indexOf("stopped:gamma#1")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("stopped:gamma#1")).toBeLessThan(order.indexOf("add:gamma"));
    expect(bots.get("gamma")![0]!.stopped).toBe(true);
    expect(bots.get("gamma")![1]!.stopped).toBe(false);
  });

  it("a replaced bot can no longer change the agent's reported state", async () => {
    const p = home();
    addAgent(p, "gamma", { telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    const { reg, order, bots, builds, attach } = setup(p, { TG_GAMMA: "111:token-gamma" });
    await attach();
    reg.watch();
    await sleep(100);
    editAgent(p, "gamma", { description: "Changed.", telegram: { enabled: true, tokenEnv: "TG_GAMMA" } });
    await until(() => builds.gamma === 2 && order.includes("disposed:gamma#1")); // swap finished
    const [old, fresh] = bots.get("gamma")!;
    fresh!.set({ state: "polling", username: "gamma_bot" });
    old!.set({ state: "error", error: "late noise from the old bot" });
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "polling", username: "gamma_bot" });
  });

  it("stops the bot when the agent folder is trashed, disabled, or the registry closes", async () => {
    const p = home();
    addAgent(p, "gone", { telegram: { enabled: true, tokenEnv: "TG_ONE" } });
    addAgent(p, "off", { telegram: { enabled: true, tokenEnv: "TG_TWO" } });
    addAgent(p, "stay", { telegram: { enabled: true, tokenEnv: "TG_THREE" } });
    const { reg, bots, attach } = setup(p, { TG_ONE: "1:a", TG_TWO: "2:b", TG_THREE: "3:c" });
    await attach();
    reg.watch();
    await sleep(100);

    mkdirSync(join(p.agentsDir, ".trash"), { recursive: true });
    renameSync(join(p.agentsDir, "gone"), join(p.agentsDir, ".trash", "gone-1"));
    editAgent(p, "off", { enabled: false, telegram: { enabled: true, tokenEnv: "TG_TWO" } });
    await until(() => bots.get("gone")![0]!.stopped && bots.get("off")![0]!.stopped);
    expect(bots.get("stay")![0]!.stopped).toBe(false);
    expect(reg.detail("gone")).toBeUndefined();

    await reg.close();
    expect(bots.get("stay")![0]!.stopped).toBe(true);
  });

  it("two env names holding the same token: the second agent's bot is not started, then is once the first lets go", async () => {
    const p = home();
    addAgent(p, "aaa", { telegram: { enabled: true, tokenEnv: "TG_AAA" } });
    addAgent(p, "bbb", { telegram: { enabled: true, tokenEnv: "TG_BBB" } });
    const env: NodeJS.ProcessEnv = { TG_AAA: "9:same", TG_BBB: "9:same" };
    const { reg, tokens, attach } = setup(p, env);
    await attach();
    expect(tokens.aaa).toEqual(["9:same"]);
    expect(tokens.bbb).toEqual([undefined]);
    expect(reg.detail("bbb")!.runtime).toMatchObject({ status: "loaded", telegram: { state: "error", error: expect.stringContaining('already used by "aaa"') } });

    env.TG_AAA = "9:rotated";
    await reg.reload();
    await until(() => tokens.bbb!.length === 2);
    expect(tokens.bbb).toEqual([undefined, "9:same"]);
    expect(tokens.aaa).toEqual(["9:same", "9:rotated"]);
    expect(reg.detail("bbb")!.runtime.telegram).toEqual({ state: "starting" });
  });

  it("a specialist can never take the primary's token, and the primary stays valid even when the specialist sorts first", async () => {
    const p = home();
    addAgent(p, "aaa", { telegram: { enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN" } });
    const { agents } = scanAgents(p.agentsDir, reloadConfig(), {});
    expect(agents.get("eigen")!.resolved).toBeDefined();
    expect(agents.get("aaa")!.resolved).toBeUndefined();
    expect(agents.get("aaa")!.problems.join()).toMatch(/tokenEnv "TELEGRAM_BOT_TOKEN" is already used by "eigen"/);

    addAgent(p, "bbb", { telegram: { enabled: true, tokenEnv: "TG_COPY" } });
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: "5:primary", TG_COPY: "5:primary" };
    const { reg, tokens, attach } = setup(p, env);
    reg.trackBot("eigen", fakeBot("eigen", []), { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] });
    await attach();
    expect(tokens.bbb).toEqual([undefined]);
    expect(reg.detail("bbb")!.runtime.telegram).toMatchObject({ state: "error", error: expect.stringContaining('already used by "eigen"') });
  });
});

describe("the primary's bot", () => {
  it("is reported like any other, and flags restartRequired when its root settings change after boot", async () => {
    const p = home();
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: "5:primary" };
    const { reg, events, attach } = setup(p, env);
    const bot = fakeBot("eigen", []);
    reg.trackBot("eigen", bot, { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] });
    await attach();
    bot.set({ state: "polling", username: "eigen_bot" });
    expect(reg.detail("eigen")!.runtime.telegram).toEqual({ state: "polling", username: "eigen_bot" });
    expect(telegramEvents(events, "eigen").map((t) => t.state)).toEqual(["starting", "polling"]);

    const cfg = (patch: object) => writeFileSync(p.configFile, JSON.stringify({ ...rootJson(p), ...patch }));
    cfg({ telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7, 8] } });
    await reg.reload(true);
    expect(reg.detail("eigen")!.runtime.telegram).toEqual({ state: "polling", username: "eigen_bot", restartRequired: true });
    expect(telegramEvents(events, "eigen").at(-1)).toMatchObject({ restartRequired: true });

    cfg({ telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] } });
    await reg.reload(true);
    expect(reg.detail("eigen")!.runtime.telegram).toEqual({ state: "polling", username: "eigen_bot" });

    env.TELEGRAM_BOT_TOKEN = "5:rotated";
    await reg.reload();
    expect(reg.detail("eigen")!.runtime.telegram).toMatchObject({ restartRequired: true });
    cfg({ telegram: { tokenEnv: "OTHER_TOKEN", allowedUserIds: [7] } });
    await reg.reload(true);
    expect(reg.detail("eigen")!.runtime.telegram).toMatchObject({ restartRequired: true });
  });

  it("close() stops it", async () => {
    const p = home();
    const { reg, order, attach } = setup(p, { TELEGRAM_BOT_TOKEN: "5:primary" });
    reg.trackBot("eigen", fakeBot("eigen", order), { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [7] });
    await attach();
    await reg.close();
    expect(order).toContain("stopped:eigen");
  });
});
