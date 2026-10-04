"use client";
import useSWR, { mutate as globalMutate } from "swr";
import type { ListSecretsResponse, SecretStatus } from "@eigen/engine/schema";
import { fetcher } from "@/lib/client/api";

export const SECRETS_KEY = "/api/secrets";

/** Names are upper-case letters, digits and "_" only, so they are URL-safe as they are. */
const keyFor = (names: string) => (names ? `${SECRETS_KEY}?names=${names}` : SECRETS_KEY);

/**
 * Which env names the configs reference, and whether each is set in ~/.eigen/.env. Never values.
 * `extra`: names typed into a form but not saved yet, so their status shows too.
 */
export function useSecrets(extra: string[] = []) {
  const names = [...new Set(extra.filter((n) => /^[A-Z][A-Z0-9_]{0,63}$/.test(n)))].sort().join(",");
  const { data, mutate, isLoading } = useSWR<ListSecretsResponse>(keyFor(names), fetcher, { revalidateOnFocus: true, keepPreviousData: true });
  const secrets = data?.secrets ?? [];
  const isSet = (name: string | undefined) => !!name && secrets.some((s: SecretStatus) => s.name === name && s.set);
  return { secrets, isSet, mutate, isLoading };
}

/** Revalidates every useSecrets() in the page (they differ by their `extra` names). */
export const refreshSecrets = () => globalMutate((k) => typeof k === "string" && k.startsWith(SECRETS_KEY));

async function send(name: string, init: RequestInit): Promise<string | null> {
  const res = await fetch(`${SECRETS_KEY}/${encodeURIComponent(name)}`, { cache: "no-store", ...init, headers: { "content-type": "application/json" } });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { issues?: string[]; error?: string };
  return body.issues?.[0] ?? body.error ?? `request failed (${res.status})`;
}

/** Write-only: sets NAME in ~/.eigen/.env. Resolves to null on success, or the error message. */
export const putSecret = (name: string, value: string) => send(name, { method: "PUT", body: JSON.stringify({ value }) });

export const deleteSecret = (name: string) => send(name, { method: "DELETE" });
