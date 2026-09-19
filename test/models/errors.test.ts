import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../src/models/adapters/anthropic.ts";
import { createOpenAICompatProvider } from "../../src/models/adapters/openai-compat.ts";
import { ModelError, parseRetryAfter, withRetry } from "../../src/models/errors.ts";
import type { ErrorKind } from "../../src/models/errors.ts";
import type { ModelEntry } from "../../src/config/schema.ts";
import { fixture, mockFetch } from "../helpers/mock-fetch.ts";

const signal = new AbortController().signal;
const ant: ModelEntry = { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "TEST_ANT_KEY2", model: "m", contextWindow: 1000, replyReserve: 100, maxOutputTokens: 100, toolCalling: true, vision: false, promptCaching: false };
const oa: ModelEntry = { ...ant, provider: "openai-compat", apiKeyEnv: undefined };
process.env.TEST_ANT_KEY2 = "k";

async function kindOf(provider: ReturnType<typeof createAnthropicProvider>, entry: ModelEntry): Promise<ModelError> {
  try {
    await provider.chat({ system: "s", messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], tools: [], signal, entry });
  } catch (e) {
    return e as ModelError;
  }
  throw new Error("expected failure");
}

describe("error normalization", () => {
  const antCases: Record<string, ErrorKind> = { rate_limited: "rate_limited", overloaded: "transient", server: "transient", auth: "auth", permission: "auth", bad_request: "bad_request", overflow: "context_overflow", too_large: "context_overflow" };
  for (const [name, kind] of Object.entries(antCases)) {
    it(`anthropic ${name} -> ${kind}`, async () => {
      const f = fixture("anthropic-errors.json")[name];
      const { fn } = mockFetch([{ status: f.status, body: f.body, headers: f.headers }]);
      const e = await kindOf(createAnthropicProvider(fn), ant);
      expect(e).toBeInstanceOf(ModelError);
      expect(e.kind).toBe(kind);
      if (name === "rate_limited") expect(e.retryAfterMs).toBe(7000);
    });
  }

  const oaCases: Record<string, ErrorKind> = { rate_limited: "rate_limited", server: "transient", auth: "auth", bad_request: "bad_request", overflow: "context_overflow", not_found: "bad_request" };
  for (const [name, kind] of Object.entries(oaCases)) {
    it(`openai-compat ${name} -> ${kind}`, async () => {
      const f = fixture("openai-errors.json")[name];
      const { fn } = mockFetch([{ status: f.status, body: f.body, headers: f.headers }]);
      expect((await kindOf(createOpenAICompatProvider(fn), oa)).kind).toBe(kind);
    });
  }

  it("network failures are transient", async () => {
    const fn = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const e = await kindOf(createOpenAICompatProvider(fn as never), oa);
    expect(e.kind).toBe("transient");
    expect(e.message).toContain("ECONNREFUSED");
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("withRetry", () => {
  const run = async (kinds: ErrorKind[]) => {
    let n = 0;
    try {
      await withRetry(
        async () => {
          const k = kinds[n++];
          if (k) throw new ModelError(k, k, { retryAfterMs: 1 });
          return "ok";
        },
        { signal, maxRetries: 3 },
      );
      return { ok: true, attempts: n };
    } catch (e) {
      return { ok: false, attempts: n, kind: (e as ModelError).kind };
    }
  };

  it("retries transient and rate_limited, honoring retry-after", async () => {
    expect(await run(["transient", "rate_limited"])).toEqual({ ok: true, attempts: 3 });
  });
  it("never retries auth, bad_request or context_overflow", async () => {
    for (const k of ["auth", "bad_request", "context_overflow"] as const) expect(await run([k])).toEqual({ ok: false, attempts: 1, kind: k });
  });
  it("gives up after maxRetries", async () => {
    expect(await run(["transient", "transient", "transient", "transient", "transient"])).toEqual({ ok: false, attempts: 4, kind: "transient" });
  });
});
