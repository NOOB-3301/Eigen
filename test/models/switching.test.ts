import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../../src/tools/registry.ts";
import { currentTime } from "../../src/tools/builtin/current-time.ts";
import { Agent } from "../../src/core/agent.ts";
import type { Config } from "../../src/config/schema.ts";
import { testConfig } from "../helpers/fake-provider.ts";
import { tempHome } from "../helpers/agent.ts";
import { fixture, mockFetch } from "../helpers/mock-fetch.ts";

describe("switching models mid-session", () => {
  it("continues the same history across openai-compat and anthropic entries", async () => {
    process.env.TEST_SWITCH_KEY = "k";
    const base = testConfig();
    const config: Config = {
      ...base,
      defaultModel: "local",
      models: {
        local: { provider: "openai-compat", baseUrl: "http://ollama/v1", model: "gemma4:e4b", contextWindow: 28000, replyReserve: 4000, maxOutputTokens: 2000, toolCalling: true, vision: false, promptCaching: false },
        cloud: { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "TEST_SWITCH_KEY", model: "claude-sonnet-5", contextWindow: 200000, replyReserve: 16000, maxOutputTokens: 16000, toolCalling: true, vision: true, promptCaching: true },
      },
    };
    let oaStep = 0;
    let antStep = 0;
    const { fn, calls } = mockFetch((url) => {
      if (url.startsWith("http://ollama")) {
        return { body: oaStep++ === 0 ? fixture("openai-tool-calls.json") : fixture("openai-stop.json") };
      }
      return { body: antStep++ === 0 ? fixture("anthropic-tool-use.json") : fixture("anthropic-end-turn.json") };
    });
    // stub shell_exec so the test never touches the real machine
    const fakeShell = defineTool({ name: "shell_exec", description: "sh", inputSchema: z.object({ command: z.string() }), execute: async () => "a.txt\nb.png\nc.pdf" });
    const tools = new ToolRegistry().register(currentTime).register(fakeShell);
    const agent = new Agent({ config, home: tempHome(), fetch: fn, tools });
    const events: string[] = [];
    let done = 0;
    agent.on((e) => {
      if (e.type === "assistant_message" && !e.interim) events.push(e.text);
      if (e.type === "done") done++;
    });
    const waitDone = (n: number) => new Promise<void>((r) => { const t = () => (done >= n ? r() : setTimeout(t, 2)); t(); });

    agent.submit({ sessionId: "s", text: "time and desktop?", channel: "t" });
    await waitDone(1);
    expect(events[0]).toBe("It is 14:02.");

    expect(agent.setModel("s", "cloud").ok).toBe(true);
    agent.submit({ sessionId: "s", text: "again on cloud", channel: "t" });
    await waitDone(2);
    const firstCloud = calls.find((c) => c.url.includes("anthropic"))!.body;
    // earlier openai-compat turn arrives in Anthropic shape: tool_use + tool_result pairs by eigen id
    const uses = firstCloud.messages[1].content.filter((b: any) => b.type === "tool_use");
    const results = firstCloud.messages[2].content.filter((b: any) => b.type === "tool_result");
    expect(uses.map((b: any) => b.name)).toEqual(["current_time", "shell_exec"]);
    expect(results.map((b: any) => b.tool_use_id)).toEqual(uses.map((b: any) => b.id));
    expect(firstCloud.messages.at(-1).content.at(-1)).toMatchObject({ type: "text", text: "again on cloud" });
    expect(firstCloud.system[0].text).toContain("<soul>");

    expect(agent.setModel("s", "local").ok).toBe(true);
    agent.submit({ sessionId: "s", text: "back to local", channel: "t" });
    await waitDone(3);
    const lastLocal = calls.at(-1)!.body;
    expect(lastLocal.messages[0].role).toBe("system");
    // Anthropic-produced turns are replayed in OpenAI shape: no provider-specific blocks.
    // Tool-call ids are minted by the provider/SDK, so an Anthropic-issued id may travel
    // with the history; what matters is that calls and results stay paired.
    expect(JSON.stringify(lastLocal)).not.toContain("signature");
    expect(JSON.stringify(lastLocal)).not.toContain("thinking");
    const toolMsgs = lastLocal.messages.filter((m: any) => m.role === "tool");
    const callIds = lastLocal.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.id));
    expect(toolMsgs.map((m: any) => m.tool_call_id).sort()).toEqual(callIds.sort());
    expect(JSON.stringify(lastLocal.messages.at(-1))).toContain("back to local");
    expect(events).toHaveLength(3);
  });
});
