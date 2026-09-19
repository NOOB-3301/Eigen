import type { Message, Part, StopReason, ToolCall } from "../../core/types.ts";
import { classifyHttp, classifyNetworkError, ModelError } from "../errors.ts";
import { apiKey, degradeImages, newCallId } from "../provider.ts";
import type { ChatRequest, ChatResult, FetchFn, ModelProvider } from "../provider.ts";
import { isAbortError } from "../../util/abort.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

type CacheControl = { type: "ephemeral" };
type Block = { type: string; cache_control?: CacheControl; [k: string]: unknown };
type ATool = { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: CacheControl };
type AMessage = { role: "user" | "assistant"; content: Block[] };

type AResponse = {
  content?: Block[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

// What we stash on assistant messages: the verbatim content (thinking blocks carry
// signatures that must round-trip byte-for-byte) plus eigen-id -> tool_use id.
type Stash = { content: Block[]; idMap: Record<string, string> };

function readStash(pd: unknown): Stash | undefined {
  const s = (pd as { anthropic?: Stash } | undefined)?.anthropic;
  return s && Array.isArray(s.content) && s.idMap && typeof s.idMap === "object" ? s : undefined;
}

function contentBlocks(parts: Part[], idMap: Record<string, string>): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    // The API rejects empty text blocks.
    if (p.type === "text") {
      if (p.text.trim()) out.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      out.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });
    } else if (p.type === "tool_call") {
      out.push({ type: "tool_use", id: p.id, name: p.name, input: p.args });
    } else {
      const inner = contentBlocks(p.content, idMap);
      out.push({
        type: "tool_result",
        tool_use_id: idMap[p.callId] ?? p.callId,
        content: inner.length ? inner : [{ type: "text", text: "(no output)" }],
        ...(p.isError ? { is_error: true } : {}),
      });
    }
  }
  return out;
}

export function toAnthropicMessages(messages: Message[]): AMessage[] {
  const idMap: Record<string, string> = {};
  const out: AMessage[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user"; // tool results travel in user turns
    let content: Block[];
    const stash = m.role === "assistant" ? readStash(m.providerData) : undefined;
    if (stash) {
      Object.assign(idMap, stash.idMap);
      content = stash.content;
    } else {
      content = contentBlocks(m.parts, idMap);
    }
    if (!content.length) content = [{ type: "text", text: "(empty)" }];
    const prev = out.at(-1);
    // The API requires alternating roles; eigen history can hold e.g. tool results
    // followed by a new user message, so merge adjacent same-role turns.
    if (prev && prev.role === role) prev.content = [...prev.content, ...content];
    else out.push({ role, content });
  }
  return out;
}

const CACHEABLE = new Set(["text", "image", "tool_result"]);

export function buildAnthropicRequest(req: ChatRequest): Record<string, unknown> {
  const { entry } = req;
  const cache = entry.promptCaching;
  const mark: CacheControl = { type: "ephemeral" };
  const messages = toAnthropicMessages(degradeImages(req.messages, entry.vision));
  const tools: ATool[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  if (cache) {
    // Render order is tools -> system -> messages. Marker 1 covers the tool list,
    // marker 2 tools+system, marker 3 the whole conversation so far (rolling cache).
    if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1]!, cache_control: mark };
    const last = messages.at(-1);
    if (last && last.role === "user") {
      const i = last.content.length - 1;
      const block = last.content[i];
      // Copy so a replayed stash is never mutated.
      if (block && CACHEABLE.has(block.type)) last.content = [...last.content.slice(0, i), { ...block, cache_control: mark }];
    }
  }

  return {
    model: entry.model,
    max_tokens: entry.maxOutputTokens,
    system: [{ type: "text", text: req.system, ...(cache ? { cache_control: mark } : {}) }],
    messages,
    ...(tools.length ? { tools } : {}),
  };
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    default:
      return "other"; // refusal, pause_turn, unknown
  }
}

export function parseAnthropicResponse(json: AResponse): Omit<ChatResult, "latencyMs"> {
  const content = json.content ?? [];
  const parts: Part[] = [];
  const toolCalls: ToolCall[] = [];
  const idMap: Record<string, string> = {};
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      const id = newCallId();
      idMap[id] = String(b.id);
      const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {};
      parts.push({ type: "tool_call", id, name: String(b.name), args: input });
      toolCalls.push({ id, name: String(b.name), args: input });
    }
    // thinking / redacted_thinking and anything else live only in the stash.
  }
  const u = json.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const stopReason = mapStop(json.stop_reason);
  const d = json.stop_details;
  const stopDetail = json.stop_reason && stopReason === "other" ? [json.stop_reason, d?.category, d?.explanation].filter(Boolean).join(": ") : undefined;
  return {
    message: { role: "assistant", parts, providerData: { anthropic: { content, idMap } satisfies Stash } },
    toolCalls,
    stopReason,
    ...(stopDetail ? { stopDetail } : {}),
    usage: {
      // Anthropic's input_tokens excludes cached tokens; eigen counts the full prompt.
      inputTokens: (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
    },
  };
}

export function createAnthropicProvider(fetchFn: FetchFn = fetch): ModelProvider {
  return {
    kind: "anthropic",
    async chat(req) {
      const key = apiKey(req.entry);
      if (!key) throw new ModelError("auth", `env var ${req.entry.apiKeyEnv ?? "(apiKeyEnv unset)"} is not set`);
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchFn(`${req.entry.baseUrl.replace(/\/+$/, "")}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(buildAnthropicRequest(req)),
          signal: req.signal,
        });
      } catch (e) {
        if (isAbortError(e)) throw e;
        throw classifyNetworkError(e);
      }
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 500);
        try {
          const j = JSON.parse(text);
          message = [j.error?.type, j.error?.message].filter(Boolean).join(": ") || message;
        } catch {}
        throw classifyHttp(res.status, message, res.headers.get("retry-after"));
      }
      let json: AResponse;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelError("transient", `invalid JSON from provider: ${text.slice(0, 200)}`);
      }
      return { ...parseAnthropicResponse(json), latencyMs: Date.now() - started };
    },
  };
}
