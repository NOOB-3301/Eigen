import type { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { loadConfig } from "./lib/config.ts";
import { paths, registry } from "./lib/fleet.ts";
import { denyEngineRequest } from "./lib/guard.ts";
import { checkGithubToken } from "./lib/github.ts";
import { checkTelegramToken, githubEnvAllowed, telegramEnvAllowed, testModel } from "./lib/probes.ts";
import { GithubCheckRequest, TelegramCheckRequest, type AgentEvent, type GithubCheckResponse, type ListTriggerRunsResponse, type ModelTestResponse, type RunTriggerResponse, type TelegramCheckResponse } from "./lib/schema.ts";

const KEEPALIVE_MS = 25_000;
const PORT = Number(process.env.EIGEN_PORT ?? 4111);
const MAX_BODY = 4096;

/** Read only by the web app's Next server (server-side), so no browser origin is ever allowed. */
const cors = { origin: () => null };

type Ctx = { req: { raw: Request; param: (k: string) => string } };

/**
 * Route setup runs while Mastra builds the HTTP server at boot: the earliest point with a Mastra handle, so specialists load before the first message.
 * Every /eigen route also passes the loopback Host check (DNS rebinding) and, for POST, the JSON-only / no-Origin check (lib/guard.ts).
 */
const route =
  (handler: (c: Ctx) => Promise<Response> | Response) =>
  async ({ mastra }: { mastra: Mastra }) => {
    await registry.attach(mastra);
    return async (c: Ctx) => denyEngineRequest(c.req.raw, PORT) ?? handler(c);
  };

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
  port: PORT,
  apiRoutes: [
    registerApiRoute("/eigen/agents", { method: "GET", cors, createHandler: route(async () => Response.json(registry.snapshot())) }),
    registerApiRoute("/eigen/agents/events", { method: "GET", cors, createHandler: route(async (c) => events(c.req.raw.signal)) }),
    registerApiRoute("/eigen/agents/:id", {
      method: "GET",
      cors,
      createHandler: route(async (c) => {
        const d = registry.detail(c.req.param("id"));
        return d ? Response.json(d) : Response.json({ error: "no such agent" }, { status: 404 });
      }),
    }),
    // Is the bot token stored under this .env name accepted by Telegram? Only Telegram token variables may be named, so this cannot be used to send another secret anywhere.
    registerApiRoute("/eigen/telegram/check", {
      method: "POST",
      cors,
      createHandler: route(async (c) => {
        const body = TelegramCheckRequest.safeParse(await readJson(c.req.raw));
        if (!body.success) return Response.json({ ok: false, error: "tokenEnv must be an upper-case variable name such as TELEGRAM_BOT_TOKEN" } satisfies TelegramCheckResponse, { status: 400 });
        const { tokenEnv } = body.data;
        if (!telegramEnvAllowed(tokenEnv, registry.telegramEnvNames()))
          return Response.json({ ok: false, error: `${tokenEnv} is not a Telegram token variable (its name must start with TELEGRAM_, or an agent must name it as its bot token)` } satisfies TelegramCheckResponse, { status: 400 });
        registry.syncEnvNow();
        return Response.json(await checkTelegramToken(process.env[tokenEnv], process.env.TELEGRAM_API_BASE_URL));
      }),
    }),
    // [triggers worker] Run history of an agent's triggers, newest first (at most 200).
    registerApiRoute("/eigen/agents/:id/triggers/runs", {
      method: "GET",
      cors,
      createHandler: route(async (c) => {
        const limit = Math.min(Math.max(Number(new URL(c.req.raw.url).searchParams.get("limit")) || 50, 1), 200);
        const runs = registry.triggerRuns(c.req.param("id"), limit);
        return runs ? Response.json({ runs } satisfies ListTriggerRunsResponse) : Response.json({ error: "no such agent" }, { status: 404 });
      }),
    }),
    // Fires a trigger now; answers when the run is over (up to 5 minutes).
    registerApiRoute("/eigen/agents/:id/triggers/:triggerId/run", {
      method: "POST",
      cors,
      createHandler: route(async (c) => {
        const run = registry.runTrigger(c.req.param("id"), c.req.param("triggerId"));
        return run ? Response.json((await run) satisfies RunTriggerResponse) : Response.json({ ok: false, error: "no such agent or trigger" } satisfies RunTriggerResponse, { status: 404 });
      }),
    }),
    // Can the token in this .env variable read this repo's pull requests? Only GITHUB_* variables and the ones a github-pr trigger names may be read, and the request only ever goes to GitHub.
    registerApiRoute("/eigen/github/check", {
      method: "POST",
      cors,
      createHandler: route(async (c) => {
        const body = GithubCheckRequest.safeParse(await readJson(c.req.raw));
        if (!body.success) return Response.json({ ok: false, error: "tokenEnv must be an upper-case variable name such as GITHUB_TOKEN, and repo must look like owner/name" } satisfies GithubCheckResponse, { status: 400 });
        const { tokenEnv, repo } = body.data;
        if (!githubEnvAllowed(tokenEnv, registry.githubEnvNames()))
          return Response.json({ ok: false, error: `${tokenEnv} is not a GitHub token variable (its name must start with GITHUB_, or a github-pr trigger must name it as its token)` } satisfies GithubCheckResponse, { status: 400 });
        registry.syncEnvNow();
        return Response.json(await checkGithubToken(process.env[tokenEnv], repo));
      }),
    }),
    // [chat worker] Studio chat (lib/chat.ts): POST streams the agent's reply as an AI SDK UI-message stream, GET returns a session's earlier messages.
    registerApiRoute("/eigen/chat/:id", {
      method: "POST",
      cors,
      createHandler: async (o) => {
        const chat = await import("./lib/chat.ts").then((m) => m.studioChat());
        return route((c) => chat.stream(o.mastra, c.req.raw, c.req.param("id")))(o);
      },
    }),
    registerApiRoute("/eigen/chat/:id/:session", {
      method: "GET",
      cors,
      createHandler: async (o) => {
        const chat = await import("./lib/chat.ts").then((m) => m.studioChat());
        return route((c) => chat.history(o.mastra, c.req.param("id"), c.req.param("session")))(o);
      },
    }),
    // One tiny prompt to a model in config.json.
    registerApiRoute("/eigen/models/:key/test", {
      method: "POST",
      cors,
      createHandler: route(async (c) => {
        registry.syncEnvNow();
        const root = loadConfig(paths.configFile); // not the cached copy: a model added a moment ago in the studio is testable at once
        const key = c.req.param("key");
        if (!(key in root.models)) return Response.json({ ok: false, ms: 0, error: `no model "${key}" in config.json` } satisfies ModelTestResponse, { status: 404 });
        return Response.json(await testModel(key, root));
      }),
    }),
  ],
};
