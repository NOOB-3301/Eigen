"use client";
import useSWR from "swr";
import type { ListSecretsResponse, SecretStatus } from "@eigen/engine/schema";
import { fetcher } from "@/lib/client/api";

export const SECRETS_KEY = "/api/secrets";

/**
 * Which env names the configs reference, and whether each is set in ~/.eigen/.env. Never values.
 * CONTRACT (owned by the app-settings worker; consumers: inspector Telegram section, Settings).
 */
export function useSecrets() {
  const { data, mutate, isLoading } = useSWR<ListSecretsResponse>(SECRETS_KEY, fetcher, { revalidateOnFocus: true });
  const secrets = data?.secrets ?? [];
  const isSet = (name: string | undefined) => !!name && secrets.some((s: SecretStatus) => s.name === name && s.set);
  return { secrets, isSet, mutate, isLoading };
}

/** Write-only: sets NAME in ~/.eigen/.env. Resolves to null on success, or the error message. */
export async function putSecret(name: string, value: string): Promise<string | null> {
  const res = await fetch(`${SECRETS_KEY}/${encodeURIComponent(name)}`, { method: "PUT", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { issues?: string[]; error?: string };
  return body.issues?.[0] ?? body.error ?? `request failed (${res.status})`;
}

export async function deleteSecret(name: string): Promise<string | null> {
  const res = await fetch(`${SECRETS_KEY}/${encodeURIComponent(name)}`, { method: "DELETE", cache: "no-store", headers: { "content-type": "application/json" } });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { issues?: string[]; error?: string };
  return body.issues?.[0] ?? body.error ?? `request failed (${res.status})`;
}
