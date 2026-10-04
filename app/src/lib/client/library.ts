"use client";
import type { GetSharedSoulResponse, GetSkillResponse, ListSkillsResponse, SharedSoulWriteResponse, SkillSummary, SkillWriteResponse } from "@eigen/engine/schema";

/*
 * Client side of the skill library and the shared soul. INTERFACE ONLY for now: the data-layer worker fills these bodies in
 * (SWR hooks over /api/skills, /api/skills/[slug], /api/soul). Signatures are the contract the builder and editors compile against.
 */

/** Every skill under ~/.eigen/skills, with the agents that name it. */
export function useSkills(): { skills: SkillSummary[]; isLoading: boolean; refresh: () => Promise<unknown> } {
  const data: ListSkillsResponse = { skills: [] };
  return { skills: data.skills, isLoading: false, refresh: async () => undefined };
}

/** One skill's SKILL.md. `slug` may be "@owner/slug". Pass null to fetch nothing. */
export function useSkill(_slug: string | null): { skill?: GetSkillResponse; isLoading: boolean; error?: string; refresh: () => Promise<unknown> } {
  return { isLoading: false, refresh: async () => undefined };
}

export const saveSkill = async (_slug: string, _text: string, _etag?: string): Promise<SkillWriteResponse> => ({ ok: false, issues: ["not implemented"] });
export const createSkill = async (_input: { slug: string; description: string; text?: string }): Promise<SkillWriteResponse> => ({ ok: false, issues: ["not implemented"] });
/** Moves the skill folder to ~/.eigen/skills/.trash (never a hard delete). */
export const deleteSkill = async (_slug: string): Promise<{ ok: boolean; error?: string }> => ({ ok: false, error: "not implemented" });

/** The shared ~/.eigen/SOUL.md. */
export function useSharedSoul(): { soul?: GetSharedSoulResponse; isLoading: boolean; refresh: () => Promise<unknown> } {
  return { isLoading: false, refresh: async () => undefined };
}
export const saveSharedSoul = async (_text: string, _etag?: string): Promise<SharedSoulWriteResponse> => ({ ok: false, issues: ["not implemented"] });
