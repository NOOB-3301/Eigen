import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { agentDir, instructionsPath, listAgentIds, readAgent, validateAgent } from "@eigen/engine/store";
import {
  buildTopology,
  fleetProblems,
  resolveAgent,
  type AgentConfig,
  type AgentRuntime,
  type AgentSummary,
  type GetAgentResponse,
  type ListAgentsResponse,
  type ResolvedAgent,
} from "@eigen/engine/schema";
import type { Config } from "@eigen/engine/config";
import { engineSnapshot } from "./engine";
import { paths, rootConfig, scrubPaths } from "./home";
import type { FleetResponse, RootInfo } from "@/lib/types";

type Scanned = { id: string; config?: AgentConfig; raw: Record<string, unknown>; resolved?: ResolvedAgent; problems: string[]; etag: string };

/** Mirrors the engine's scan (lib/agents.ts) so the studio shows the same problems while the engine is down. */
function scan(root: Config): Scanned[] {
  const p = paths();
  const out: Scanned[] = [];
  for (const id of listAgentIds(p)) {
    let a;
    try {
      a = readAgent(p, id);
    } catch {
      continue; // folder name that is not a valid id: the engine ignores it too
    }
    if (!a) continue;
    const raw = (a.config ?? {}) as Record<string, unknown>;
    // rev covers the prompt too, so an instructions-only edit still counts as a fleet change.
    const etag = `${a.etag}.${createHash("sha256").update(a.instructionsText ?? "").digest("hex").slice(0, 8)}`;
    if (a.parseError) {
      out.push({ id, raw, problems: [`config.json is not valid JSON: ${a.parseError}`], etag });
      continue;
    }
    const { issues, parsed } = validateAgent(p, id, a.config, root);
    const problems = [...issues];
    const file = parsed && !parsed.instructions.inline ? instructionsPath(agentDir(p, id), parsed.instructions.file) : undefined;
    if (parsed && !parsed.instructions.inline && file && !existsSync(file))
      problems.push(`instructions file ${parsed.instructions.file} is missing`);
    out.push({ id, raw, config: parsed, problems, etag, resolved: parsed && !problems.length ? resolveAgent(parsed, root) : undefined });
  }
  const cross = fleetProblems(out.flatMap((s) => (s.config && !s.problems.length ? [s.config] : [])));
  for (const s of out) {
    const msgs = cross[s.id];
    if (msgs?.length) {
      s.problems.push(...msgs);
      delete s.resolved;
    }
  }
  return Object.assign(out, { fleet: cross["*"] ?? [] });
}

const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

function summaryOf(s: Scanned, root: Config): AgentSummary {
  const r = s.resolved;
  const c = s.config;
  return {
    id: s.id,
    name: r?.name ?? c?.name ?? str(s.raw.name, s.id),
    role: r?.role ?? c?.role ?? str(s.raw.role, ""),
    description: r?.description ?? c?.description ?? str(s.raw.description, ""),
    enabled: c?.enabled ?? s.raw.enabled !== false,
    primary: r?.primary ?? c?.primary ?? s.raw.primary === true,
    modelKey: r?.modelKey ?? c?.model ?? str(s.raw.model, root.defaultModel),
    telegram: r?.telegram ?? { enabled: false, allowedUserIds: [], source: "root" },
    runtime: { status: "offline", problems: s.problems.map(scrubPaths) },
  };
}

/** What we can say from disk alone: every status is "offline" (the engine is the only one who knows what is loaded). */
export function offlineSnapshot(root: Config): ListAgentsResponse {
  const scanned = scan(root) as Scanned[] & { fleet: string[] };
  const summaries = scanned.map((s) => summaryOf(s, root));
  const resolved = scanned.flatMap((s) => (s.resolved ? [s.resolved] : []));
  const rev = createHash("sha256")
    .update(scanned.map((s) => `${s.id}:${s.etag}`).join("|"))
    .digest("hex")
    .slice(0, 12);
  return { agents: summaries, fleetProblems: scanned.fleet, topology: buildTopology(summaries, resolved, root), rev };
}

const OVERRIDABLE = ["model", "limits.maxSteps", "memory.lastMessages", "memory.semanticRecall", "memory.observational"] as const;

/** Which inheritable fields each agent file sets itself (read from disk, so it works with or without the engine). */
function overridesFromDisk(): Record<string, string[]> {
  const p = paths();
  const out: Record<string, string[]> = {};
  for (const id of listAgentIds(p)) {
    try {
      const raw = readAgent(p, id)?.config as Record<string, unknown> | undefined;
      if (!raw) continue;
      out[id] = OVERRIDABLE.filter((path) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), raw) !== undefined);
    } catch {
      /* invalid folder name */
    }
  }
  return out;
}

export async function fleet(): Promise<FleetResponse> {
  let root: Config;
  try {
    root = rootConfig();
  } catch (e) {
    return { agents: [], fleetProblems: [scrubPaths((e as Error).message)], topology: { nodes: [], edges: [] }, rev: "0", engine: "offline", overrides: {}, rootError: true };
  }
  const live = await engineSnapshot();
  const overrides = overridesFromDisk();
  if (live) return { ...live, engine: "online", overrides };
  return { ...offlineSnapshot(root), engine: "offline", overrides };
}

/** Non-secret root info for the editor: model keys and ids, MCP server names, inherited defaults. No URLs, env names or values. */
export function rootInfo(): RootInfo {
  const root = rootConfig();
  return {
    telegram: { tokenEnv: root.telegram.tokenEnv, allowedUserIds: root.telegram.allowedUserIds },
    defaultModel: root.defaultModel,
    models: Object.entries(root.models).map(([key, m]) => ({ key, id: m.id, contextWindow: m.contextWindow })),
    mcpServers: Object.entries(root.mcpServers).map(([name, s]) => ({ name, enabled: s.enabled, trusted: s.trusted })),
    defaults: {
      maxSteps: root.limits.maxSteps,
      lastMessages: root.memory.lastMessages,
      semanticRecall: root.memory.semanticRecall,
      observational: { enabled: root.memory.observational.enabled },
    },
  };
}

/** Removes secrets and endpoints from a resolved agent: model/embedder URLs and env names, MCP env/header values. */
function publicResolved(r: ResolvedAgent): ResolvedAgent {
  const own = Object.fromEntries(
    Object.entries(r.mcp.own).map(([name, s]) => {
      const safe = { ...s } as Record<string, unknown>;
      for (const k of ["env", "headers"] as const) if (safe[k]) safe[k] = Object.fromEntries(Object.keys(safe[k] as object).map((h) => [h, "•••"]));
      return [name, safe];
    }),
  ) as ResolvedAgent["mcp"]["own"];
  return {
    ...r,
    model: { id: r.model?.id ?? "", replyReserve: r.model?.replyReserve ?? 0, contextWindow: r.model?.contextWindow },
    memory: { ...r.memory, embedder: { id: r.memory.embedder.id } },
    mcp: { ...r.mcp, own },
  };
}

export async function agentDetail(id: string): Promise<GetAgentResponse | null> {
  const p = paths();
  const a = readAgent(p, id);
  if (!a) return null;
  const root = rootConfig();
  let resolved: ResolvedAgent | null = null;
  let problems: string[] = [];
  if (a.parseError) problems = [`config.json is not valid JSON: ${a.parseError}`];
  else {
    const v = validateAgent(p, id, a.config, root);
    problems = v.issues;
    if (v.parsed && !v.issues.length) resolved = publicResolved(resolveAgent(v.parsed, root));
  }
  const live = await engineSnapshot(800);
  const runtime: AgentRuntime = live?.agents.find((s) => s.id === id)?.runtime ?? { status: "offline", problems };
  return { config: a.config, resolved, instructionsText: a.instructionsText, soulText: null, runtime: { ...runtime, problems: runtime.problems.map(scrubPaths) }, etag: a.etag };
}
