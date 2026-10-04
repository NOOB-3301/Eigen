import type { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { registry } from "./lib/fleet.ts";
import type { AgentEvent } from "./lib/schema.ts";

const KEEPALIVE_MS = 25_000;

/** Read only by the web app's Next server (server-side), so no browser origin is ever allowed. */
const cors = { origin: () => null };

/** Route setup runs while Mastra builds the HTTP server at boot: the earliest point with a Mastra handle, so specialists load before the first message. */
const withRegistry =
  <T,>(handler: T) =>
  async ({ mastra }: { mastra: Mastra }) => {
    await registry.attach(mastra);
    return handler;
  };

function events(signal: AbortSignal) {
  const enc = new TextEncoder();
  let stop = () => undefined as void;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      const send = (s: string) => {
        try {
          ctl.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      // Unnamed events, so a plain EventSource `onmessage` sees them; the JSON carries `type`.
      const onEvent = (e: AgentEvent) => send(`data: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => send(": keep-alive\n\n"), KEEPALIVE_MS);
      stop = () => {
        clearInterval(ping);
        registry.events.off("event", onEvent);
        signal.removeEventListener("abort", stop);
        try {
          ctl.close();
        } catch {}
      };
      registry.events.on("event", onEvent);
      signal.addEventListener("abort", stop);
      send(`retry: 3000\n: connected\n\n`);
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export default {
  host: "127.0.0.1",
  port: Number(process.env.EIGEN_PORT ?? 4111),
  apiRoutes: [
    registerApiRoute("/eigen/agents", { method: "GET", cors, createHandler: withRegistry(async () => Response.json(registry.snapshot())) }),
    registerApiRoute("/eigen/agents/events", { method: "GET", cors, createHandler: withRegistry(async (c: { req: { raw: Request } }) => events(c.req.raw.signal)) }),
    registerApiRoute("/eigen/agents/:id", {
      method: "GET",
      cors,
      createHandler: withRegistry(async (c: { req: { param: (k: string) => string } }) => {
        const d = registry.detail(c.req.param("id"));
        return d ? Response.json(d) : Response.json({ error: "no such agent" }, { status: 404 });
      }),
    }),
  ],
};
