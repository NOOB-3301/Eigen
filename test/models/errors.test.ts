import { describe, expect, it } from "vitest";
import { classifyHttp, ModelError, parseRetryAfter, withRetry } from "../../src/models/errors.ts";
import type { ErrorKind } from "../../src/models/errors.ts";

const signal = new AbortController().signal;

describe("classifyHttp", () => {
  const cases: Array<[number, string, ErrorKind]> = [
    [401, "invalid x-api-key", "auth"],
    [403, "not allowed", "auth"],
    [429, "rate limit reached", "rate_limited"],
    [500, "internal", "transient"],
    [529, "overloaded", "transient"],
    [408, "timeout", "transient"],
    [400, "prompt is too long: 210000 tokens > 200000 maximum", "context_overflow"],
    [400, "This model's maximum context length is 8192 tokens.", "context_overflow"],
    [413, "request too large", "context_overflow"],
    [400, "tool_use ids must be unique", "bad_request"],
    [404, "model not found", "bad_request"],
  ];
  for (const [status, message, kind] of cases) {
    it(`${status} "${message.slice(0, 30)}" -> ${kind}`, () => {
      expect(classifyHttp(status, message).kind).toBe(kind);
    });
  }

  it("carries Retry-After through", () => {
    expect(classifyHttp(429, "slow down", "7").retryAfterMs).toBe(7000);
  });
});

describe("parseRetryAfter", () => {
  it("accepts seconds and HTTP dates, ignores nothing", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});

describe("withRetry", () => {
  const run = async (kinds: ErrorKind[], maxRetries = 3) => {
    let n = 0;
    try {
      await withRetry(
        async () => {
          const k = kinds[n++];
          if (k) throw new ModelError(k, k, { retryAfterMs: 1 });
          return "ok";
        },
        { signal, maxRetries },
      );
      return { ok: true, attempts: n };
    } catch (e) {
      return { ok: false, attempts: n, kind: (e as ModelError).kind };
    }
  };

  it("retries transient and rate_limited", async () => {
    expect(await run(["transient", "rate_limited"])).toEqual({ ok: true, attempts: 3 });
  });
  it("never retries auth, bad_request or context_overflow", async () => {
    for (const k of ["auth", "bad_request", "context_overflow"] as const) expect(await run([k])).toEqual({ ok: false, attempts: 1, kind: k });
  });
  it("gives up after maxRetries", async () => {
    expect(await run(Array(6).fill("transient"))).toEqual({ ok: false, attempts: 4, kind: "transient" });
  });
  it("does not retry when maxRetries is 0", async () => {
    expect(await run(["transient"], 0)).toEqual({ ok: false, attempts: 1, kind: "transient" });
  });
  it("rethrows abort errors without retrying", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new DOMException("aborted", "AbortError");
        },
        { signal, maxRetries: 3 },
      ),
    ).rejects.toThrow("aborted");
    expect(n).toBe(1);
  });
});
