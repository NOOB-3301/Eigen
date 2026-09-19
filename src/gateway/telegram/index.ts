import { Api } from "grammy";
import type { TelegramConfig } from "../../config/schema.ts";
import type { Agent } from "../../core/agent.ts";
import type { Channel } from "../channel.ts";
import { logger } from "../../util/logger.ts";
import { createCommands } from "./commands.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createFastPath } from "./fastpath.ts";
import { Outbox } from "./outbox.ts";
import { Receiver } from "./receiver.ts";

const UNSUPPORTED_NOTICE_MS = 60_000;

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  // Settles when polling ends; rejects with ConflictError if another poller shows up.
  done: Promise<void> = Promise.resolve();
  #cfg: TelegramConfig;
  #agent: Agent;
  #outbox?: Outbox;
  #receiver?: Receiver;

  constructor(cfg: TelegramConfig, agent: Agent) {
    this.#cfg = cfg;
    this.#agent = agent;
  }

  async start(): Promise<void> {
    const token = process.env[this.#cfg.tokenEnv];
    if (!token) throw new Error(`Telegram bot token missing: set ${this.#cfg.tokenEnv} in ~/.eigen/.env`);
    const api = new Api(token);
    const me = await api.getMe(); // verifies the token
    // Long polling fails while a webhook is set; keep pending updates.
    await api.deleteWebhook({ drop_pending_updates: false });
    logger.info({ evt: "telegram_ready", bot: me.username, allowedUsers: this.#cfg.allowedUserIds.length });

    const outbox = new Outbox(api, this.#cfg);
    const dispatcher = createDispatcher(this.#agent, outbox);
    const commands = createCommands(this.#agent, outbox);
    const lastNotice = new Map<number, number>();
    const fastPath = createFastPath(this.#cfg.allowedUserIds, {
      onCommand: commands,
      onText: dispatcher.onText,
      onUnsupported: (chatId) => {
        const now = Date.now();
        if (now - (lastNotice.get(chatId) ?? 0) < UNSUPPORTED_NOTICE_MS) return;
        lastNotice.set(chatId, now);
        outbox.send(chatId, "Only text messages are supported for now.");
      },
    });
    this.#outbox = outbox;
    // grammY types its signal param with a polyfill AbortSignal; the runtime object is native.
    const pollApi = { getUpdates: (o: Parameters<Api["getUpdates"]>[0], signal?: AbortSignal) => api.getUpdates(o, signal as never) };
    this.#receiver = new Receiver(pollApi, fastPath, this.#cfg.pollTimeoutSec);
    this.done = this.#receiver.run();
  }

  async stop(): Promise<void> {
    await this.#receiver?.stop();
    await this.#outbox?.flush(2000);
    this.#outbox?.stop();
  }
}
