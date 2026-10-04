/*
 * The agent store: creating, reading, saving and trashing standalone agents. (There is no root config any more; this file used to test it.)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { AgentConfigSchema, agentProblems } from "../src/mastra/lib/schema.ts";
import { createAgent, listAgentIds, readAgent, trashAgent, validateAgent, writeAgent } from "../src/mastra/lib/store.ts";
import { addAgent, agentConfig, emptyHome } from "./helpers/agent-home.ts";

const model = { id: "anthropic/claude-sonnet-5-5" };

describe("createAgent", () => {
  it("scaffolds a folder whose config the schema accepts, with instructions, an empty 0600 .env, skills/ and sandbox/", () => {
    const p = emptyHome();
    const r = createAgent(p, { id: "researcher", name: "Researcher", role: "researcher", description: "Finds sources.", model });
    expect(r).toMatchObject({ status: 200, body: { ok: true, etag: expect.stringMatching(/^[0-9a-f]{16}$/) } });

    const a = agentPaths(p, "researcher");
    const parsed = AgentConfigSchema.safeParse(JSON.parse(readFileSync(a.configFile, "utf8")));
    expect(parsed.success).toBe(true);
    expect(agentProblems(parsed.data!)).toEqual([]);
    expect(parsed.data).toMatchObject({ id: "researcher", name: "Researcher", role: "researcher", model: "main", models: { main: { id: model.id } } });
    // Everything but the model and the instructions starts switched off: the person connects the rest in the builder.
    expect(parsed.data).toMatchObject({ memory: { storage: { enabled: false }, lastMessages: { enabled: false }, workingMemory: { enabled: false } }, tools: { builtin: [] }, skills: { enabled: [] }, soul: { enabled: false }, telegram: { enabled: false } });
    expect(readFileSync(join(a.dir, "instructions.md"), "utf8")).toMatch(/^You are Researcher\. Finds sources\./);
    expect(statSync(a.envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(a.skillsDir) && existsSync(a.sandboxDir) && existsSync(a.dataDir)).toBe(true);
    expect(validateAgent(p, "researcher", JSON.parse(readFileSync(a.configFile, "utf8"))).issues).toEqual([]);
    expect(readAgent(p, "researcher")!.etag).toBe((r.body as { etag: string }).etag);
    expect(listAgentIds(p)).toEqual(["researcher"]);
  });

  it("uses the instructions from the request, and refuses an id that exists (409) without touching it", () => {
    const p = emptyHome();
    expect(createAgent(p, { id: "writer", name: "Writer", model, instructionsText: "Write well." }).status).toBe(200);
    expect(readAgent(p, "writer")!.instructionsText).toBe("Write well.\n");
    const again = createAgent(p, { id: "writer", name: "Other", model, instructionsText: "pwned" });
    expect(again.status).toBe(409);
    expect(readAgent(p, "writer")!.instructionsText).toBe("Write well.\n");
  });

  it("refuses a bad id or model before creating anything", () => {
    const p = emptyHome();
    expect(createAgent(p, { id: "../x", name: "X", model }).status).toBe(400);
    expect(createAgent(p, { id: "bad", name: "X", model: { id: "no-slash" } }).status).toBe(400);
    expect(readdirSync(p.agentsDir)).toEqual([]);
  });
});

describe("writeAgent", () => {
  it("saves config and instructions with an etag; a stale etag is a 409 and writes nothing", () => {
    const p = emptyHome();
    addAgent(p, "helper");
    const before = readAgent(p, "helper")!;
    const config = agentConfig("helper", { description: "Helps." });

    const stale = writeAgent(p, "helper", { config, instructionsText: "pwned", etag: "0000000000000000" });
    expect(stale).toMatchObject({ status: 409, body: { ok: false, etag: before.etag } });
    expect(readAgent(p, "helper")!.instructionsText).toBe("Do work.\n");

    const ok = writeAgent(p, "helper", { config, instructionsText: "Help.", etag: before.etag });
    expect(ok.status).toBe(200);
    const after = readAgent(p, "helper")!;
    expect(after).toMatchObject({ instructionsText: "Help.\n", config: { description: "Helps." }, etag: (ok.body as { etag: string }).etag });
  });

  it("an instructions-only edit by hand changes the etag, so a stale save conflicts", () => {
    const p = emptyHome();
    const a = addAgent(p, "helper");
    const { etag } = readAgent(p, "helper")!;
    writeFileSync(join(a.dir, "instructions.md"), "Edited elsewhere.\n");
    expect(writeAgent(p, "helper", { config: agentConfig("helper"), etag }).status).toBe(409);
  });

  it("400 with every issue: schema, agentProblems, id not equal to the folder; nothing written", () => {
    const p = emptyHome();
    const a = addAgent(p, "helper");
    const before = readFileSync(a.configFile, "utf8");
    const bad = writeAgent(p, "helper", { config: agentConfig("other", { telegram: { enabled: true } }) });
    expect(bad.status).toBe(400);
    const issues = (bad.body as { issues: string[] }).issues;
    expect(issues).toContain('id: "other" must equal the folder name "helper"');
    expect(issues.some((i) => i.startsWith("telegram: add at least one allowed user id"))).toBe(true);
    expect(writeAgent(p, "helper", { config: { id: "helper" } }).status).toBe(400);
    expect(readFileSync(a.configFile, "utf8")).toBe(before);
  });

  it("refuses two agents on one remote database, whichever id sorts first", () => {
    const p = emptyHome();
    const storage = { memory: { storage: { url: "https://db.example.com", authTokenEnv: "LIBSQL_AUTH_TOKEN" } } };
    addAgent(p, "beta", storage);
    addAgent(p, "alpha");
    const r = writeAgent(p, "alpha", { config: agentConfig("alpha", storage) });
    expect(r.status).toBe(400);
    expect((r.body as { issues: string[] }).issues).toEqual(['memory.storage.url: already used by "beta"; agents never share storage']);
    // A disabled agent runs nothing, so it may keep the same URL.
    expect(writeAgent(p, "alpha", { config: agentConfig("alpha", { ...storage, enabled: false }) }).status).toBe(200);
  });

  it("404 for an agent that does not exist, and creates nothing", () => {
    const p = emptyHome();
    expect(writeAgent(p, "ghost", { config: agentConfig("ghost") }).status).toBe(404);
    expect(existsSync(join(p.agentsDir, "ghost"))).toBe(false);
  });

  it("reads a config.json that is not JSON as {} with the reason", () => {
    const p = emptyHome();
    addAgent(p, "broken", {}, { raw: "{ nope" });
    expect(readAgent(p, "broken")).toMatchObject({ config: {}, parseError: expect.any(String), instructionsText: "Do work.\n" });
  });
});

describe("trashAgent", () => {
  it("moves the whole folder, .env and memory included, to agents/.trash; nothing is erased", () => {
    const p = emptyHome();
    const a = addAgent(p, "helper");
    writeFileSync(a.memoryDbFile, "db");
    expect(trashAgent(p, "helper")).toEqual({ status: 200 });
    expect(existsSync(a.dir)).toBe(false);
    const [trashed] = readdirSync(p.trashDir);
    expect(trashed).toMatch(/^helper-\d{4}-/);
    expect(readFileSync(join(p.trashDir, trashed!, "memory.db"), "utf8")).toBe("db");
    expect(existsSync(join(p.trashDir, trashed!, ".env"))).toBe(true);
    expect(listAgentIds(p)).toEqual([]);
    expect(trashAgent(p, "helper").status).toBe(404);
  });
});
