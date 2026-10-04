import { createHash } from "node:crypto";
import { secretStatuses } from "@eigen/engine/envfile";
import { agentPaths, machineTimezone } from "@eigen/engine/home";
import { listAgentIds, readAgent, validateAgent } from "@eigen/engine/store";
import {
  buildTopology,
  fleetProblems,
  missingKeys,
  resolveAgent,
  type AgentConfig,
  type AgentRuntime,
  type AgentSummary,
  type GetAgentResponse,
  type ListAgentsResponse,
  type ResolvedAgent,
} from "@eigen/engine/schema";
import { engineSnapshot } from "./engine";
import { paths, scrubPaths } from "./home";
import type { FleetResponse } from "@/lib/types";

type Scanned = { id: string; raw: Record<string, unknown>; config?: AgentConfig; resolved?: ResolvedAgent; problems: string[]; etag: string };

/** Is NAME set in this agent's .env? Asked of the file's statuses, so no value is ever held here. */
function keyChecker(id: string): (name: string) => boolean {
  const set = new Set(secretStatuses(agentPaths(paths(), id).envFile, new Map()).flatMap((s) => (s.set ? [s.name] : [])));
  return (name) => set.has(name);
}

/** The problems the engine would report for one agent's files, short of what only a running engine knows (bot tokens, MCP servers). */
function problemsOf(id: string, raw: unknown, parseError?: string): { config?: AgentConfig; problems: string[] } {
  if (parseError) return { problems: [`config.json is not valid JSON: ${parseError}`] };
  // Storage clashes are judged across the fleet in scan() (the first agent by id keeps the database, as in the engine), not pairwise.
  const { issues, parsed } = validateAgent(paths(), id, raw, { others: [] });
  if (!parsed) return { problems: issues };
  const keys = parsed.enabled ? missingKeys(parsed, keyChecker(id)) : [];
  return { config: parsed, problems: [...issues, ...keys] };
}

/** Mirrors the engine's scan so the studio shows the same agents and problems while the engine is down. */
function scan(): Scanned[] {
  const p = paths();
  const out: Scanned[] = [];
  for (const id of listAgentIds(p)) {
    const a = readAgent(p, id);
    if (!a) continue;
    const raw = (a.config && typeof a.config === "object" ? a.config : {}) as Record<string, unknown>;
    const { config, problems } = problemsOf(id, a.config, a.parseError);
    out.push({ id, raw, config, problems, etag: a.etag });
  }
  const cross = fleetProblems(out.flatMap((s) => (s.config && !s.problems.length ? [s.config] : [])));
  for (const s of out) s.problems.push(...(cross[s.id] ?? []));
  for (const s of out) if (s.config && !s.problems.length) s.resolved = resolveAgent(s.config, machineTimezone());
  return out;
}

const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

/** One agent's card, from whatever could be read: the parsed config when it is valid, else the raw fields, else the id. */
export function summaryOf(s: Pick<Scanned, "id" | "raw" | "config" | "problems">): AgentSummary {
  const c = s.config;
  return {
    id: s.id,
    name: c?.name ?? str(s.raw.name, s.id),
    role: c?.role ?? str(s.raw.role, ""),
    description: c?.description ?? str(s.raw.description, ""),
    enabled: c?.enabled ?? s.raw.enabled !== false,
    modelKey: c?.model ?? str(s.raw.model, ""),
    telegram: { enabled: c?.telegram.enabled ?? false, allowedUserIds: c?.telegram.allowedUserIds ?? [] },
    runtime: { status: "offline", problems: s.problems.map(scrubPaths) },
  };
}

/** What can be said from disk alone: every status is "offline" (only the engine knows what is loaded). */
export function offlineSnapshot(): ListAgentsResponse {
  const scanned = scan();
  const summaries = scanned.map(summaryOf);
  const resolved = scanned.flatMap((s) => (s.resolved ? [s.resolved] : []));
  const rev = createHash("sha256")
    .update(scanned.map((s) => `${s.id}:${s.etag}`).join("|"))
    .digest("hex")
    .slice(0, 12);
  return { agents: summaries, fleetProblems: [], topology: buildTopology(summaries, resolved), rev };
}

/** GET /api/agents: the engine's snapshot when it answers, else one computed from the folders. */
export async function fleet(): Promise<FleetResponse> {
  const live = await engineSnapshot();
  if (live) return { ...live, engine: "online" };
  return { ...offlineSnapshot(), engine: "offline" };
}

/** GET /api/agents/:id: the files as the editor sees them, plus what the engine says is running (or the offline problems). */
export async function agentDetail(id: string): Promise<GetAgentResponse | null> {
  const a = readAgent(paths(), id);
  if (!a) return null;
  const { config, problems } = problemsOf(id, a.config, a.parseError);
  const resolved = config && !problems.length ? resolveAgent(config, machineTimezone()) : null;
  const live = await engineSnapshot(800);
  const runtime: AgentRuntime = live?.agents.find((s) => s.id === id)?.runtime ?? { status: "offline", problems };
  return { config: a.config, resolved, instructionsText: a.instructionsText, soulText: a.soulText, runtime: { ...runtime, problems: runtime.problems.map(scrubPaths) }, etag: a.etag };
}
