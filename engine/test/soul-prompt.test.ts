import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentFactory } from "../src/mastra/lib/factory.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import { readAgentMd, soulText } from "../src/mastra/lib/soul.ts";
import { testContext, tmpAgent } from "./helpers/agent-folder.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const OWN = "Own voice: playful, uses puns.";
const at = new Date("2026-10-01T09:30:00Z");
const on = { enabled: true, file: "soul.md" };

describe("soulText: the agent's own persona, when it is on", () => {
  it("reads the agent's soul file when enabled, nothing when off", () => {
    const { paths } = tmpAgent();
    writeFileSync(join(paths.dir, "soul.md"), `${OWN}\n`);
    expect(soulText(on, paths.dir)).toBe(OWN);
    expect(soulText({ ...on, enabled: false }, paths.dir)).toBe("");
  });

  it("re-reads the file on every call, so an edit applies to the next turn", () => {
    const { paths } = tmpAgent();
    writeFileSync(join(paths.dir, "soul.md"), "v1");
    expect(soulText(on, paths.dir)).toBe("v1");
    writeFileSync(join(paths.dir, "soul.md"), "v2");
    expect(soulText(on, paths.dir)).toBe("v2");
  });

  it("a missing soul file gives no persona (the registry reports it)", () => {
    expect(soulText(on, tmpAgent().paths.dir)).toBe("");
  });
});

describe("readAgentMd: the file is a .md directly in the agent folder", () => {
  it("accepts a plain file name, also an empty file", () => {
    const { paths } = tmpAgent();
    writeFileSync(join(paths.dir, "soul.md"), "");
    expect(readAgentMd(paths.dir, "soul.md")).toEqual({ text: "" });
  });

  it("refuses .., sub-folders, absolute paths and files that are not markdown", () => {
    const { paths, other } = tmpAgent();
    mkdirSync(join(paths.dir, "persona"));
    writeFileSync(join(paths.dir, "persona", "voice.md"), "nested");
    for (const name of ["../other/instructions.md", "persona/voice.md", join(other.dir, "instructions.md"), "config.json", ".env", "."])
      expect(readAgentMd(paths.dir, name), name).toEqual({ problem: expect.stringMatching(/must be a \.md file inside the agent folder/) });
  });

  it("refuses a symlink that leads to the agent's own .env, its data, or another agent", () => {
    const { paths, other } = tmpAgent();
    writeFileSync(join(other.dir, "soul.md"), "the other agent's soul");
    writeFileSync(join(paths.sandboxDir, "notes.md"), "written by the agent itself");
    symlinkSync(paths.envFile, join(paths.dir, "env.md"));
    symlinkSync(join(other.dir, "soul.md"), join(paths.dir, "theirs.md"));
    symlinkSync(join(paths.sandboxDir, "notes.md"), join(paths.dir, "sandboxed.md"));
    for (const name of ["env.md", "theirs.md", "sandboxed.md"]) expect(readAgentMd(paths.dir, name), name).toEqual({ problem: expect.stringMatching(/leads out/) });
  });

  it("allows a symlink to another .md in the same folder", () => {
    const { paths } = tmpAgent();
    writeFileSync(join(paths.dir, "real.md"), "inside");
    symlinkSync(join(paths.dir, "real.md"), join(paths.dir, "soul.md"));
    expect(readAgentMd(paths.dir, "soul.md")).toEqual({ text: "inside" });
  });

  it("says a missing or unreadable file is missing", () => {
    const { paths } = tmpAgent();
    mkdirSync(join(paths.dir, "folder.md"));
    expect(readAgentMd(paths.dir, "soul.md")).toEqual({ problem: "soul.md is missing or unreadable" });
    expect(readAgentMd(paths.dir, "folder.md")).toEqual({ problem: "folder.md is missing or unreadable" });
  });
});

describe("the soul in the prompt", () => {
  it("goes after the operating instructions and before the ground rules, and not at all when off", () => {
    const t = tmpAgent({ soul: { enabled: true } });
    writeFileSync(join(t.paths.dir, "soul.md"), OWN);
    const text = buildInstructions(t.r, t.paths, at);
    expect(text).toContain(`<soul>\n${OWN}\n</soul>`);
    expect(text.indexOf("<operating_instructions>")).toBeLessThan(text.indexOf("<soul>"));
    expect(text.indexOf("<soul>")).toBeLessThan(text.indexOf("<ground_rules>"));
    expect(buildInstructions({ ...t.r, soul: { ...t.r.soul, enabled: false } }, t.paths, at)).not.toContain("<soul>");
  });

  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

  it("reaches the model of a built agent, and an edit reaches the next turn", async () => {
    const llm = await fakeLlm([{ text: "ok" }]);
    closers.push(llm.close);
    const t = tmpAgent({ models: { main: { id: "fake/model", url: llm.url } }, soul: { enabled: true } });
    writeFileSync(join(t.paths.dir, "soul.md"), OWN);
    const built = await makeAgentFactory({ isolation: "none" })(t.r, testContext(t.paths).ctx);
    closers.push(built.dispose);
    const system = () => JSON.stringify(llm.requests.at(-1)!.messages.filter((m) => m.role === "system"));
    await built.agent.generate("hi");
    expect(system()).toContain(OWN);
    writeFileSync(join(t.paths.dir, "soul.md"), "Second voice.");
    await built.agent.generate("again");
    expect(system()).toContain("Second voice.");
  });
});
