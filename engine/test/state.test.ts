import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeModelKey, patchState, readState } from "../src/mastra/lib/state.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

describe("chat state (per agent)", () => {
  it("starts empty, merges patches, and survives a reread", () => {
    const { paths } = tmpAgent();
    expect(readState(paths.stateFile)).toEqual({});
    patchState(paths.stateFile, { model: "cloud" });
    patchState(paths.stateFile, { verbose: true });
    expect(readState(paths.stateFile)).toEqual({ model: "cloud", verbose: true });
  });

  it("each agent has its own: one agent's /model never moves another's", () => {
    const a = tmpAgent();
    const b = tmpAgent({}, { id: "b", home: join(a.paths.dir, "..", "..") });
    patchState(a.paths.stateFile, { model: "x" });
    expect(readState(b.paths.stateFile)).toEqual({});
  });

  it("falls back to the configured model when the choice is gone from config.json", () => {
    const { paths, r } = tmpAgent({ models: { main: { id: "fake/a", url: "http://x.test/v1" }, alt: { id: "fake/b", url: "http://x.test/v1" } } });
    expect(activeModelKey(r, paths.stateFile)).toBe("main");
    patchState(paths.stateFile, { model: "alt" });
    expect(activeModelKey(r, paths.stateFile)).toBe("alt");
    patchState(paths.stateFile, { model: "deleted-long-ago" });
    expect(activeModelKey(r, paths.stateFile)).toBe("main");
    patchState(paths.stateFile, { model: "constructor" }); // not an own key of models
    expect(activeModelKey(r, paths.stateFile)).toBe("main");
  });
});
