"use client";
import useSWR from "swr";
import type { AgentConfigInput, GetAgentResponse, UpdateAgentConfigRequest, UpdateAgentConfigResponse } from "@eigen/engine/schema";
import type { FleetResponse, Layout, RootInfo } from "@/lib/types";

export const keys = {
  fleet: "/api/agents",
  root: "/api/root",
  layout: "/api/layout",
  agent: (id: string) => `/api/agents/${id}`,
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public issues: string[],
    public body: unknown,
  ) {
    super(issues[0] ?? `request failed (${status})`);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

export async function fetcher<T>(url: string): Promise<T> {
  const { status, body } = await call<T & { issues?: string[] }>(url);
  if (status >= 400) throw new ApiError(status, body.issues ?? [], body);
  return body;
}

export const useFleet = () => useSWR<FleetResponse>(keys.fleet, fetcher, { revalidateOnFocus: true, keepPreviousData: true });
export const useRoot = () => useSWR<RootInfo>(keys.root, fetcher, { revalidateOnFocus: true });
export const useLayout = () => useSWR<Layout>(keys.layout, fetcher, { revalidateOnFocus: false });
export const useAgent = (id: string | null) => useSWR<GetAgentResponse>(id ? keys.agent(id) : null, fetcher, { revalidateOnFocus: false, keepPreviousData: false });

export type SaveResult = { status: number; body: UpdateAgentConfigResponse };

export const saveConfig = (id: string, req: UpdateAgentConfigRequest) =>
  call<UpdateAgentConfigResponse>(`/api/agents/${id}/config`, { method: "POST", body: JSON.stringify(req) }) as Promise<SaveResult>;

export const createAgent = (config: AgentConfigInput, instructionsText?: string) =>
  call<UpdateAgentConfigResponse>("/api/agents", { method: "POST", body: JSON.stringify({ config, instructionsText }) }) as Promise<SaveResult>;

export const trashAgent = (id: string) => call<{ ok: boolean; issues?: string[] }>(`/api/agents/${id}`, { method: "DELETE" });

export const putLayout = (layout: Layout) => call<{ ok: boolean }>(keys.layout, { method: "PUT", body: JSON.stringify(layout) });
