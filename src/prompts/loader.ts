import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../util/logger.ts";
import { estimateText } from "../util/tokens.ts";

export type PromptFile = "system" | "soul";

export type PromptSet = {
  system: string;
  soul: string;
  // Where each came from, so /reload can tell the user about fallbacks.
  sources: Record<PromptFile, "home" | "default">;
  notes: string[];
};

export type PromptPaths = { home: string; defaultsDir: string };

const REL: Record<PromptFile, string> = { system: "prompts/system.md", soul: "SOUL.md" };

export const SOUL_WARN_TOKENS = 500;

function readNonEmpty(path: string): string {
  const s = readFileSync(path, "utf8");
  if (!s.trim()) throw new Error("file is empty");
  return s.trim();
}

function loadOne(which: PromptFile, paths: PromptPaths, notes: string[]): { text: string; source: "home" | "default" } {
  const homePath = join(paths.home, REL[which]);
  try {
    return { text: readNonEmpty(homePath), source: "home" };
  } catch (e) {
    const note = `${REL[which]} missing or unreadable in ${paths.home} (${(e as Error).message}); using packaged default`;
    logger.warn({ evt: "prompt_fallback", file: REL[which], err: (e as Error).message }, note);
    notes.push(note);
  }
  // No catch: if the packaged default is also unusable there is no safe prompt, so fail loudly.
  return { text: readNonEmpty(join(paths.defaultsDir, REL[which])), source: "default" };
}

export function loadPrompts(paths: PromptPaths): PromptSet {
  const notes: string[] = [];
  const system = loadOne("system", paths, notes);
  const soul = loadOne("soul", paths, notes);
  const set: PromptSet = { system: system.text, soul: soul.text, sources: { system: system.source, soul: soul.source }, notes };
  const soulTokens = estimateText(set.soul);
  logger.info({ evt: "prompts_loaded", systemTokens: estimateText(set.system), soulTokens, sources: set.sources });
  if (soulTokens > SOUL_WARN_TOKENS) {
    const note = `SOUL.md is ~${soulTokens} tokens (recommended <= ${SOUL_WARN_TOKENS}); it is sent on every call`;
    logger.warn({ evt: "soul_large", soulTokens }, note);
    notes.push(note);
  }
  return set;
}
