import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { createAgentRegistry, type AgentRegistry, type RegistryOptions } from "../../src/mastra/lib/agents.ts";
import type { AgentFactory, FactoryContext } from "../../src/mastra/lib/factory.ts";
import type { HomePaths } from "../../src/mastra/lib/home.ts";
import type { AgentEvent, ResolvedAgent, TelegramRuntime } from "../../src/mastra/lib/schema.ts";
import type { TelegramBot } from "../../src/mastra/lib/telegram.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("timed out");
}

/** A bot whose state the test drives. stop() takes a moment and is recorded in the shared order log. */
export function fakeBot(label: string, order: string[]) {
  let current: TelegramRuntime = { state: "starting" };
  const subs = new Set<(t: TelegramRuntime) => void>();
  let stopped = false;
  const sent: Array<{ chat: string; text: string }> = [];
  const bot = {
    adapter: { openDM: async (id: string) => `telegram:${id}`, postMessage: async (chat: string, text: string) => void sent.push({ chat, text }) },
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
    sent,
    get stopped() {
      return stopped;
    },
  };
  return bot as unknown as TelegramBot & { set: (t: TelegramRuntime) => void; stopped: boolean; sent: typeof sent };
}

export type FakeBot = ReturnType<typeof fakeBot>;

const open: AgentRegistry[] = [];
/** Call from afterEach. */
export const closeRegistries = () => Promise.all(open.splice(0).map((r) => r.close()));

/**
 * A registry with a stub factory (no real Mastra agents) and a fake Mastra. Records every build: what each agent was built with (its env, its
 * bot token, its paths), the order of bot stops, adds, removes and disposals, and every event.
 */
export function registryRig(p: Pick<HomePaths, "agentsDir">, opts: Omit<RegistryOptions, "paths" | "factory"> = {}, { failBuild }: { failBuild?: (r: ResolvedAgent) => boolean } = {}) {
  const order: string[] = [];
  const bots = new Map<string, FakeBot[]>();
  const builds: Record<string, number> = {};
  const contexts: Record<string, FactoryContext[]> = {};
  const refreshed: string[] = [];
  const factory: AgentFactory = async (r, ctx) => {
    if (failBuild?.(r)) throw new Error(`cannot build ${r.id}`);
    const n = (builds[r.id] = (builds[r.id] ?? 0) + 1);
    (contexts[r.id] ??= []).push(ctx);
    const bot = ctx.telegramToken ? fakeBot(`${r.id}#${n}`, order) : undefined;
    if (bot) bots.set(r.id, [...(bots.get(r.id) ?? []), bot]);
    return {
      agent: { id: r.id, name: r.name, version: n } as unknown as Agent,
      telegram: bot,
      refreshSkills: async () => void refreshed.push(r.id),
      dispose: async () => void order.push(`disposed:${r.id}#${n}`),
    };
  };
  const reg = createAgentRegistry({ paths: p, factory, debounceMs: 40, disposeGraceMs: 0, timezone: () => "UTC", ...opts });
  open.push(reg);
  const events: AgentEvent[] = [];
  reg.events.on("event", (e) => events.push(e));
  const agents = new Map<string, Agent>();
  const mastra = {
    addAgent: (a: Agent, key: string) => {
      if (agents.has(key)) throw new Error(`duplicate ${key}`);
      order.push(`add:${key}`);
      agents.set(key, a);
    },
    removeAgent: (key: string) => (agents.has(key) && order.push(`remove:${key}`), agents.delete(key)),
    getAgentById: (key: string) => agents.get(key),
  };
  /** macOS replays file events from just before a recursive watch started; let those arrive and settle before a test acts. */
  const watch = async () => {
    reg.watch();
    await sleep(400);
    await reg.reload();
    refreshed.length = 0;
  };
  return { reg, order, bots, builds, contexts, refreshed, events, agents, watch, attach: () => reg.attach(mastra as unknown as Mastra) };
}

export const telegramEvents = (events: AgentEvent[], id: string) => events.flatMap((e) => (e.type === "agent.telegram" && e.id === id ? [e.telegram] : []));
