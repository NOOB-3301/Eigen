import { describe, expect, it } from "vitest";
import { makeAgent } from "../helpers/agent.ts";
import type { AgentEvent } from "../../src/core/events.ts";

const of = <T extends AgentEvent["type"]>(events: AgentEvent[], t: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === t);

describe("agent loop", () => {
  it("plain reply ends the run", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ text: "hello" }]);
    agent.submit({ sessionId: "s", text: "hi", channel: "test" });
    await doneCount(1);
    expect(of(events, "assistant_message").map((e) => e.text)).toEqual(["hello"]);
    expect(of(events, "done")[0]!.reason).toBe("end");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain("current_time");
    // system prompt never stored in history
    expect(provider.requests[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
  });

  it("executes a tool call and feeds the result back", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ calls: [{ name: "current_time" }] }, { text: "it is noon" }]);
    agent.submit({ sessionId: "s", text: "time?", channel: "test" });
    await doneCount(1);
    expect(of(events, "tool_start")[0]!.name).toBe("current_time");
    expect(of(events, "tool_end")[0]!.ok).toBe(true);
    const second = provider.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const call = second[1]!.parts[0]!;
    const result = second[2]!.parts[0]!;
    expect(call.type === "tool_call" && result.type === "tool_result" && result.callId === call.id).toBe(true);
    expect(call.type === "tool_call" && call.id.startsWith("call_")).toBe(true);
    expect(of(events, "done")[0]!.reason).toBe("end");
  });

  it("unknown tool name returns closest names and recovers", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ calls: [{ name: "current_tim" }] }, { calls: [{ name: "current_time" }] }, { text: "done" }]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    const res = provider.requests[1]!.messages[2]!.parts[0]!;
    expect(res.type === "tool_result" && res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('Unknown tool \\"current_tim\\"');
    expect(JSON.stringify(res)).toContain("current_time");
    expect(of(events, "done")[0]!.reason).toBe("end");
  });

  it("malformed args return the validation error and recover", async () => {
    const { agent, events, doneCount, provider } = makeAgent([
      { calls: [{ name: "read_file", args: { pathh: "/tmp" } }] },
      { calls: [{ name: "read_file", argsError: "arguments are not valid JSON: {oops" }] },
      { text: "ok" },
    ]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(JSON.stringify(provider.requests[1]!.messages[2])).toMatch(/Invalid arguments for read_file[\s\S]*path/);
    expect(JSON.stringify(provider.requests[2]!.messages[4])).toContain("not valid JSON");
    expect(of(events, "done")[0]!.reason).toBe("end");
  });

  it("stops after toolArgRetryMax consecutive bad calls", async () => {
    const { agent, events, doneCount } = makeAgent([{ calls: [{ name: "nope" }] }], { limits: { toolArgRetryMax: 2 } });
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(of(events, "error")[0]!.message).toMatch(/3 invalid tool calls/);
    expect(of(events, "done")[0]!.reason).toBe("error");
  });

  it("enforces maxSteps", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ calls: [{ name: "current_time" }] }], { limits: { maxSteps: 3 } });
    agent.submit({ sessionId: "s", text: "loop", channel: "test" });
    await doneCount(1);
    expect(provider.requests).toHaveLength(3);
    expect(of(events, "error")[0]!.message).toMatch(/after 3 steps/);
    expect(of(events, "done")[0]!.reason).toBe("limit");
  });

  it("enforces the per-run token budget", async () => {
    const { agent, events, doneCount } = makeAgent([{ calls: [{ name: "current_time" }], usage: { inputTokens: 600, outputTokens: 10 } }], { limits: { runTokenBudget: 1000 } });
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(of(events, "error")[0]!.message).toMatch(/per-run budget/);
  });

  it("max_tokens stop never executes a truncated tool call", async () => {
    const { agent, events, doneCount } = makeAgent([{ text: "partial", calls: [{ name: "shell_exec", args: { command: "touch /tmp/should-not-run" } }], stopReason: "max_tokens" }]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(of(events, "tool_start")).toHaveLength(0);
    expect(of(events, "error")[0]!.message).toMatch(/output token limit[\s\S]*not executed/);
    expect(agent.status("s").messages).toBe(2); // user + text-only assistant
  });

  it("retries an empty reply once", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ text: "  " }, { text: "real" }]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(provider.requests).toHaveLength(2);
    expect(of(events, "assistant_message")[0]!.text).toBe("real");
  });

  it("errors after two empty replies", async () => {
    const { agent, events, doneCount } = makeAgent([{ text: "" }]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(of(events, "error")[0]!.message).toMatch(/empty reply/);
  });

  it("cancel aborts a busy tool and the queue", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ calls: [{ name: "sleep", args: { ms: 30_000 } }] }, { text: "never" }]);
    agent.submit({ sessionId: "s", text: "long", channel: "test" });
    agent.submit({ sessionId: "s", text: "queued", channel: "test" });
    while (!of(events, "tool_start").length) await new Promise((r) => setTimeout(r, 2));
    const started = Date.now();
    expect(agent.cancel("s")).toEqual({ cancelled: true, dropped: 1 });
    await doneCount(1);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(of(events, "done")[0]!.reason).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.requests).toHaveLength(1); // queued message dropped
    expect(agent.status("s").running).toBe(false);
  });

  it("cancel aborts an in-flight model request", async () => {
    const { agent, events, doneCount } = makeAgent([{ text: "slow", delayMs: 30_000 }]);
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await new Promise((r) => setTimeout(r, 10));
    agent.cancel("s");
    await doneCount(1);
    expect(of(events, "done")[0]!.reason).toBe("cancelled");
  });

  it("queues messages FIFO, one run at a time", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ text: "a", delayMs: 20 }, { text: "b" }, { text: "c" }]);
    agent.submit({ sessionId: "s", text: "1", channel: "test" });
    expect(agent.submit({ sessionId: "s", text: "2", channel: "test" }).ahead).toBe(1);
    expect(agent.submit({ sessionId: "s", text: "3", channel: "test" }).ahead).toBe(2);
    expect(agent.status("s").queueLength).toBe(2);
    await doneCount(3);
    expect(of(events, "assistant_message").map((e) => e.text)).toEqual(["a", "b", "c"]);
    // each request sees the previous runs' history in order
    const last = provider.requests[2]!.messages.filter((m) => m.role === "user").map((m) => (m.parts[0] as { text: string }).text);
    expect(last).toEqual(["1", "2", "3"]);
  });

  it("sends no tools when toolCalling is false", async () => {
    const { agent, doneCount, provider } = makeAgent([{ text: "ok" }]);
    const cfg = agent.models.entry("fake");
    cfg.toolCalling = false;
    agent.submit({ sessionId: "s", text: "x", channel: "test" });
    await doneCount(1);
    expect(provider.requests[0]!.tools).toEqual([]);
    expect(agent.status("s").toolCalling).toBe(false);
  });

  it("refuses runs once the daily cap is hit", async () => {
    const { agent, events, doneCount, provider } = makeAgent([{ text: "ok", usage: { inputTokens: 90, outputTokens: 20 } }]);
    agent.models.entry("fake").dailyTokenCap = 100;
    agent.submit({ sessionId: "s", text: "1", channel: "test" });
    agent.submit({ sessionId: "s", text: "2", channel: "test" });
    await doneCount(2);
    expect(provider.requests).toHaveLength(1);
    expect(of(events, "error")[0]!.message).toMatch(/Daily token cap/);
  });
});
