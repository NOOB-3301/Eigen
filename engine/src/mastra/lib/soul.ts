/**
 * An agent's persona block (<soul>): `soul.file` in the agent's own folder, when `soul.enabled`. There is no shared soul.
 * Read from disk on every turn, like the instructions, so a soul edited in the studio applies to the next message with no reload.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { agentMdFile } from "./home.ts";
import type { ResolvedAgent } from "./schema.ts";

/**
 * The text of a .md file named in the agent's config, or why it cannot be used. The name must be a plain .md file name in the agent folder
 * (agentMdFile), also after symlinks are resolved: the real file must be a .md directly in the agent folder, so a soul.md linked to the agent's
 * own .env, into its sandbox or data/, or to another agent's folder is refused.
 */
export function readAgentMd(agentDir: string, file: string): { text: string } | { problem: string } {
  const full = agentMdFile(agentDir, file);
  if (!full) return { problem: `${file} must be a .md file inside the agent folder` };
  try {
    const real = realpathSync(full);
    if (dirname(real) !== realpathSync(agentDir) || !real.endsWith(".md")) return { problem: `${file} must stay inside the agent folder (it is a link that leads out)` };
    return { text: readFileSync(real, "utf8").trim() };
  } catch {
    return { problem: `${file} is missing or unreadable` };
  }
}

/** Kept for callers that check a soul file before saving it. */
export const readOwnSoul = readAgentMd;

/** What goes inside <soul> this turn: "" when the soul is off or its file is missing (the registry's scan reports that). */
export function soulText(soul: ResolvedAgent["soul"], agentDir: string): string {
  if (!soul.enabled) return "";
  const own = readAgentMd(agentDir, soul.file);
  return "text" in own ? own.text : "";
}
