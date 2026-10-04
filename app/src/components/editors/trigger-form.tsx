"use client";
import type { Trigger, TriggerInput } from "@eigen/engine/schema";

/**
 * Edits one trigger of an agent (cron or github-pr). INTERFACE ONLY: the editors worker builds it.
 * Controlled, no saving: the builder writes it into the agent's config.json with everything else.
 * `telegramOn`: the agent has a running bot (delivery needs one). `risky`: the agent has bash/workspace or a trusted MCP server,
 * which a github-pr trigger should warn about (a PR's text is untrusted input).
 */
export function TriggerForm({ agentId, value, onChange, onRemove, telegramOn, risky }: { agentId: string; value: TriggerInput | Trigger; onChange: (next: TriggerInput) => void; onRemove?: () => void; telegramOn: boolean; risky: boolean }) {
  void agentId;
  void onChange;
  void onRemove;
  void telegramOn;
  void risky;
  return <div>Trigger: {value.id}</div>;
}

/** What a new trigger of that type starts as (valid, disabled until the user turns it on). */
export function newTrigger(type: Trigger["type"], id: string): TriggerInput {
  return type === "cron"
    ? { id, type, enabled: false, cron: "0 9 * * *", prompt: "Summarise what I should know today." }
    : { id, type, enabled: false, repo: "owner/name", tokenEnv: "GITHUB_TOKEN", prompt: "Review pull request {{pr.number}}: {{pr.title}}." };
}
