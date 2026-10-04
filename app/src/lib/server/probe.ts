import { engineBase } from "./engine";
import { json } from "./http";

/** Anything shaped like a Telegram bot token or a long key never leaves the server, even inside an error string. */
const SECRETISH = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b|\b(?:sk|pk|ghp|xox[abprs]|AIza)[-_A-Za-z0-9]{16,}\b|Bearer\s+[A-Za-z0-9._-]{16,}/g;

export const cleanText = (v: unknown, max = 300): string | undefined => (typeof v === "string" ? v.replace(SECRETISH, "[redacted]").slice(0, max) : undefined);

/**
 * POSTs a JSON probe to the engine (loopback only) and relays a sanitized answer.
 * 503 { ok:false, error:"engine offline" } when nothing answers; 501 when the engine predates the probe route.
 */
export async function forwardProbe<T extends { ok: boolean }>(path: string, body: unknown, timeoutMs: number, shape: (raw: Record<string, unknown>) => T): Promise<Response> {
  const base = engineBase();
  if (!base) return json({ ok: false, error: "engine offline" }, 503);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return timedOut ? json({ ok: false, error: "the engine did not answer in time" }, 504) : json({ ok: false, error: "engine offline" }, 503);
  }
  if (res.status === 404) return json({ ok: false, error: "this engine version has no such check; restart it to pick up the update" }, 501);
  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") return json({ ok: false, error: "the engine sent an unexpected answer" }, 502);
  return json(shape(raw));
}
