"use client";
import type { GithubCheckResponse, ListTriggerRunsResponse, RunTriggerResponse, TriggerRun } from "@eigen/engine/schema";

/*
 * Client side of trigger run history and probes. INTERFACE ONLY for now: the data-layer worker fills these bodies in
 * (routes under /api/agents/[id]/triggers and /api/github/check).
 */

/** Newest first. Live: updates when an agent.trigger event arrives. */
export function useTriggerRuns(_agentId: string | null, _limit = 50): { runs: TriggerRun[]; isLoading: boolean; refresh: () => Promise<unknown> } {
  const data: ListTriggerRunsResponse = { runs: [] };
  return { runs: data.runs, isLoading: false, refresh: async () => undefined };
}

/** Fires one trigger now and resolves when its run has finished. */
export const runTriggerNow = async (_agentId: string, _triggerId: string): Promise<RunTriggerResponse> => ({ ok: false, error: "not implemented" });

/** Can the token in `tokenEnv` read the pull requests of `repo`? The token never reaches the browser. */
export const checkGithub = async (_tokenEnv: string, _repo: string): Promise<GithubCheckResponse> => ({ ok: false, error: "not implemented" });
