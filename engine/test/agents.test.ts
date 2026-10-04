import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanAgents } from "../src/mastra/lib/agents.ts";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import { agentPaths, type HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { tmpHome, writeAgent } from "./helpers/home.ts";
import { closeRegistries, registryRig, sleep, until } from "./helpers/registry.ts";

afterEach(closeRegistries);

const keyed: Partial<AgentConfigInput> = { models: { main: { id: "anthropic/claude-x" } }, model: "main" };
const editConfig = (p: HomePaths, id: string, patch: Record<string, unknown>) => {
  const file = agentPaths(p, id).configFile;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};

describe("scanAgents", () => {
  it("resolves a valid agent with the machine's time zone and its own model", () => {
    const p = tmpHome();
    writeAgent(p, "researcher", { limits: { maxSteps: 5 } });
    writeAgent(p, "zoned", { timezone: "Asia/Kolkata" });
    const { agents, fleet } = scanAgents(p, "Europe/Paris");
    expect(fleet).toEqual([]);
    expect(agents.get("researcher")).toMatchObject({ problems: [], resolved: { modelKey: "main", maxSteps: 5, timezone: "Europe/Paris" }, hash: expect.any(String) });
    expect(agents.get("zoned")!.resolved!.timezone).toBe("Asia/Kolkata");
  });

  it("reports schema errors, id/folder mismatch, missing instructions and soul files, and unreadable configs", () => {
    const p = tmpHome();
    writeAgent(p, "bad", { name: "" });
    writeAgent(p, "renamed", { id: "other" });
    rmSync(join(writeAgent(p, "nofile").dir, "instructions.md"));
    writeAgent(p, "soulless", { soul: { enabled: true } });
    writeAgent(p, "inline", { instructions: { inline: "Be brief." } });
    rmSync(join(agentPaths(p, "inline").dir, "instructions.md"));
    mkdirSync(join(p.agentsDir, "empty"));
    const { agents } = scanAgents(p, "UTC");
    expect(agents.get("bad")!.problems.join()).toMatch(/name/);
    expect(agents.get("renamed")!.problems.join()).toMatch(/must equal the folder name/);
    expect(agents.get("nofile")!.problems.join()).toMatch(/instructions\.file: instructions\.md is missing/);
    expect(agents.get("soulless")!.problems.join()).toMatch(/soul\.file: soul\.md is missing/);
    expect(agents.get("empty")!.problems.join()).toMatch(/cannot read config.json/);
    for (const id of ["bad", "renamed", "nofile", "soulless", "empty"]) expect(agents.get(id)!.resolved).toBeUndefined();
    expect(agents.get("inline")!.problems).toEqual([]);
  });

  it("never lets a config point at a file outside the agent folder", () => {
    const p = tmpHome();
    writeAgent(p, "peek", { instructions: { file: "../other/instructions.md" } });
    writeAgent(p, "env", { soul: { enabled: true, file: ".env" } });
    const { agents } = scanAgents(p, "UTC");
    expect(agents.get("peek")!.resolved).toBeUndefined();
    expect(agents.get("env")!.resolved).toBeUndefined();
  });

  it("a prompt file that is a link leading out of the folder (to a .env, say) makes the agent invalid", () => {
    const p = tmpHome();
    const a = writeAgent(p, "linked");
    const b = agentPaths(p, "linked");
    rmSync(join(b.dir, "instructions.md"));
    symlinkSync(b.envFile, join(b.dir, "instructions.md"));
    const { agents } = scanAgents(p, "UTC");
    expect(a).toBeDefined();
    expect(agents.get("linked")!.resolved).toBeUndefined();
    expect(agents.get("linked")!.problems.join(" ")).toMatch(/instructions\.file: .*link/);
  });

  it("a key the agent thinks with must be in ITS .env, never the engine's environment", () => {
    const p = tmpHome();
    writeAgent(p, "nokey", keyed);
    writeAgent(p, "haskey", keyed, { env: { ANTHROPIC_API_KEY: "sk-ant-own-key" } });
    process.env.ANTHROPIC_API_KEY = "sk-from-the-shell";
    try {
      const { agents } = scanAgents(p, "UTC");
      expect(agents.get("nokey")!.problems).toEqual([expect.stringMatching(/ANTHROPIC_API_KEY is not set in this agent's keys \(models.main\)/)]);
      expect(agents.get("haskey")!.problems).toEqual([]);
      expect(agents.get("haskey")!.env.get("ANTHROPIC_API_KEY")).toBe("sk-ant-own-key");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("changes the hash of the agent whose key changes, and nobody else's; an unrelated variable changes nothing", () => {
    const p = tmpHome();
    writeAgent(p, "alpha", keyed, { env: { ANTHROPIC_API_KEY: "one" } });
    writeAgent(p, "beta", keyed, { env: { ANTHROPIC_API_KEY: "one" } });
    const hashes = () => Object.fromEntries([...scanAgents(p, "UTC").agents].map(([id, a]) => [id, a.hash]));
    const before = hashes();
    setSecret(agentPaths(p, "alpha").envFile, "UNRELATED", "x");
    expect(hashes()).toEqual(before);
    setSecret(agentPaths(p, "alpha").envFile, "ANTHROPIC_API_KEY", "two");
    const after = hashes();
    expect(after.alpha).not.toBe(before.alpha);
    expect(after.beta).toBe(before.beta);
  });

  it("two agents on one remote database: the second (by id) is invalid", () => {
    const p = tmpHome();
    const memory = { storage: { url: "https://db.example.com" } };
    writeAgent(p, "bbb", { memory });
    writeAgent(p, "aaa", { memory });
    const { agents } = scanAgents(p, "UTC");
    expect(agents.get("aaa")!.resolved).toBeDefined();
    expect(agents.get("bbb")!.problems.join()).toMatch(/already used by "aaa"/);
  });

  it("ignores .trash and _drafts folders, and an empty home has no agents", () => {
    const p = tmpHome();
    expect(scanAgents(p, "UTC").agents.size).toBe(0);
    writeAgent(p, "_draft" as string);
    mkdirSync(join(p.agentsDir, ".trash"), { recursive: true });
    writeAgent(p, "old");
    renameSync(join(p.agentsDir, "old"), join(p.agentsDir, ".trash", "old"));
    expect([...scanAgents(p, "UTC").agents.keys()]).toEqual([]);
  });
});

describe("agent registry", () => {
  it("starts with zero agents and serves an empty snapshot", async () => {
    const p = tmpHome();
    const { reg, attach } = registryRig(p);
    await attach();
    expect(reg.snapshot()).toMatchObject({ agents: [], fleetProblems: [], topology: { nodes: [], edges: [] } });
  });

  it("loads agents into Mastra on attach, each built with its own folder and its own .env", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha", keyed, { env: { ANTHROPIC_API_KEY: "key-alpha" } });
    writeAgent(p, "beta", keyed, { env: { ANTHROPIC_API_KEY: "key-beta" } });
    const { reg, builds, contexts, events, agents, attach } = registryRig(p);
    await attach();
    await attach(); // idempotent
    expect(builds).toEqual({ alpha: 1, beta: 1 });
    expect([...agents.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(contexts.alpha![0]!.paths.dir).toBe(join(p.agentsDir, "alpha"));
    expect([...contexts.alpha![0]!.env]).toEqual([["ANTHROPIC_API_KEY", "key-alpha"]]);
    expect([...contexts.beta![0]!.env]).toEqual([["ANTHROPIC_API_KEY", "key-beta"]]);
    expect(events.filter((e) => e.type === "agent.loaded").map((e) => e.type === "agent.loaded" && e.id)).toEqual(["alpha", "beta"]);
    const snap = reg.snapshot();
    expect(snap.agents.map((a) => [a.id, a.runtime.status, a.modelKey])).toEqual([
      ["alpha", "loaded", "main"],
      ["beta", "loaded", "main"],
    ]);
    expect(snap.topology.nodes.map((n) => n.id)).toEqual(["agent:alpha", "agent:beta"]);
    expect(snap.topology.edges).toEqual([]);
    expect(reg.detail("alpha")).toMatchObject({ id: "alpha", runtime: { status: "loaded" }, resolved: { id: "alpha" } });
    expect(reg.detail("nobody")).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/key-alpha|key-beta/);
    expect(JSON.stringify(events)).not.toMatch(/key-alpha|key-beta/);
  });

  it("rebuilds a changed agent, disposing the old version after the new one is in", async () => {
    const p = tmpHome();
    writeAgent(p, "researcher");
    writeAgent(p, "other");
    const { reg, builds, order, agents, attach } = registryRig(p);
    await attach();
    const before = agents.get("researcher");
    await reg.reload();
    expect(builds).toEqual({ researcher: 1, other: 1 }); // unchanged: no rebuild
    order.length = 0;
    editConfig(p, "researcher", { description: "New job." });
    await reg.reload();
    expect(builds).toEqual({ researcher: 2, other: 1 });
    expect(order).toEqual(["remove:researcher", "add:researcher", "disposed:researcher#1"]);
    expect(agents.get("researcher")).not.toBe(before);
    expect(reg.resolved("researcher")?.description).toBe("New job.");
  });

  it("keeps a replaced version's storage open for a grace period, so a reply that is being written can finish", async () => {
    const p = tmpHome();
    writeAgent(p, "researcher");
    const { reg, order, attach } = registryRig(p, { disposeGraceMs: 150 });
    await attach();
    editConfig(p, "researcher", { description: "New job." });
    await reg.reload();
    expect(order).not.toContain("disposed:researcher#1"); // the old version is replaced but not closed yet
    await until(() => order.includes("disposed:researcher#1"), 2000);
    editConfig(p, "researcher", { description: "Newer job." });
    await reg.reload();
    await reg.close(); // shutting down closes what still waits, at once
    expect(order).toContain("disposed:researcher#2");
  });

  it("the /reload hook the factory gets re-reads the folder", async () => {
    const p = tmpHome();
    writeAgent(p, "researcher");
    const { reg, builds, contexts, attach } = registryRig(p);
    await attach();
    editConfig(p, "researcher", { description: "Changed by hand." });
    await contexts.researcher![0]!.reload();
    expect(builds.researcher).toBe(2);
    expect(reg.resolved("researcher")?.description).toBe("Changed by hand.");
  });

  it("keeps the last good version running when a file turns invalid (stale), and marks a new bad agent invalid", async () => {
    const p = tmpHome();
    writeAgent(p, "researcher");
    const { reg, events, agents, attach } = registryRig(p);
    await attach();
    writeFileSync(agentPaths(p, "researcher").configFile, "{ not json");
    writeAgent(p, "broken", { role: "" });
    await reg.reload();
    expect(agents.has("researcher")).toBe(true);
    const byId = Object.fromEntries(reg.summaries().map((s) => [s.id, s.runtime]));
    expect(byId.researcher).toMatchObject({ status: "stale", loadedHash: expect.any(String) });
    expect(byId.researcher!.problems.join()).toMatch(/cannot read config.json/);
    expect(byId.broken!.status).toBe("invalid");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.error", id: "researcher", stale: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.error", id: "broken", stale: false }));
    expect(reg.detail("researcher")!.resolved).toMatchObject({ id: "researcher" }); // the last good version

    writeAgent(p, "researcher");
    await reg.reload();
    expect(reg.detail("researcher")!.runtime).toMatchObject({ status: "loaded", problems: [] });
  });

  it("a key removed from the agent's .env makes it stale; the last good version keeps running", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha", keyed, { env: { ANTHROPIC_API_KEY: "key" } });
    const { reg, agents, attach } = registryRig(p);
    await attach();
    writeFileSync(agentPaths(p, "alpha").envFile, "");
    await reg.reload();
    expect(agents.has("alpha")).toBe(true);
    expect(reg.detail("alpha")!.runtime).toMatchObject({ status: "stale", problems: [expect.stringMatching(/ANTHROPIC_API_KEY is not set/)] });
  });

  it("a factory that throws leaves the agent invalid (or the old version running, stale)", async () => {
    const p = tmpHome();
    writeAgent(p, "fragile");
    let fail = true;
    const { reg, agents, attach } = registryRig(p, {}, { failBuild: () => fail });
    await attach();
    expect(reg.detail("fragile")!.runtime).toMatchObject({ status: "invalid", problems: ["failed to build: cannot build fragile"] });
    fail = false;
    editConfig(p, "fragile", { description: "x" });
    await reg.reload();
    expect(agents.has("fragile")).toBe(true);
    fail = true;
    editConfig(p, "fragile", { description: "y" });
    await reg.reload();
    expect(agents.has("fragile")).toBe(true);
    expect(reg.detail("fragile")!.runtime.status).toBe("stale");
  });

  it("removes deleted, trashed and disabled agents", async () => {
    const p = tmpHome();
    writeAgent(p, "gone");
    writeAgent(p, "trashed");
    writeAgent(p, "off");
    const { reg, order, events, agents, attach } = registryRig(p);
    await attach();
    expect([...agents.keys()].sort()).toEqual(["gone", "off", "trashed"]);
    rmSync(agentPaths(p, "gone").dir, { recursive: true });
    mkdirSync(p.trashDir, { recursive: true });
    renameSync(agentPaths(p, "trashed").dir, join(p.trashDir, "trashed-1"));
    editConfig(p, "off", { enabled: false });
    await reg.reload();
    expect([...agents.keys()]).toEqual([]);
    expect(order.filter((o) => o.startsWith("disposed")).sort()).toEqual(["disposed:gone#1", "disposed:off#1", "disposed:trashed#1"]);
    expect(events.filter((e) => e.type === "agent.removed").length).toBe(3);
    expect(reg.summaries().map((s) => [s.id, s.runtime.status])).toEqual([["off", "disabled"]]);
    expect(reg.detail("trashed")).toBeUndefined();
  });

  it("picks up a new agent folder, a config edit and an .env change through fs.watch, without a restart", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha", keyed, { env: { ANTHROPIC_API_KEY: "one" } });
    writeAgent(p, "beta");
    const { reg, builds, events, agents, attach, watch } = registryRig(p);
    await attach();
    await watch();
    writeAgent(p, "late");
    await until(() => agents.has("late"));

    setSecret(agentPaths(p, "alpha").envFile, "ANTHROPIC_API_KEY", "two");
    await until(() => builds.alpha === 2);
    editConfig(p, "beta", { description: "edited" });
    await until(() => builds.beta === 2);
    await sleep(300);
    expect(builds).toEqual({ alpha: 2, beta: 2, late: 1 });
    expect(reg.resolved("beta")!.description).toBe("edited");
    expect(JSON.stringify(events)).not.toContain('"two"');
  });

  it("drops an agent through fs.watch when the studio trashes its folder (a bare rename)", async () => {
    const p = tmpHome();
    writeAgent(p, "gone");
    const { agents, attach, watch } = registryRig(p);
    await attach();
    await watch();
    mkdirSync(p.trashDir, { recursive: true });
    renameSync(agentPaths(p, "gone").dir, join(p.trashDir, "gone-1"));
    await until(() => !agents.has("gone"));
  });

  it("an agent writing in its sandbox, data/ or memory.db never causes a scan", async () => {
    const p = tmpHome();
    writeAgent(p, "busy");
    const { events, attach, watch } = registryRig(p);
    await attach();
    await watch();
    events.length = 0;
    const a = agentPaths(p, "busy");
    writeFileSync(join(a.sandboxDir, "notes.md"), "x");
    writeFileSync(join(a.dataDir, "state.json"), "{}");
    writeFileSync(a.memoryDbFile, "db");
    await sleep(400);
    expect(events.filter((e) => e.type === "fleet.changed")).toEqual([]);
  });
});
