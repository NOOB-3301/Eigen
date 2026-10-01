import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { CallToolResult, MCPClient } from "@ai-sdk/mcp";
import { isRemoteServer } from "../../config/schema.ts";
import type { McpOptions, McpServer, McpServers } from "../../config/schema.ts";
import type { Part } from "../../core/types.ts";
import { defineRawTool } from "../registry.ts";
import type { ToolContext, ToolOutput, ToolRegistry } from "../registry.ts";
import { scrubbedEnv } from "../builtin/shell-session.ts";
import { logger } from "../../util/logger.ts";

export const MCP_PREFIX = "mcp__";
const MAX_TOOL_NAME = 64; // both providers cap tool names

export type TransportKind = "stdio" | "http" | "sse";
export type ServerStatus = { name: string; transport: TransportKind; ok: boolean; tools: number; error?: string; ms: number };

// "env:NAME" keeps secrets in ~/.eigen/.env instead of config.json.
function resolveEnvRefs(values: Record<string, string> | undefined, server: string): Record<string, string> | undefined {
  if (!values) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!v.startsWith("env:")) {
      out[k] = v;
      continue;
    }
    const name = v.slice(4);
    const resolved = process.env[name];
    if (resolved === undefined) logger.warn({ evt: "mcp_env_missing", server, key: k, envVar: name });
    out[k] = resolved ?? "";
  }
  return out;
}

export function toolName(server: string, tool: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  let name = `${MCP_PREFIX}${clean(server)}__${clean(tool)}`;
  if (name.length > MAX_TOOL_NAME) name = name.slice(0, MAX_TOOL_NAME);
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// MCP content blocks -> eigen parts. Images stay images so the vision-degrade path
// in models/provider.ts can replace them for models without vision.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: unknown }
  | { type: string };

export function toParts(result: CallToolResult): Part[] {
  const parts: Part[] = [];
  // CallToolResult is a union; only some branches carry content blocks.
  const blocks = ((result as { content?: ContentBlock[] }).content ?? []) as ContentBlock[];
  for (const block of blocks) {
    if (block.type === "text") parts.push({ type: "text", text: (block as { text: string }).text });
    else if (block.type === "image") parts.push({ type: "image", mediaType: (block as { mimeType: string }).mimeType, data: (block as { data: string }).data });
    else if (block.type === "resource") {
      const r = (block as { resource: unknown }).resource as { text?: string; blob?: string; mimeType?: string; uri?: string };
      if (typeof r.text === "string") parts.push({ type: "text", text: r.text });
      else if (typeof r.blob === "string" && r.mimeType?.startsWith("image/")) parts.push({ type: "image", mediaType: r.mimeType, data: r.blob });
      else parts.push({ type: "text", text: `[resource ${r.uri ?? "?"} (${r.mimeType ?? "unknown type"})]` });
    } else parts.push({ type: "text", text: JSON.stringify(block) });
  }
  return parts;
}

async function connect(name: string, server: McpServer, timeoutMs: number): Promise<MCPClient> {
  const client = isRemoteServer(server)
    ? createMCPClient({
        transport: { type: server.transport, url: server.url, headers: resolveEnvRefs(server.headers, name) },
        initializationOptions: { timeout: timeoutMs },
      })
    : createMCPClient({
        transport: new Experimental_StdioMCPTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          // Servers get their own env plus a scrubbed copy of ours: no eigen API keys.
          env: { ...(scrubbedEnv() as Record<string, string>), ...(resolveEnvRefs(server.env, name) ?? {}) },
          stderr: "ignore",
        }),
        initializationOptions: { timeout: timeoutMs },
      });
  return await withTimeout(client, timeoutMs, `connect timed out after ${timeoutMs} ms`);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref())]);
}

// Owns the MCP clients and keeps the ToolRegistry in sync with them.
export class McpManager {
  #registry: ToolRegistry;
  #opts: McpOptions;
  #toolTimeoutMs?: number;
  #clients = new Map<string, MCPClient>();
  #status: ServerStatus[] = [];

  constructor(registry: ToolRegistry, opts: McpOptions, toolTimeoutMs?: number) {
    this.#registry = registry;
    this.#opts = opts;
    this.#toolTimeoutMs = toolTimeoutMs ?? opts.toolTimeoutMs;
  }

  list(): string[] {
    console.log("=== MCP clients ===");
    console.log([...this.#clients.keys()]);
    return [...this.#clients.keys()];
  }

    
  status(): ServerStatus[] {
    return this.#status;
  }

  toolCount(): number {
    return this.#status.reduce((n, s) => n + s.tools, 0);
  }

  // Never throws: a server that fails to start is reported, the rest still work.
  async connectAll(servers: McpServers): Promise<ServerStatus[]> {
    if (!this.#opts.enabled) {
      this.#status = [];
      return this.#status;
    }
    const taken = new Set(this.#registry.names());
    const entries = Object.entries(servers).filter(([, s]) => s.enabled);
    this.#status = await Promise.all(entries.map(([name, server]) => this.#connectOne(name, server, taken)));
    return this.#status;
  }

  async #connectOne(name: string, server: McpServer, taken: Set<string>): Promise<ServerStatus> {
    const transport: TransportKind = isRemoteServer(server) ? server.transport : "stdio";
    const started = Date.now();
    try {
      const client = await connect(name, server, this.#opts.startupTimeoutMs);
      this.#clients.set(name, client);
      const { tools } = await withTimeout(client.listTools(), this.#opts.startupTimeoutMs, "tools/list timed out");
      for (const t of tools) {
        const local = toolName(name, t.name, taken);
        taken.add(local);
        this.#registry.register(
          defineRawTool({
            name: local,
            description: t.description ?? `${t.name} (MCP server ${name})`,
            // The server owns validation, so its schema passes through untouched.
            inputSchema: { jsonSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> },
            timeoutMs: () => this.#toolTimeoutMs,
            execute: (input: unknown, ctx: ToolContext) => this.#call(name, t.name, input, ctx),
          }),
        );
      }
      const status = { name, transport, ok: true, tools: tools.length, ms: Date.now() - started };
      logger.info({ evt: "mcp_server", ...status });
      return status;
    } catch (e) {
      await this.#clients.get(name)?.close().catch(() => {});
      this.#clients.delete(name);
      const status = { name, transport, ok: false, tools: 0, error: (e as Error).message, ms: Date.now() - started };
      logger.error({ evt: "mcp_server", ...status });
      return status;
    }
  }

  async #call(server: string, tool: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const client = this.#clients.get(server);
    if (!client) return { content: [{ type: "text", text: `MCP server "${server}" is not connected. Ask the user to run /reload-mcp.` }], isError: true };
    const result = await client.callTool({
      name: tool,
      arguments: (input ?? {}) as Record<string, unknown>,
      options: { signal: ctx.signal },
    });
    return { content: toParts(result), isError: result.isError === true };
  }

  async reload(servers: McpServers): Promise<ServerStatus[]> {
    await this.close();
    this.#registry.unregisterPrefix(MCP_PREFIX);
    return this.connectAll(servers);
  }

  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
