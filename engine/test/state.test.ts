import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { activeModel, patchState, readState } from "../src/mastra/lib/state.ts";
import { tmpHome } from "./helpers/home.ts";

describe("chat state", () => {
  it("starts empty, merges patches, and survives a reread", () => {
    const p = tmpHome();
    expect(readState(p)).toEqual({});
    patchState(p, { model: "cloud" });
    patchState(p, { verbose: true });
    expect(readState(p)).toEqual({ model: "cloud", verbose: true });
  });

  it("falls back to the default model when the choice is gone from config.json", () => {
    const p = tmpHome();
    const cfg = loadConfig(p.configFile);
    expect(activeModel(cfg, {})).toBe(cfg.defaultModel);
    expect(activeModel(cfg, { model: "cloud" })).toBe("cloud");
    expect(activeModel(cfg, { model: "deleted-long-ago" })).toBe(cfg.defaultModel);
  });
});
