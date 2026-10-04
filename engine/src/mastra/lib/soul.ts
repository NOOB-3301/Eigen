/**
 * An agent's persona block (<soul>). shared: ~/.eigen/SOUL.md. own: a .md file in the agent's folder (soul.md). none: no block.
 * Read from disk on every turn, like the instructions, so a soul edited in the studio applies to the next message with no reload.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HomePaths } from "./home.ts";
import { readText } from "./instructions.ts";
import type { ResolvedAgent } from "./schema.ts";

const escapes = (root: string, full: string) => {
  const rel = relative(root, full);
  return !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/**
 * The text of an agent's own soul file, or why it cannot be used. The file must be a .md inside the agent's folder, also after
 * symlinks are resolved (a soul.md linked to .env or to a folder elsewhere is refused). The studio's writer (store.ts soulPath) applies the same rule.
 */
export function readOwnSoul(agentDir: string, file: string): { text: string } | { problem: string } {
  const full = resolve(agentDir, file);
  if (!file.endsWith(".md") || escapes(agentDir, full)) return { problem: "soul.file must be a .md file inside the agent folder" };
  try {
    const real = realpathSync(full);
    if (escapes(realpathSync(agentDir), real)) return { problem: "soul.file must stay inside the agent folder (it is a link that leads out)" };
    return { text: readFileSync(real, "utf8").trim() };
  } catch {
    return { problem: `soul file ${file} is missing or unreadable` };
  }
}

/** What goes inside <soul> this turn. A missing own file is reported by the registry's scan; the turn itself just runs without it. */
export function soulText(soul: ResolvedAgent["soul"], p: Pick<HomePaths, "soulFile">, agentDir: string): string {
  if (soul.source === "shared") return readText(p.soulFile);
  if (soul.source === "none") return "";
  const own = readOwnSoul(agentDir, soul.file);
  return "text" in own ? own.text : "";
}
