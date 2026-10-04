import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { Workspace } from "@mastra/core/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRegistry, defaultAgentFactory, scanAgentDir, type AgentFactory, type AgentRegistry, type BuiltAgent } from "../src/mastra/lib/agents.ts";
import { loadConfig, reloadConfig } from "../src/mastra/lib/config.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { makeWorkspace, refreshSkills, skillPaths, type SkillSelection } from "../src/mastra/lib/tools/workspace.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { tmpHome } from "./helpers/home.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stubMcp = { load: async () => ({ tools: {}, errors: {}, servers: [] }), state: () => ({ tools: {}, errors: {}, servers: [] }), tools: () => ({}), close: async () => undefined } as unknown as Mcp;

/** Writes root/<rel>/SKILL.md; the name is the last folder segment, which is what Mastra requires. */
function skill(root: string, rel: string, description = `does ${rel}`) {
  const file = join(root, rel, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${rel.split("/").pop()}\ndescription: ${description}\n---\n\nSteps for ${rel}.\n`);
  return file;
}

/** A home with three library skills and one skill in the shared sandbox. */
function home() {
  const p = tmpHome({ sandbox: { isolation: "none" } });
  skill(p.userSkillsDir, "pdf");
  skill(p.userSkillsDir, "notes");
  skill(p.userSkillsDir, "@acme/weather");
  skill(p.sandboxSkillsDir, "@me/shared-box");
  return p;
}

const workspace = (p: HomePaths, skills: SkillSelection | (() => SkillSelection), log?: (m: string) => void) => makeWorkspace(p, loadConfig(p.configFile), "none", "t", { skills, log });
/** The skills the workspace resolves for a turn (what the agent is told about). */
const names = async (ws: Workspace) => (await (await ws.skills!.getScoped!()).list()).map((s) => s.name).sort();

describe("skillPaths", () => {
  it("all is today's globs, none keeps only the agent's own sandbox, a list is exactly those SKILL.md files", () => {
    const p = tmpHome();
    expect(skillPaths(p, "all")).toEqual(["skills/**/SKILL.md", "sandbox/skills/**/SKILL.md"]);
    expect(skillPaths(p, "none")).toEqual(["sandbox/skills/**/SKILL.md"]);
    expect(skillPaths(p, ["pdf", "@acme/weather"])).toEqual(["skills/pdf/SKILL.md", "skills/@acme/weather/SKILL.md", "sandbox/skills/**/SKILL.md"]);
    expect(skillPaths(p, [])).toEqual(["sandbox/skills/**/SKILL.md"]);
  });

  it("points an agent with its own sandbox at ITS sandbox/skills, not the shared one", () => {
    const p = tmpHome();
    const own = { ...p, sandboxDir: join(p.agentsDir, "poet", "sandbox"), sandboxSkillsDir: join(p.agentsDir, "poet", "sandbox", "skills") };
    expect(skillPaths(own, "all")).toEqual(["skills/**/SKILL.md", ".agents/poet/sandbox/skills/**/SKILL.md"]);
    expect(skillPaths(own, ["pdf"])).toEqual(["skills/pdf/SKILL.md", ".agents/poet/sandbox/skills/**/SKILL.md"]);
  });

  it("drops names that are not slugs: in a path they would be globs or a way out", () => {
    const p = tmpHome();
    expect(skillPaths(p, ["pdf", "**", "../../.env", "a/../b", "x*", "{a,b}", "/abs"])).toEqual(["skills/pdf/SKILL.md", "sandbox/skills/**/SKILL.md"]);
  });
});

describe("a workspace with a skill selection (Mastra's real loader)", () => {
  it("all: the whole library plus the agent's sandbox skills", async () => {
    const ws = workspace(home(), "all");
    expect(await names(ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
  });

  it("none: no library skill, but the agent's own sandbox skills stay", async () => {
    const ws = workspace(home(), "none");
    expect(await names(ws)).toEqual(["shared-box"]);
  });

  it("a list: exactly those skills, including an @owner/slug one, never the others", async () => {
    const p = home();
    expect(await names(workspace(p, ["pdf"]))).toEqual(["pdf", "shared-box"]);
    expect(await names(workspace(p, ["@acme/weather", "notes"]))).toEqual(["notes", "shared-box", "weather"]);
  });

  it("two agents with different selections are told about different skills", async () => {
    const p = home();
    const llm = await fakeLlm([{ text: "ok" }]);
    try {
      const told = async (skills: SkillSelection) => {
        const before = llm.requests.length;
        await new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, workspace: workspace(p, skills) }).generate("hi");
        const system = llm.requests[before]!.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
        return [...system.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]).sort();
      };
      expect(await told("all")).toEqual(["notes", "pdf", "shared-box", "weather"]);
      expect(await told(["pdf"])).toEqual(["pdf", "shared-box"]);
      expect(await told("none")).toEqual(["shared-box"]);
    } finally {
      await llm.close();
    }
  });

  it("ignores a named skill that does not exist, says so once, and picks it up when it appears", async () => {
    const p = home();
    const logged: string[] = [];
    const ws = workspace(p, ["pdf", "ghost"], (m) => logged.push(m));
    expect(await names(ws)).toEqual(["pdf", "shared-box"]);
    expect(await names(ws)).toEqual(["pdf", "shared-box"]);
    expect(logged).toEqual(['t: skill "ghost" is not in the skills folder, ignored']);

    skill(p.userSkillsDir, "ghost");
    expect(await names(ws)).toEqual(["ghost", "pdf", "shared-box"]);
    rmSync(join(p.userSkillsDir, "ghost"), { recursive: true });
    expect(await names(ws)).toEqual(["pdf", "shared-box"]);
    expect(logged).toHaveLength(2); // gone again, so it is reported again
  });

  it("a selection given as a function is read on every turn (the primary follows its config)", async () => {
    const p = home();
    let current: SkillSelection = "all";
    const ws = workspace(p, () => current);
    expect(await names(ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
    current = ["notes"];
    expect(await names(ws)).toEqual(["notes", "shared-box"]);
    current = "none";
    expect(await names(ws)).toEqual(["shared-box"]);
    current = "all";
    expect(await names(ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
  });
});

describe("refreshSkills", () => {
  it("shows a new or edited library skill right away instead of after Mastra's 30 s staleness check", async () => {
    const p = home();
    const ws = workspace(p, "all");
    await ws.init();
    expect(await names(ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);

    skill(p.userSkillsDir, "fresh");
    skill(p.userSkillsDir, "pdf", "now with a new description");
    expect(await names(ws)).not.toContain("fresh");
    await refreshSkills(ws);
    expect(await names(ws)).toContain("fresh");
    const pdf = (await (await ws.skills!.getScoped!()).list()).find((s) => s.name === "pdf");
    expect(pdf?.description).toBe("now with a new description");
  });

  it("refreshing a workspace that was never read does not leave it empty", async () => {
    const p = home();
    const ws = workspace(p, "all");
    await refreshSkills(ws);
    expect(await names(ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
  });
});

describe("an agent with its own sandbox (the real factory)", () => {
  const built: BuiltAgent[] = [];
  afterEach(async () => {
    await Promise.all(built.splice(0).map((b) => b.dispose?.()));
  });

  async function build(p: HomePaths, id: string, patch: Partial<AgentConfigInput>) {
    const dir = join(p.agentsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "instructions.md"), `You are the ${id}.`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, ...patch }));
    const root = loadConfig(p.configFile);
    const scanned = scanAgentDir(dir, root);
    expect(scanned.problems).toEqual([]);
    const b = await defaultAgentFactory(scanned.resolved!, scanned, { paths: p, root: () => root, rootMcp: stubMcp, subAgents: () => ({}), resolved: () => undefined, env: {} });
    built.push(b);
    return { dir, ws: (await b.agent.getWorkspace())! };
  }

  it("sees its own sandbox/skills and not the shared sandbox's (the glob followed the shared home before)", async () => {
    const p = home();
    skill(join(p.agentsDir, "poet", "sandbox", "skills"), "@me/poems");
    const own = await build(p, "poet", { sandbox: { mode: "own" } });
    expect(await names(own.ws)).toEqual(["notes", "pdf", "poems", "weather"]);

    const shared = await build(p, "clerk", {});
    expect(await names(shared.ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
  });

  it("applies skills.inherit from its config, with its own sandbox skills kept", async () => {
    const p = home();
    skill(join(p.agentsDir, "poet", "sandbox", "skills"), "@me/poems");
    expect(await names((await build(p, "poet", { sandbox: { mode: "own" }, skills: { inherit: ["pdf"] } })).ws)).toEqual(["pdf", "poems"]);
    expect(await names((await build(p, "bare", { skills: { inherit: "none" } })).ws)).toEqual(["shared-box"]);
  });

  it("exposes refreshSkills for the registry, and none when it has no workspace", async () => {
    const p = home();
    const withWs = await build(p, "clerk", {});
    expect(await names(withWs.ws)).toEqual(["notes", "pdf", "shared-box", "weather"]);
    skill(p.userSkillsDir, "fresh");
    expect(await names(withWs.ws)).not.toContain("fresh");
    await built[0]!.refreshSkills!();
    expect(await names(withWs.ws)).toContain("fresh");

    await build(p, "bare", { tools: { builtin: [] } });
    expect(built[1]!.refreshSkills).toBeUndefined();
  });
});

describe("the registry's skills watcher", () => {
  let open: AgentRegistry[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((r) => r.close()));
  });

  function setup(agents: Record<string, SkillSelection>, debounceMs = 40) {
    const p = home();
    process.env.EIGEN_HOME = p.home;
    reloadConfig();
    for (const [id, inherit] of Object.entries(agents)) {
      const dir = join(p.agentsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "instructions.md"), `You are ${id}.`);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, skills: { inherit } }));
    }
    const refreshed: string[] = [];
    const factory: AgentFactory = async (r) => ({ agent: { id: r.id, name: r.name } as unknown as Agent, refreshSkills: async () => void refreshed.push(r.id) });
    const reg = createAgentRegistry({ paths: p, rootMcp: stubMcp, factory, debounceMs });
    open.push(reg);
    const agentsById = new Map<string, unknown>();
    const mastra = { addAgent: (a: Agent, key: string) => agentsById.set(key, a), removeAgent: (key: string) => agentsById.delete(key), getAgentById: (key: string) => agentsById.get(key) };
    // macOS replays file events from just before a recursive watch started; let those arrive and drop them before the test acts.
    const watch = async () => {
      reg.watch();
      await sleep(500);
      refreshed.length = 0;
    };
    return { p, reg, refreshed, agentsById, watch, attach: () => reg.attach(mastra as unknown as Mastra) };
  }

  it("refreshes only the agents that see the changed skill: those on all, and those that name it", async () => {
    const { p, refreshed, attach, watch } = setup({ everything: "all", nothing: "none", pdfer: ["pdf"], noter: ["notes"], weatherman: ["@acme/weather"] });
    await attach();
    await watch();

    // Wait for the watcher (a loaded machine delivers file events late), then give any wrongly refreshed agent time to show up too.
    const settle = async (count: number) => {
      const end = Date.now() + 5000;
      while (refreshed.length < count && Date.now() < end) await sleep(25);
      await sleep(300);
    };
    skill(p.userSkillsDir, "pdf", "edited");
    await settle(2);
    expect(refreshed.sort()).toEqual(["everything", "pdfer"]);

    refreshed.length = 0;
    writeFileSync(join(p.userSkillsDir, "@acme", "weather", "SKILL.md"), "---\nname: weather\ndescription: edited\n---\n\nBody");
    await settle(2);
    expect(refreshed.sort()).toEqual(["everything", "weatherman"]);
  });

  it("a burst of writes refreshes each agent once, after the last one (every write restarts the wait)", async () => {
    // Wide margins: the writes must land closer together than the wait, even when the machine is busy.
    const { p, refreshed, attach, watch } = setup({ everything: "all" }, 1000);
    await attach();
    await watch();
    for (const name of ["a", "b", "c"]) {
      skill(p.userSkillsDir, name);
      await sleep(100);
    }
    await sleep(2500);
    expect(refreshed).toEqual(["everything"]);
  });

  it("ignores the studio's temporary files and dot folders", async () => {
    const { p, refreshed, attach, watch } = setup({ everything: "all" });
    await attach();
    await watch();
    writeFileSync(join(p.userSkillsDir, "pdf", "SKILL.md.123.tmp"), "x");
    mkdirSync(join(p.userSkillsDir, ".cache"));
    writeFileSync(join(p.userSkillsDir, ".cache", "index.json"), "{}");
    await sleep(300);
    expect(refreshed).toEqual([]);
  });

  it("refreshes the primary's own workspace (it has no BuiltAgent): a new skill is visible without a restart", async () => {
    const { p, agentsById, attach, watch } = setup({});
    const ws = workspace(p, "all");
    await ws.init();
    expect(await names(ws)).not.toContain("fresh");
    agentsById.set("eigen", { getWorkspace: async () => ws });
    await attach();
    await watch();

    skill(p.userSkillsDir, "fresh");
    const end = Date.now() + 5000;
    while (Date.now() < end && !(await names(ws)).includes("fresh")) await sleep(50);
    expect(await names(ws)).toContain("fresh");
  });
});
