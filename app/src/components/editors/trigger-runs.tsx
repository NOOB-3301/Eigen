"use client";

/** Run history of an agent's triggers, newest first, with a "Run now" per trigger. INTERFACE ONLY: the editors worker builds it. */
export function TriggerRuns({ agentId, triggerId }: { agentId: string; triggerId?: string }) {
  void triggerId;
  return <div>Runs of {agentId}</div>;
}
