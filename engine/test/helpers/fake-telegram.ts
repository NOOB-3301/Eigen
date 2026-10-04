import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Call = { method: string; body: Record<string, any>; token: string };

/** The token the harness gives the primary bot; every helper defaults to it. */
export const PRIMARY_TOKEN = "123:abc";

const botFor = (token: string) => ({
  id: Number(token.split(":")[0]) || 4242,
  is_bot: true,
  first_name: "eigen",
  username: token === PRIMARY_TOKEN ? "eigen_test_bot" : `bot_${token.replace(/\W/g, "_")}`,
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
});

type Poll = { res: ServerResponse; ended: boolean };
const CONFLICT = "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running";

/**
 * A minimal Telegram Bot API for several bots at once (the token is in the URL path). Long-polls getUpdates per token, records every call,
 * answers sends with message objects, and behaves like Telegram when two pollers share a token: the newer getUpdates terminates the one in
 * flight, which gets a 409.
 */
export async function fakeTelegram() {
  const calls: Call[] = [];
  const queues = new Map<string, Array<Record<string, unknown>>>();
  const inflight = new Map<string, Poll[]>();
  const maxInflight = new Map<string, number>();
  const conflicts = new Map<string, number>();
  const rejected = new Map<string, { status: number; description: string }>();
  let nextId = 1000;
  let nextMessage = 1;

  const queue = (token: string) => queues.get(token) ?? queues.set(token, []).get(token)!;
  const textOf = (b: Record<string, any>) => String(b.text ?? b.rich_message?.markdown ?? "");
  const message = (token: string, chatId: number, text = "") => ({ message_id: nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private", first_name: "u" }, from: botFor(token), text });

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const [, token = PRIMARY_TOKEN, method = "unknown"] = /\/bot([^/]+)\/(\w+)/.exec(req.url ?? "") ?? [];
      let body: Record<string, any> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      calls.push({ method, body, token });
      const send = (r: ServerResponse, payload: Record<string, unknown>, status = 200) => {
        if (r.writableEnded) return;
        r.statusCode = status;
        r.setHeader("content-type", "application/json");
        r.end(JSON.stringify(payload));
      };
      const reply = (result: unknown) => send(res, { ok: true, result });
      const bad = rejected.get(token);
      if (bad) return send(res, { ok: false, error_code: bad.status, description: bad.description }, bad.status);

      if (method === "getMe") return reply(botFor(token));
      if (method === "getWebhookInfo") return reply({ url: "", has_custom_certificate: false, pending_update_count: 0 });
      if (method === "getUpdates") {
        const mine: Poll = { res, ended: false };
        const others = inflight.get(token) ?? [];
        // Telegram lets one getUpdates per bot live: a newer request terminates the older one with a 409.
        for (const old of others) {
          conflicts.set(token, (conflicts.get(token) ?? 0) + 1);
          old.ended = true;
          send(old.res, { ok: false, error_code: 409, description: CONFLICT }, 409);
        }
        inflight.set(token, [mine]);
        maxInflight.set(token, Math.max(maxInflight.get(token) ?? 0, others.length + 1));
        // The client gave up (stopPolling aborts the request): the socket closes before we answered. (`req` "close" fires after the body is read, so it is `res` that tells.)
        res.on("close", () => {
          if (!res.writableEnded) mine.ended = true;
          inflight.set(token, (inflight.get(token) ?? []).filter((p) => p !== mine));
        });
        const deadline = Date.now() + Math.min(Number(body.timeout ?? 1), 2) * 1000;
        while (!queue(token).length && Date.now() < deadline && !mine.ended) await new Promise((r) => setTimeout(r, 50));
        if (mine.ended) return;
        inflight.set(token, (inflight.get(token) ?? []).filter((p) => p !== mine));
        return reply(queue(token).splice(0));
      }
      if (method === "sendMessage" || method === "editMessageText") return reply(message(token, Number(body.chat_id), textOf(body)));
      return reply(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    calls,
    /** Queue an incoming private text message from `from` for the bot with `token`. */
    say(text: string, from = 7, chat = from, type = "private", token = PRIMARY_TOKEN) {
      const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : undefined;
      queue(token).push({
        update_id: nextId++,
        message: { message_id: nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: chat, type, first_name: "u" }, from: { id: from, is_bot: false, first_name: "u" }, text, ...(entities && { entities }) },
      });
    },
    /** Click an inline button on a message the bot with `token` sent. */
    press(data: string, from = 7, chat = from, token = PRIMARY_TOKEN) {
      queue(token).push({ update_id: nextId++, callback_query: { id: String(nextId), from: { id: from, is_bot: false, first_name: "u" }, chat_instance: "1", data, message: message(token, chat, "card") } });
    },
    /** Texts the bots sent: every bot's, or only the one with `token`. */
    sent: (token?: string) => calls.filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && (!token || c.token === token)).map((c) => textOf(c.body)),
    callsFor: (token: string, method?: string) => calls.filter((c) => c.token === token && (!method || c.method === method)),
    /** getUpdates requests being held open for this token right now. */
    pollers: (token = PRIMARY_TOKEN) => (inflight.get(token) ?? []).length,
    /** The most getUpdates requests ever open at once for this token (more than 1 = two pollers on one bot). */
    maxPollers: (token = PRIMARY_TOKEN) => maxInflight.get(token) ?? 0,
    /** How many 409s Telegram has answered for this token. */
    conflicts: (token = PRIMARY_TOKEN) => conflicts.get(token) ?? 0,
    /** Answer every call for this token with an HTTP error (e.g. 401 for a revoked bot). */
    reject: (token: string, status: number, description: string) => void rejected.set(token, { status, description }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
