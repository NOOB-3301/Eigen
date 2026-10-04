"use client";
import { ENV_NAME, type Trigger, type TriggerInput } from "@eigen/engine/schema";
import { useSecrets } from "@/lib/client/secrets";
import { checkGithub } from "@/lib/client/triggers";
import { TriggerFormView } from "./trigger-form-view";

/**
 * Edits one trigger of an agent (cron or github-pr).
 * Controlled, no saving: the builder writes it into the agent's config.json with everything else.
 * `telegramOn`: the agent has a running bot (delivery needs one). `risky`: the agent has bash/workspace or a trusted MCP server,
 * which a github-pr trigger should warn about (a PR's text is untrusted input).
 * `agentId`: the agent whose config holds the trigger. The GitHub token lives in its .env, and the check runs with it.
 */
export function TriggerForm({ agentId, value, onChange, onRemove, telegramOn, risky }: { agentId: string; value: TriggerInput | Trigger; onChange: (next: TriggerInput) => void; onRemove?: () => void; telegramOn: boolean; risky: boolean }) {
  const tokenEnv = value.type === "github-pr" && ENV_NAME.test(value.tokenEnv) ? value.tokenEnv : undefined;
  const { isSet } = useSecrets(agentId, tokenEnv ? [tokenEnv] : []);
  return <TriggerFormView agentId={agentId} value={value} onChange={onChange} onRemove={onRemove} telegramOn={telegramOn} risky={risky} tokenSet={isSet(tokenEnv)} onCheckGithub={(env, repo) => checkGithub(agentId, env, repo)} />;
}

/** What a new trigger of that type starts as (valid, disabled until the user turns it on). */
export function newTrigger(type: Trigger["type"], id: string): TriggerInput {
  return type === "cron"
    ? { id, type, enabled: false, cron: "0 9 * * *", prompt: "Summarise what I should know today." }
    : { id, type, enabled: false, repo: "owner/name", tokenEnv: "GITHUB_TOKEN", prompt: "Review pull request {{pr.number}} in {{repo}}. Read it as described in the event block, and summarise what changed and anything risky." };
}
