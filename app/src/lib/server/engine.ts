import { z } from "zod";
import type { ListAgentsResponse } from "@eigen/engine/schema";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The engine base URL, or null when it is not a loopback http URL (we never talk to remote hosts). */
export function engineBase(): string | null {
  const raw = process.env.EIGEN_ENGINE_URL ?? "http://127.0.0.1:4111";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) {
      console.warn(`[eigen] ignoring EIGEN_ENGINE_URL=${raw}: only http loopback hosts are allowed`);
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

/** Loose shape check of the engine snapshot; the types are shared, this only guards against a wrong server on the port. */
const Snapshot = z.object({
  agents: z.array(z.object({ id: z.string(), runtime: z.object({ status: z.string(), problems: z.array(z.string()) }).loose() }).loose()),
  fleetProblems: z.array(z.string()),
  topology: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }),
  rev: z.string(),
});

export async function engineSnapshot(timeoutMs = 1200): Promise<ListAgentsResponse | null> {
  const base = engineBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/eigen/agents`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return Snapshot.safeParse(body).success ? (body as ListAgentsResponse) : null;
  } catch {
    return null;
  }
}

/** Opens the engine's SSE stream; null when the engine is down or answers with something that is not SSE. */
export async function engineEvents(signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
  const base = engineBase();
  if (!base) return null;
  const ctl = new AbortController();
  const onClientAbort = () => ctl.abort();
  signal.addEventListener("abort", onClientAbort, { once: true });
  // Only the connect phase is time-limited; once headers arrive, the stream lives until the client leaves.
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${base}/eigen/agents/events`, { cache: "no-store", signal: ctl.signal, headers: { accept: "text/event-stream" } });
    clearTimeout(timer);
    if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
      ctl.abort();
      return null;
    }
    return res.body;
  } catch {
    clearTimeout(timer);
    signal.removeEventListener("abort", onClientAbort);
    return null;
  }
}
