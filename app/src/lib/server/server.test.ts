/*
 * The studio's server side without the engine: the offline fleet snapshot, the per-agent route checks and the probe relay.
 * EIGEN_ENGINE_URL points at a port nothing listens on, so no test ever reaches a real engine (the user's runs on 4111).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agentPaths, ensureAgentDirs, ensureHome, homePaths } from "@eigen/engine/home";
import { setAgentSecret } from "@eigen/engine/store";
import { agentDetail, fleet, offlineSnapshot } from "./fleet";
import { agentOr } from "./http";
import { ENGINE_OFFLINE, forwardProbe } from "./probe";
import { extraNames, refusalOf } from "./secrets";

const saved = { home: process.env.EIGEN_HOME, engine: process.env.EIGEN_ENGINE_URL };
afterAll(() => {
  process.env.EIGEN_HOME = saved.home;
  process.env.EIGEN_ENGINE_URL = saved.engine;
});

const KEY_VALUE = "sk-ant-test-value-0123456789abcdef";
let p: ReturnType<typeof homePaths>;
beforeEach(() => {
  process.env.EIGEN_HOME = mkdtempSync(join(tmpdir(), "eigen-app-"));
  process.env.EIGEN_ENGINE_URL = "http://127.0.0.1:4197";
  p = homePaths();
  ensureHome(p);
});

const addAgent = (id: string, patch: Record<string, unknown> = {}) => {
  const a = agentPaths(p, id);
  ensureAgentDirs(a);
  writeFileSync(join(a.dir, "instructions.md"), "Work.\n");
  writeFileSync(a.configFile, JSON.stringify({ id, name: id.toUpperCase(), models: { main: { id: "anthropic/claude-sonnet-5-5" } }, model: "main", ...patch }));
};

describe("offline fleet snapshot", () => {
  it("shows every agent as an island with nothing between agents, every status offline", async () => {
    addAgent("alpha", { telegram: { enabled: true, allowedUserIds: [7] }, tools: { mcp: { files: { command: "node" } } } });
    addAgent("beta", { tools: { mcp: { web: { url: "https://mcp.example.com" } } } });
    setAgentSecret(p, "alpha", "ANTHROPIC_API_KEY", KEY_VALUE);
    setAgentSecret(p, "beta", "ANTHROPIC_API_KEY", KEY_VALUE);
    const f = await fleet();
    expect(f.engine).toBe("offline");
    expect(f.agents.map((a) => [a.id, a.runtime.status, a.runtime.problems])).toEqual([
      ["alpha", "offline", []],
      ["beta", "offline", []],
    ]);
    expect(f.topology.edges.map((e) => [e.source, e.target]).sort()).toEqual([
      ["agent:alpha", "mcp:alpha/files"],
      ["agent:beta", "mcp:beta/web"],
      ["channel:telegram:alpha", "agent:alpha"],
    ]);
    expect(JSON.stringify(f)).not.toContain(KEY_VALUE);
  });

  it("reports a missing key, a broken file and a shared database as problems, like the engine", () => {
    addAgent("alpha");
    addAgent("broken");
    writeFileSync(agentPaths(p, "broken").configFile, "{ nope");
    const db = { memory: { storage: { url: "https://db.example.com" } } };
    addAgent("one", db);
    addAgent("two", db);
    for (const id of ["one", "two"]) setAgentSecret(p, id, "ANTHROPIC_API_KEY", KEY_VALUE);
    const byId = Object.fromEntries(offlineSnapshot().agents.map((a) => [a.id, a.runtime.problems]));
    expect(byId.alpha).toEqual(["ANTHROPIC_API_KEY is not set in this agent's keys (models.main)"]);
    expect(byId.broken).toEqual([expect.stringMatching(/^config.json is not valid JSON/)]);
    expect(byId.one).toEqual([]);
    expect(byId.two).toEqual(['memory.storage.url is already used by "one"; agents never share storage']);
  });

  it("an agent's detail carries the raw files, its etag and its offline problems", async () => {
    addAgent("alpha");
    const d = (await agentDetail("alpha"))!;
    expect(d).toMatchObject({ config: { id: "alpha" }, instructionsText: "Work.\n", soulText: null, resolved: null, runtime: { status: "offline" } });
    expect(d.runtime.problems).toHaveLength(1);
    expect(await agentDetail("ghost")).toBeNull();
  });

  it("an empty home is an empty fleet", async () => {
    expect(await fleet()).toMatchObject({ agents: [], topology: { nodes: [], edges: [] }, engine: "offline" });
  });
});

describe("per-agent route checks", () => {
  it("400 for a bad id, 404 for an unknown agent (no folder created), null for a real one", async () => {
    addAgent("alpha");
    expect(agentOr("alpha")).toBeNull();
    const bad = agentOr("../alpha")!;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, issues: ["id: must be a lowercase slug"] });
    const missing = agentOr("ghost", "error")!;
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: 'no agent "ghost"' });
    mkdirSync(join(p.agentsDir, "empty"));
    expect(agentOr("empty")!.status).toBe(404);
  });

  it("?names= keeps only valid env names, at most 50", () => {
    expect(extraNames("http://x/api?names=A_KEY,lower,,B%3DC, C1 ")).toEqual(["A_KEY", "C1"]);
    expect(extraNames(`http://x/api?names=${Array.from({ length: 60 }, (_, i) => `K${i}`).join(",")}`)).toHaveLength(50);
  });

  it("a refused secret never echoes its value", () => {
    expect(refusalOf(new Error(`bad value ${KEY_VALUE}`), KEY_VALUE)).toBe("bad value [value]");
  });

  it("probes answer { ok:false, error: the engine is offline } when nothing listens", async () => {
    const r = await forwardProbe("/eigen/agents/alpha/telegram/check", {}, 2000, (raw) => ({ ok: raw.ok === true }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: ENGINE_OFFLINE });
  });
});
