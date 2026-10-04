"use client";
import useSWR, { mutate as globalMutate } from "swr";
import type { ListSecretsResponse, SecretStatus } from "@eigen/engine/schema";
import { fetcher } from "@/lib/client/api";

/** Every agent has its own .env: ~/.eigen/agents/<id>/.env. */
export const secretsKey = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/secrets`;

/** Names are upper-case letters, digits and "_" only, so they are URL-safe as they are. */
const keyFor = (agentId: string, names: string) => (names ? `${secretsKey(agentId)}?names=${names}` : secretsKey(agentId));

/**
 * Which env names this agent's config references, and whether each is set in its .env. Never values.
 * `extra`: names typed into a form but not saved yet, so their status shows too.
 */
export function useSecrets(agentId: string | null, extra: string[] = []) {
  const names = [...new Set(extra.filter((n) => /^[A-Z][A-Z0-9_]{0,63}$/.test(n)))].sort().join(",");
  const { data, mutate, isLoading } = useSWR<ListSecretsResponse>(agentId ? keyFor(agentId, names) : null, fetcher, { revalidateOnFocus: true, keepPreviousData: true });
  const secrets = data?.secrets ?? [];
  const isSet = (name: string | undefined) => !!name && secrets.some((s: SecretStatus) => s.name === name && s.set);
  return { secrets, isSet, mutate, isLoading };
}

/** Revalidates every useSecrets() of this agent (they differ by their `extra` names). */
export const refreshSecrets = (agentId: string) => globalMutate((k) => typeof k === "string" && k.startsWith(secretsKey(agentId)));

async function send(agentId: string, name: string, init: RequestInit): Promise<string | null> {
  const res = await fetch(`${secretsKey(agentId)}/${encodeURIComponent(name)}`, { cache: "no-store", ...init, headers: { "content-type": "application/json" } });
  if (res.ok) {
    void refreshSecrets(agentId);
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { issues?: string[]; error?: string };
  return body.issues?.[0] ?? body.error ?? `request failed (${res.status})`;
}

/** Write-only: sets NAME in this agent's .env. Resolves to null on success, or the error message. */
export const putSecret = (agentId: string, name: string, value: string) => send(agentId, name, { method: "PUT", body: JSON.stringify({ value }) });

export const deleteSecret = (agentId: string, name: string) => send(agentId, name, { method: "DELETE" });
