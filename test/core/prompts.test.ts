import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, BLOCK_ORDER, renderSystem } from "../../src/core/context.ts";
import { DEFAULTS_DIR } from "../../src/config/home.ts";
import { loadPrompts } from "../../src/prompts/loader.ts";
import { Agent } from "../../src/core/agent.ts";
import { FakeProvider, FakeRegistry, testConfig } from "../helpers/fake-provider.ts";
import { tempHome } from "../helpers/agent.ts";
import { readFileSync } from "node:fs";

describe("prompt assembly", () => {
  it("renders blocks in fixed order with delimiters and skips empty reserved blocks", () => {
    const { system, blocks } = renderSystem({ system: "SYS", soul: "SOUL", sources: { system: "home", soul: "home" }, notes: [] });
    expect(blocks.map((b) => b.name)).toEqual(["system", "soul"]);
    expect(BLOCK_ORDER).toEqual(["system", "soul", "memory", "skills"]);
    expect(system.indexOf("SYS")).toBeLessThan(system.indexOf("SOUL"));
    expect(system).toBe("<operating_instructions>\nSYS\n</operating_instructions>\n\n<soul>\nSOUL\n</soul>");
  });

  it("buildContext output is stable across calls (cache-friendly prefix)", () => {
    const prompts = loadPrompts({ home: tempHome(), defaultsDir: DEFAULTS_DIR });
    const entry = testConfig().models.fake!;
    const input = { prompts, messages: [], entry, tools: [], limits: { imageTokenEstimate: 1000 } };
    expect(buildContext(input).system).toBe(buildContext(input).system);
    expect(buildContext(input).system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("falls back to packaged defaults when SOUL.md / system.md are missing", () => {
    const home = tempHome({});
    const p = loadPrompts({ home, defaultsDir: DEFAULTS_DIR });
    expect(p.sources).toEqual({ system: "default", soul: "default" });
    expect(p.soul).toBe(readFileSync(join(DEFAULTS_DIR, "SOUL.md"), "utf8").trim());
    expect(p.notes.join()).toMatch(/SOUL.md missing/);
  });

  it("treats an empty home file as missing", () => {
    const p = loadPrompts({ home: tempHome({ "SOUL.md": "   \n", "prompts/system.md": "S" }), defaultsDir: DEFAULTS_DIR });
    expect(p.sources).toEqual({ system: "home", soul: "default" });
  });

  it("/reload keeps the previous prompts when loading fails", async () => {
    const home = tempHome();
    const defaultsDir = mkdtempSync(join(tmpdir(), "eigen-defaults-")); // empty: no fallback available
    const config = testConfig();
    const provider = new FakeProvider([{ text: "x" }]);
    const agent = new Agent({ config, home, defaultsDir, models: new FakeRegistry(config, provider) });
    rmSync(join(home, "SOUL.md"));
    const r = agent.reload();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/keeping the previous prompts/);
    expect(agent.newSession("s").message).toMatch(/Reload failed/);
    const done = new Promise<void>((res) => agent.on((e) => e.type === "done" && res()));
    agent.submit({ sessionId: "s", text: "hi", channel: "t" });
    await done;
    expect(provider.requests[0]!.system).toContain("Home soul.");
  });

  it("/new picks up edited prompts", async () => {
    const home = tempHome({ "SOUL.md": "v1", "prompts/system.md": "S" });
    const config = testConfig();
    const provider = new FakeProvider([{ text: "ok" }]);
    const agent = new Agent({ config, home, models: new FakeRegistry(config, provider) });
    const wait = () => new Promise<void>((r) => agent.on((e) => e.type === "done" && r()));
    let w = wait();
    agent.submit({ sessionId: "s", text: "a", channel: "t" });
    await w;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "SOUL.md"), "v2");
    w = wait();
    agent.submit({ sessionId: "s", text: "b", channel: "t" });
    await w;
    expect(provider.requests[1]!.system).toContain("v1"); // frozen for the session
    agent.newSession("s");
    w = wait();
    agent.submit({ sessionId: "s", text: "c", channel: "t" });
    await w;
    expect(provider.requests[2]!.system).toContain("v2");
    expect(provider.requests[2]!.messages).toHaveLength(1);
  });
});
