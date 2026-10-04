/**
 * Shared contract between the engine and the web app (`@eigen/engine/schema`).
 * Pure: zod + types only, no node:* imports, so Next.js can import it from client or server code.
 *
 * Ownership rule: the root ~/.eigen/config.json owns SHARED resources (model catalog, telegram, sandbox policy,
 * embedder, MCP server catalog). An agent's ~/.eigen/.agents/<id>/config.json REFERENCES those by name and
 * OVERRIDES only per-agent knobs. Anything an agent leaves out is inherited from the root.
 */
import { z } from "zod";
import type { Config, ModelEntry } from "./config.ts";

export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_CONFIG_FILE = "config.json";

const posInt = z.number().int().positive();
const strMap = z.record(z.string(), z.string());
export const AgentId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase slug: a-z, 0-9, '-', max 32 chars");

/** Same shapes as root `mcpServers`, for servers private to one agent. */
const mcpFlags = { enabled: z.boolean().default(true), trusted: z.boolean().default(false) };
const AgentMcpStdio = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: strMap.optional(), ...mcpFlags });
const AgentMcpRemote = z.object({ url: z.url(), headers: strMap.optional(), transport: z.enum(["http", "sse"]).optional(), ...mcpFlags });

/** Tools that are code in the engine, not MCP. The allowlist is what an agent may use. */
export const BUILTIN_TOOLS = ["workspace", "schedule", "skills"] as const;

export const AgentConfigSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SCHEMA_VERSION).default(AGENT_SCHEMA_VERSION),
    /** Must equal the folder name. Also the Mastra agent id and the memory resource namespace. */
    id: AgentId,
    name: z.string().min(1).max(64),
    /** Short label for the UI ("researcher", "planner"). */
    role: z.string().min(1).max(40),
    /** What the agent is for. The primary reads this to decide when to delegate, so write it for a model. */
    description: z.string().min(1).max(1000),
    enabled: z.boolean().default(true),
    /** Exactly one enabled agent is primary: it owns the Telegram channel and supervises the rest. */
    primary: z.boolean().default(false),
    /** Key into root `models`. Omitted: root `defaultModel` (or the chat's /model choice for the primary). */
    model: z.string().min(1).optional(),
    instructions: z
      .object({
        /** Relative to the agent folder. Missing file + no inline = config error. Markdown only, so it can never point the editor at .env or a config. */
        file: z.string().regex(/\.md$/, "must be a .md file").default("instructions.md"),
        /** Used instead of `file` when set; handy for one-liners created from the UI. */
        inline: z.string().optional(),
        /** Prepend ~/.eigen/SOUL.md (shared persona). */
        includeSoul: z.boolean().default(true),
        /** Append the curated ~/.eigen/memory/*.md block. Defaults to true for the primary only. */
        includeMemoryFiles: z.boolean().optional(),
      })
      .prefault({}),
    tools: z
      .object({
        builtin: z.array(z.enum(BUILTIN_TOOLS)).default(["workspace"]),
        mcp: z
          .object({
            /** Which root `mcpServers` this agent sees: all, none, or a named subset. */
            inherit: z.union([z.literal("all"), z.literal("none"), z.array(z.string().min(1))]).default("none"),
            /** Servers only this agent connects to. Names must not collide with root servers. */
            servers: z.record(z.string(), z.union([AgentMcpStdio, AgentMcpRemote])).default({}),
          })
          .prefault({}),
      })
      .prefault({}),
    /** Partial overrides, deep-merged over root `memory`. Embedder and cron always come from the root. */
    memory: z
      .object({
        /** isolated: own threads + working memory. shared: same resource as the primary (sees the user's profile). */
        scope: z.enum(["isolated", "shared"]).default("isolated"),
        lastMessages: posInt.optional(),
        semanticRecall: z.object({ enabled: z.boolean(), topK: posInt, messageRange: posInt }).partial().optional(),
        observational: z.object({ enabled: z.boolean() }).partial().optional(),
      })
      .prefault({}),
    limits: z.object({ maxSteps: posInt.optional() }).prefault({}),
    /** shared: ~/.eigen/sandbox. own: ~/.eigen/.agents/<id>/sandbox (same isolation policy as root). */
    sandbox: z.object({ mode: z.enum(["shared", "own"]).default("shared") }).prefault({}),
    delegation: z
      .object({
        /** Who may call this agent as a sub-agent. */
        acceptsFrom: z.enum(["primary", "any", "none"]).default("primary"),
        /** Agents this one may delegate to (the primary implicitly gets every agent that accepts from it). */
        canDelegateTo: z.array(AgentId).default([]),
      })
      .prefault({}),
    telegram: z
      .object({
        /** "@alias text" or "/use alias" in Telegram routes straight to this agent. Defaults to [id]. */
        aliases: z.array(AgentId).optional(),
      })
      .prefault({}),
  })
  .refine((a) => !(a.primary && a.delegation.acceptsFrom === "primary"), {
    path: ["delegation", "acceptsFrom"],
    message: 'the primary cannot accept delegation "from primary"; use "none" or "any"',
  })
  .refine((a) => !a.delegation.canDelegateTo.includes(a.id), { path: ["delegation", "canDelegateTo"], message: "an agent cannot delegate to itself" });

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/* ------------------------------------------------------------------------------------------------ */
/* Resolution: agent config + root config -> effective values (with provenance for the UI).          */
/* ------------------------------------------------------------------------------------------------ */

export type Source = "agent" | "root";

export type ResolvedAgent = {
  id: string;
  name: string;
  role: string;
  description: string;
  enabled: boolean;
  primary: boolean;
  modelKey: string;
  model: ModelEntry;
  instructions: AgentConfig["instructions"] & { includeMemoryFiles: boolean };
  builtinTools: AgentConfig["tools"]["builtin"];
  /** Root server names this agent connects to (after `inherit`), plus its private ones. */
  mcp: { inherited: string[]; own: AgentConfig["tools"]["mcp"]["servers"] };
  memory: Config["memory"] & { scope: AgentConfig["memory"]["scope"] };
  maxSteps: number;
  sandboxMode: AgentConfig["sandbox"]["mode"];
  delegation: AgentConfig["delegation"];
  aliases: string[];
  /** Dotted path -> where the effective value came from. Only for fields an agent can override. */
  provenance: Record<string, Source>;
};

const from = (v: unknown): Source => (v === undefined ? "root" : "agent");

/** Cross-checks references against the root config. Returns problems instead of throwing so the UI can show all of them. */
export function agentProblems(a: AgentConfig, root: Config): string[] {
  const problems: string[] = [];
  if (a.model && !(a.model in root.models)) problems.push(`model "${a.model}" is not in root config.json models`);
  const inherit = a.tools.mcp.inherit;
  if (Array.isArray(inherit)) inherit.filter((n) => !(n in root.mcpServers)).forEach((n) => problems.push(`tools.mcp.inherit: "${n}" is not in root mcpServers`));
  Object.keys(a.tools.mcp.servers)
    .filter((n) => n in root.mcpServers)
    .forEach((n) => problems.push(`tools.mcp.servers.${n} shadows a root mcpServer; rename it or inherit the root one`));
  return problems;
}

export function resolveAgent(a: AgentConfig, root: Config): ResolvedAgent {
  const modelKey = a.model ?? root.defaultModel;
  const inherit = a.tools.mcp.inherit;
  const rootServers = Object.keys(root.mcpServers).filter((n) => root.mcpServers[n]!.enabled);
  const m = a.memory;
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    description: a.description,
    enabled: a.enabled,
    primary: a.primary,
    modelKey,
    model: root.models[modelKey]!,
    instructions: { ...a.instructions, includeMemoryFiles: a.instructions.includeMemoryFiles ?? a.primary },
    builtinTools: a.tools.builtin,
    mcp: { inherited: inherit === "all" ? rootServers : inherit === "none" ? [] : rootServers.filter((n) => inherit.includes(n)), own: a.tools.mcp.servers },
    memory: {
      ...root.memory,
      scope: m.scope,
      lastMessages: m.lastMessages ?? root.memory.lastMessages,
      semanticRecall: { ...root.memory.semanticRecall, ...m.semanticRecall },
      observational: { ...root.memory.observational, ...m.observational },
      // Subconscious knowledge is a singleton tied to the user's resource; only the primary / shared-scope agents get it.
      knowledge: { ...root.memory.knowledge, enabled: root.memory.knowledge.enabled && (a.primary || m.scope === "shared") },
    },
    maxSteps: a.limits.maxSteps ?? root.limits.maxSteps,
    sandboxMode: a.sandbox.mode,
    delegation: a.delegation,
    aliases: a.telegram.aliases ?? [a.id],
    provenance: {
      model: from(a.model),
      "limits.maxSteps": from(a.limits.maxSteps),
      "memory.lastMessages": from(m.lastMessages),
      "memory.semanticRecall": from(m.semanticRecall),
      "memory.observational": from(m.observational),
    },
  };
}

/** Problems that span agents (run after every scan). Keyed by agent id; "*" for global ones. */
export function fleetProblems(agents: AgentConfig[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, msg: string) => (out[id] ??= []).push(msg);
  const enabled = agents.filter((a) => a.enabled);
  const primaries = enabled.filter((a) => a.primary);
  if (primaries.length !== 1) add("*", `exactly one enabled agent must be primary (found ${primaries.length}: ${primaries.map((a) => a.id).join(", ") || "none"})`);
  const ids = new Set(enabled.map((a) => a.id));
  const aliasOwner = new Map<string, string>();
  for (const a of enabled) {
    a.delegation.canDelegateTo.filter((t) => !ids.has(t)).forEach((t) => add(a.id, `delegation.canDelegateTo: "${t}" is not an enabled agent`));
    for (const alias of a.telegram.aliases ?? [a.id]) {
      const owner = aliasOwner.get(alias);
      if (owner) add(a.id, `telegram alias "${alias}" is already used by "${owner}"`);
      else aliasOwner.set(alias, a.id);
    }
  }
  return out;
}

/** Who may delegate to whom, after applying both sides' rules. */
export function delegationEdges(agents: ResolvedAgent[]): Array<[from: string, to: string]> {
  const live = agents.filter((a) => a.enabled);
  const primary = live.find((a) => a.primary);
  const edges: Array<[string, string]> = [];
  for (const src of live)
    for (const dst of live) {
      if (src.id === dst.id || dst.delegation.acceptsFrom === "none") continue;
      const asked = src.delegation.canDelegateTo.includes(dst.id) || src.primary;
      const allowed = dst.delegation.acceptsFrom === "any" || (dst.delegation.acceptsFrom === "primary" && src.id === primary?.id);
      if (asked && allowed) edges.push([src.id, dst.id]);
    }
  return edges;
}

/* ------------------------------------------------------------------------------------------------ */
/* Runtime status + API DTOs                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * loaded:   registered in Mastra with the current file contents.
 * stale:    the file changed and is invalid; the LAST GOOD version keeps running.
 * invalid:  never loaded (bad on first sight).
 * disabled: enabled=false.
 * offline:  web app could not reach the engine (status unknown).
 */
export type AgentStatus = "loaded" | "stale" | "invalid" | "disabled" | "offline";

export type AgentRuntime = {
  status: AgentStatus;
  problems: string[];
  /** sha256 of the normalized config + instructions text currently registered. */
  loadedHash?: string;
  loadedAt?: string;
  mcpErrors?: Record<string, string>;
};

export type AgentSummary = Pick<ResolvedAgent, "id" | "name" | "role" | "description" | "enabled" | "primary" | "modelKey" | "aliases"> & {
  runtime: AgentRuntime;
};

/** GET /api/agents */
export type ListAgentsResponse = { agents: AgentSummary[]; fleetProblems: string[]; topology: Topology; rev: string };

/** GET /api/agents/:id */
export type GetAgentResponse = {
  /** Raw file contents as parsed JSON (what the editor edits). */
  config: AgentConfigInput;
  /** Null when the config is invalid. */
  resolved: ResolvedAgent | null;
  instructionsText: string | null;
  runtime: AgentRuntime;
  /** Opaque version for optimistic concurrency (hash of the file bytes). */
  etag: string;
};

/** Engine GET /eigen/agents/:id: what is running (the web app reads the files itself). `resolved` is the last good version for a stale agent. */
export type GetAgentRuntimeResponse = { id: string; runtime: AgentRuntime; resolved: ResolvedAgent | null };

/** POST /api/agents/:id/config. `etag` from the GET; omit to force. `instructionsText` writes the instructions file too. */
export const UpdateAgentConfigRequest = z.object({
  config: z.unknown(),
  instructionsText: z.string().optional(),
  etag: z.string().optional(),
});
export type UpdateAgentConfigRequest = z.infer<typeof UpdateAgentConfigRequest>;

/**
 * 200 { ok: true, etag }            written; the engine watcher picks it up (watch /api/agents/events for "loaded").
 * 400 { ok: false, issues }         schema or reference errors; nothing written.
 * 409 { ok: false, etag }           file changed since your GET; refetch and merge.
 */
export type UpdateAgentConfigResponse = { ok: true; etag: string } | { ok: false; issues?: string[]; etag?: string };

/** GET /api/agents/events (SSE). */
export type AgentEvent =
  | { type: "agent.loaded"; id: string; hash: string }
  | { type: "agent.removed"; id: string }
  | { type: "agent.error"; id: string; problems: string[]; stale: boolean }
  | { type: "fleet.changed"; rev: string };

/* ------------------------------------------------------------------------------------------------ */
/* Topology (React Flow). Positions are NOT here: they live in data/topology-layout.json.            */
/* ------------------------------------------------------------------------------------------------ */

export type TopologyNode =
  | { id: `channel:${string}`; type: "channel"; data: { channel: "telegram"; routesTo: string } }
  | { id: `agent:${string}`; type: "agent"; data: AgentSummary & { builtinTools: string[] } }
  | { id: `mcp:${string}`; type: "mcp"; data: { name: string; owner: "root" | string; trusted: boolean; error?: string } };

export type TopologyEdge = {
  id: string;
  source: TopologyNode["id"];
  target: TopologyNode["id"];
  type: "routes" | "alias" | "delegates" | "uses";
  label?: string;
};

export type Topology = { nodes: TopologyNode[]; edges: TopologyEdge[] };

export const agentNodeId = (id: string) => `agent:${id}` as const;
export const mcpNodeId = (name: string, owner = "root") => (owner === "root" ? (`mcp:${name}` as const) : (`mcp:${owner}/${name}` as const));

/** Builds the graph from resolved agents. Agents that failed to resolve still appear (as summaries) with no edges. */
export function buildTopology(summaries: AgentSummary[], resolved: ResolvedAgent[], root: Pick<Config, "mcpServers">, mcpErrors: Record<string, string> = {}): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const byId = new Map(resolved.map((r) => [r.id, r]));
  const primary = resolved.find((r) => r.primary && r.enabled);

  nodes.push({ id: "channel:telegram", type: "channel", data: { channel: "telegram", routesTo: primary?.id ?? "" } });
  if (primary) edges.push({ id: `routes:telegram->${primary.id}`, source: "channel:telegram", target: agentNodeId(primary.id), type: "routes", label: "default" });

  for (const s of summaries) {
    const r = byId.get(s.id);
    nodes.push({ id: agentNodeId(s.id), type: "agent", data: { ...s, builtinTools: r?.builtinTools ?? [] } });
    if (!r?.enabled) continue;
    if (!r.primary) for (const alias of r.aliases) edges.push({ id: `alias:telegram->${r.id}:${alias}`, source: "channel:telegram", target: agentNodeId(r.id), type: "alias", label: `@${alias}` });
    for (const name of r.mcp.inherited) edges.push({ id: `uses:${r.id}->${name}`, source: agentNodeId(r.id), target: mcpNodeId(name), type: "uses" });
    for (const [name, srv] of Object.entries(r.mcp.own)) {
      nodes.push({ id: mcpNodeId(name, r.id), type: "mcp", data: { name, owner: r.id, trusted: srv.trusted, error: mcpErrors[`${r.id}/${name}`] } });
      edges.push({ id: `uses:${r.id}->${r.id}/${name}`, source: agentNodeId(r.id), target: mcpNodeId(name, r.id), type: "uses" });
    }
  }

  for (const [name, srv] of Object.entries(root.mcpServers))
    if (srv.enabled) nodes.push({ id: mcpNodeId(name), type: "mcp", data: { name, owner: "root", trusted: srv.trusted, error: mcpErrors[name] } });

  for (const [src, dst] of delegationEdges(resolved)) edges.push({ id: `delegates:${src}->${dst}`, source: agentNodeId(src), target: agentNodeId(dst), type: "delegates" });

  return { nodes, edges };
}

/**
 * What `npm run setup` / the migration writes for the existing single agent.
 * Its instructions stay in ~/.eigen/prompts/system.md (one source of truth, so editing the primary's prompt in the studio edits the file it always used).
 */
export const DEFAULT_PRIMARY: AgentConfigInput = {
  id: "eigen",
  name: "Eigen",
  role: "assistant",
  description: "The user's personal assistant. Talks to the user on Telegram and delegates specialised work to other agents.",
  primary: true,
  instructions: { file: "../../prompts/system.md" },
  tools: { builtin: ["workspace", "schedule", "skills"], mcp: { inherit: "all" } },
  memory: { scope: "shared" },
  delegation: { acceptsFrom: "none" },
  telegram: { aliases: [] },
};
