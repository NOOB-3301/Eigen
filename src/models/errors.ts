import { backoffDelay, sleep } from "../util/backoff.ts";
import { isAbortError } from "../util/abort.ts";

export type ErrorKind = "transient" | "rate_limited" | "auth" | "bad_request" | "context_overflow";

export class ModelError extends Error {
  override name = "ModelError";
  kind: ErrorKind;
  status?: number;
  retryAfterMs?: number;

  constructor(kind: ErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const OVERFLOW_RE = /prompt is too long|context[ _-]?(length|window)|maximum context|too many (input )?tokens/i;

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// Shared HTTP-status classification; adapters pass the provider's error message/code.
export function classifyHttp(status: number, message: string, retryAfter?: string | null): ModelError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  const msg = `HTTP ${status}: ${message}`;
  const opts = { status, retryAfterMs };
  if (status === 401 || status === 403) return new ModelError("auth", msg, opts);
  if (status === 429) return new ModelError("rate_limited", msg, opts);
  if (status === 413 || OVERFLOW_RE.test(message)) return new ModelError("context_overflow", msg, opts);
  if (status === 408 || status === 409 || status >= 500) return new ModelError("transient", msg, opts);
  return new ModelError("bad_request", msg, opts);
}

export function classifyNetworkError(e: unknown): ModelError {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  return new ModelError("transient", `network error: ${(e as Error)?.message ?? e}${cause ? ` (${cause})` : ""}`);
}

export function isRetryable(e: unknown): e is ModelError {
  return e instanceof ModelError && (e.kind === "transient" || e.kind === "rate_limited");
}

export type RetryOpts = {
  signal: AbortSignal;
  maxRetries: number;
  onRetry?: (e: ModelError, attempt: number, delayMs: number) => void;
};

// The one place model calls are retried; adapters just throw ModelError.
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e) || !isRetryable(e) || attempt >= opts.maxRetries) throw e;
      const delay = Math.min(e.retryAfterMs ?? backoffDelay(attempt, 1000), 60_000);
      opts.onRetry?.(e, attempt + 1, delay);
      await sleep(delay, opts.signal);
    }
  }
}
