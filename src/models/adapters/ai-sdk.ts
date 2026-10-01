import { APICallError, experimental_evaluate, generateText, jsonSchema, tool } from "ai";
import type { AssistantModelMessage, LanguageModel, ModelMessage, ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "../../config/schema.ts";
import type { Message, Part, StopReason, ToolCall } from "../../core/types.ts";
import { classifyHttp, ModelError } from "../errors.ts";
import { apiKey, degradeImages, textOf } from "../provider.ts";
import type { ChatRequest, ChatResult, EvaluateRequest, EvaluateResult, FetchFn, ModelProvider } from "../provider.ts";
import { isAbortError } from "../../util/abort.ts";
import { logger } from "../../util/logger.ts";

// The SDK owns provider wire formats; eigen keeps its own loop by declaring tools
// WITHOUT an execute function, which makes generateText stop and hand back tool calls.

// What we stash on an assistant message so the next call replays the provider's own
// blocks (Anthropic thinking blocks and their signatures) unchanged.
type Stash = { aiSdk: AssistantModelMessage[] };

function readStash(pd: unknown): AssistantModelMessage[] | undefined {
  const s = (pd as Stash | undefined)?.aiSdk;
  return Array.isArray(s) && s.length ? s : undefined;
}

// Wraps fetch so the exact outgoing body stays visible in the logs, which is what we
// lose by not building the request ourselves.
function loggingFetch(base: FetchFn): FetchFn {
  return async (input, init) => {
    if (logger.isLevelEnabled("debug")) logger.debug({ evt: "model_request", url: String(input), body: safeJson(init?.body) });
    return base(input, init);
  };
}

function safeJson(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body.slice(0, 2000);
  }
}

// Anthropic (and OpenAI/Google) expose an evaluation model; openai-compatible does not.
function evaluationModelFor(entry: ModelEntry, fetchFn: FetchFn) {
  if (entry.provider !== "anthropic") return undefined;
  const key = apiKey(entry);
  if (!key) return undefined;
  const provider = createAnthropic({ baseURL: entry.baseUrl, apiKey: key, fetch: fetchFn });
  return provider.evaluationModel?.(entry.model);
}

function modelFor(entry: ModelEntry, fetchFn: FetchFn): LanguageModel {
  const key = apiKey(entry);
  if (entry.provider === "anthropic") {
    if (!key) throw new ModelError("auth", `env var ${entry.apiKeyEnv ?? "(apiKeyEnv unset)"} is not set`);
    return createAnthropic({ baseURL: entry.baseUrl, apiKey: key, fetch: fetchFn })(entry.model);
  }
  if (entry.apiKeyEnv && !key) throw new ModelError("auth", `env var ${entry.apiKeyEnv} is not set`);
  // Ollama, LM Studio, OpenRouter, OpenAI: anything speaking /chat/completions.
  return createOpenAICompatible({ name: entry.provider, baseURL: entry.baseUrl, apiKey: key, fetch: fetchFn })(entry.model);
}

function toolNameOf(messages: Message[], index: number, callId: string): string {
  for (let i = index - 1; i >= 0; i--) {
    for (const p of messages[i]!.parts) if (p.type === "tool_call" && p.id === callId) return p.name;
  }
  return "unknown_tool";
}

export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") {
      const content: Extract<ModelMessage, { role: "user" }>["content"] = [];
      for (const p of m.parts) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        // Decode ourselves: the SDK rejects a string that is not valid base64.
        else if (p.type === "image") content.push({ type: "image", image: Buffer.from(p.data, "base64"), mediaType: p.mediaType });
      }
      if (content.length) out.push({ role: "user", content });
      return;
    }
    if (m.role === "assistant") {
      const stash = readStash(m.providerData);
      if (stash) {
        out.push(...stash); // byte-identical replay (thinking blocks keep their signatures)
        return;
      }
      const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
      const text = textOf(m.parts);
      if (text) content.push({ type: "text", text });
      for (const p of m.parts) if (p.type === "tool_call") content.push({ type: "tool-call", toolCallId: p.id, toolName: p.name, input: p.args });
      if (content.length) out.push({ role: "assistant", content });
      return;
    }
    const results = m.parts.flatMap((p) =>
      p.type === "tool_result"
        ? [
            {
              type: "tool-result" as const,
              toolCallId: p.callId,
              toolName: toolNameOf(messages, i, p.callId),
              output: { type: p.isError ? ("error-text" as const) : ("text" as const), value: textOf(p.content) || "(no output)" },
            },
          ]
        : [],
    );
    if (results.length) out.push({ role: "tool", content: results });
  });
  return out;
}

function withCacheControl(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (!last) return messages;
  // Message-level cacheControl becomes block-level cache_control on the turn's last
  // block, giving a rolling cache of the conversation so far.
  return [...messages.slice(0, -1), { ...last, providerOptions: { ...last.providerOptions, anthropic: { cacheControl: { type: "ephemeral" } } } }];
}

function toToolSet(req: ChatRequest): ToolSet {
  return Object.fromEntries(
    req.tools.map((t, i) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema),
        // Cache the tool block once; tools render before system and never change.
        ...(req.entry.promptCaching && i === req.tools.length - 1 ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
      }),
    ]),
  );
}

const STOP: Record<string, StopReason> = { stop: "end", "tool-calls": "tool_use", length: "max_tokens" };

export function createAiSdkProvider(fetchFn: FetchFn = fetch): ModelProvider {
  const wrapped = loggingFetch(fetchFn);
  return {
    kind: "ai-sdk",
    async evaluate(req: EvaluateRequest): Promise<EvaluateResult> {
      const model = evaluationModelFor(req.entry, wrapped);
      if (!model) throw new ModelError("bad_request", `entry "${req.entry.model}" has no evaluation model`);
      const r = await experimental_evaluate({ model, state: req.state as never, questions: req.questions as never, abortSignal: req.signal });
      return { answers: r.answers as Record<string, unknown>, usage: r.usage };
    },
    async chat(req: ChatRequest): Promise<ChatResult> {
      const { entry } = req;
      const started = Date.now();
      let messages = toModelMessages(degradeImages(req.messages, entry.vision));
      if (entry.promptCaching) messages = withCacheControl(messages);
      
      let r;
      try {
        r = await generateText({
          model: modelFor(entry, wrapped),
          system: req.system,
          messages,
          tools: entry.toolCalling ? toToolSet(req) : undefined,
          maxOutputTokens: entry.maxOutputTokens,
          abortSignal: req.signal,
          maxRetries: 0, // eigen's withRetry is the single retry place
          ...(entry.promptCaching ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
        });
      } catch (e) {
        throw normalizeError(e);
      }
      const parts: Part[] = [];
      if (r.text.trim()) parts.push({ type: "text", text: r.text });
      const toolCalls: ToolCall[] = r.toolCalls.map((c) => {
        const args = c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {};
        return {
          id: c.toolCallId,
          name: c.toolName,
          args,
          // The SDK flags calls it could not parse or match; feed that back to the model.
          ...(c.invalid ? { argsError: `${(c as { error?: { message?: string } }).error?.message ?? "invalid tool call"}: ${JSON.stringify(c.input)}` } : {}),
        };
      });
      for (const c of toolCalls) parts.push({ type: "tool_call", id: c.id, name: c.name, args: c.args });

      const assistants = r.responseMessages.filter((m): m is AssistantModelMessage => m.role === "assistant");
      const cacheRead = r.usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const stopReason = STOP[r.finishReason] ?? "other";
      return {
        message: { role: "assistant", parts, ...(assistants.length ? { providerData: { aiSdk: assistants } satisfies Stash } : {}) },
        toolCalls,
        stopReason,
        ...(stopReason === "other" ? { stopDetail: r.rawFinishReason ?? r.finishReason } : {}),
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
        },
        latencyMs: Date.now() - started,
      };
    },
  };
}

export function normalizeError(e: unknown): unknown {
  if (isAbortError(e) || e instanceof ModelError) return e;
  if (APICallError.isInstance(e)) {
    const body = e.responseBody ?? "";
    let message = e.message;
    try {
      const j = JSON.parse(body);
      message = [j.error?.type ?? j.error?.code, j.error?.message ?? j.error].filter(Boolean).join(": ") || message;
    } catch {}
    if (e.statusCode !== undefined) return classifyHttp(e.statusCode, message, e.responseHeaders?.["retry-after"]);
    return new ModelError(e.isRetryable ? "transient" : "bad_request", message);
  }
  const name = (e as Error)?.name ?? "";
  if (/Invalid|Type|Schema|NoSuchTool|Unsupported/i.test(name)) return new ModelError("bad_request", `${name}: ${(e as Error).message}`);
  return new ModelError("transient", `${name || "error"}: ${(e as Error)?.message ?? String(e)}`);
}
