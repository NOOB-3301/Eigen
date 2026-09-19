import type { TelegramConfig } from "../../config/schema.ts";
import { backoffDelay, sleep } from "../../util/backoff.ts";
import { logger } from "../../util/logger.ts";
import { splitMessage, toTelegramHtml } from "./format.ts";

// The subset of the Bot API the outbox uses; grammY's Api satisfies it.
export type OutboxApi = {
  sendMessage(chatId: number, text: string, other?: { parse_mode?: "HTML" }): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
};

type ApiErr = { error_code?: number; description?: string; parameters?: { retry_after?: number } };

const MAX_ATTEMPTS = 5;

// The only code that talks to Telegram's send endpoints: FIFO queue, global rate limit,
// chunking, HTML with plain-text fallback, retries, and typing indicators.
export class Outbox {
  #api: OutboxApi;
  #cfg: Pick<TelegramConfig, "chunkSize" | "sendRatePerSec" | "typingRefreshMs">;
  #queue: Array<{ chatId: number; text: string }> = [];
  #draining = false;
  #lastSend = 0;
  #idle: Array<() => void> = [];
  #typing = new Map<number, ReturnType<typeof setInterval>>();

  constructor(api: OutboxApi, cfg: Pick<TelegramConfig, "chunkSize" | "sendRatePerSec" | "typingRefreshMs">) {
    this.#api = api;
    this.#cfg = cfg;
  }

  send(chatId: number, text: string): void {
    for (const chunk of splitMessage(text, this.#cfg.chunkSize)) this.#queue.push({ chatId, text: chunk });
    void this.#drain();
  }

  pending(): number {
    return this.#queue.length + (this.#draining ? 1 : 0);
  }

  startTyping(chatId: number): void {
    if (this.#typing.has(chatId)) return;
    const tick = () => void this.#api.sendChatAction(chatId, "typing").catch((e) => logger.debug({ evt: "typing_error", chat: chatId, err: String(e) }));
    tick();
    this.#typing.set(chatId, setInterval(tick, this.#cfg.typingRefreshMs));
  }

  stopTyping(chatId: number): void {
    clearInterval(this.#typing.get(chatId));
    this.#typing.delete(chatId);
  }

  // Resolves when the queue is empty or the timeout passes, whichever is first.
  flush(timeoutMs: number): Promise<void> {
    if (!this.#draining && !this.#queue.length) return Promise.resolve();
    return Promise.race([new Promise<void>((r) => this.#idle.push(r)), sleep(timeoutMs)]);
  }

  stop(): void {
    for (const id of [...this.#typing.keys()]) this.stopTyping(id);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length) {
        const item = this.#queue.shift()!;
        const wait = this.#lastSend + 1000 / this.#cfg.sendRatePerSec - Date.now();
        if (wait > 0) await sleep(wait);
        await this.#deliver(item.chatId, item.text);
        this.#lastSend = Date.now();
      }
    } finally {
      this.#draining = false;
      for (const r of this.#idle.splice(0)) r();
    }
  }

  async #deliver(chatId: number, text: string): Promise<void> {
    let html = true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (html) await this.#api.sendMessage(chatId, toTelegramHtml(text), { parse_mode: "HTML" });
        else await this.#api.sendMessage(chatId, text);
        logger.info({ evt: "send", chat: chatId, length: text.length, attempts: attempt, html });
        return;
      } catch (e) {
        const err = e as ApiErr;
        const code = err.error_code;
        if (code === 400 && html && /parse|entit|tag/i.test(err.description ?? "")) {
          html = false; // our formatting was rejected; the text itself is fine
          attempt--;
          continue;
        }
        const retryable = code === undefined || code === 429 || code >= 500;
        logger.warn({ evt: "send_error", chat: chatId, attempt, code, err: err.description ?? String(e), retryable });
        if (!retryable) break;
        if (attempt < MAX_ATTEMPTS) await sleep(code === 429 && err.parameters?.retry_after ? err.parameters.retry_after * 1000 : backoffDelay(attempt - 1, 1000));
      }
    }
    logger.error({ evt: "send_failed", chat: chatId, length: text.length });
  }
}
