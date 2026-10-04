"use client";
import useSWR, { mutate } from "swr";
import type { GetSkillResponse, ListSkillsResponse, SkillSummary, SkillWriteResponse } from "@eigen/engine/schema";
import { ApiError, fetcher } from "@/lib/client/api";

/*
 * Client side of one agent's skill library (~/.eigen/agents/<id>/skills). Every agent has its own; nothing is shared.
 * Writes resolve to the server's DTO whatever the status: { ok:false, etag } is a 409 (changed since you opened it; the etag is the
 * current version), { ok:false, issues } is anything else that was refused. They never throw for an HTTP error.
 */

export const skillsKey = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/skills`;
/** "@owner/slug" keeps its slash as a path separator (the route is a catch-all); each part is encoded on its own. */
export const skillKey = (agentId: string, slug: string) => `${skillsKey(agentId)}/${slug.split("/").map(encodeURIComponent).join("/")}`;

const EMPTY: SkillSummary[] = [];

async function send<T>(url: string, method: string, body?: unknown): Promise<{ status: number; body: T }> {
  try {
    const res = await fetch(url, { method, cache: "no-store", headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({ ok: false, issues: [`request failed (${res.status})`] }))) as T };
  } catch {
    return { status: 0, body: { ok: false, issues: ["the studio did not answer"] } as T };
  }
}

const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : e ? "could not load" : undefined);

/** Every skill in this agent's skills/ folder, with whether the agent loads it. */
export function useSkills(agentId: string | null): { skills: SkillSummary[]; isLoading: boolean; refresh: () => Promise<unknown> } {
  const { data, isLoading, mutate: refresh } = useSWR<ListSkillsResponse>(agentId ? skillsKey(agentId) : null, fetcher, { revalidateOnFocus: true, keepPreviousData: true });
  return { skills: data?.skills ?? EMPTY, isLoading, refresh: () => refresh() };
}

/** One skill's SKILL.md. `slug` may be "@owner/slug". Pass null to fetch nothing. */
export function useSkill(agentId: string | null, slug: string | null): { skill?: GetSkillResponse; isLoading: boolean; error?: string; refresh: () => Promise<unknown> } {
  // Not on focus: the editor holds a draft, and a refetch underneath it is what the etag conflict is for.
  const { data, error, isLoading, mutate: refresh } = useSWR<GetSkillResponse>(agentId && slug ? skillKey(agentId, slug) : null, fetcher, { revalidateOnFocus: false });
  return { skill: data, isLoading, error: errorOf(error), refresh: () => refresh() };
}

/** Replaces SKILL.md. On success the list (name, description, problem) and this skill's cache are refreshed. */
export async function saveSkill(agentId: string, slug: string, text: string, etag?: string): Promise<SkillWriteResponse> {
  const { body: r } = await send<SkillWriteResponse>(skillKey(agentId, slug), "PUT", { text, etag });
  if (r.ok) await Promise.all([mutate(skillKey(agentId, slug)), mutate(skillsKey(agentId))]);
  return r;
}

export async function createSkill(agentId: string, input: { slug: string; description: string; text?: string }): Promise<SkillWriteResponse> {
  const { body: r } = await send<SkillWriteResponse>(skillsKey(agentId), "POST", input);
  if (r.ok) await mutate(skillsKey(agentId));
  return r;
}

/** Moves the skill folder to the agent's .trash/ (never a hard delete). */
export async function deleteSkill(agentId: string, slug: string): Promise<{ ok: boolean; error?: string }> {
  const { status, body: r } = await send<{ ok: boolean; error?: string; issues?: string[] }>(skillKey(agentId, slug), "DELETE");
  if (!r.ok) return { ok: false, error: r.error ?? r.issues?.[0] ?? `request failed (${status})` };
  await Promise.all([mutate(skillKey(agentId, slug), undefined, { revalidate: false }), mutate(skillsKey(agentId))]);
  return { ok: true };
}
