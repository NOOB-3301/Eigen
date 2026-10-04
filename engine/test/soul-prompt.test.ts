import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentFactory, scanAgentDir, type BuiltAgent } from "../src/mastra/lib/agents.ts";
import { loadConfig } from "../src/mastra/lib/config.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { readOwnSoul, soulText } from "../src/mastra/lib/soul.ts";
import type { Mcp } from "../src/mastra/lib/tools/mcp.ts";
import { tmpHome } from "./helpers/home.ts";

const SHARED = "Shared voice: formal and precise.";
const OWN = "Own voice: playful, uses puns.";
const at = new Date("2026-10-01T09:30:00Z");

const stubMcp = { load: async () => ({ tools: {}, errors: {}, servers: [] }), state: () => ({ tools: {}, errors: {}, servers: [] }), tools: () => ({}), close: async () => undefined } as unknown as Mcp;

function home() {
  const p = tmpHome({ sandbox: { isolation: "none" } });
  writeFileSync(p.soulFile, SHARED);
  return p;
}

function addAgent(p: HomePaths, id: string, patch: Partial<AgentConfigInput> = {}) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), `You are the ${id}.`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `The ${id}.`, ...patch }));
  return dir;
}

describe("soulText: which persona goes in the prompt", () => {
  it("shared reads SOUL.md, own reads the agent's file, none is empty", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    writeFileSync(join(dir, "soul.md"), `${OWN}\n`);
    expect(soulText({ source: "shared", file: "soul.md" }, p, dir)).toBe(SHARED);
    expect(soulText({ source: "own", file: "soul.md" }, p, dir)).toBe(OWN);
    expect(soulText({ source: "none", file: "soul.md" }, p, dir)).toBe("");
  });

  it("re-reads the files on every call, so an edit applies to the next turn", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    writeFileSync(join(dir, "soul.md"), "v1");
    expect(soulText({ source: "own", file: "soul.md" }, p, dir)).toBe("v1");
    writeFileSync(join(dir, "soul.md"), "v2");
    expect(soulText({ source: "own", file: "soul.md" }, p, dir)).toBe("v2");
    writeFileSync(p.soulFile, "shared v2");
    expect(soulText({ source: "shared", file: "soul.md" }, p, dir)).toBe("shared v2");
  });

  it("an own soul that cannot be read gives no persona instead of the shared one", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    expect(soulText({ source: "own", file: "soul.md" }, p, dir)).toBe("");
  });
});

describe("readOwnSoul: the file stays inside the agent folder", () => {
  it("accepts a file in the folder or a subfolder, and an empty one", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    mkdirSync(join(dir, "persona"));
    writeFileSync(join(dir, "persona", "voice.md"), "nested");
    writeFileSync(join(dir, "soul.md"), "");
    expect(readOwnSoul(dir, "persona/voice.md")).toEqual({ text: "nested" });
    expect(readOwnSoul(dir, "soul.md")).toEqual({ text: "" });
  });

  it("refuses .., an absolute path and a file that is not markdown", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    writeFileSync(join(p.agentsDir, "outside.md"), "secret");
    expect(readOwnSoul(dir, "../outside.md")).toEqual({ problem: expect.stringMatching(/inside the agent folder/) });
    expect(readOwnSoul(dir, p.soulFile)).toEqual({ problem: expect.stringMatching(/inside the agent folder/) });
    expect(readOwnSoul(dir, "config.json")).toEqual({ problem: expect.stringMatching(/\.md file/) });
    expect(readOwnSoul(dir, ".")).toEqual({ problem: expect.stringMatching(/\.md file/) });
  });

  it("refuses a symlink that leads out of the folder, for the file and for a folder on the way", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    symlinkSync(p.envFile, join(dir, "env.md"));
    symlinkSync(p.home, join(dir, "linked"));
    writeFileSync(join(p.home, "elsewhere.md"), "outside");
    expect(readOwnSoul(dir, "env.md")).toEqual({ problem: expect.stringMatching(/leads out/) });
    expect(readOwnSoul(dir, "linked/elsewhere.md")).toEqual({ problem: expect.stringMatching(/leads out/) });
  });

  it("allows a symlink that stays inside the folder", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    writeFileSync(join(dir, "real.md"), "inside");
    symlinkSync(join(dir, "real.md"), join(dir, "soul.md"));
    expect(readOwnSoul(dir, "soul.md")).toEqual({ text: "inside" });
  });

  it("says a missing or unreadable file is missing", () => {
    const p = home();
    const dir = addAgent(p, "poet");
    mkdirSync(join(dir, "folder.md"));
    expect(readOwnSoul(dir, "soul.md")).toEqual({ problem: "soul file soul.md is missing or unreadable" });
    expect(readOwnSoul(dir, "folder.md")).toEqual({ problem: "soul file folder.md is missing or unreadable" });
  });
});

describe("buildInstructions with a soul", () => {
  it("puts the given soul after the operating instructions, and none at all when it is empty", () => {
    const p = home();
    const text = buildInstructions(p, "UTC", at, { soul: OWN });
    expect(text).toContain(`<soul>\n${OWN}\n</soul>`);
    expect(text).not.toContain(SHARED);
    expect(text.indexOf("<operating_instructions>")).toBeLessThan(text.indexOf("<soul>"));
    expect(text.indexOf("<soul>")).toBeLessThan(text.indexOf("<ground_rules>"));
    expect(buildInstructions(p, "UTC", at, { soul: "" })).not.toContain("<soul>");
  });

  it("without a soul setting it still reads the shared SOUL.md", () => {
    expect(buildInstructions(home(), "UTC", at)).toContain(`<soul>\n${SHARED}\n</soul>`);
  });
});

describe("scan: an own soul that cannot be read is a config problem", () => {
  it("reports a missing file like a missing instructions file, and the agent has no resolved config", () => {
    const p = home();
    const dir = addAgent(p, "poet", { soul: { source: "own" } });
    const scanned = scanAgentDir(dir, loadConfig(p.configFile));
    expect(scanned.problems).toEqual(["soul file soul.md is missing or unreadable"]);
    expect(scanned.resolved).toBeUndefined();
    expect(scanned.hash).toBeUndefined();
  });

  it("loads once the file exists, and a link out of the folder is a problem", () => {
    const p = home();
    const dir = addAgent(p, "poet", { soul: { source: "own" } });
    writeFileSync(join(dir, "soul.md"), OWN);
    const ok = scanAgentDir(dir, loadConfig(p.configFile));
    expect(ok.problems).toEqual([]);
    expect(ok.resolved?.soul).toEqual({ source: "own", file: "soul.md" });

    const linked = addAgent(p, "sneaky", { soul: { source: "own", file: "env.md" } });
    symlinkSync(p.envFile, join(linked, "env.md"));
    expect(scanAgentDir(linked, loadConfig(p.configFile)).problems).toEqual([expect.stringMatching(/leads out/)]);
  });

  it("does not look for a soul file when the source is shared or none", () => {
    const p = home();
    for (const source of ["shared", "none"] as const) {
      const scanned = scanAgentDir(addAgent(p, `a-${source}`, { soul: { source } }), loadConfig(p.configFile));
      expect(scanned.problems).toEqual([]);
    }
  });

  it("includeSoul still drives the source when soul.source is omitted", () => {
    const p = home();
    const root = loadConfig(p.configFile);
    expect(scanAgentDir(addAgent(p, "legacy-on"), root).resolved?.soul.source).toBe("shared");
    expect(scanAgentDir(addAgent(p, "legacy-off", { instructions: { includeSoul: false } }), root).resolved?.soul.source).toBe("none");
  });

  it("the version hash follows the soul source but not the soul text (the text is re-read per turn)", () => {
    const p = home();
    const dir = addAgent(p, "poet", { soul: { source: "own" } });
    writeFileSync(join(dir, "soul.md"), "v1");
    const root = loadConfig(p.configFile);
    const before = scanAgentDir(dir, root).hash;
    writeFileSync(join(dir, "soul.md"), "v2");
    expect(scanAgentDir(dir, root).hash).toBe(before);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ id: "poet", name: "poet", role: "specialist", description: "The poet.", soul: { source: "shared" } }));
    expect(scanAgentDir(dir, root).hash).not.toBe(before);
  });
});

describe("a specialist's prompt (the real factory)", () => {
  const built: BuiltAgent[] = [];
  afterEach(async () => {
    await Promise.all(built.splice(0).map((b) => b.dispose?.()));
  });

  async function prompt(p: HomePaths, id: string, patch: Partial<AgentConfigInput>, soul?: string) {
    const dir = addAgent(p, id, patch);
    if (soul !== undefined) writeFileSync(join(dir, "soul.md"), soul);
    const root = loadConfig(p.configFile);
    const scanned = scanAgentDir(dir, root);
    expect(scanned.problems).toEqual([]);
    const b = await defaultAgentFactory(scanned.resolved!, scanned, { paths: p, root: () => root, rootMcp: stubMcp, subAgents: () => ({}), resolved: () => undefined, env: {} });
    built.push(b);
    return { dir, text: async () => String(await b.agent.getInstructions()) };
  }

  it("shared: the shared SOUL.md; own: its own file and never the shared one; none: no block", async () => {
    const p = home();
    const shared = await prompt(p, "on-shared", { soul: { source: "shared" } });
    expect(await shared.text()).toContain(SHARED);

    const own = await prompt(p, "on-own", { soul: { source: "own" } }, OWN);
    expect(await own.text()).toContain(`<soul>\n${OWN}\n</soul>`);
    expect(await own.text()).not.toContain(SHARED);

    const none = await prompt(p, "on-none", { soul: { source: "none" } });
    const text = await none.text();
    expect(text).not.toContain("<soul>");
    expect(text).not.toContain(SHARED);
  });

  it("an edit to the own soul file shows up in the next prompt with no rebuild", async () => {
    const p = home();
    const own = await prompt(p, "poet", { soul: { source: "own" } }, "first draft");
    expect(await own.text()).toContain("first draft");
    writeFileSync(join(own.dir, "soul.md"), "second draft");
    const text = await own.text();
    expect(text).toContain("second draft");
    expect(text).not.toContain("first draft");
  });

  it("includeSoul false (no soul block in the config) keeps the shared soul out", async () => {
    const p = home();
    const legacy = await prompt(p, "legacy", { instructions: { includeSoul: false } });
    expect(await legacy.text()).not.toContain(SHARED);
  });
});
