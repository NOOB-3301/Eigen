import { describe, expect, it } from "vitest";
import { createOpenAICompatProvider } from "../../src/models/adapters/openai-compat.ts";
import { IMAGE_PLACEHOLDER } from "../../src/models/provider.ts";
import type { ModelEntry } from "../../src/config/schema.ts";
import type { Message, ToolDef } from "../../src/core/types.ts";
import { fixture, mockFetch } from "../helpers/mock-fetch.ts";

const entry: ModelEntry = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1/", model: "gemma4:e4b", contextWindow: 28000, replyReserve: 4096, maxOutputTokens: 1234, toolCalling: true, vision: true, promptCaching: false };
const tools: ToolDef[] = [{ name: "current_time", description: "time", inputSchema: { type: "object", properties: {} } }];
const signal = new AbortController().signal;

const history: Message[] = [
  { role: "user", parts: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "iVBOR" }] },
  { role: "assistant", parts: [{ type: "text", text: "Checking." }, { type: "tool_call", id: "call_1", name: "current_time", args: {} }], providerData: { anthropic: { content: [], idMap: {} } } },
  { role: "tool", parts: [{ type: "tool_result", callId: "call_1", content: [{ type: "text", text: "14:02" }] }, { type: "tool_result", callId: "call_2", content: [{ type: "text", text: "boom" }], isError: true }] },
];

describe("openai-compat adapter", () => {
  it("maps eigen messages to chat-completions format", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }]);
    await createOpenAICompatProvider(fn).chat({ system: "SYS", messages: history, tools, signal, entry });
    const { url, body, headers } = calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headers.authorization).toBeUndefined();
    expect(body.model).toBe("gemma4:e4b");
    expect(body.max_tokens).toBe(1234);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] },
      { role: "assistant", content: "Checking.", tool_calls: [{ id: "call_1", type: "function", function: { name: "current_time", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "14:02" },
      { role: "tool", tool_call_id: "call_2", content: "ERROR: boom" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "current_time", description: "time", parameters: { type: "object", properties: {} } } }]);
  });

  it("sends a bearer key when configured and omits tools when none", async () => {
    process.env.TEST_OA_KEY = "sk-test";
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }]);
    await createOpenAICompatProvider(fn).chat({ system: "S", messages: [history[0]!], tools: [], signal, entry: { ...entry, apiKeyEnv: "TEST_OA_KEY" } });
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it("replaces images with a placeholder when vision is false", async () => {
    const { fn, calls } = mockFetch([{ body: fixture("openai-stop.json") }]);
    await createOpenAICompatProvider(fn).chat({ system: "S", messages: [history[0]!], tools, signal, entry: { ...entry, vision: false } });
    expect(calls[0]!.body.messages[1]).toEqual({ role: "user", content: `look\n${IMAGE_PLACEHOLDER}` });
    expect(history[0]!.parts[1]!.type).toBe("image"); // history untouched
  });

  it("parses tool calls into eigen format with eigen-generated ids", async () => {
    const { fn } = mockFetch([{ body: fixture("openai-tool-calls.json") }]);
    const r = await createOpenAICompatProvider(fn).chat({ system: "S", messages: [history[0]!], tools, signal, entry });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls.map((c) => [c.name, c.args])).toEqual([["current_time", {}], ["shell_exec", { command: "ls ~/Desktop" }]]);
    expect(r.toolCalls.every((c) => c.id.startsWith("call_") && c.id !== "call_x1y2z3" && c.id !== "call_a4b5c6")).toBe(true);
    expect(r.message.parts.map((p) => p.type)).toEqual(["tool_call", "tool_call"]); // empty content dropped
    expect(r.usage).toEqual({ inputTokens: 412, outputTokens: 37 });
  });

  it("returns unparseable arguments as argsError with the raw text", async () => {
    const { fn } = mockFetch([{ body: fixture("openai-bad-args.json") }]);
    const r = await createOpenAICompatProvider(fn).chat({ system: "S", messages: [history[0]!], tools, signal, entry });
    expect(r.toolCalls[0]!.argsError).toMatch(/not valid JSON.*\{"command": "ls/);
  });

  it("parses a text reply with cached tokens and maps finish reasons", async () => {
    const { fn } = mockFetch([
      { body: fixture("openai-stop.json") },
      { body: { ...fixture("openai-stop.json"), choices: [{ message: { content: "cut" }, finish_reason: "length" }] } },
    ]);
    const p = createOpenAICompatProvider(fn);
    const r = await p.chat({ system: "S", messages: [history[0]!], tools, signal, entry });
    expect(r.stopReason).toBe("end");
    expect(r.message).toEqual({ role: "assistant", parts: [{ type: "text", text: "It is 14:02." }] });
    expect(r.usage.cachedInputTokens).toBe(400);
    expect((await p.chat({ system: "S", messages: [history[0]!], tools, signal, entry })).stopReason).toBe("max_tokens");
  });
});
