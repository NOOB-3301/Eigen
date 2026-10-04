import { engineBase } from "./engine";
import { json } from "./http";

/** Anything shaped like a Telegram bot token or a long key never leaves the server, even inside an error string. */
const SECRETISH = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b|\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AIza)[-_A-Za-z0-9]{16,}\b|Bearer\s+[A-Za-z0-9._-]{16,}/g;

export const cleanText = (v: unknown, max = 300): string | undefined => (typeof v === "string" ? v.replace(SECRETISH, "[redacted]").slice(0, max) : undefined);

type Forward = { method?: "GET" | "POST"; body?: unknown; timeoutMs: number };

/**
 * Calls an engine route (loopback only) and relays a sanitized answer. `shape` rebuilds the answer field by field from what the
 * engine sent, or returns null when it is not the expected shape (502).
 * 503 { ok:false, error:"engine offline" } when nothing answers; 504 on timeout; 501 when the engine predates the route.
 * A 4xx that carries a well-formed { ok:false, error } (unknown agent or trigger, bad input) keeps its status; any other
 * well-shaped answer is relayed as 200, the way probes always reported their own failures.
 */
export async function forwardEngine<T>(path: string, { method = "POST", body, timeoutMs }: Forward, shape: (raw: Record<string, unknown>) => T | null): Promise<Response> {
  const base = engineBase();
  if (!base) return json({ ok: false, error: "engine offline" }, 503);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      cache: "no-store",
      ...(method === "POST" && { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Node's fetch also gives up on its own when no headers arrive within 300 s (a long trigger run); that is a timeout too, not an offline engine.
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || cause === "UND_ERR_HEADERS_TIMEOUT");
    return timedOut ? json({ ok: false, error: "the engine did not answer in time" }, 504) : json({ ok: false, error: "engine offline" }, 503);
  }
  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const refusal = raw && typeof raw === "object" && raw.ok === false && typeof raw.error === "string";
  if (res.status >= 400 && res.status < 500 && refusal) return json({ ok: false, error: cleanText(raw.error) }, res.status);
  if (res.status === 404) return json({ ok: false, error: "this engine version has no such route; restart it to pick up the update" }, 501);
  const shaped = raw && typeof raw === "object" ? shape(raw) : null;
  return shaped ? json(shaped) : json({ ok: false, error: "the engine sent an unexpected answer" }, 502);
}

/** A JSON probe ({ ok, ... }) to the engine: forwardEngine with the answer required to carry a boolean `ok`. */
export const forwardProbe = <T extends { ok: boolean }>(path: string, body: unknown, timeoutMs: number, shape: (raw: Record<string, unknown>) => T): Promise<Response> =>
  forwardEngine(path, { body, timeoutMs }, (raw) => (typeof raw.ok === "boolean" ? shape(raw) : null));
