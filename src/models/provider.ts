import { randomBytes } from "node:crypto";
import type { ModelEntry } from "../config/schema.ts";
import type { Message, Part, StopReason, ToolCall, ToolDef, Usage } from "../core/types.ts";

export type ChatRequest = {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  signal: AbortSignal;
  entry: ModelEntry;
};

export type ChatResult = {
  message: Message; // role "assistant"; tool_call parts carry eigen-generated ids
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  stopDetail?: string;
  latencyMs: number;
};

export type EvaluateRequest = {
  state: unknown;
  questions: Record<string, unknown>;
  entry: ModelEntry;
  signal?: AbortSignal;
};

export type EvaluateResult = { answers: Record<string, unknown>; usage?: { inputTokens?: number; outputTokens?: number } };

export interface ModelProvider {
  readonly kind: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  // Optional capability: only providers with an SDK evaluation model implement it.
  evaluate?(req: EvaluateRequest): Promise<EvaluateResult>;
}

export type FetchFn = typeof fetch;

// Tool-call ids are always minted by eigen so history never depends on one provider's id scheme.
export function newCallId(): string {
  return `call_${randomBytes(8).toString("hex")}`;
}

export const IMAGE_PLACEHOLDER = "[image omitted: the current model has no vision support]";

function degradeParts(parts: Part[]): Part[] {
  return parts.map((p): Part => {
    if (p.type === "image") return { type: "text", text: IMAGE_PLACEHOLDER };
    if (p.type === "tool_result") return { ...p, content: degradeParts(p.content) };
    return p;
  });
}

// Applied at send time only; stored history keeps the image.
export function degradeImages(messages: Message[], vision: boolean): Message[] {
  if (vision) return messages;
  return messages.map((m) => (m.parts.some((p) => p.type === "image" || p.type === "tool_result") ? { ...m, parts: degradeParts(m.parts) } : m));
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function apiKey(entry: ModelEntry): string | undefined {
  return entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
}
