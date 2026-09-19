import type { ChatRequest, ChatResult, ModelProvider } from "../../src/models/provider.ts";
import { newCallId } from "../../src/models/provider.ts";
import type { Part, StopReason, ToolCall } from "../../src/core/types.ts";
import type { Config } from "../../src/config/schema.ts";
import { ModelRegistry } from "../../src/models/registry.ts";

export type Script = {
  text?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown>; argsError?: string }>;
  stopReason?: StopReason;
  stopDetail?: string;
  delayMs?: number; // abortable
  error?: Error;
  usage?: { inputTokens: number; outputTokens: number };
};

// Deterministic provider: each chat() consumes the next script step (the last one repeats).
export class FakeProvider implements ModelProvider {
  readonly kind = "fake";
  requests: ChatRequest[] = [];
  #steps: Script[];
  #i = 0;

  constructor(steps: Script[]) {
    this.#steps = steps;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone({ ...req, signal: undefined }) as unknown as ChatRequest);
    const s = this.#steps[Math.min(this.#i++, this.#steps.length - 1)]!;
    if (s.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, s.delayMs);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (s.error) throw s.error;
    const toolCalls: ToolCall[] = (s.calls ?? []).map((c) => ({ id: newCallId(), name: c.name, args: c.args ?? {}, ...(c.argsError ? { argsError: c.argsError } : {}) }));
    const parts: Part[] = [];
    if (s.text !== undefined) parts.push({ type: "text", text: s.text });
    for (const c of toolCalls) parts.push({ type: "tool_call", id: c.id, name: c.name, args: c.args });
    return {
      message: { role: "assistant", parts },
      toolCalls,
      stopReason: s.stopReason ?? (toolCalls.length ? "tool_use" : "end"),
      ...(s.stopDetail ? { stopDetail: s.stopDetail } : {}),
      usage: s.usage ?? { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
    };
  }
}

export function testConfig(overrides: Partial<Config["limits"]> = {}): Config {
  return {
    defaultModel: "fake",
    models: {
      fake: { provider: "openai-compat", baseUrl: "http://fake/v1", model: "fake-1", contextWindow: 100_000, replyReserve: 4_000, maxOutputTokens: 2_000, toolCalling: true, vision: false, promptCaching: false },
    },
    telegram: { tokenEnv: "T", allowedUserIds: [1], pollTimeoutSec: 30, chunkSize: 4096, typingRefreshMs: 4000, sendRatePerSec: 30 },
    limits: {
      maxSteps: 25,
      runTokenBudget: 1_000_000,
      runTimeoutMs: 60_000,
      toolTimeoutMs: 5_000,
      toolOutputMaxChars: 10_000,
      toolArgRetryMax: 2,
      modelRetryMax: 0,
      imageTokenEstimate: 1000,
      ...overrides,
    },
    mcpServers: {},
    mcp: {},
  };
}

// A ModelRegistry whose every entry is served by the given provider.
export class FakeRegistry extends ModelRegistry {
  #p: ModelProvider;
  constructor(config: Config, provider: ModelProvider) {
    super(config);
    this.#p = provider;
  }
  override provider(): ModelProvider {
    return this.#p;
  }
}
