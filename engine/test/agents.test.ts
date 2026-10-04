import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRegistry, delegationContext, scanAgents, toolsFromServers, type AgentFactory, type AgentRegistry } from "../src/mastra/lib/agents.ts";
import { reloadConfig } from "../src/mastra/lib/config.ts";
import { homePaths, seedAgents, type HomePaths } from "../src/mastra/lib/home.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import type { AgentConfigInput, AgentEvent } from "../src/mastra/lib/schema.ts";
import { readAgent, trashAgent, writeAgent } from "../src/mastra/lib/store.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { tmpHome } from "./helpers/home.ts";

const ENGINE = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tmp home whose root config is the one getConfig()/reloadConfig() read. */
function home(patch: Record<string, unknown> = {}) {
  const p = tmpHome(patch);
  process.env.EIGEN_HOME = p.home;
  reloadConfig();
  return p;
}

function addAgent(p: HomePaths, id: string, patch: Partial<AgentConfigInput> = {}, instructions = "Research things.") {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), instructions);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, ...patch }));
  return dir;
}

const rootCfg = () => reloadConfig();

const stubMcp = { load: async () => ({ tools: {}, errors: {}, servers: [] }), state: () => ({ tools: {}, errors: {}, servers: [] }), tools: () => ({}), close: async () => undefined } as unknown as Mcp;

function fakeMastra() {
  const agents = new Map<string, Agent>();
  return {
    agents,
    addAgent: (a: Agent, key: string) => {
      if (agents.has(key)) throw new Error(`duplicate ${key}`);
      agents.set(key, a);
    },
    removeAgent: (key: string) => agents.delete(key),
    getAgentById: (key: string) => agents.get(key),
  };
}

let open: AgentRegistry[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
});

function registry(p: HomePaths, debounceMs = 50) {
  const built: string[] = [];
  const disposed: string[] = [];
  const factory: AgentFactory = async (r) => {
    built.push(r.id);
    return { agent: { id: r.id, name: r.name } as unknown as Agent, dispose: async () => void disposed.push(r.id) };
  };
  const reg = createAgentRegistry({ paths: p, rootMcp: stubMcp, factory, debounceMs });
  const events: AgentEvent[] = [];
  reg.events.on("event", (e) => events.push(e));
  const mastra = fakeMastra();
  open.push(reg);
  return { reg, built, disposed, events, mastra, attach: () => reg.attach(mastra as unknown as Mastra) };
}

describe("scanAgents", () => {
  it("loads the seeded primary and a valid specialist, resolved against the root", () => {
    const p = home();
    addAgent(p, "researcher", { model: "cloud", limits: { maxSteps: 5 } });
    const { agents, fleet } = scanAgents(p.agentsDir, rootCfg());
    expect(fleet).toEqual([]);
    const r = agents.get("researcher")!;
    expect(r.problems).toEqual([]);
    expect(r.resolved).toMatchObject({ modelKey: "cloud", maxSteps: 5, primary: false, aliases: ["researcher"], provenance: { model: "agent", "memory.lastMessages": "root" } });
    expect(agents.get("eigen")!.resolved).toMatchObject({ primary: true, modelKey: "local", instructions: { includeMemoryFiles: true } });
  });

  it("reports schema errors, id/folder mismatch, missing instructions and unknown references", () => {
    const p = home();
    addAgent(p, "bad", { name: "" });
    addAgent(p, "renamed", { id: "other" } as Partial<AgentConfigInput>);
    addAgent(p, "ghost", { model: "nope", tools: { mcp: { inherit: ["missing"] } } });
    const noFile = addAgent(p, "nofile");
    rmSync(join(noFile, "instructions.md"));
    mkdirSync(join(p.agentsDir, "empty"));
    const { agents } = scanAgents(p.agentsDir, rootCfg());
    expect(agents.get("bad")!.problems.join()).toMatch(/name/);
    expect(agents.get("renamed")!.problems.join()).toMatch(/must equal the folder name/);
    expect(agents.get("ghost")!.problems).toEqual([expect.stringMatching(/model "nope"/), expect.stringMatching(/"missing" is not in root mcpServers/)]);
    expect(agents.get("nofile")!.problems.join()).toMatch(/instructions file instructions.md is missing/);
    expect(agents.get("empty")!.problems.join()).toMatch(/cannot read config.json/);
    for (const id of ["bad", "renamed", "ghost", "nofile", "empty"]) expect(agents.get(id)!.resolved).toBeUndefined();
  });

  it("rejects instruction files that are not markdown", () => {
    const p = home();
    addAgent(p, "peek", { instructions: { file: "../../.env" } });
    expect(scanAgents(p.agentsDir, rootCfg()).agents.get("peek")!.problems.join()).toMatch(/\.md/);
  });

  it("flags alias clashes on the second owner only", () => {
    const p = home();
    addAgent(p, "alpha", { telegram: { aliases: ["r"] } });
    addAgent(p, "beta", { telegram: { aliases: ["r"] } });
    const { agents } = scanAgents(p.agentsDir, rootCfg());
    expect(agents.get("alpha")!.resolved).toBeDefined();
    expect(agents.get("beta")!.problems.join()).toMatch(/alias "r" is already used by "alpha"/);
    expect(agents.get("beta")!.resolved).toBeUndefined();
  });

  it("needs exactly one enabled primary", () => {
    const p = home();
    addAgent(p, "second", { primary: true, delegation: { acceptsFrom: "none" } });
    expect(scanAgents(p.agentsDir, rootCfg()).fleet.join()).toMatch(/found 2: eigen, second/);
    rmSync(join(p.agentsDir, "second"), { recursive: true });
    rmSync(join(p.agentsDir, "eigen"), { recursive: true });
    addAgent(p, "solo");
    expect(scanAgents(p.agentsDir, rootCfg()).fleet.join()).toMatch(/found 0: none/);
  });

  it("ignores .trash and _drafts folders", () => {
    const p = home();
    addAgent(p, "_draft");
    mkdirSync(join(p.agentsDir, ".trash"), { recursive: true });
    addAgent(p, "old");
    renameSync(join(p.agentsDir, "old"), join(p.agentsDir, ".trash", "old"));
    expect([...scanAgents(p.agentsDir, rootCfg()).agents.keys()]).toEqual(["eigen"]);
  });
});

describe("inherited MCP tools", () => {
  it("assigns each tool to the longest server name that prefixes it", () => {
    const tools = { git_status: 1, git_hub_issues: 2, other_x: 3 };
    const all = ["git", "git_hub", "other"];
    expect(toolsFromServers(tools, ["git"], all)).toEqual({ git_status: 1 });
    expect(toolsFromServers(tools, ["git_hub", "other"], all)).toEqual({ git_hub_issues: 2, other_x: 3 });
    expect(toolsFromServers(tools, [], all)).toEqual({});
  });
});

describe("delegation context", () => {
  it("never passes the caller's system prompt; isolated agents get no conversation at all", () => {
    const messages = (["system", "user", "assistant", "signal"] as const).map((role) => ({ role }) as never);
    const scope = { iso: "isolated", sh: "shared" } as Record<string, "isolated" | "shared">;
    const { messageFilter } = delegationContext((id) => (scope[id] ? ({ memory: { scope: scope[id] } } as never) : undefined));
    expect(messageFilter({ messages, primitiveId: "iso" })).toEqual([]);
    expect(messageFilter({ messages, primitiveId: "sh" }).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messageFilter({ messages, primitiveId: "unknown" })).toEqual([]);
  });
});

describe("agent registry", () => {
  it("loads specialists into Mastra on attach and wires delegation from the primary", async () => {
    const p = home();
    addAgent(p, "researcher");
    const { reg, built, events, mastra, attach } = registry(p);
    await reg.start();
    expect(built).toEqual([]); // no Mastra yet
    expect(reg.resolved("eigen")?.primary).toBe(true);
    await attach();
    await attach(); // idempotent
    expect(built).toEqual(["researcher"]);
    expect([...mastra.agents.keys()]).toEqual(["researcher"]);
    expect(Object.keys(reg.subAgents("eigen"))).toEqual(["researcher"]);
    expect(events.filter((e) => e.type === "agent.loaded").map((e) => e.type === "agent.loaded" && e.id)).toEqual(["eigen", "researcher"]);
    const snap = reg.snapshot();
    expect(snap.agents.map((a) => [a.id, a.runtime.status])).toEqual([
      ["eigen", "loaded"],
      ["researcher", "loaded"],
    ]);
    expect(snap.topology.edges.map((e) => e.id)).toContain("delegates:eigen->researcher");
    expect(reg.detail("researcher")).toMatchObject({ id: "researcher", runtime: { status: "loaded" }, resolved: { id: "researcher" } });
    expect(reg.detail("nobody")).toBeUndefined();
    expect(reg.byAlias("RESEARCHER")).toBe("researcher");
  });

  it("rebuilds a changed agent, disposing the old version", async () => {
    const p = home();
    const dir = addAgent(p, "researcher");
    const { reg, built, disposed, mastra, attach } = registry(p);
    await attach();
    const before = mastra.agents.get("researcher");
    await reg.reload();
    expect(built).toEqual(["researcher"]); // unchanged: no rebuild
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), description: "New job." }));
    await reg.reload();
    expect(built).toEqual(["researcher", "researcher"]);
    expect(disposed).toEqual(["researcher"]);
    expect(mastra.agents.get("researcher")).not.toBe(before);
    expect(reg.resolved("researcher")?.description).toBe("New job.");
  });

  it("a root change reloads only the agents that inherit the changed value", async () => {
    const p = home();
    addAgent(p, "inherits");
    addAgent(p, "pinned", { model: "cloud" });
    const { reg, built, attach } = registry(p);
    await attach();
    expect(built.sort()).toEqual(["inherits", "pinned"]);
    const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
    writeFileSync(p.configFile, JSON.stringify({ ...cfg, defaultModel: "cloud" }));
    await reg.reload(true);
    expect(built.sort()).toEqual(["inherits", "inherits", "pinned"]);
    expect(reg.resolved("inherits")?.modelKey).toBe("cloud");
    expect(reg.resolved("eigen")?.modelKey).toBe("cloud");
  });

  it("keeps the last good version running when a file turns invalid (stale), and marks a new bad agent invalid", async () => {
    const p = home();
    const dir = addAgent(p, "researcher");
    const { reg, events, mastra, attach } = registry(p);
    await attach();
    writeFileSync(join(dir, "config.json"), "{ not json");
    addAgent(p, "broken", { role: "" });
    await reg.reload();
    expect(mastra.agents.has("researcher")).toBe(true);
    const byId = Object.fromEntries(reg.summaries().map((s) => [s.id, s.runtime]));
    expect(byId.researcher).toMatchObject({ status: "stale", loadedHash: expect.any(String) });
    expect(byId.researcher!.problems.join()).toMatch(/cannot read config.json/);
    expect(byId.broken!.status).toBe("invalid");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.error", id: "researcher", stale: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.error", id: "broken", stale: false }));
    expect(Object.keys(reg.subAgents("eigen"))).toEqual(["researcher"]);
  });

  it("removes deleted, trashed and disabled agents", async () => {
    const p = home();
    addAgent(p, "gone");
    addAgent(p, "trashed");
    const off = addAgent(p, "off");
    const { reg, disposed, events, mastra, attach } = registry(p);
    await attach();
    expect([...mastra.agents.keys()].sort()).toEqual(["gone", "off", "trashed"]);
    rmSync(join(p.agentsDir, "gone"), { recursive: true });
    expect(trashAgent(p, "trashed").status).toBe(200);
    writeFileSync(join(off, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(off, "config.json"), "utf8")), enabled: false }));
    await reg.reload();
    expect([...mastra.agents.keys()]).toEqual([]);
    expect(disposed.sort()).toEqual(["gone", "off", "trashed"]);
    expect(events.filter((e) => e.type === "agent.removed").length).toBe(3);
    expect(reg.summaries().map((s) => [s.id, s.runtime.status])).toEqual(
      expect.arrayContaining([
        ["eigen", "loaded"],
        ["off", "disabled"],
      ]),
    );
    expect(reg.summaries().map((s) => s.id)).not.toContain("trashed");
  });

  it("picks up a new agent folder through fs.watch without a restart", async () => {
    const p = home();
    const { reg, events, mastra, attach } = registry(p, 50);
    await attach();
    reg.watch();
    await sleep(100);
    addAgent(p, "late");
    const end = Date.now() + 8000;
    while (Date.now() < end && !events.some((e) => e.type === "agent.loaded" && e.id === "late")) await sleep(50);
    expect(mastra.agents.has("late")).toBe(true);
  });

  it("drops an agent through fs.watch when the studio trashes its folder (a bare rename, no file events inside)", async () => {
    const p = home();
    addAgent(p, "gone");
    const { reg, events, mastra, attach } = registry(p, 50);
    await attach();
    reg.watch();
    await sleep(300);
    expect(mastra.agents.has("gone")).toBe(true);

    trashAgent(p, "gone");
    const end = Date.now() + 8000;
    while (Date.now() < end && !events.some((e) => e.type === "agent.removed" && e.id === "gone")) await sleep(50);
    expect(mastra.agents.has("gone")).toBe(false);
  });
});

describe("store", () => {
  it("guards writes with an etag (409) and validates before writing (400)", () => {
    const p = home();
    addAgent(p, "researcher");
    const file = join(p.agentsDir, "researcher", "config.json");
    const a = readAgent(p, "researcher")!;
    const next = { ...a.config, description: "Changed." };

    const stale = writeAgent(p, rootCfg(), "researcher", { config: next, etag: "0000" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, etag: a.etag });

    const before = readFileSync(file, "utf8");
    const bad = writeAgent(p, rootCfg(), "researcher", { config: { ...next, model: "nope" }, instructionsText: "never written", etag: a.etag });
    expect(bad.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(join(p.agentsDir, "researcher", "instructions.md"), "utf8")).toBe("Research things.");

    const ok = writeAgent(p, rootCfg(), "researcher", { config: next, instructionsText: "Dig deeper.", etag: a.etag });
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    expect(readAgent(p, "researcher")).toMatchObject({ config: { description: "Changed." }, instructionsText: "Dig deeper.\n", etag: (ok.body as { etag: string }).etag });
    expect(readdirSync(join(p.agentsDir, "researcher")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(writeAgent(p, rootCfg(), "researcher", { config: next, etag: a.etag }).status).toBe(409);
  });

  it("refuses to trash the primary and moves others to .trash", () => {
    const p = home();
    addAgent(p, "researcher");
    expect(trashAgent(p, "eigen").status).toBe(400);
    expect(existsSync(join(p.agentsDir, "eigen", "config.json"))).toBe(true);
    const t = trashAgent(p, "researcher");
    expect(t.status).toBe(200);
    expect(existsSync(join(t.trashedTo!, "instructions.md"))).toBe(true);
    expect(() => readAgent(p, "../x")).toThrow(/invalid agent id/);
  });
});

describe("migration", () => {
  it("seeds the primary once, using the root system prompt, and never touches existing state", () => {
    const p = homePaths(tmpHome().home);
    rmSync(p.agentsDir, { recursive: true });
    writeFileSync(join(p.memoryDir, "profile.md"), "mine");
    mkdirSync(join(p.dataDir), { recursive: true });
    writeFileSync(join(p.dataDir, "eigen.db"), "db");

    expect(seedAgents(p)).toEqual([".agents/eigen/config.json"]);
    expect(seedAgents(p)).toEqual([]);
    const cfg = JSON.parse(readFileSync(join(p.agentsDir, "eigen", "config.json"), "utf8"));
    expect(cfg).toMatchObject({ id: "eigen", primary: true, instructions: { file: "../../prompts/system.md" } });
    expect(readFileSync(join(p.memoryDir, "profile.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(p.dataDir, "eigen.db"), "utf8")).toBe("db");

    process.env.EIGEN_HOME = p.home;
    const primary = scanAgents(p.agentsDir, reloadConfig()).agents.get("eigen")!;
    expect(primary.problems).toEqual([]);
    expect(primary.instructionsFile).toBe(join(p.agentsDir, "eigen", "../../prompts/system.md"));
  });

  it("does not seed when any agent folder exists, and the script is idempotent", () => {
    const p = homePaths(tmpHome().home);
    rmSync(p.agentsDir, { recursive: true });
    addAgent(p, "mine");
    expect(seedAgents(p)).toEqual([]);
    expect(existsSync(join(p.agentsDir, "eigen"))).toBe(false);

    const q = homePaths(tmpHome().home);
    rmSync(q.agentsDir, { recursive: true });
    const run = () => execFileSync(process.execPath, ["scripts/migrate.ts"], { cwd: ENGINE, env: { ...process.env, EIGEN_HOME: q.home }, encoding: "utf8" });
    expect(run()).toMatch(/created .agents\/eigen\/config.json/);
    const first = readFileSync(join(q.agentsDir, "eigen", "config.json"), "utf8");
    expect(run()).toMatch(/nothing to do/);
    expect(readFileSync(join(q.agentsDir, "eigen", "config.json"), "utf8")).toBe(first);
  });
});

describe("primary instructions settings", () => {
  it("default settings keep the classic prompt byte for byte; overrides drop soul and memory", () => {
    const p = home();
    const at = new Date("2026-10-01T09:30:00Z");
    const classic = buildInstructions(p, "UTC", at);
    expect(buildInstructions(p, "UTC", at, { text: readFileSync(p.systemPromptFile, "utf8").trim(), soul: true, memory: true })).toBe(classic);
    const lean = buildInstructions(p, "UTC", at, { text: "Only this.", soul: false, memory: false });
    expect(lean).toContain("<operating_instructions>\nOnly this.\n</operating_instructions>");
    expect(lean).not.toContain("<soul>");
    expect(lean).not.toContain("<memory>");
    expect(lean).toContain("<ground_rules>");
  });
});
