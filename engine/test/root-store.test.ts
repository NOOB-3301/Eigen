import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRoot, writeRoot } from "../src/mastra/lib/store.ts";
import { tmpHome } from "./helpers/home.ts";

const addAgent = (p: ReturnType<typeof tmpHome>, id: string, patch: Record<string, unknown> = {}) => {
  mkdirSync(join(p.agentsDir, id), { recursive: true });
  writeFileSync(join(p.agentsDir, id, "instructions.md"), "Do work.");
  writeFileSync(join(p.agentsDir, id, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: "d", ...patch }));
};

describe("root config store", () => {
  it("round-trips the file untouched, keeping keys the schema does not know", () => {
    const p = tmpHome({ somethingCustom: { a: 1 } });
    const r = readRoot(p)!;
    expect(r.config.somethingCustom).toEqual({ a: 1 });
    const w = writeRoot(p, { config: r.config, etag: r.etag });
    expect(w.status).toBe(200);
    expect(JSON.parse(readFileSync(p.configFile, "utf8")).somethingCustom).toEqual({ a: 1 });
    expect(readRoot(p)!.etag).toBe((w.body as { etag: string }).etag);
  });

  it("adds a custom model and makes it the default", () => {
    const p = tmpHome();
    const r = readRoot(p)!;
    const config = { ...r.config, defaultModel: "mine", models: { ...(r.config.models as object), mine: { id: "openai/gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY", contextWindow: 128000 } } };
    expect(writeRoot(p, { config, etag: r.etag }).status).toBe(200);
    expect(readRoot(p)!.config.defaultModel).toBe("mine");
  });

  it("409 when the file changed, 400 for schema errors, nothing written either way", () => {
    const p = tmpHome();
    const r = readRoot(p)!;
    const before = readFileSync(p.configFile, "utf8");
    expect(writeRoot(p, { config: r.config, etag: "0000" }).status).toBe(409);
    const bad = writeRoot(p, { config: { ...r.config, defaultModel: "nope" }, etag: r.etag });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/defaultModel/);
    const badId = writeRoot(p, { config: { ...r.config, models: { x: { id: "no-slash" } }, defaultModel: "x" }, etag: r.etag });
    expect(badId.status).toBe(400);
    expect(readFileSync(p.configFile, "utf8")).toBe(before);
  });

  it("refuses to remove a model or MCP server an agent still uses, naming the agent", () => {
    const p = tmpHome({ mcpServers: { files: { command: "node", args: [] } } });
    const r = readRoot(p)!;
    const models = r.config.models as Record<string, unknown>;
    const [keep, drop] = Object.keys(models);
    addAgent(p, "researcher", { model: drop, tools: { mcp: { inherit: ["files"] } } });
    const noModel = writeRoot(p, { config: { ...r.config, defaultModel: keep, curatorModel: keep, models: { [keep!]: models[keep!] } }, etag: r.etag });
    expect(noModel.status).toBe(400);
    expect((noModel.body as { issues: string[] }).issues.join()).toContain(`agent "researcher": model "${drop}"`);
    const noMcp = writeRoot(p, { config: { ...r.config, mcpServers: {} }, etag: r.etag });
    expect(noMcp.status).toBe(400);
    expect((noMcp.body as { issues: string[] }).issues.join()).toContain('agent "researcher": tools.mcp.inherit: "files" is not in root mcpServers');
  });

  it("reports an unreadable file instead of throwing", () => {
    const p = tmpHome();
    writeFileSync(p.configFile, "{ nope");
    expect(readRoot(p)).toMatchObject({ config: {}, parseError: expect.any(String) });
  });
});
