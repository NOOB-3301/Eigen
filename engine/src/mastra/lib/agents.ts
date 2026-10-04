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
import { getConfig, reloadConfig, toMastraModel, type Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import { memoryBlock, readText } from "./instructions.ts";
import { makeMemory } from "./memory.ts";
import {
  AGENT_CONFIG_FILE,
  AgentConfigSchema,
  agentProblems,
  buildTopology,
  delegationEdges,
  fleetProblems,
  resolveAgent,
  type AgentConfig,
  type AgentEvent,
  type AgentRuntime,
  type AgentSummary,
  type GetAgentRuntimeResponse,
  type ListAgentsResponse,
  type ResolvedAgent,
} from "./schema.ts";
import { instructionsPath } from "./store.ts";
import { makeMcp, type Mcp } from "./tools/mcp.ts";
import { makeWorkspace } from "./tools/workspace.ts";

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
  /** Hash of resolved settings; instructions text is excluded (it is re-read per turn). */
  hash?: string;
};

export type Scan = { agents: Map<string, ScannedAgent>; fleet: string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const ignoredDir = (name: string) => name.startsWith(".") || name.startsWith("_");

export function scanAgentDir(dir: string, root: Config): ScannedAgent {
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
  if (problems.length) return { id, dir, config, problems };
  const resolved = resolveAgent(config, root);
  return { id, dir, config, resolved, instructionsFile, problems, hash: sha(JSON.stringify(resolved)) };
}

export function scanAgents(agentsDir: string, root: Config): Scan {
  const agents = new Map<string, ScannedAgent>();
  const entries = existsSync(agentsDir) ? readdirSync(agentsDir, { withFileTypes: true }) : [];
  for (const e of entries) if (e.isDirectory() && !ignoredDir(e.name)) agents.set(e.name, scanAgentDir(join(agentsDir, e.name), root));

  const valid = [...agents.values()].flatMap((a) => (a.config && !a.problems.length ? [a.config] : []));
  const cross = fleetProblems(valid);
  for (const [id, msgs] of Object.entries(cross)) {
    const a = agents.get(id);
    if (!a) continue;
    a.problems.push(...msgs);
    delete a.resolved; // a cross-agent problem makes the agent invalid too (e.g. alias clash)
    delete a.hash;
  }
  return { agents, fleet: cross["*"] ?? [] };
}

/* ------------------------------------------------------------------------------------------------ */
/* Factory: ResolvedAgent -> Mastra Agent. Injected so tests can stub it.                             */
/* ------------------------------------------------------------------------------------------------ */

export type BuiltAgent = { agent: Agent; dispose?: () => Promise<void>; mcpErrors?: Record<string, string> };
export type AgentFactory = (r: ResolvedAgent, scanned: ScannedAgent, deps: FactoryDeps) => Promise<BuiltAgent>;
export type FactoryDeps = {
  paths: HomePaths;
  root: () => Config;
  rootMcp: Mcp;
  subAgents: (id: string) => Record<string, Agent>;
  resolved: (id: string) => ResolvedAgent | undefined;
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

export const defaultAgentFactory: AgentFactory = async (r, scanned, { paths, root, rootMcp, subAgents, resolved }) => {
  const p = r.sandboxMode === "own" ? ownSandboxPaths(paths, scanned.dir) : paths;
  const cfgFor = (): Config => ({ ...root(), memory: r.memory, limits: { maxSteps: r.maxSteps } });

  // Private MCP servers get their own client; it is closed when this agent version is replaced.
  const ownMcp = Object.keys(r.mcp.own).length ? makeMcp() : undefined;
  const ownState = ownMcp ? await ownMcp.load({ ...cfgFor(), mcpServers: r.mcp.own }) : undefined;

  const workspace = r.builtinTools.includes("workspace") ? makeWorkspace(p, cfgFor(), undefined, `agent-${r.id}`) : undefined;

  const agent = new Agent({
    id: r.id,
    name: r.name,
    description: r.description,
    // Re-read every turn, like the primary: prompt edits apply on the next message without a reload.
    instructions: () =>
      compact([
        tag("role", r.instructions.inline ?? readText(scanned.instructionsFile!)),
        r.instructions.includeSoul && tag("soul", readText(paths.soulFile)),
        r.instructions.includeMemoryFiles && tag("memory", memoryBlock(paths.memoryDir)),
      ]).join("\n\n"),
    model: toMastraModel(r.model),
    defaultOptions: { maxSteps: r.maxSteps, delegation: delegationContext(resolved) },
    memory: makeMemory(paths, cfgFor),
    workspace,
    tools: () => ({ ...toolsFromServers(rootMcp.tools(), r.mcp.inherited, rootMcp.state().servers), ...(ownMcp?.tools() ?? {}) }),
    agents: () => subAgents(r.id),
  });

  return {
    agent,
    dispose: async () => void (await ownMcp?.close()),
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
};

export function createAgentRegistry(opts: RegistryOptions) {
  const { paths, rootMcp, fsAgentIds = ["eigen"], factory = defaultAgentFactory, debounceMs = 300, log = () => undefined } = opts;
  const events = new EventEmitter<{ event: [AgentEvent] }>();
  const running = new Map<string, Running>();
  const runtime = new Map<string, AgentRuntime>();
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
    if (!isFs(id)) mastra?.removeAgent(id);
    await cur.built?.dispose?.().catch((e) => log(`dispose ${id} failed`, e));
    emit({ type: "agent.removed", id });
  }

  async function load(s: ScannedAgent) {
    const resolved = s.resolved!;
    const loadedAt = new Date().toISOString();
    if (isFs(s.id)) {
      running.set(s.id, { hash: s.hash!, resolved, loadedAt });
    } else {
      if (!mastra) return; // not attached yet; the attach() sync will load it
      const built = await factory(resolved, s, { paths, root: getConfig, rootMcp, subAgents, resolved: (id) => running.get(id)?.resolved });
      const prev = running.get(s.id);
      // Mastra's addAgent throws on an existing key, so swap: remove old, add new, then dispose old resources.
      mastra.removeAgent(s.id);
      mastra.addAgent(built.agent, s.id);
      running.set(s.id, { hash: s.hash!, resolved, built, loadedAt });
      await prev?.built?.dispose?.().catch((e) => log(`dispose ${s.id} failed`, e));
    }
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

    scan = scanAgents(paths.agentsDir, root);

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
        await load(s);
      } catch (e) {
        const problems = [`failed to build: ${(e as Error).message}`];
        runtime.set(s.id, { ...(runtime.get(s.id) ?? {}), status: cur ? "stale" : "invalid", problems });
        emit({ type: "agent.error", id: s.id, problems, stale: !!cur });
      }
    }
    emit({ type: "fleet.changed", rev: String(++rev) });
  }

  const sync = (reloadRoot = false) => (queue = queue.then(() => reconcile(reloadRoot)).catch((e) => log("agent sync failed", e)));

  /** Only config.json / instruction files one level down matter; agents writing in their own sandbox must not trigger scans. */
  const relevant = (rel: string) => {
    const parts = rel.split(sep);
    return parts.length === 2 && !ignoredDir(parts[0]!) && /\.(json|md)$/.test(parts[1]!);
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

  return {
    events,

    /** Idempotent. Call as early as a Mastra instance is reachable; the first call loads every agent. */
    attach(m: Mastra): Promise<void> {
      if (mastra === m && attached) return attached;
      mastra = m;
      return (attached = sync());
    },

    /** Initial scan without Mastra (so the fs primary can read its resolved settings at module load). */
    start() {
      return sync();
    },

    /** Re-scan now (tests, or after an out-of-band change). `reloadRoot` also re-reads config.json and reconnects root MCP. */
    reload: (reloadRoot = false) => sync(reloadRoot),

    watch() {
      if (watchers.length) return;
      // Recursive fs.watch: native on macOS, supported on Linux since Node 20. Rename-replace (atomic writes) fires too.
      watchers.push(watch(paths.agentsDir, { recursive: true }, (_e, f) => f && relevant(f.toString()) && onChange(false)));
      watchers.push(watch(dirname(paths.configFile), (_e, f) => f?.toString() === basename(paths.configFile) && onChange(true)));
    },

    async close() {
      clearTimeout(timer);
      watchers.splice(0).forEach((w) => w.close());
      await queue;
      for (const id of [...running.keys()]) await unload(id);
    },

    /** Settings for an agent the file router owns (the primary reads its model/maxSteps/etc. from here). */
    resolved: (id: string) => running.get(id)?.resolved,
    primaryId: () => [...running.values()].find((r) => r.resolved.primary)?.resolved.id ?? fsAgentIds[0]!,
    subAgents,

    /** Telegram routing: "@alias" / "/use alias" -> agent id, only for loaded agents. */
    byAlias(alias: string) {
      return [...running.values()].find((r) => r.resolved.aliases.includes(alias.toLowerCase()))?.resolved.id;
    },

    /** Body for GET /eigen/agents/:id. */
    detail(id: string): GetAgentRuntimeResponse | undefined {
      const s = scan.agents.get(id);
      const r = running.get(id)?.resolved;
      if (!s && !r) return undefined;
      return { id, runtime: runtime.get(id) ?? { status: "invalid", problems: s?.problems ?? [] }, resolved: r ?? s?.resolved ?? null };
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
          aliases: r?.aliases ?? [],
          runtime: runtime.get(s.id) ?? { status: "invalid", problems: s.problems },
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
