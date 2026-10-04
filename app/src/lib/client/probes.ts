"use client";
import type { ModelTestResponse, TelegramCheckResponse } from "@eigen/engine/schema";

async function post<T>(url: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ ok: false, error: `request failed (${res.status})` }))) as T;
  } catch {
    return { ok: false, error: "the studio did not answer" } as T;
  }
}

const agentUrl = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}`;

/** getMe with the token stored under `tokenEnv` in this agent's .env. The token never reaches the browser. */
export const checkTelegram = (agentId: string, tokenEnv: string) => post<TelegramCheckResponse>(`${agentUrl(agentId)}/telegram/check`, { tokenEnv });

/** Sends one tiny prompt to one of this agent's models, with this agent's key. Tests the SAVED config (apply a draft first). */
export const testModel = (agentId: string, key: string) => post<ModelTestResponse>(`${agentUrl(agentId)}/models/${encodeURIComponent(key)}/test`, {});
