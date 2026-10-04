"use client";
import useSWR, { mutate } from "swr";
import type { GithubCheckResponse, ListTriggerRunsResponse, RunTriggerResponse, TriggerRun } from "@eigen/engine/schema";
import { fetcher } from "@/lib/client/api";

/*
 * Client side of trigger run history and probes (routes under /api/agents/[id]/triggers and /api/agents/[id]/github/check).
 * The run log lives in the engine, so with the engine offline the list is empty and the probes answer { ok:false, error }.
 */

/** Prefix of every runs key for one agent (keys differ by ?limit=), so an event can revalidate all of them. */
export const runsKeyPrefix = (agentId: string) => `/api/agents/${agentId}/triggers/runs`;
const runsKey = (agentId: string, limit: number) => `${runsKeyPrefix(agentId)}?limit=${limit}`;

/** Revalidates every useTriggerRuns() of this agent. */
export const refreshTriggerRuns = (agentId: string) => mutate((k) => typeof k === "string" && k.startsWith(runsKeyPrefix(agentId)));

const EMPTY: TriggerRun[] = [];

/** Newest first. Live: updates when an agent.trigger event arrives (lib/client/events.ts revalidates these keys). */
export function useTriggerRuns(agentId: string | null, limit = 50): { runs: TriggerRun[]; isLoading: boolean; refresh: () => Promise<unknown> } {
  const { data, isLoading, mutate: refresh } = useSWR<ListTriggerRunsResponse>(agentId ? runsKey(agentId, limit) : null, fetcher, {
    revalidateOnFocus: true,
    keepPreviousData: true,
    shouldRetryOnError: false,
  });
  return { runs: data?.runs ?? EMPTY, isLoading, refresh: () => refresh() };
}

async function post<T extends { ok: boolean; error?: string }>(url: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as (T & { issues?: string[] }) | null;
    if (!data) return { ok: false, error: `request failed (${res.status})` } as T;
    // Input errors from the studio itself come back as `issues`; these DTOs speak `error`.
    return data.ok || data.error ? data : ({ ...data, ok: false, error: data.issues?.[0] ?? `request failed (${res.status})` } as T);
  } catch {
    return { ok: false, error: "the studio did not answer" } as T;
  }
}

/** Fires one trigger now and resolves when its run has finished. */
export async function runTriggerNow(agentId: string, triggerId: string): Promise<RunTriggerResponse> {
  const r = await post<RunTriggerResponse>(`/api/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(triggerId)}/run`, {});
  void refreshTriggerRuns(agentId);
  return r;
}

/** Can the token in `tokenEnv` (in this agent's .env) read the pull requests of `repo`? The token never reaches the browser. */
export const checkGithub = (agentId: string, tokenEnv: string, repo: string): Promise<GithubCheckResponse> =>
  post<GithubCheckResponse>(`/api/agents/${encodeURIComponent(agentId)}/github/check`, { tokenEnv, repo });
