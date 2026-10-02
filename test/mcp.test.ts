import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/mastra/lib/config.ts";
import { makeMcp } from "../src/mastra/lib/tools/mcp.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const SERVER = join(import.meta.dirname, "helpers/mcp-server.ts");
const stdio = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [SERVER], ...extra });

const cfg = (mcpServers: Record<string, unknown>, mcp: Record<string, unknown> = {}): Config =>
  parseConfig({ defaultModel: "m", models: { m: { id: "fake/model" } }, telegram: { allowedUserIds: [1] }, mcpServers, mcp: { startupTimeoutMs: 15_000, ...mcp } });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((c) => c()));
});
const connect = async (config: Config, env: NodeJS.ProcessEnv = process.env) => {
  const mcp = makeMcp(env);
  closers.push(mcp.close);
  return { mcp, state: await mcp.load(config) };
};
const run = (tool: unknown, input: Record<string, unknown> = {}) =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, { requestContext: undefined });

describe("makeMcp", () => {
  it("connects a stdio server and namespaces its tools by server", async () => {
    const { state } = await connect(cfg({ demo: stdio() }));
    expect(Object.keys(state.tools).sort()).toEqual(["demo_boom", "demo_echo", "demo_env", "demo_shot"]);
    expect(state).toMatchObject({ errors: {}, servers: ["demo"] });
  });

  it("asks for approval on every tool unless the server is trusted", async () => {
    const { state } = await connect(cfg({ demo: stdio(), safe: stdio({ trusted: true }) }));
    expect((state.tools.demo_echo as { requireApproval?: boolean }).requireApproval).toBe(true);
    expect((state.tools.safe_echo as { requireApproval?: boolean }).requireApproval).toBeFalsy();
  });

  it("runs a tool and surfaces a tool failure as an error the model can read", async () => {
    const { state } = await connect(cfg({ demo: stdio({ trusted: true }) }));
    expect(JSON.stringify(await run(state.tools.demo_echo, { text: "hi" }))).toContain('echo: {\\"text\\":\\"hi\\"}');
    await expect(run(state.tools.demo_boom)).rejects.toThrow(/tool exploded/);
  });

  it("keeps healthy servers when another fails, and says why", async () => {
    const { state } = await connect(cfg({ demo: stdio(), broken: { command: process.execPath, args: [SERVER, "--fail"] } }));
    expect(Object.keys(state.tools)).toContain("demo_echo");
    expect(Object.keys(state.errors)).toEqual(["broken"]);
  });

  it("resolves env:NAME refs and hands the server none of eigen's other secrets", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("DEMO_TOKEN", "t0k3n");
    const { state } = await connect(cfg({ demo: stdio({ env: { TOKEN: "env:DEMO_TOKEN", PLAIN: "x" }, trusted: true }) }));
    const out = JSON.stringify(await run(state.tools.demo_env, { names: ["TOKEN", "PLAIN", "ANTHROPIC_API_KEY", "DEMO_TOKEN"] }));
    expect(out).toContain('TOKEN\\":\\"t0k3n');
    expect(out).toContain('PLAIN\\":\\"x');
    expect(out).toContain('ANTHROPIC_API_KEY\\":null');
    expect(out).toContain('DEMO_TOKEN\\":null');
  });

  it("skips disabled servers, and everything when mcp is off", async () => {
    expect((await connect(cfg({ demo: stdio({ enabled: false }) }))).state.servers).toEqual([]);
    expect((await connect(cfg({ demo: stdio() }, { enabled: false }))).state.tools).toEqual({});
  });

  it("reload picks up config changes and drops the old client", async () => {
    const { mcp } = await connect(cfg({ demo: stdio() }));
    const next = await mcp.load(cfg({ demo: stdio({ env: { MCP_EXTRA_TOOL: "1" } }) }));
    expect(Object.keys(next.tools)).toContain("demo_extra");
    expect(Object.keys(mcp.tools())).toContain("demo_extra");
    expect(Object.keys((await mcp.load(cfg({})))?.tools)).toEqual([]);
  });

  it("works as an agent's tool set", async () => {
    const { mcp } = await connect(cfg({ demo: stdio({ trusted: true }) }));
    const llm = await fakeLlm([{ calls: [{ name: "demo_echo", args: { text: "ping" } }] }, { text: "done" }]);
    closers.push(llm.close);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, tools: () => mcp.tools() });
    await agent.generate("go", { maxSteps: 4 });
    const toolOutput = llm.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(toolOutput).toContain("ping");
  });
});
