"use client";
import type { ModelTestResponse, TelegramCheckResponse } from "@eigen/engine/schema";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `request failed (${res.status})` }))) as T;
}

/** getMe with the token stored under `tokenEnv` in ~/.eigen/.env. The token never reaches the browser. */
export const checkTelegram = (tokenEnv: string) => post<TelegramCheckResponse>("/api/telegram/check", { tokenEnv });

/** Sends one tiny prompt to a root model. */
export const testModel = (key: string) => post<ModelTestResponse>(`/api/models/${encodeURIComponent(key)}/test`, {});
