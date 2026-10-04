import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedAgent } from "./schema.ts";

/** One agent's choices made from chat (/model, /verbose), in its data/state.json. They survive restarts and reloads; config.json is never touched. */
export type State = { model?: string; verbose?: boolean };

export function readState(file: string): State {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function patchState(file: string, patch: State) {
  const next = { ...readState(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next));
  return next;
}

/** The model the agent uses now: the one chosen with /model while its config still has it, else its configured `model`. */
export const activeModelKey = (r: Pick<ResolvedAgent, "models" | "modelKey">, stateFile: string): string => {
  const chosen = readState(stateFile).model;
  return chosen && Object.hasOwn(r.models, chosen) ? chosen : r.modelKey;
};
