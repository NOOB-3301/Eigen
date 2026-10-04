/**
 * Agent discovery + hot reload. Every agent is a standalone folder, ~/.eigen/agents/<id>/ (schema.ts lists what is in it).
 * Folders starting with "." or "_" are ignored (`.trash/`, `_drafts/`).
 *
 * The registry diffs every scan against what is running, by a hash of the RESOLVED agent plus fingerprints of the .env values it uses, so a
 * config edit or a rotated key rebuilds exactly that agent and nobody else. A file that becomes invalid never takes a running agent down: the
 * last good version keeps running ("stale").
 *
 * The registry owns WHEN an agent is built, replaced and disposed; lib/factory.ts owns WHAT it is made of. The registry never reads
 * process.env for an agent: each agent's values come from its own .env and are handed to the factory and its triggers only.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { Mastra } from "@mastra/core/mastra";
import { z } from "zod";
import { readEnvFile, valueFingerprint } from "./envfile.ts";
import { defaultAgentFactory, type AgentFactory, type BuiltAgent } from "./factory.ts";
import { readAgentMd } from "./soul.ts";
import { agentPaths, machineTimezone, type AgentPaths, type HomePaths } from "./home.ts";
import {
  AGENT_CONFIG_FILE,
  AgentConfigSchema,
  AgentId,
  agentEnvNames,
  agentProblems,
  buildTopology,
  fleetProblems,
  missingKeys,
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
import { createTriggerManager, type TriggerDeps } from "./triggers.ts";

/* ------------------------------------------------------------------------------------------------ */
/* Scan: pure read of the folder, no side effects                                                    */
/* ------------------------------------------------------------------------------------------------ */

export type ScannedAgent = {
  id: string;
  paths: AgentPaths;
  config?: AgentConfig;
  resolved?: ResolvedAgent;
  /** The agent's .env as read by this scan. Only this agent's version (its factory call and triggers) ever sees it. */
  env: ReadonlyMap<string, string>;
  problems: string[];
  /** Hash of the resolved settings plus fingerprints of the env values the agent uses; the instructions and soul text are excluded (re-read per turn). */
  hash?: string;
};

export type Scan = { agents: Map<string, ScannedAgent>; fleet: string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");

export function scanAgentDir(p: Pick<HomePaths, "agentsDir">, id: string, zone = machineTimezone()): ScannedAgent {
  const paths = agentPaths(p, id);
  const env = readEnvFile(paths.envFile);
  const base = { id, paths, env };
  if (!AgentId.safeParse(id).success) return { ...base, problems: [`"${id}" is not a valid agent id (a-z, 0-9 and "-", starting with a letter)`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (e) {
    return { ...base, problems: [`cannot read ${AGENT_CONFIG_FILE}: ${(e as Error).message}`] };
  }
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) return { ...base, problems: [z.prettifyError(parsed.error)] };
  const config = parsed.data;
  const problems = agentProblems(config);
  if (config.id !== id) problems.push(`id "${config.id}" must equal the folder name "${id}"`);
  // The same confined reader the prompt uses: a file that is missing, or a link leading out of the folder (to .env, say), makes the agent invalid
  // (or stale) instead of letting it run with an empty prompt or with a secret as its prompt.
  if (config.instructions.inline === undefined) {
    const read = readAgentMd(paths.dir, config.instructions.file);
    if ("problem" in read) problems.push(`instructions.file: ${read.problem}`);
  }
  if (config.soul.enabled) {
    const read = readAgentMd(paths.dir, config.soul.file);
    if ("problem" in read) problems.push(`soul.file: ${read.problem}`);
  }
  problems.push(...missingKeys(config, (n) => !!env.get(n)));
  if (problems.length) return { ...base, config, problems };
  const resolved = resolveAgent(config, zone);
  const secrets = agentEnvNames(config).map((n) => `${n}=${valueFingerprint(env.get(n))}`);
  return { ...base, config, resolved, problems, hash: sha(JSON.stringify(resolved) + secrets.join(",")) };
}

export function scanAgents(p: Pick<HomePaths, "agentsDir">, zone = machineTimezone()): Scan {
  const agents = new Map<string, ScannedAgent>();
  // Sorted, so "the second owner" of a shared bot token is the same agent on every filesystem.
  const entries = existsSync(p.agentsDir) ? readdirSync(p.agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  for (const e of entries) if (e.isDirectory() && !ignoredDir(e.name)) agents.set(e.name, scanAgentDir(p, e.name, zone));

  const valid = [...agents.values()].flatMap((a) => (a.config && !a.problems.length ? [a.config] : []));
  for (const [id, msgs] of Object.entries(fleetProblems(valid))) {
    const a = agents.get(id);
    if (!a) continue;
    a.problems.push(...msgs);
    delete a.resolved; // a cross-agent problem makes the agent invalid too (two agents on one remote database)
    delete a.hash;
  }
  return { agents, fleet: [] };
}

/**
 * Which agents may not start their bot because an agent before them (by id) has the same token VALUE in its .env. Telegram allows one poller
 * per token, and a second one makes both fail with 409. The blocked agent still loads, just without a bot.
 */
export function tokenBlocks(scan: Scan): Map<string, string> {
  const owner = new Map<string, string>();
  const blocked = new Map<string, string>();
  for (const s of scan.agents.values()) {
    const r = s.resolved;
    const value = r?.enabled && r.telegram.enabled ? s.env.get(r.telegram.tokenEnv) : undefined;
    if (!value) continue;
    const fp = valueFingerprint(value);
    const held = owner.get(fp);
    if (held) blocked.set(s.id, held);
    else owner.set(fp, s.id);
  }
  return blocked;
}

/* ------------------------------------------------------------------------------------------------ */
/* Registry: keeps Mastra in sync with the folder                                                     */
/* ------------------------------------------------------------------------------------------------ */

type Running = { hash: string; resolved: ResolvedAgent; env: ReadonlyMap<string, string>; built: BuiltAgent; loadedAt: string };

export type RegistryOptions = {
  paths: Pick<HomePaths, "agentsDir">;
  factory?: AgentFactory;
  debounceMs?: number;
  /**
   * How long a replaced version's storage, MCP clients and the like stay open after its replacement is live. A message that was already being answered
   * holds them, so closing at once would fail that reply. Tests pass 0.
   */
  disposeGraceMs?: number;
  log?: (msg: string, extra?: unknown) => void;
  /** The machine's time zone, for agents that name none. Tests pin it. */
  timezone?: () => string;
  /** Passed through to the trigger manager (tests: a fake clock, a fake GitHub, a stub run). */
  triggers?: Partial<Pick<TriggerDeps, "clock" | "fetchFn" | "runAgent" | "githubApi" | "runTimeoutMs">>;
};

export function createAgentRegistry(opts: RegistryOptions) {
  const { paths, factory = defaultAgentFactory, debounceMs = 300, disposeGraceMs = 30_000, log = () => undefined, timezone = machineTimezone } = opts;
  const events = new EventEmitter<{ event: [AgentEvent] }>();
  const running = new Map<string, Running>();
  const runtime = new Map<string, AgentRuntime>();
  const tg = new Map<string, TelegramRuntime>();
  let scan: Scan = { agents: new Map(), fleet: [] };
  let mastra: Mastra | undefined;
  let attached: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let rev = 0;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  const emit = (e: AgentEvent) => events.emit("event", e);

  /** Versions waiting to be closed (see disposeGraceMs): the timer, and what to run when it fires or the registry closes. */
  const retired = new Map<NodeJS.Timeout, () => Promise<void>>();
  const retire = (id: string, built: BuiltAgent) => {
    const close = () => built.dispose().catch((e) => log(`dispose ${id} failed`, e));
    if (!disposeGraceMs) return close();
    const t = setTimeout(() => {
      retired.delete(t);
      void close();
    }, disposeGraceMs);
    t.unref();
    retired.set(t, close);
  };

  /** Cron and GitHub triggers wake agents on their own. They start with an agent version (load) and stop when the agent goes (unload). */
  const triggers = createTriggerManager({
    paths,
    ...opts.triggers,
    log: (msg) => log(msg),
    emit: (id, trigger) => emit({ type: "agent.trigger", id, trigger }),
    agentOf: (id) => running.get(id)?.built.agent,
    botOf: (id) => running.get(id)?.built.telegram,
    envOf: (id) => running.get(id)?.env ?? new Map(),
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
    if (cur && cur.state === t.state && cur.username === t.username && cur.error === t.error) return;
    tg.set(id, t);
    emit({ type: "agent.telegram", id, telegram: t });
    emit({ type: "fleet.changed", rev: String(++rev) }); // topology carries the bot state too
  }

  async function unload(id: string) {
    const cur = running.get(id);
    if (!cur) return;
    running.delete(id);
    triggers.drop(id); // before the bot: a run that finishes now must not try to deliver through a bot that is stopping
    // First the bot (no more messages for an agent that is going away), then the agent, then everything else it held.
    await cur.built.telegram?.stop().catch((e) => log(`stopping the bot of ${id} failed`, e));
    mastra?.removeAgent(id);
    await retire(id, cur.built);
    tg.delete(id);
    emit({ type: "agent.removed", id });
  }

  const loadedRuntime = (r: Running): AgentRuntime => {
    const errors = r.built.mcpErrors;
    return { status: "loaded", problems: [], loadedHash: r.hash, loadedAt: r.loadedAt, ...(errors && Object.keys(errors).length && { mcpErrors: errors }) };
  };

  /** What the agent's bot reports when it has none. */
  const noBot = (r: ResolvedAgent, blockedBy: string | undefined, tokenSet: boolean): TelegramRuntime =>
    !r.telegram.enabled
      ? { state: "off" }
      : blockedBy
        ? { state: "error", error: `this bot token is also used by "${blockedBy}"; one token serves one agent` }
        : !tokenSet
          ? { state: "missing-token", error: `${r.telegram.tokenEnv} is not set in this agent's keys` }
          : { state: "error", error: "the bot was not built" };

  async function load(m: Mastra, s: ScannedAgent, blockedBy?: string) {
    const resolved = s.resolved!;
    const loadedAt = new Date().toISOString();
    const token = resolved.telegram.enabled ? s.env.get(resolved.telegram.tokenEnv) : undefined;
    const built = await factory(resolved, { paths: s.paths, env: s.env, telegramToken: blockedBy ? undefined : token, reload: () => sync(), log });
    const prev = running.get(s.id);
    // Telegram allows one poller per token and Mastra starts polling as soon as the agent is added, so the old bot must be fully stopped first.
    await prev?.built.telegram?.stop().catch((e) => log(`stopping the old bot of ${s.id} failed`, e));
    // Mastra's addAgent throws on an existing key, so swap: remove old, add new, then dispose old resources.
    m.removeAgent(s.id);
    m.addAgent(built.agent, s.id);
    running.set(s.id, { hash: s.hash!, resolved, env: s.env, built, loadedAt });
    setTelegram(s.id, built.telegram?.state() ?? noBot(resolved, blockedBy, !!token));
    built.telegram?.subscribe((next) => running.get(s.id)?.built === built && setTelegram(s.id, next));
    if (prev) await retire(s.id, prev.built);
    triggers.sync(s.id, resolved);
    runtime.set(s.id, loadedRuntime(running.get(s.id)!));
    emit({ type: "agent.loaded", id: s.id, hash: s.hash! });
  }

  /** One full reconcile. Serialized: overlapping watch events never interleave addAgent/removeAgent. */
  async function reconcile() {
    scan = scanAgents(paths, timezone());
    const m = mastra;
    if (!m) return; // not attached yet: attach() runs the first real sync
    const blocked = tokenBlocks(scan);
    // A blocked bot is part of the agent's version, so the agent starts its bot when the holder lets go of the token.
    for (const [id, by] of blocked) {
      const a = scan.agents.get(id);
      if (a?.hash) a.hash = sha(`${a.hash}|blocked-by:${by}`);
    }

    for (const id of [...running.keys()]) if (!scan.agents.has(id)) await unload(id);
    for (const id of [...runtime.keys()]) if (!scan.agents.has(id) && !running.has(id)) runtime.delete(id);

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
      if (cur && cur.hash === s.hash) {
        // Unchanged; a file that was broken and is back to the running version is simply loaded again.
        if (runtime.get(s.id)?.status !== "loaded") runtime.set(s.id, loadedRuntime(cur));
        continue;
      }
      try {
        await load(m, s, blocked.get(s.id));
      } catch (e) {
        const problems = [`failed to build: ${(e as Error).message}`];
        runtime.set(s.id, { ...(runtime.get(s.id) ?? {}), status: cur ? "stale" : "invalid", problems });
        emit({ type: "agent.error", id: s.id, problems, stale: !!cur });
      }
    }
    emit({ type: "fleet.changed", rev: String(++rev) });
  }

  const sync = () => (queue = queue.then(reconcile).catch((e) => log("agent sync failed", e)));

  function onChange() {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), debounceMs);
  }

  /** The skills of one agent changed: that agent re-reads its skill folders now, instead of at Mastra's 30 s staleness check. Debounced per agent. */
  const skillTimers = new Map<string, NodeJS.Timeout>();
  function onSkillsChange(id: string) {
    clearTimeout(skillTimers.get(id));
    skillTimers.set(
      id,
      setTimeout(() => {
        skillTimers.delete(id);
        const built = running.get(id)?.built;
        built?.refreshSkills?.().catch((e) => log(`refreshing the skills of ${id} failed`, e));
      }, debounceMs),
    );
  }

  /**
   * Routes one fs event under agents/ (path relative to it). Only a folder appearing or going, its config.json, .env and top-level .md files
   * mean a re-scan; skills/** and sandbox/skills/** mean a skills refresh for that agent only. Everything else an agent writes (its sandbox,
   * data/, memory.db) is ignored, so an agent at work never causes scans.
   */
  function onFsEvent(rel: string) {
    const parts = rel.split(sep);
    const [id, name] = parts;
    if (!id || ignoredDir(id)) return;
    if (parts.length === 1) return onChange();
    if (parts.length === 2 && (name === AGENT_CONFIG_FILE || name === ".env" || /^[^.].*\.md$/.test(name!))) return onChange();
    const inSkills = name === "skills" ? parts.slice(2) : name === "sandbox" && parts[2] === "skills" ? parts.slice(3) : undefined;
    if (!inSkills?.length || inSkills.some((x) => x.startsWith(".")) || rel.endsWith(".tmp")) return; // the studio writes through a .tmp file and renames it
    onSkillsChange(id);
  }

  return {
    events,

    /** Idempotent. Call as early as a Mastra instance is reachable; the first call loads every agent. */
    attach(m: Mastra): Promise<void> {
      if (mastra === m && attached) return attached;
      mastra = m;
      return (attached = sync());
    },

    /** Re-scan now (tests, the /reload command, or after an out-of-band change). */
    reload: () => sync(),

    watch() {
      if (watchers.length) return;
      // Recursive fs.watch: native on macOS, supported on Linux since Node 20. Rename-replace (atomic writes) fires too.
      watchers.push(watch(paths.agentsDir, { recursive: true }, (_e, f) => f && onFsEvent(f.toString())));
    },

    async close() {
      clearTimeout(timer);
      skillTimers.forEach((t) => clearTimeout(t));
      skillTimers.clear();
      watchers.splice(0).forEach((w) => w.close());
      await queue;
      await triggers.close();
      for (const id of [...running.keys()]) await unload(id);
      for (const [t, close] of [...retired]) {
        clearTimeout(t);
        await close(); // shutting down: nothing is left to finish
      }
      retired.clear();
    },

    /** Whether a folder for this agent exists (valid or not). The check routes answer 404 otherwise. */
    exists: (id: string) => AgentId.safeParse(id).success && scan.agents.has(id),
    /** The agent's config as last scanned, when it parsed. */
    config: (id: string) => scan.agents.get(id)?.config,
    /** Settings of the running version (the last good one for a stale agent). */
    resolved: (id: string) => running.get(id)?.resolved,

    /** Run history of an agent's triggers, newest first. Undefined for an agent that does not exist. */
    triggerRuns: (id: string, limit: number) => (AgentId.safeParse(id).success && scan.agents.has(id) ? triggers.runs(id, limit) : undefined),
    /** Fires one trigger now and resolves when the run is over. Undefined for an agent or trigger that is not running. */
    runTrigger: (id: string, triggerId: string) => triggers.runNow(id, triggerId),

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
          modelKey: r?.modelKey ?? c?.model ?? "",
          telegram: { enabled: r?.telegram.enabled ?? c?.telegram.enabled ?? false, allowedUserIds: r?.telegram.allowedUserIds ?? c?.telegram.allowedUserIds ?? [] },
          runtime: runtimeOf(s.id) ?? { status: "invalid", problems: s.problems },
        };
      });
    },

    /** Body for the engine's GET /eigen/agents (the web app merges it with what it reads from disk). */
    snapshot(): ListAgentsResponse {
      const summaries = this.summaries();
      const resolved = [...running.values()].map((r) => r.resolved);
      return { agents: summaries, fleetProblems: scan.fleet, topology: buildTopology(summaries, resolved), rev: String(rev) };
    },
  };
}

export type AgentRegistry = ReturnType<typeof createAgentRegistry>;
