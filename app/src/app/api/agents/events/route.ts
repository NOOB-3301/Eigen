import type { AgentEvent } from "@eigen/engine/schema";
import { engineBase, engineEvents } from "@/lib/server/engine";
import { offlineSnapshot } from "@/lib/server/fleet";
import { rootConfig } from "@/lib/server/home";
import { onFleetChange } from "@/lib/server/watch";
import { guard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const enc = new TextEncoder();
const HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };

/** Out-of-band event (named, so it never collides with the engine's AgentEvent messages) telling the UI who is talking. */
const mode = (engine: "online" | "offline") => enc.encode(`retry: 1500\nevent: eigen.mode\ndata: ${JSON.stringify({ engine })}\n\n`);
const message = (e: AgentEvent) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);

/**
 * Proxies the engine's AgentEvent stream. When the engine is down, falls back to watching the agent files and emits
 * `fleet.changed` so the studio still live-updates; it keeps probing and closes once the engine is back, so the
 * browser's EventSource reconnects straight onto the proxied stream.
 */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const upstream = await engineEvents(req.signal);
  if (upstream) {
    const reader = upstream.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(mode("online"));
      },
      async pull(c) {
        try {
          const { value, done } = await reader.read();
          if (done) c.close();
          else c.enqueue(value);
        } catch {
          c.close();
        }
      },
      cancel() {
        void reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, { headers: HEADERS });
  }

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      let closed = false;
      const send = (chunk: Uint8Array) => {
        if (!closed) c.enqueue(chunk);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          c.close();
        } catch {
          /* already closed */
        }
      };
      send(mode("offline"));
      const off = onFleetChange(() => {
        let rev = String(Date.now());
        try {
          rev = offlineSnapshot(rootConfig()).rev;
        } catch {
          /* root config unreadable: still tell the UI something changed */
        }
        send(message({ type: "fleet.changed", rev }));
      });
      const heartbeat = setInterval(() => send(enc.encode(`: ping\n\n`)), 15_000);
      const base = engineBase();
      const probe = setInterval(async () => {
        if (!base) return;
        try {
          const r = await fetch(`${base}/eigen/agents`, { cache: "no-store", signal: AbortSignal.timeout(800) });
          if (r.ok) close(); // engine is back: let EventSource reconnect to the proxy
        } catch {
          /* still down */
        }
      }, 5_000);
      cleanup = () => {
        off();
        clearInterval(heartbeat);
        clearInterval(probe);
      };
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: HEADERS });
}
