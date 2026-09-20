import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager, toolName, toParts } from "../../src/tools/mcp/client.ts";
import type { McpServers } from "../../src/config/schema.ts";
import { createBuiltinTools } from "../../src/core/agent.ts";
import { executeTool } from "../../src/tools/gateway.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const SERVER = join(import.meta.dirname, "../helpers/mcp-server.ts");
const opts = { enabled: true, startupTimeoutMs: 15_000 };
const stdio = (extra = false, args: string[] = []): McpServers => ({
  demo: { command: process.execPath, args: [SERVER, ...args], enabled: true, ...(extra ? { env: { MCP_EXTRA_TOOL: "1" } } : {}) },
});

const managers: McpManager[] = [];
function manager(registry = new ToolRegistry()) {
  const m = new McpManager(registry, opts);
  managers.push(m);
  return { m, registry };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

const call = (registry: ToolRegistry, name: string, args: Record<string, unknown> = {}) =>
  executeTool({ id: "c1", name, args }, { registry, signal: new AbortController().signal, sessionId: "s", timeoutMs: 15_000, maxOutputChars: 5_000 });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((p) => p.text ?? `[${p.type}]`).join("\n");

describe("McpManager", () => {
  it("connects a stdio server and registers its tools namespaced", async () => {
    const { m, registry } = manager();
    const status = await m.connectAll(stdio());
    expect(status).toEqual([{ name: "demo", transport: "stdio", ok: true, tools: 3, ms: expect.any(Number) }]);
    expect(registry.names()).toEqual(["mcp__demo__echo", "mcp__demo__shot", "mcp__demo__boom"]);
    // the server's JSON Schema reaches the model untouched
    expect(registry.defs()[0]).toEqual({
      name: "mcp__demo__echo",
      description: "Echo the text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
  });

  it("runs a tool through eigen's gateway", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    const r = await call(registry, "mcp__demo__echo", { text: "hi" });
    expect(r.kind).toBe("ok");
    expect(r.isError).toBe(false);
    expect(text(r)).toBe('echo: {"text":"hi"}');
  });

  it("marks MCP tool errors as errors", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    const r = await call(registry, "mcp__demo__boom");
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("tool exploded");
  });

  it("maps image content to an eigen image part", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    const r = await call(registry, "mcp__demo__shot");
    expect(r.content).toEqual([{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }]);
  });

  it("truncates long MCP output like any other tool", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    const r = await executeTool(
      { id: "c", name: "mcp__demo__echo", args: { text: "x".repeat(500) } },
      { registry, signal: new AbortController().signal, sessionId: "s", timeoutMs: 15_000, maxOutputChars: 100 },
    );
    expect(text(r)).toContain("output truncated");
  });

  it("keeps healthy servers when another fails, and reports why", async () => {
    const { m, registry } = manager();
    const status = await m.connectAll({ ...stdio(), broken: { command: process.execPath, args: [SERVER, "--fail"], enabled: true } });
    expect(status.find((s) => s.name === "demo")?.ok).toBe(true);
    const broken = status.find((s) => s.name === "broken")!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
    expect(registry.names().every((n) => n.startsWith("mcp__demo__"))).toBe(true);
  });

  it("skips disabled servers and honours mcp.enabled", async () => {
    const { m, registry } = manager();
    expect(await m.connectAll({ demo: { ...stdio().demo!, enabled: false } })).toEqual([]);
    expect(registry.names()).toEqual([]);

    const off = new McpManager(registry, { ...opts, enabled: false });
    managers.push(off);
    expect(await off.connectAll(stdio())).toEqual([]);
  });

  it("reload picks up new tools and drops removed ones", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    expect(registry.names()).not.toContain("mcp__demo__extra");
    await m.reload(stdio(true));
    expect(registry.names()).toContain("mcp__demo__extra");
    expect(registry.names().filter((n) => n === "mcp__demo__echo")).toHaveLength(1); // no duplicates
    await m.reload({});
    expect(registry.names()).toEqual([]);
  });

  it("keeps built-in tools untouched across reloads", async () => {
    const registry = createBuiltinTools();
    const builtins = registry.names();
    const m = new McpManager(registry, opts);
    managers.push(m);
    await m.connectAll(stdio());
    await m.reload(stdio());
    expect(registry.names().filter((n) => !n.startsWith("mcp__"))).toEqual(builtins);
  });

  it("close leaves no child processes behind", async () => {
    const { m } = manager();
    await m.connectAll(stdio());
    expect(execSync(`ps -axo command | grep -c "[m]cp-server.ts" || true`).toString().trim()).not.toBe("0");
    await m.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(execSync(`ps -axo command | grep -c "[m]cp-server.ts" || true`).toString().trim()).toBe("0");
  });

  it("reports a clear error when the server is gone", async () => {
    const { m, registry } = manager();
    await m.connectAll(stdio());
    await m.close();
    const r = await call(registry, "mcp__demo__echo", { text: "hi" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not connected|closed|/i);
  });
});

describe("tool naming", () => {
  it("namespaces, sanitizes and de-duplicates", () => {
    const taken = new Set<string>();
    expect(toolName("demo", "echo", taken)).toBe("mcp__demo__echo");
    taken.add("mcp__demo__echo");
    expect(toolName("demo", "echo", taken)).toBe("mcp__demo__echo_2");
    expect(toolName("my server", "read file!", new Set())).toBe("mcp__my_server__read_file_");
  });

  it("truncates to the 64-character provider limit", () => {
    const name = toolName("a".repeat(40), "b".repeat(40), new Set());
    expect(name.length).toBe(64);
    expect(name.startsWith("mcp__")).toBe(true);
  });
});

describe("content mapping", () => {
  it("handles text, embedded resources and unknown blocks", () => {
    expect(
      toParts({
        content: [
          { type: "text", text: "a" },
          { type: "resource", resource: { uri: "file:///x", text: "inner" } },
          { type: "resource", resource: { uri: "file:///y", mimeType: "application/pdf", blob: "AAA" } },
          { type: "audio", data: "zzz" },
        ],
      } as never),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "inner" },
      { type: "text", text: "[resource file:///y (application/pdf)]" },
      { type: "text", text: '{"type":"audio","data":"zzz"}' },
    ]);
  });
});
