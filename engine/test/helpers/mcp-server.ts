// Minimal MCP stdio server for tests: newline-delimited JSON-RPC over stdin/stdout.
// Modes via argv/env: --fail (exit immediately), MCP_EXTRA_TOOL=1 (adds a second tool).
import { createInterface } from "node:readline";

if (process.argv.includes("--fail")) process.exit(1);

const tools = [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "shot", description: "Return an image", inputSchema: { type: "object", properties: {} } },
  { name: "env", description: "Report environment variables", inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] } },
  { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  ...(process.env.MCP_EXTRA_TOOL ? [{ name: "extra", description: "Added on reload", inputSchema: { type: "object", properties: {} } }] : []),
];

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let req: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notification
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result });

  switch (req.method) {
    case "initialize":
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "0.0.1" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const name = req.params?.name;
      if (name === "echo") return reply({ content: [{ type: "text", text: `echo: ${JSON.stringify(req.params?.arguments ?? {})}` }] });
      if (name === "shot") return reply({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
      if (name === "env") return reply({ content: [{ type: "text", text: JSON.stringify(Object.fromEntries(((req.params?.arguments?.names as string[]) ?? []).map((n) => [n, process.env[n] ?? null]))) }] });
      if (name === "boom") return reply({ content: [{ type: "text", text: "tool exploded" }], isError: true });
      if (name === "extra") return reply({ content: [{ type: "text", text: "extra tool" }] });
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
    default:
      return reply({});
  }
});
