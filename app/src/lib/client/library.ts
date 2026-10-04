"use client";
import useSWR, { mutate } from "swr";
import type { GetSharedSoulResponse, GetSkillResponse, ListSkillsResponse, SharedSoulWriteResponse, SkillSummary, SkillWriteResponse } from "@eigen/engine/schema";
import { ApiError, fetcher } from "@/lib/client/api";

/*
 * Client side of the skill library (~/.eigen/skills) and the shared soul (~/.eigen/SOUL.md).
 * Writes resolve to the server's DTO whatever the status: { ok:false, etag } is a 409 (changed since you opened it; the etag is the
 * current version), { ok:false, issues } is anything else that was refused. They never throw for an HTTP error.
 */

export const SKILLS_KEY = "/api/skills";
export const SOUL_KEY = "/api/soul";
/** "@owner/slug" keeps its slash as a path separator (the route is a catch-all); each part is encoded on its own. */
export const skillKey = (slug: string) => `${SKILLS_KEY}/${slug.split("/").map(encodeURIComponent).join("/")}`;

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

/** Every skill under ~/.eigen/skills, with the agents that name it. */
export function useSkills(): { skills: SkillSummary[]; isLoading: boolean; refresh: () => Promise<unknown> } {
  const { data, isLoading, mutate: refresh } = useSWR<ListSkillsResponse>(SKILLS_KEY, fetcher, { revalidateOnFocus: true, keepPreviousData: true });
  return { skills: data?.skills ?? EMPTY, isLoading, refresh: () => refresh() };
}

/** One skill's SKILL.md. `slug` may be "@owner/slug". Pass null to fetch nothing. */
export function useSkill(slug: string | null): { skill?: GetSkillResponse; isLoading: boolean; error?: string; refresh: () => Promise<unknown> } {
  // Not on focus: the editor holds a draft, and a refetch underneath it is what the etag conflict is for.
  const { data, error, isLoading, mutate: refresh } = useSWR<GetSkillResponse>(slug ? skillKey(slug) : null, fetcher, { revalidateOnFocus: false });
  return { skill: data, isLoading, error: errorOf(error), refresh: () => refresh() };
}

/** Replaces SKILL.md. On success the list (name, description, problem) and this skill's cache are refreshed. */
export async function saveSkill(slug: string, text: string, etag?: string): Promise<SkillWriteResponse> {
  const { body: r } = await send<SkillWriteResponse>(skillKey(slug), "PUT", { text, etag });
  if (r.ok) await Promise.all([mutate(skillKey(slug)), mutate(SKILLS_KEY)]);
  return r;
}

export async function createSkill(input: { slug: string; description: string; text?: string }): Promise<SkillWriteResponse> {
  const { body: r } = await send<SkillWriteResponse>(SKILLS_KEY, "POST", input);
  if (r.ok) await mutate(SKILLS_KEY);
  return r;
}

/** Moves the skill folder to ~/.eigen/skills/.trash (never a hard delete). */
export async function deleteSkill(slug: string): Promise<{ ok: boolean; error?: string }> {
  const { status, body: r } = await send<{ ok: boolean; error?: string; issues?: string[] }>(skillKey(slug), "DELETE");
  if (!r.ok) return { ok: false, error: r.error ?? r.issues?.[0] ?? `request failed (${status})` };
  await Promise.all([mutate(skillKey(slug), undefined, { revalidate: false }), mutate(SKILLS_KEY)]);
  return { ok: true };
}

/** The shared ~/.eigen/SOUL.md. */
export function useSharedSoul(): { soul?: GetSharedSoulResponse; isLoading: boolean; refresh: () => Promise<unknown> } {
  const { data, isLoading, mutate: refresh } = useSWR<GetSharedSoulResponse>(SOUL_KEY, fetcher, { revalidateOnFocus: false });
  return { soul: data, isLoading, refresh: () => refresh() };
}

export async function saveSharedSoul(text: string, etag?: string): Promise<SharedSoulWriteResponse> {
  const { body: r } = await send<SharedSoulWriteResponse>(SOUL_KEY, "PUT", { text, etag });
  if (r.ok) await mutate(SOUL_KEY);
  return r;
}
