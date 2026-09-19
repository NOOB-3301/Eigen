import type { Message, Part, StopReason, ToolCall } from "../../core/types.ts";
import { classifyHttp, classifyNetworkError, ModelError } from "../errors.ts";
import { apiKey, degradeImages, newCallId, textOf } from "../provider.ts";
import type { ChatRequest, ChatResult, FetchFn, ModelProvider } from "../provider.ts";
import { isAbortError } from "../../util/abort.ts";

type OaContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
type OaToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OaMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: OaContent }
  | { role: "assistant"; content: string | null; tool_calls?: OaToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OaResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

function userContent(parts: Part[]): OaContent {
  if (!parts.some((p) => p.type === "image")) return textOf(parts);
  const out: Exclude<OaContent, string> = [];
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else if (p.type === "image") out.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
  }
  return out;
}

// Tool messages are text-only in chat completions.
function resultText(parts: Part[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image]" : "")).join("\n") || "(no output)";
}

export function toOpenAIMessages(system: string, messages: Message[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: userContent(m.parts) });
    } else if (m.role === "assistant") {
      const calls = m.parts.flatMap((p): OaToolCall[] =>
        p.type === "tool_call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args) } }] : [],
      );
      const text = textOf(m.parts);
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const p of m.parts) {
        if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.callId, content: (p.isError ? "ERROR: " : "") + resultText(p.content) });
      }
    }
  }
  console.log("toOpenAIMessages", JSON.stringify(out, null, 2));
  return out;
}

export function buildOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  const { entry } = req;
  const body: Record<string, unknown> = {
    model: entry.model,
    messages: toOpenAIMessages(req.system, degradeImages(req.messages, entry.vision)),
    // Ollama maps max_tokens to num_predict; newer OpenAI models also accept it.
    max_tokens: entry.maxOutputTokens,
    stream: false,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }
  return body;
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (raw === undefined || raw === null || raw === "") return { args: {} };
  const text = String(raw);
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { args: v };
    return { args: {}, error: `arguments must be a JSON object, got: ${text}` };
  } catch (e) {
    return { args: {}, error: `arguments are not valid JSON (${(e as Error).message}): ${text}` };
  }
}

function mapFinish(reason: string | null | undefined, hasCalls: boolean): StopReason {
  if (reason === "length") return "max_tokens";
  if (hasCalls) return "tool_use";
  if (reason === "stop" || reason === "tool_calls") return "end";
  return "other";
}

export function parseOpenAIResponse(json: OaResponse): Omit<ChatResult, "latencyMs"> {
  const choice = json.choices?.[0];
  if (!choice) throw new ModelError("transient", "response had no choices");
  const msg = choice.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    const { args, error } = parseArgs(tc.function?.arguments);
    return { id: newCallId(), name: tc.function?.name ?? "", args, ...(error ? { argsError: error } : {}) };
  });
  const parts: Part[] = [];
  if (msg.content) parts.push({ type: "text", text: msg.content });
  for (const c of toolCalls) parts.push({ type: "tool_call", id: c.id, name: c.name, args: c.args });
  const u = json.usage ?? {};
  return {
    message: { role: "assistant", parts },
    toolCalls,
    stopReason: mapFinish(choice.finish_reason, toolCalls.length > 0),
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(u.prompt_tokens_details?.cached_tokens ? { cachedInputTokens: u.prompt_tokens_details.cached_tokens } : {}),
    },
  };
}

export function createOpenAICompatProvider(fetchFn: FetchFn = fetch): ModelProvider {
  return {
    kind: "openai-compat",
    async chat(req) {
      const key = apiKey(req.entry);
      if (req.entry.apiKeyEnv && !key) throw new ModelError("auth", `env var ${req.entry.apiKeyEnv} is not set`);
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchFn(`${req.entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(buildOpenAIRequest(req)),
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
          message = [j.error?.code, j.error?.message ?? j.error].filter(Boolean).join(": ") || message;
        } catch {}
        throw classifyHttp(res.status, message, res.headers.get("retry-after"));
      }
      let json: OaResponse;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelError("transient", `invalid JSON from provider: ${text.slice(0, 200)}`);
      }
      return { ...parseOpenAIResponse(json), latencyMs: Date.now() - started };
    },
  };
}
