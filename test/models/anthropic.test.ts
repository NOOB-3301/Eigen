import { describe, expect, it, beforeAll } from "vitest";
import { ANTHROPIC_VERSION, createAnthropicProvider } from "../../src/models/adapters/anthropic.ts";
import { IMAGE_PLACEHOLDER } from "../../src/models/provider.ts";
import type { ModelEntry } from "../../src/config/schema.ts";
import type { Message, ToolDef } from "../../src/core/types.ts";
import { fixture, mockFetch } from "../helpers/mock-fetch.ts";

const entry: ModelEntry = { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "TEST_ANT_KEY", model: "claude-sonnet-5", contextWindow: 200000, replyReserve: 16000, maxOutputTokens: 16000, toolCalling: true, vision: true, promptCaching: true };
const tools: ToolDef[] = [
  { name: "current_time", description: "time", inputSchema: { type: "object", properties: {} } },
  { name: "shell_exec", description: "sh", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const signal = new AbortController().signal;
const user = (t: string): Message => ({ role: "user", parts: [{ type: "text", text: t }] });

beforeAll(() => {
  process.env.TEST_ANT_KEY = "sk-ant-test";
});

describe("anthropic adapter", () => {
  it("sends system as a separate parameter, required headers, and max_tokens", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    await createAnthropicProvider(fn).chat({ system: "SYS", messages: [user("hi")], tools, signal, entry: { ...entry, promptCaching: false } });
    const { url, headers, body } = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(body.max_tokens).toBe(16000);
    expect(body.system).toEqual([{ type: "text", text: "SYS" }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(body.tools[1]).toEqual({ name: "shell_exec", description: "sh", input_schema: tools[1]!.inputSchema });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("places cache markers on tools, system and the last message only when promptCaching", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    await createAnthropicProvider(fn).chat({ system: "SYS", messages: [user("a"), { role: "assistant", parts: [{ type: "text", text: "b" }] }, user("c")], tools, signal, entry });
    const { body } = calls[0]!;
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
  });

  it("maps tool_use to eigen tool calls, stashes content, and round-trips providerData", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-tool-use.json") }, { body: fixture("anthropic-end-turn.json") }]);
    const p = createAnthropicProvider(fn);
    const r1 = await p.chat({ system: "S", messages: [user("time and desktop?")], tools, signal, entry });
    expect(r1.stopReason).toBe("tool_use");
    expect(r1.toolCalls.map((c) => c.name)).toEqual(["current_time", "shell_exec"]);
    expect(r1.toolCalls.every((c) => c.id.startsWith("call_"))).toBe(true);
    expect(r1.message.parts.map((p) => p.type)).toEqual(["text", "tool_call", "tool_call"]);
    expect(r1.usage).toEqual({ inputTokens: 1020, outputTokens: 61 });

    const history: Message[] = [
      user("time and desktop?"),
      r1.message,
      {
        role: "tool",
        parts: [
          { type: "tool_result", callId: r1.toolCalls[0]!.id, content: [{ type: "text", text: "14:02" }] },
          { type: "tool_result", callId: r1.toolCalls[1]!.id, content: [{ type: "text", text: "exit code 1" }], isError: true },
        ],
      },
    ];
    const r2 = await p.chat({ system: "S", messages: history, tools, signal, entry: { ...entry, promptCaching: false } });
    const sent = calls[1]!.body.messages;
    // assistant turn replayed byte-for-byte, thinking block included
    expect(sent[1]).toEqual({ role: "assistant", content: fixture("anthropic-tool-use.json").content });
    // results go in a user turn and reference the provider's tool_use ids
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01A09q90qw90lq917835lq9", content: [{ type: "text", text: "14:02" }] },
        { type: "tool_result", tool_use_id: "toolu_01B77aa1bb2cc3dd4ee5ff6", content: [{ type: "text", text: "exit code 1" }], is_error: true },
      ],
    });
    expect(r2.stopReason).toBe("end");
    expect(r2.usage).toEqual({ inputTokens: 1060, outputTokens: 18, cachedInputTokens: 1020 });
  });

  it("builds tool_use blocks from neutral parts when there is no providerData (e.g. after a model switch)", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    const history: Message[] = [
      user("q"),
      { role: "assistant", parts: [{ type: "text", text: "" }, { type: "tool_call", id: "call_abc", name: "current_time", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "call_abc", content: [] }] },
      user("follow-up"),
    ];
    await createAnthropicProvider(fn).chat({ system: "S", messages: history, tools, signal, entry: { ...entry, promptCaching: false } });
    const sent = calls[0]!.body.messages;
    expect(sent[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "call_abc", name: "current_time", input: {} }] });
    // tool results and the next user message merge into one user turn
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_abc", content: [{ type: "text", text: "(no output)" }] },
        { type: "text", text: "follow-up" },
      ],
    });
    expect(sent).toHaveLength(3);
  });

  it("sends images as base64 blocks, or a placeholder when vision is false", async () => {
    const img: Message = { role: "user", parts: [{ type: "image", mediaType: "image/jpeg", data: "/9j/4AAQ" }, { type: "text", text: "what?" }] };
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    const p = createAnthropicProvider(fn);
    await p.chat({ system: "S", messages: [img], tools, signal, entry: { ...entry, promptCaching: false } });
    expect(calls[0]!.body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } });
    await p.chat({ system: "S", messages: [img], tools, signal, entry: { ...entry, promptCaching: false, vision: false } });
    expect(calls[1]!.body.messages[0].content[0]).toEqual({ type: "text", text: IMAGE_PLACEHOLDER });
  });

  it("normalizes stop reasons, surfacing refusals", async () => {
    const base = fixture("anthropic-end-turn.json");
    const { fn } = mockFetch([
      { body: { ...base, stop_reason: "max_tokens" } },
      { body: { ...base, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } } },
    ]);
    const p = createAnthropicProvider(fn);
    expect((await p.chat({ system: "S", messages: [user("x")], tools, signal, entry })).stopReason).toBe("max_tokens");
    const r = await p.chat({ system: "S", messages: [user("x")], tools, signal, entry });
    expect(r.stopReason).toBe("other");
    expect(r.stopDetail).toBe("refusal: cyber");
  });

  it("fails with auth when the key env var is missing", async () => {
    const { fn } = mockFetch([{ body: {} }]);
    await expect(createAnthropicProvider(fn).chat({ system: "S", messages: [user("x")], tools, signal, entry: { ...entry, apiKeyEnv: "NOPE_UNSET" } })).rejects.toMatchObject({ kind: "auth" });
  });
});
