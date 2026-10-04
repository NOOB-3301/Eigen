"use client";
import type { Config } from "@eigen/engine/config";
import type { UpdateRootConfigResponse } from "@eigen/engine/schema";

export type Obj = Record<string, unknown>;

/** GET /api/root/config: the file as written, its version, and what the schema fills in for missing keys. */
export type RootPayload = { config: Obj; etag: string; parseError?: string; defaults: Config };

export const ROOT_CONFIG_URL = "/api/root/config";

export async function loadRoot(): Promise<RootPayload> {
  const res = await fetch(ROOT_CONFIG_URL, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as RootPayload & { issues?: string[] };
  if (!res.ok) throw new Error(body.issues?.[0] ?? `could not read config.json (${res.status})`);
  return body;
}

export async function saveRoot(config: Obj, etag?: string): Promise<{ status: number; body: UpdateRootConfigResponse }> {
  const res = await fetch(ROOT_CONFIG_URL, { method: "PUT", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, etag }) });
  return { status: res.status, body: (await res.json().catch(() => ({ ok: false, issues: [`request failed (${res.status})`] }))) as UpdateRootConfigResponse };
}
