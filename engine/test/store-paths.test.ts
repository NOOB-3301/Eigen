import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { createAgent, instructionsPath, readAgent, writeAgent } from "../src/mastra/lib/store.ts";
import { tmpHome } from "./helpers/home.ts";

const dir = "/h/.eigen/.agents/helper";
const base = { id: "helper", name: "Helper", role: "assistant", description: "Helps." };

describe("instructionsPath", () => {
  it("allows files inside the agent folder", () => {
    expect(instructionsPath(dir, "instructions.md")).toBe(`${dir}/instructions.md`);
    expect(instructionsPath(dir, "notes/role.md")).toBe(`${dir}/notes/role.md`);
  });
  it("allows only the shared primary prompt outside it", () => {
    expect(instructionsPath(dir, "../../prompts/system.md")).toBe("/h/.eigen/prompts/system.md");
    expect(instructionsPath(dir, "../../memory/profile.md")).toBeUndefined();
    expect(instructionsPath(dir, "../../../outside.md")).toBeUndefined();
    expect(instructionsPath(dir, "/etc/hosts.md")).toBeUndefined();
    expect(instructionsPath(dir, ".")).toBeUndefined();
  });
});

describe("store refuses escaping instruction paths", () => {
  it("create and write return 400 and touch nothing", () => {
    const p = tmpHome();
    const root = loadConfig(p.configFile);
    const target = join(p.memoryDir, "profile.md");
    const before = readFileSync(target, "utf8");

    const made = createAgent(p, root, { ...base, instructions: { file: "../../memory/profile.md" } }, "pwned");
    expect(made.status).toBe(400);
    expect(existsSync(join(p.agentsDir, "helper"))).toBe(false);

    expect(createAgent(p, root, base, "ok").status).toBe(200);
    const w = writeAgent(p, root, "helper", { config: { ...base, instructions: { file: "../../memory/profile.md" } }, instructionsText: "pwned" });
    expect(w.status).toBe(400);
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("reading never follows an escaping path", () => {
    const p = tmpHome();
    mkdirSync(join(p.agentsDir, "helper"), { recursive: true });
    writeFileSync(join(p.agentsDir, "helper", "config.json"), JSON.stringify({ ...base, instructions: { file: "../../memory/profile.md" } }));
    expect(readAgent(p, "helper")?.instructionsText).toBeNull();
  });
});
