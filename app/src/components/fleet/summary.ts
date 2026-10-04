import type { AgentSummary } from "@eigen/engine/schema";

/*
 * What the fleet's summary card says about one agent, as pure functions (no React) so the wording is tested once and the card,
 * the phone list and the command palette agree.
 */

type Engine = "online" | "offline";

/** The sentence the engine and the studio use for a key the agent cannot think without (schema.ts missingKeys). */
const MISSING_KEY = /^([A-Z][A-Z0-9_]{0,63}) is not set in this agent's keys\b/;

/** Splits problems into the keys to set (names only) and everything else, so the card can say "Set ANTHROPIC_API_KEY" as an action. */
export function splitProblems(problems: string[]): { keys: string[]; other: string[] } {
  const keys: string[] = [];
  const other: string[] = [];
  for (const p of problems) {
    const m = MISSING_KEY.exec(p);
    if (m) keys.push(m[1]!);
    else other.push(p);
  }
  return { keys: [...new Set(keys)], other };
}

/** Whether the studio chat can talk to this agent now, and if not, why in one sentence. */
export function chatAvailability(a: Pick<AgentSummary, "name" | "runtime">, engine: Engine): { ok: boolean; reason?: string } {
  if (engine === "offline") return { ok: false, reason: "The engine is not running. Start it (npm run dev) to chat." };
  switch (a.runtime.status) {
    case "loaded":
    case "stale":
      return { ok: true };
    case "disabled":
      return { ok: false, reason: `${a.name} is turned off. Enable it in the builder to chat.` };
    case "invalid":
      return { ok: false, reason: `${a.name} has not loaded. Fix its problems in the builder.` };
    default:
      return { ok: false, reason: "The engine has not reported this agent yet." };
  }
}

/** The headline under the agent's name: its role, and what it is waiting for when it is not running. */
export function headline(a: Pick<AgentSummary, "role" | "enabled" | "runtime">, engine: Engine): string {
  const role = a.role || "assistant";
  if (!a.enabled) return `${role}, turned off`;
  if (engine === "offline") return `${role}, engine offline`;
  const { keys, other } = splitProblems(a.runtime.problems);
  if (keys.length && !other.length) return `${role}, needs ${keys.length === 1 ? "a key" : "keys"}`;
  if (a.runtime.problems.length) return `${role}, ${a.runtime.problems.length} ${a.runtime.problems.length === 1 ? "problem" : "problems"}`;
  return role;
}

/** Most problems first, then by name: the order of the phone list and of the palette with nothing typed. */
export const byAttention = <T extends Pick<AgentSummary, "name" | "runtime">>(agents: T[]): T[] =>
  [...agents].sort((x, y) => y.runtime.problems.length - x.runtime.problems.length || x.name.localeCompare(y.name));
