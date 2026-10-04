import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerSchema, type McpServer } from "../src/mastra/lib/schema.ts";
import { resolveEnvRefs, startMcp, stdioEnv } from "../src/mastra/lib/tools/mcp.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const SERVER = join(import.meta.dirname, "helpers/mcp-server.ts");
const stdio = (extra: Record<string, unknown> = {}): McpServer => McpServerSchema.parse({ command: process.execPath, args: [SERVER], ...extra });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((c) => c()));
});
const connect = async (servers: Record<string, McpServer>, env: Record<string, string> = {}) => {
  const mcp = await startMcp("t", servers, new Map(Object.entries(env)), 15_000);
  closers.push(mcp.close);
  return mcp;
};
const run = (tool: unknown, input: Record<string, unknown> = {}) =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, { requestContext: undefined });

describe("env:NAME values come from the agent's own .env only", () => {
  it("resolves from the map, never from process.env", () => {
    vi.stubEnv("SHELL_TOKEN", "from-the-shell");
    const env = new Map([["OWN_TOKEN", "own"]]);
    expect(resolveEnvRefs({ a: "env:OWN_TOKEN", b: "env:SHELL_TOKEN", c: "plain" }, env)).toEqual({ a: "own", b: "", c: "plain" });
  });

  it("a stdio server starts with PATH, HOME and its own env, nothing else of the engine's environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-engine");
    const out = stdioEnv({ env: { TOKEN: "env:OWN_TOKEN" } }, new Map([["OWN_TOKEN", "t"]]));
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH", "TOKEN"].filter((k) => k !== "HOME" || process.env.HOME));
    expect(out.TOKEN).toBe("t");
  });
});

describe("startMcp", () => {
  it("connects a stdio server and namespaces its tools by server", async () => {
    const { state } = await connect({ demo: stdio() });
    expect(Object.keys(state.tools).sort()).toEqual(["demo_boom", "demo_echo", "demo_env", "demo_shot"]);
    expect(state).toMatchObject({ errors: {}, servers: ["demo"] });
  });

  it("asks for approval on every tool unless the server is trusted", async () => {
    const { state } = await connect({ demo: stdio(), safe: stdio({ trusted: true }) });
    expect((state.tools.demo_echo as { requireApproval?: boolean }).requireApproval).toBe(true);
    expect((state.tools.safe_echo as { requireApproval?: boolean }).requireApproval).toBeFalsy();
  });

  it("runs a tool and surfaces a tool failure as an error the model can read", async () => {
    const { state } = await connect({ demo: stdio({ trusted: true }) });
    expect(JSON.stringify(await run(state.tools.demo_echo, { text: "hi" }))).toContain('echo: {\\"text\\":\\"hi\\"}');
    await expect(run(state.tools.demo_boom)).rejects.toThrow(/tool exploded/);
  });

  it("keeps healthy servers when another fails, and says why", async () => {
    const { state } = await connect({ demo: stdio(), broken: stdio({ args: [SERVER, "--fail"] }) });
    expect(Object.keys(state.tools)).toContain("demo_echo");
    expect(Object.keys(state.errors)).toEqual(["broken"]);
  });

  it("the server process sees its env:NAME values from the agent's .env and none of the engine's secrets", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("DEMO_TOKEN", "from-the-shell");
    const { state } = await connect({ demo: stdio({ env: { TOKEN: "env:DEMO_TOKEN", PLAIN: "x" }, trusted: true }) }, { DEMO_TOKEN: "t0k3n" });
    const out = JSON.stringify(await run(state.tools.demo_env, { names: ["TOKEN", "PLAIN", "ANTHROPIC_API_KEY", "DEMO_TOKEN", "USER", "SHELL"] }));
    expect(out).toContain('TOKEN\\":\\"t0k3n');
    expect(out).toContain('PLAIN\\":\\"x');
    for (const n of ["ANTHROPIC_API_KEY", "DEMO_TOKEN", "USER", "SHELL"]) expect(out, n).toContain(`${n}\\":null`);
  });

  it("skips disabled servers", async () => {
    expect((await connect({ demo: stdio({ enabled: false }) })).state.servers).toEqual([]);
  });

  it("works as an agent's tool set", async () => {
    const mcp = await connect({ demo: stdio({ trusted: true }) });
    const llm = await fakeLlm([{ calls: [{ name: "demo_echo", args: { text: "ping" } }] }, { text: "done" }]);
    closers.push(llm.close);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, tools: () => mcp.tools() });
    await agent.generate("go", { maxSteps: 4 });
    const toolOutput = llm.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(toolOutput).toContain("ping");
  });
});
