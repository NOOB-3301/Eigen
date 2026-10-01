import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Call = { method: string; body: Record<string, any> };

const BOT = { id: 4242, is_bot: true, first_name: "eigen", username: "eigen_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

/** A minimal Telegram Bot API: long-poll getUpdates, records every call, answers sends with message objects. */
export async function fakeTelegram() {
  const calls: Call[] = [];
  const queue: Array<Record<string, unknown>> = [];
  let nextId = 1000;
  let nextMessage = 1;

  const textOf = (b: Record<string, any>) => String(b.text ?? b.rich_message?.markdown ?? "");
  const message = (chatId: number, text = "") => ({ message_id: nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private", first_name: "u" }, from: BOT, text });

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const method = /\/bot[^/]+\/(\w+)/.exec(req.url ?? "")?.[1] ?? "unknown";
      let body: Record<string, any> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      calls.push({ method, body });
      const reply = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === "getMe") return reply(BOT);
      if (method === "getWebhookInfo") return reply({ url: "", has_custom_certificate: false, pending_update_count: 0 });
      if (method === "getUpdates") {
        const deadline = Date.now() + Math.min(Number(body.timeout ?? 1), 2) * 1000;
        while (!queue.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        return reply(queue.splice(0));
      }
      if (method === "sendMessage" || method === "editMessageText") return reply(message(Number(body.chat_id), textOf(body)));
      return reply(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    calls,
    /** Queue an incoming private text message from `from`. */
    say(text: string, from = 7, chat = from, type = "private") {
      const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : undefined;
      queue.push({
        update_id: nextId++,
        message: { message_id: nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: chat, type, first_name: "u" }, from: { id: from, is_bot: false, first_name: "u" }, text, ...(entities && { entities }) },
      });
    },
    /** Click an inline button on a message the bot sent. */
    press(data: string, from = 7, chat = from) {
      queue.push({ update_id: nextId++, callback_query: { id: String(nextId), from: { id: from, is_bot: false, first_name: "u" }, chat_instance: "1", data, message: message(chat, "card") } });
    },
    sent: () => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => textOf(c.body)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
