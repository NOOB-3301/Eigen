/**
 * Agent discovery + hot reload.
 *
 *   ~/.eigen/.agents/<id>/config.json      AgentConfigSchema (lib/schema.ts)
 *   ~/.eigen/.agents/<id>/instructions.md  role prompt (re-read every turn, so prompt edits need no reload)
 *   ~/.eigen/.agents/<id>/sandbox/         only when sandbox.mode = "own"
 *
 * Folders starting with "." or "_" are ignored (use `_drafts/`, `.trash/`).
 *
 * The registry diffs every scan against what is running, by a hash of the RESOLVED agent (agent file merged with
 * root config.json), so a root change that alters inherited values reloads exactly the agents it affects.
 * A file that becomes invalid never takes a running agent down: the last good version keeps running ("stale").
 *
 * Agents that are code-registered by Mastra's file router (the primary `eigen`, which owns the Telegram channel)
 * are never added/removed here; they read their resolved settings from `registry.resolved(id)` on every call.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { Agent, type MastraDBMessage } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { compact, maxBy, pick, pickBy } from "lodash-es";
import { z } from "zod";
import { makeChatQueue } from "./chat-queue.ts";
import { getConfig, reloadConfig, toMastraModel, type Config } from "./config.ts";
import { syncEnv, valueFingerprint } from "./envfile.ts";
import type { HomePaths } from "./home.ts";
import { memoryBlock, readText } from "./instructions.ts";
import { makeMemory } from "./memory.ts";
import {
  AGENT_CONFIG_FILE,
  AgentConfigSchema,
  AgentId,
  agentEnvNames,
  agentProblems,
  buildTopology,
  delegationEdges,
  fleetProblems,
  referencedEnvNames,
  resolveAgent,
  type AgentConfig,
  type AgentEvent,
  type AgentRuntime,
  type AgentSummary,
  type GetAgentRuntimeResponse,
  type ListAgentsResponse,
  type ResolvedAgent,
  type TelegramRuntime,
  type TriggerRuntime,
} from "./schema.ts";
import { readOwnSoul, soulText } from "./soul.ts";
import { instructionsPath } from "./store.ts";
import { makeMcp, type Mcp } from "./tools/mcp.ts";
import { makeWorkspace, refreshSkills } from "./tools/workspace.ts";
import { createBot, telegramChannels, type TelegramBot } from "./telegram.ts";
import { createTriggerManager } from "./triggers.ts";

/* ------------------------------------------------------------------------------------------------ */
/* Scan: pure read of the folder, no side effects                                                    */
/* ------------------------------------------------------------------------------------------------ */

export type ScannedAgent = {
  id: string;
  dir: string;
  config?: AgentConfig;
  resolved?: ResolvedAgent;
  instructionsFile?: string;
  problems: string[];
  /** Hash of the resolved settings plus a fingerprint of the env values the agent depends on (a rotated key rebuilds it); instructions text is excluded (it is re-read per turn). */
  hash?: string;
};

export type Scan = { agents: Map<string, ScannedAgent>; fleet: string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");

export function scanAgentDir(dir: string, root: Config, env: NodeJS.ProcessEnv = process.env): ScannedAgent {
  const id = basename(dir);
  const file = join(dir, AGENT_CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { id, dir, problems: [`cannot read ${AGENT_CONFIG_FILE}: ${(e as Error).message}`] };
  }
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) return { id, dir, problems: [z.prettifyError(parsed.error)] };
  const config = parsed.data;
  const problems = agentProblems(config, root);
  if (config.id !== id) problems.push(`id "${config.id}" must equal the folder name "${id}"`);
  const instructionsFile = instructionsPath(dir, config.instructions.file);
  if (!config.instructions.inline) {
    if (!instructionsFile) problems.push("instructions.file must stay inside the agent folder");
    else if (!existsSync(instructionsFile)) problems.push(`instructions file ${config.instructions.file} is missing`);
  }
  const resolved = resolveAgent(config, root);
  if (resolved.soul.source === "own") {
    const own = readOwnSoul(dir, resolved.soul.file); // like a missing instructions file: the agent is invalid (or stale), not silently running without its soul
    if ("problem" in own) problems.push(own.problem);
  }
  if (problems.length) return { id, dir, config, problems };
  const secrets = agentEnvNames(resolved, root).map((n) => `${n}=${valueFingerprint(env[n])}`);
  return { id, dir, config, resolved, instructionsFile, problems, hash: sha(JSON.stringify(resolved) + secrets.join(",")) };
}

export function scanAgents(agentsDir: string, root: Config, env: NodeJS.ProcessEnv = process.env): Scan {
  const agents = new Map<string, ScannedAgent>();
  // Sorted, so "the second owner" of a shared bot token is the same agent on every filesystem.
  const entries = existsSync(agentsDir) ? readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  for (const e of entries) if (e.isDirectory() && !ignoredDir(e.name)) agents.set(e.name, scanAgentDir(join(agentsDir, e.name), root, env));

  const valid = [...agents.values()].flatMap((a) => (a.config && !a.problems.length ? [a.config] : []));
  const cross = fleetProblems(valid, root);
  for (const [id, msgs] of Object.entries(cross)) {
    const a = agents.get(id);
    if (!a) continue;
    a.problems.push(...msgs);
    delete a.resolved; // a cross-agent problem makes the agent invalid too (e.g. two agents on one Telegram bot token)
    delete a.hash;
  }
  return { agents, fleet: cross["*"] ?? [] };
}

/* ------------------------------------------------------------------------------------------------ */
/* Factory: ResolvedAgent -> Mastra Agent. Injected so tests can stub it.                             */
/* ------------------------------------------------------------------------------------------------ */

export type BuiltAgent = {
  agent: Agent;
  dispose?: () => Promise<void>;
  mcpErrors?: Record<string, string>;
  /** This agent's own Telegram bot, if it has one. The registry stops it before a replacement is added (one poller per token). */
  telegram?: TelegramBot;
  /** Re-reads the skill folders now (the registry calls it when ~/.eigen/skills changes). Absent when the agent has no workspace. */
  refreshSkills?: () => Promise<void>;
};
export type AgentFactory = (r: ResolvedAgent, scanned: ScannedAgent, deps: FactoryDeps) => Promise<BuiltAgent>;
export type FactoryDeps = {
  paths: HomePaths;
  root: () => Config;
  rootMcp: Mcp;
  subAgents: (id: string) => Record<string, Agent>;
  resolved: (id: string) => ResolvedAgent | undefined;
  env: NodeJS.ProcessEnv;
  /** The bot token to start this agent's bot with. Undefined: no bot (not enabled, token not set, or another agent holds the same token). */
  telegramToken?: string;
  log?: (msg: string, extra?: unknown) => void;
};

/**
 * What a sub-agent sees of its caller's conversation. Mastra hands it the caller's messages INCLUDING the caller's system
 * prompt (with the user's memory files); that never goes along. An isolated agent gets only the delegation prompt; a shared
 * one also gets the user/assistant turns.
 */
export const delegationContext = (resolved: (id: string) => ResolvedAgent | undefined) => ({
  messageFilter: ({ messages, primitiveId }: { messages: MastraDBMessage[]; primitiveId: string }) =>
    resolved(primitiveId)?.memory.scope === "shared" ? messages.filter((m) => m.role === "user" || m.role === "assistant") : [],
});

const tag = (name: string, body: string) => (body ? `<${name}>\n${body}\n</${name}>` : "");

/** HomePaths with the sandbox moved into the agent's own folder. */
const ownSandboxPaths = (p: HomePaths, dir: string): HomePaths => {
  const sandboxDir = join(dir, "sandbox");
  return {
    ...p,
    sandboxDir,
    sandboxSkillsDir: join(sandboxDir, "skills"),
    sandboxQuarantineDir: join(sandboxDir, "skills-quarantine"),
    sandboxHomeDir: join(sandboxDir, ".home"),
    groundRulesFile: join(sandboxDir, "groundrules.md"),
  };
};

/**
 * MCPClient namespaces tools as `<server>_<tool>`; inherited servers reuse the root client instead of spawning a second process.
 * A tool belongs to the LONGEST server name that prefixes it, so inheriting "git" never leaks the tools of a server named "git_hub".
 */
export const toolsFromServers = <T,>(tools: Record<string, T>, servers: string[], allServers: string[]): Record<string, T> => {
  const owner = (name: string) => maxBy(allServers.filter((s) => name.startsWith(`${s}_`)), (s) => s.length);
  return pickBy(tools, (_t, name) => servers.includes(owner(name) ?? ""));
};

export const defaultAgentFactory: AgentFactory = async (r, scanned, { paths, root, rootMcp, subAgents, resolved, telegramToken, log }) => {
  const p = r.sandboxMode === "own" ? ownSandboxPaths(paths, scanned.dir) : paths;
  const cfgFor = (): Config => ({ ...root(), memory: r.memory, limits: { maxSteps: r.maxSteps } });

  // Private MCP servers get their own client; it is closed when this agent version is replaced.
  const ownMcp = Object.keys(r.mcp.own).length ? makeMcp() : undefined;
  const ownState = ownMcp ? await ownMcp.load({ ...cfgFor(), mcpServers: r.mcp.own }) : undefined;

  const workspace = r.builtinTools.includes("workspace") ? makeWorkspace(p, cfgFor(), undefined, `agent-${r.id}`, { skills: r.skills.inherit, log }) : undefined;

  // The bot is only created here (no polling yet); Mastra starts polling when the agent is added to it.
  const bot = telegramToken ? createBot({ token: telegramToken, allowedUserIds: r.telegram.allowedUserIds }) : undefined;
  let channels: ReturnType<typeof telegramChannels> | undefined;
  if (bot) {
    const queue = makeChatQueue();
    const { slashHandler } = await import("./commands.ts"); // loaded lazily: it pulls in the consolidation and skills code
    channels = telegramChannels(bot, { queue, verbose: () => false, isolatedAs: r.memory.scope === "isolated" ? r.id : undefined, slash: slashHandler({ paths, mcp: rootMcp, queue, agentId: r.id, baseModel: () => r.modelKey, restricted: true }) });
  }

  const agent = new Agent({
    id: r.id,
    name: r.name,
    description: r.description,
    // Re-read every turn, like the primary: prompt edits apply on the next message without a reload.
    instructions: () =>
      compact([
        tag("role", r.instructions.inline ?? readText(scanned.instructionsFile!)),
        tag("soul", soulText(r.soul, paths, scanned.dir)),
        r.instructions.includeMemoryFiles && tag("memory", memoryBlock(paths.memoryDir)),
      ]).join("\n\n"),
    model: toMastraModel(r.model),
    defaultOptions: { maxSteps: r.maxSteps, delegation: delegationContext(resolved) },
    memory: makeMemory(paths, cfgFor),
    workspace,
    tools: () => ({ ...toolsFromServers(rootMcp.tools(), r.mcp.inherited, rootMcp.state().servers), ...(ownMcp?.tools() ?? {}) }),
    agents: () => subAgents(r.id),
    ...(channels && { channels }),
  });

  return {
    agent,
    telegram: bot,
    refreshSkills: workspace && (() => refreshSkills(workspace)),
    dispose: async () => {
      await bot?.stop();
      await ownMcp?.close();
    },
    mcpErrors: Object.fromEntries(Object.entries(ownState?.errors ?? {}).map(([k, v]) => [`${r.id}/${k}`, v])),
  };
};

/* ------------------------------------------------------------------------------------------------ */
/* Registry: keeps Mastra in sync with the folder                                                     */
/* ------------------------------------------------------------------------------------------------ */

type Running = { hash: string; resolved: ResolvedAgent; built?: BuiltAgent; loadedAt: string };

export type RegistryOptions = {
  paths: HomePaths;
  rootMcp: Mcp;
  /** Ids registered by Mastra's file router; the registry tracks their settings but never adds/removes them. */
  fsAgentIds?: string[];
  factory?: AgentFactory;
  debounceMs?: number;
  log?: (msg: string, extra?: unknown) => void;
  /** The environment the registry reads secrets from and mirrors ~/.eigen/.env into. Tests pass a plain object. */
  env?: NodeJS.ProcessEnv;
};

/** The primary's bot is built at boot from root config (agents/eigen/config.ts), so what it was built with is remembered to tell when a restart is needed. */
type TrackedBot = { bot: TelegramBot; boot: { tokenEnv: string; allowedUserIds: number[]; tokenFp: string }; off: () => void };
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function createAgentRegistry(opts: RegistryOptions) {
  const { paths, rootMcp, fsAgentIds = ["eigen"], factory = defaultAgentFactory, debounceMs = 300, log = () => undefined, env = process.env } = opts;
  const events = new EventEmitter<{ event: [AgentEvent] }>();
  const running = new Map<string, Running>();
  const runtime = new Map<string, AgentRuntime>();
  const ownedEnv = new Map<string, string>();
  const tg = new Map<string, TelegramRuntime>();
  const tracked = new Map<string, TrackedBot>();
  let scan: Scan = { agents: new Map(), fleet: [] };
  let rootProblem: string | undefined;
  let mastra: Mastra | undefined;
  let attached: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let rev = 0;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  const emit = (e: AgentEvent) => events.emit("event", e);
  const isFs = (id: string) => fsAgentIds.includes(id);

  /** Cron and GitHub triggers wake agents on their own. They start with an agent version (load) and stop when the agent goes (unload). */
  const triggers = createTriggerManager({
    paths,
    env,
    log: (msg) => log(msg),
    emit: (id, trigger) => emit({ type: "agent.trigger", id, trigger }),
    timezone: () => getConfig().timezone,
    agentOf: (id) => {
      try {
        return running.get(id)?.built?.agent ?? (mastra && isFs(id) ? (mastra.getAgentById(id) as Agent) : undefined);
      } catch {
        return undefined; // the file router has not registered the primary yet
      }
    },
    botOf: (id) => running.get(id)?.built?.telegram ?? tracked.get(id)?.bot,
    secretsOf: (id) => {
      const r = running.get(id)?.resolved;
      return r ? agentEnvNames(r, getConfig()).flatMap((name) => env[name] ?? []) : [];
    },
  });

  /** An agent that is switched off still lists its triggers, as disabled. */
  const triggersOf = (id: string): TriggerRuntime[] | undefined => {
    const live = triggers.runtimes(id);
    if (live) return live.length ? live : undefined;
    const c = scan.agents.get(id)?.config;
    return c && !c.enabled && c.triggers.length ? c.triggers.map((t) => ({ id: t.id, type: t.type, state: "disabled" })) : undefined;
  };

  /** Runtime as the API reports it: the agent's load status plus its bot's and triggers' state. */
  const runtimeOf = (id: string): AgentRuntime | undefined => {
    const r = runtime.get(id);
    const t = tg.get(id);
    const tr = triggersOf(id);
    return r && (t || tr) ? { ...r, ...(t && { telegram: t }), ...(tr && { triggers: tr }) } : r;
  };

  function setTelegram(id: string, t: TelegramRuntime) {
    const cur = tg.get(id);
    if (cur && cur.state === t.state && cur.username === t.username && cur.error === t.error && cur.restartRequired === t.restartRequired) return;
    tg.set(id, t);
    emit({ type: "agent.telegram", id, telegram: t });
    emit({ type: "fleet.changed", rev: String(++rev) }); // topology carries the bot state too
  }

  const restartNeeded = (t: TrackedBot) => {
    const root = getConfig().telegram;
    return root.tokenEnv !== t.boot.tokenEnv || !sameIds(root.allowedUserIds, t.boot.allowedUserIds) || valueFingerprint(env[root.tokenEnv]) !== t.boot.tokenFp;
  };
  const withRestart = (id: string, s: TelegramRuntime): TelegramRuntime => {
    const t = tracked.get(id);
    const { restartRequired: _drop, ...rest } = s;
    return t && restartNeeded(t) ? { ...rest, restartRequired: true } : rest;
  };
  const refreshTracked = () => {
    for (const [id, t] of tracked) setTelegram(id, withRestart(id, t.bot.state()));
  };

  /**
   * Which agents may not start their bot because another bot already holds the same token VALUE (two env names can hold one token, and a
   * second poller on a token makes both fail with 409). The primary's bot wins, then the lowest id.
   */
  function tokenBlocks(): Map<string, string> {
    const owner = new Map<string, string>();
    const blocked = new Map<string, string>();
    for (const [id, t] of tracked) owner.set(t.boot.tokenFp, id);
    for (const s of scan.agents.values()) {
      const r = s.resolved;
      const name = r?.enabled && !isFs(s.id) && r.telegram.enabled ? r.telegram.tokenEnv : undefined;
      const value = name ? env[name] : undefined;
      if (!value) continue;
      const fp = valueFingerprint(value);
      const held = owner.get(fp);
      if (held && held !== s.id) blocked.set(s.id, held);
      else owner.set(fp, s.id);
    }
    return blocked;
  }

  const subAgents = (id: string): Record<string, Agent> => {
    const out: Record<string, Agent> = {};
    const live = [...running.values()].map((r) => r.resolved);
    for (const [src, dst] of delegationEdges(live)) {
      if (src !== id) continue;
      const agent = running.get(dst)?.built?.agent ?? (mastra && isFs(dst) ? (mastra.getAgentById(dst) as Agent) : undefined);
      if (agent) out[dst] = agent;
    }
    return out;
  };

  async function unload(id: string) {
    const cur = running.get(id);
    if (!cur) return;
    running.delete(id);
    triggers.drop(id); // before the bot: a run that finishes now must not try to deliver through a bot that is stopping
    // First the bot (no more messages for an agent that is going away), then the agent, then everything else it held.
    await cur.built?.telegram?.stop().catch((e) => log(`stopping the bot of ${id} failed`, e));
    if (!isFs(id)) mastra?.removeAgent(id);
    await cur.built?.dispose?.().catch((e) => log(`dispose ${id} failed`, e));
    if (!isFs(id)) tg.delete(id);
    emit({ type: "agent.removed", id });
  }

  async function load(s: ScannedAgent, blockedBy?: string) {
    const resolved = s.resolved!;
    const loadedAt = new Date().toISOString();
    if (isFs(s.id)) {
      running.set(s.id, { hash: s.hash!, resolved, loadedAt });
    } else {
      if (!mastra) return; // not attached yet; the attach() sync will load it
      const tokenName = resolved.telegram.enabled ? resolved.telegram.tokenEnv : undefined;
      const tokenValue = tokenName ? env[tokenName] : undefined;
      const built = await factory(resolved, s, { paths, root: getConfig, rootMcp, subAgents, resolved: (id) => running.get(id)?.resolved, env, telegramToken: blockedBy ? undefined : tokenValue, log });
      const prev = running.get(s.id);
      // Telegram allows one poller per token and Mastra starts polling as soon as the agent is added, so the old bot must be fully stopped first.
      await prev?.built?.telegram?.stop().catch((e) => log(`stopping the old bot of ${s.id} failed`, e));
      // Mastra's addAgent throws on an existing key, so swap: remove old, add new, then dispose old resources.
      mastra.removeAgent(s.id);
      mastra.addAgent(built.agent, s.id);
      running.set(s.id, { hash: s.hash!, resolved, built, loadedAt });
      setTelegram(
        s.id,
        built.telegram?.state() ??
          (!resolved.telegram.enabled
            ? { state: "off" }
            : blockedBy
              ? { state: "error", error: `this bot token is already used by "${blockedBy}"; one token serves one agent` }
              : { state: "missing-token", error: `${tokenName} is not set in .env` }),
      );
      built.telegram?.subscribe((next) => running.get(s.id)?.built === built && setTelegram(s.id, next));
      await prev?.built?.dispose?.().catch((e) => log(`dispose ${s.id} failed`, e));
    }
    triggers.sync(s.id, resolved);
    runtime.set(s.id, { status: "loaded", problems: [], loadedHash: s.hash, loadedAt, mcpErrors: running.get(s.id)?.built?.mcpErrors });
    emit({ type: "agent.loaded", id: s.id, hash: s.hash! });
  }

  /** One full reconcile. Serialized: overlapping watch events never interleave addAgent/removeAgent. */
  async function reconcile(reloadRoot: boolean) {
    let root: Config;
    try {
      root = reloadRoot ? reloadConfig() : getConfig();
      rootProblem = undefined;
    } catch (e) {
      rootProblem = (e as Error).message; // a broken root config.json freezes the fleet as-is
      emit({ type: "fleet.changed", rev: String(++rev) });
      return;
    }
    if (reloadRoot) await rootMcp.load(root).catch((e) => log("root MCP reload failed", e));

    scan = scanAgents(paths.agentsDir, root, env);
    const blocked = tokenBlocks();
    // A blocked bot is part of the agent's version, so the agent restarts its bot when the holder lets go of the token.
    for (const [id, by] of blocked) {
      const a = scan.agents.get(id);
      if (a?.hash) a.hash = sha(`${a.hash}|blocked-by:${by}`);
    }

    for (const id of running.keys()) if (!scan.agents.has(id)) await unload(id);

    for (const s of scan.agents.values()) {
      const cur = running.get(s.id);
      if (s.config && !s.config.enabled && !s.problems.length) {
        await unload(s.id);
        runtime.set(s.id, { status: "disabled", problems: [] });
        continue;
      }
      if (!s.resolved) {
        // Bad file: keep the last good version running, and say so.
        runtime.set(s.id, { ...(runtime.get(s.id) ?? {}), status: cur ? "stale" : "invalid", problems: s.problems });
        emit({ type: "agent.error", id: s.id, problems: s.problems, stale: !!cur });
        continue;
      }
      if (cur?.hash === s.hash) continue;
      try {
        await load(s, blocked.get(s.id));
      } catch (e) {
        const problems = [`failed to build: ${(e as Error).message}`];
        runtime.set(s.id, { ...(runtime.get(s.id) ?? {}), status: cur ? "stale" : "invalid", problems });
        emit({ type: "agent.error", id: s.id, problems, stale: !!cur });
      }
    }
    refreshTracked();
    emit({ type: "fleet.changed", rev: String(++rev) });
  }

  const sync = (reloadRoot = false) => (queue = queue.then(() => reconcile(reloadRoot)).catch((e) => log("agent sync failed", e)));

  /** Only an agent folder appearing, disappearing or being renamed (one segment), and its config.json / instruction files (two) matter; agents writing in their own sandbox must not trigger scans. */
  const relevant = (rel: string) => {
    const parts = rel.split(sep);
    if (ignoredDir(parts[0]!)) return false;
    return parts.length === 1 || (parts.length === 2 && /\.(json|md)$/.test(parts[1]!));
  };

  /** Debounced; a root change anywhere in the burst makes the whole burst a root reload. */
  let rootDirty = false;
  function onChange(reloadRoot: boolean) {
    rootDirty ||= reloadRoot;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = rootDirty;
      rootDirty = false;
      void sync(r);
    }, debounceMs);
  }

  /** ~/.eigen/.env changed: mirror it into the environment; only agents whose own env values changed rebuild (their hash covers them). */
  function onEnvChange() {
    const changed = syncEnv(paths, ownedEnv, env);
    if (!changed.length) return;
    const rootMcpEnv = new Set([...referencedEnvNames(getConfig())].filter(([, by]) => by.some((u) => u.startsWith("mcpServers."))).map(([n]) => n));
    onChange(changed.some((n) => rootMcpEnv.has(n))); // a root MCP server that reads the variable must reconnect
  }

  /** Does a change at `rel` (under ~/.eigen/skills, "/"-separated) reach this agent? Agents on "all" see every skill; the others only the ones they name. */
  const seesSkill = ({ inherit }: ResolvedAgent["skills"], rel: string) => inherit === "all" || (Array.isArray(inherit) && inherit.some((name) => rel === name || rel.startsWith(`${name}/`)));

  /** The skill library changed: the agents that see it re-read their skill folders now, instead of at Mastra's 30 s staleness check. */
  async function refreshAgentSkills(changed: string[]) {
    for (const [id, r] of running) {
      if (!changed.some((rel) => seesSkill(r.resolved.skills, rel))) continue;
      try {
        if (r.built) await r.built.refreshSkills?.();
        else {
          // The primary has no BuiltAgent: its workspace is the one Mastra assembled from agents/eigen/workspace.ts.
          const workspace = await (mastra?.getAgentById(id) as Agent | undefined)?.getWorkspace?.();
          if (workspace) await refreshSkills(workspace);
        }
      } catch (e) {
        log(`refreshing the skills of ${id} failed`, e);
      }
    }
  }

  /** Debounced like the agent folder; every path in the burst is kept so only the agents that see one of them refresh. */
  const changedSkills = new Set<string>();
  let skillsTimer: NodeJS.Timeout | undefined;
  function onSkillsChange(rel: string) {
    const parts = rel.split(sep);
    if (parts.some((p) => p.startsWith(".")) || rel.endsWith(".tmp")) return; // the studio writes through a .tmp file and renames it
    changedSkills.add(parts.join("/"));
    clearTimeout(skillsTimer);
    skillsTimer = setTimeout(() => {
      const changed = [...changedSkills];
      changedSkills.clear();
      void refreshAgentSkills(changed);
    }, debounceMs);
  }

  return {
    events,

    /** Idempotent. Call as early as a Mastra instance is reachable; the first call loads every agent. */
    attach(m: Mastra): Promise<void> {
      if (mastra === m && attached) return attached;
      mastra = m;
      syncEnv(paths, ownedEnv, env);
      return (attached = sync());
    },

    /** Initial scan without Mastra (so the fs primary can read its resolved settings at module load). */
    start() {
      syncEnv(paths, ownedEnv, env);
      return sync();
    },

    /** Mirror .env into the environment right now (the studio writes a key, then immediately asks for a check). */
    syncEnvNow: () => void syncEnv(paths, ownedEnv, env),

    /** Env names that hold a Telegram bot token in some config: the only names the token check may read. */
    telegramEnvNames(): string[] {
      const names = new Set([getConfig().telegram.tokenEnv]);
      for (const s of scan.agents.values()) if (s.config?.telegram.tokenEnv) names.add(s.config.telegram.tokenEnv);
      return [...names];
    },

    /** Env names that hold a GitHub token in some github-pr trigger: with GITHUB_*, the only names the GitHub check may read. */
    githubEnvNames(): string[] {
      const names = new Set<string>();
      for (const s of scan.agents.values()) for (const t of s.config?.triggers ?? []) if (t.type === "github-pr") names.add(t.tokenEnv);
      return [...names];
    },

    /** Run history of an agent's triggers, newest first. Undefined for an agent that does not exist. */
    triggerRuns: (id: string, limit: number) => (scan.agents.has(id) && AgentId.safeParse(id).success ? triggers.runs(id, limit) : undefined),

    /** Fires one trigger now and resolves when the run is over. Undefined for an agent or trigger that is not running. */
    runTrigger: (id: string, triggerId: string) => triggers.runNow(id, triggerId),

    /** The primary's bot (built at boot by agents/eigen/config.ts): report its state like any other, and flag when a change needs a restart. */
    trackBot(id: string, bot: TelegramBot, boot: { tokenEnv: string; allowedUserIds: number[] }) {
      tracked.get(id)?.off();
      const t: TrackedBot = { bot, boot: { ...boot, tokenFp: valueFingerprint(env[boot.tokenEnv]) }, off: () => undefined };
      tracked.set(id, t);
      t.off = bot.subscribe((next) => setTelegram(id, withRestart(id, next)));
      setTelegram(id, withRestart(id, bot.state()));
    },

    /** Re-scan now (tests, or after an out-of-band change). `reloadRoot` also re-reads config.json and reconnects root MCP. */
    reload: (reloadRoot = false) => sync(reloadRoot),

    watch() {
      if (watchers.length) return;
      // Recursive fs.watch: native on macOS, supported on Linux since Node 20. Rename-replace (atomic writes) fires too.
      watchers.push(watch(paths.agentsDir, { recursive: true }, (_e, f) => f && relevant(f.toString()) && onChange(false)));
      watchers.push(
        watch(dirname(paths.configFile), (_e, f) => {
          const name = f?.toString();
          if (name === basename(paths.configFile)) onChange(true);
          else if (name === basename(paths.envFile)) onEnvChange();
        }),
      );
      // The studio's skill editor writes ~/.eigen/skills/<slug>/SKILL.md.
      if (existsSync(paths.userSkillsDir)) watchers.push(watch(paths.userSkillsDir, { recursive: true }, (_e, f) => f && onSkillsChange(f.toString())));
    },

    async close() {
      clearTimeout(timer);
      clearTimeout(skillsTimer);
      watchers.splice(0).forEach((w) => w.close());
      await queue;
      await triggers.close();
      for (const id of [...running.keys()]) await unload(id);
      for (const t of tracked.values()) {
        t.off();
        await t.bot.stop().catch((e) => log("stopping the primary bot failed", e));
      }
      tracked.clear();
    },

    /** Settings for an agent the file router owns (the primary reads its model/maxSteps/etc. from here). */
    resolved: (id: string) => running.get(id)?.resolved,
    primaryId: () => [...running.values()].find((r) => r.resolved.primary)?.resolved.id ?? fsAgentIds[0]!,
    subAgents,

    /** Body for GET /eigen/agents/:id. */
    detail(id: string): GetAgentRuntimeResponse | undefined {
      const s = scan.agents.get(id);
      const r = running.get(id)?.resolved;
      if (!s && !r) return undefined;
      return { id, runtime: runtimeOf(id) ?? { status: "invalid", problems: s?.problems ?? [] }, resolved: r ?? s?.resolved ?? null };
    },

    summaries(): AgentSummary[] {
      return [...scan.agents.values()].map((s) => {
        const r = running.get(s.id)?.resolved ?? s.resolved;
        const c = s.config;
        return {
          id: s.id,
          name: r?.name ?? c?.name ?? s.id,
          role: r?.role ?? c?.role ?? "",
          description: r?.description ?? c?.description ?? "",
          enabled: c?.enabled ?? false,
          primary: r?.primary ?? c?.primary ?? false,
          modelKey: r?.modelKey ?? c?.model ?? "",
          telegram: r?.telegram ?? { enabled: false, allowedUserIds: [], source: "root" as const },
          runtime: runtimeOf(s.id) ?? { status: "invalid", problems: s.problems },
        };
      });
    },

    /** Body for the engine's GET /eigen/agents (the web app merges it with what it reads from disk). */
    snapshot(): ListAgentsResponse {
      const summaries = this.summaries();
      const resolved = [...running.values()].map((r) => r.resolved);
      const mcpErrors = Object.assign({}, rootMcp.state().errors, ...[...running.values()].map((r) => r.built?.mcpErrors ?? {}));
      const root = getConfig();
      return {
        agents: summaries,
        fleetProblems: compact([rootProblem, ...scan.fleet]),
        topology: buildTopology(summaries, resolved, pick(root, "mcpServers"), mcpErrors),
        rev: String(rev),
      };
    },
  };
}

export type AgentRegistry = ReturnType<typeof createAgentRegistry>;
