import { beforeAll, describe, expect, it } from "vitest";
import { createAiSdkProvider, toModelMessages } from "../../src/models/adapters/ai-sdk.ts";
import { IMAGE_PLACEHOLDER } from "../../src/models/provider.ts";
import { ModelError } from "../../src/models/errors.ts";
import type { ErrorKind } from "../../src/models/errors.ts";
import type { ModelEntry } from "../../src/config/schema.ts";
import type { Message, ToolDef } from "../../src/core/types.ts";
import { fixture, mockFetch } from "../helpers/mock-fetch.ts";

const ollama: ModelEntry = {
  provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "gemma4:e4b",
  contextWindow: 28000, replyReserve: 4096, maxOutputTokens: 1234, toolCalling: true, vision: true, promptCaching: false,
};
const claude: ModelEntry = {
  provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "TEST_AISDK_KEY", model: "claude-sonnet-5",
  contextWindow: 200000, replyReserve: 16000, maxOutputTokens: 16000, toolCalling: true, vision: true, promptCaching: true,
};
const tools: ToolDef[] = [
  { name: "current_time", description: "time", inputSchema: { type: "object", properties: {} } },
  { name: "shell_exec", description: "sh", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const signal = new AbortController().signal;
const user = (t: string): Message => ({ role: "user", parts: [{ type: "text", text: t }] });
const chat = (fn: typeof fetch, entry: ModelEntry, messages: Message[], t = tools) =>
  createAiSdkProvider(fn).chat({ system: "SYS", messages, tools: t, signal, entry });

beforeAll(() => {
  process.env.TEST_AISDK_KEY = "sk-ant-test";
});

describe("ai-sdk adapter: openai-compatible", () => {
  it("sends eigen history in chat-completions shape with tools and max_tokens", async () => {
    const history: Message[] = [
      user("look"),
      { role: "assistant", parts: [{ type: "text", text: "Checking." }, { type: "tool_call", id: "call_1", name: "current_time", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "call_1", content: [{ type: "text", text: "14:02" }] }] },
    ];
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }]);
    await chat(fn, ollama, history);
    const { url, body } = calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(body.model).toBe("gemma4:e4b");
    expect(body.max_tokens).toBe(1234);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.messages[1]).toMatchObject({ role: "user" });
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "current_time", arguments: "{}" });
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "14:02" });
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["current_time", "shell_exec"]);
  });

  it("omits tools when the entry has toolCalling off", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }]);
    await chat(fn, { ...ollama, toolCalling: false }, [user("hi")]);
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it("parses tool calls and usage", async () => {
    const { fn } = mockFetch([{ body: fixture("openai-tool-calls.json") }]);
    const r = await chat(fn, ollama, [user("time and desktop?")]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls.map((c) => [c.name, c.args])).toEqual([["current_time", {}], ["shell_exec", { command: "ls ~/Desktop" }]]);
    expect(r.message.parts.filter((p) => p.type === "tool_call")).toHaveLength(2);
    expect(r.usage).toEqual({ inputTokens: 412, outputTokens: 37 });
  });

  it("parses a plain reply with cached tokens", async () => {
    const { fn } = mockFetch([{ body: fixture("openai-stop.json") }]);
    const r = await chat(fn, ollama, [user("x")]);
    expect(r.stopReason).toBe("end");
    expect(r.message.parts[0]).toEqual({ type: "text", text: "It is 14:02." });
    expect(r.usage.cachedInputTokens).toBe(400);
  });

  it("maps a length finish to max_tokens", async () => {
    const cut = { ...fixture("openai-stop.json"), choices: [{ index: 0, message: { role: "assistant", content: "cut" }, finish_reason: "length" }] };
    const { fn } = mockFetch([{ body: cut }]);
    expect((await chat(fn, ollama, [user("x")])).stopReason).toBe("max_tokens");
  });

  it("replaces images with a placeholder when vision is false", async () => {
    const img: Message = { role: "user", parts: [{ type: "image", mediaType: "image/png", data: "iVBOR" }, { type: "text", text: "what?" }] };
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }, { body: fixture("openai-stop.json") }]);
    await chat(fn, ollama, [img]);
    expect(JSON.stringify(calls[0]!.body.messages[1])).toContain("image_url");
    await chat(fn, { ...ollama, vision: false }, [img]);
    expect(JSON.stringify(calls[1]!.body.messages[1])).toContain(IMAGE_PLACEHOLDER);
    expect(img.parts[0]!.type).toBe("image"); // history untouched
  });
});

describe("ai-sdk adapter: anthropic", () => {
  it("sends system separately, sets max_tokens, and uses the API key header", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    await chat(fn, { ...claude, promptCaching: false }, [user("hi")]);
    const { url, headers, body } = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(body.max_tokens).toBe(16000);
    expect(JSON.stringify(body.system)).toContain("SYS");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["current_time", "shell_exec"]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("adds cache markers only when promptCaching is on", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    await chat(fn, claude, [user("a"), { role: "assistant", parts: [{ type: "text", text: "b" }] }, user("c")]);
    const { body } = calls[0]!;
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });

  it("round-trips provider blocks (thinking) and maps tool_use/tool_result", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-tool-use.json") }, { body: fixture("anthropic-end-turn.json") }]);
    const provider = createAiSdkProvider(fn);
    const first = await provider.chat({ system: "SYS", messages: [user("time and desktop?")], tools, signal, entry: claude });
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls.map((c) => c.name)).toEqual(["current_time", "shell_exec"]);
    expect(first.message.providerData).toBeDefined();

    const history: Message[] = [
      user("time and desktop?"),
      first.message,
      {
        role: "tool",
        parts: [
          { type: "tool_result", callId: first.toolCalls[0]!.id, content: [{ type: "text", text: "14:02" }] },
          { type: "tool_result", callId: first.toolCalls[1]!.id, content: [{ type: "text", text: "boom" }], isError: true },
        ],
      },
    ];
    const second = await provider.chat({ system: "SYS", messages: history, tools, signal, entry: { ...claude, promptCaching: false } });
    const sent = calls[1]!.body.messages;
    const assistant = sent.find((m: { role: string }) => m.role === "assistant");
    // thinking block replayed with its signature, and tool_use ids match the tool_results
    expect(assistant.content[0]).toMatchObject({ type: "thinking", signature: fixture("anthropic-tool-use.json").content[0].signature });
    const useIds = assistant.content.filter((b: { type: string }) => b.type === "tool_use").map((b: { id: string }) => b.id);
    expect(useIds).toEqual(["toolu_01A09q90qw90lq917835lq9", "toolu_01B77aa1bb2cc3dd4ee5ff6"]);
    const results = sent.at(-1).content.filter((b: { type: string }) => b.type === "tool_result");
    expect(results.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(useIds);
    expect(results[1].is_error).toBe(true);
    // the SDK reports cache reads inside inputTokens (40 + 1020), matching eigen's old adapter
    expect(second.usage).toEqual({ inputTokens: 1060, outputTokens: 18, cachedInputTokens: 1020 });
  });

  it("builds tool_use blocks from neutral parts when there is no providerData", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    const history: Message[] = [
      user("q"),
      { role: "assistant", parts: [{ type: "tool_call", id: "call_abc", name: "current_time", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "call_abc", content: [] }] },
      user("next"),
    ];
    await chat(fn, { ...claude, promptCaching: false }, history);
    const sent = calls[0]!.body.messages;
    expect(sent[1].content).toEqual([{ type: "tool_use", id: "call_abc", name: "current_time", input: {} }]);
    expect(sent[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_abc" });
  });

  it("sends images as base64 blocks", async () => {
    const img: Message = { role: "user", parts: [{ type: "image", mediaType: "image/jpeg", data: "/9j/4AAQ" }] };
    const { fn, calls } = mockFetch([{ body: fixture("anthropic-end-turn.json") }]);
    await chat(fn, { ...claude, promptCaching: false }, [img]);
    expect(calls[0]!.body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } });
  });

  it("fails with auth when the key env var is missing", async () => {
    const { fn } = mockFetch([{ body: {} }]);
    await expect(chat(fn, { ...claude, apiKeyEnv: "NOPE_UNSET" }, [user("x")])).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("ai-sdk adapter: message conversion", () => {
  it("keeps tool names attached to their results", () => {
    const out = toModelMessages([
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell_exec", args: { command: "ls" } }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "c1", content: [{ type: "text", text: "ok" }] }] },
    ]);
    expect(out[1]).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "shell_exec", output: { type: "text", value: "ok" } }] });
  });
});

describe("ai-sdk adapter: error normalization", () => {
  const cases: Array<[string, string, ErrorKind]> = [
    ["anthropic-errors.json", "rate_limited", "rate_limited"],
    ["anthropic-errors.json", "overloaded", "transient"],
    ["anthropic-errors.json", "auth", "auth"],
    ["anthropic-errors.json", "overflow", "context_overflow"],
    ["anthropic-errors.json", "bad_request", "bad_request"],
    ["openai-errors.json", "rate_limited", "rate_limited"],
    ["openai-errors.json", "server", "transient"],
    ["openai-errors.json", "auth", "auth"],
    ["openai-errors.json", "overflow", "context_overflow"],
    ["openai-errors.json", "not_found", "bad_request"],
  ];
  for (const [file, name, kind] of cases) {
    it(`${file.split("-")[0]} ${name} -> ${kind}`, async () => {
      const f = fixture(file)[name];
      const { fn } = mockFetch([{ status: f.status, body: f.body, headers: f.headers }]);
      const entry = file.startsWith("anthropic") ? { ...claude, promptCaching: false } : ollama;
      const err = await chat(fn, entry, [user("x")]).catch((e) => e);
      expect(err).toBeInstanceOf(ModelError);
      expect(err.kind).toBe(kind);
    });
  }

  it("network failures are transient", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const err = await chat(fn, ollama, [user("x")]).catch((e) => e);
    expect(err.kind).toBe("transient");
  });
});
