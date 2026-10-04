import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { HomePaths } from "./home.ts";

export type State = { model?: string; verbose?: boolean };

const file = (p: HomePaths) => join(p.dataDir, "state.json");

/** Choices made from chat (/model, /verbose); they survive restarts. */
export function readState(p: HomePaths): State {
  try {
    return JSON.parse(readFileSync(file(p), "utf8"));
  } catch {
    return {};
  }
}

export function patchState(p: HomePaths, patch: State) {
  const next = { ...readState(p), ...patch };
  writeFileSync(file(p), JSON.stringify(next));
  return next;
}

/** The model chosen with /model, unless config.json no longer has it; otherwise `base` (the primary's own `model`), then the root default. */
export const activeModel = (cfg: Config, state: State, base?: string) =>
  state.model && state.model in cfg.models ? state.model : base && base in cfg.models ? base : cfg.defaultModel;
