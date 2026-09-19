// eigen's own conversation format. Adapters translate to and from provider shapes;
// nothing else may know those shapes.

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; args: Record<string, unknown> };
export type ToolResultPart = { type: "tool_result"; callId: string; content: Part[]; isError?: boolean };
export type ImagePart = { type: "image"; mediaType: string; data: string };
export type Part = TextPart | ToolCallPart | ToolResultPart | ImagePart;

export type Role = "user" | "assistant" | "tool";

export type Message = {
  role: Role;
  parts: Part[];
  // Opaque blob an adapter needs echoed back unchanged (e.g. thinking blocks). Core
  // stores it, never reads it, and drops it when the session changes provider.
  providerData?: unknown;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // Set when the model emitted arguments that are not a JSON object; the raw text is
  // fed back so the model can correct itself.
  argsError?: string;
};

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
