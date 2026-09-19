import type { Update } from "grammy/types";
import { isAbortError } from "../../util/abort.ts";
import { backoffDelay, sleep } from "../../util/backoff.ts";
import { logger } from "../../util/logger.ts";

export type PollApi = {
  getUpdates(other: { offset?: number; timeout?: number; limit?: number; allowed_updates?: ReadonlyArray<"message"> }, signal?: AbortSignal): Promise<Update[]>;
};

export class ConflictError extends Error {
  override name = "ConflictError";
}

let activeReceiver: Receiver | undefined;

// Our own long-poll loop (instead of bot.start) so we control offsets, abort the pending
// poll on shutdown, log every poll error/retry, and treat 409 as fatal.
export class Receiver {
  #api: PollApi;
  #onUpdate: (u: Update) => void;
  #timeoutSec: number;
  #offset = 0; // in-memory only: reset on every start
  #running = false;
  #controller?: AbortController;

  constructor(api: PollApi, onUpdate: (u: Update) => void, timeoutSec: number) {
    this.#api = api;
    this.#onUpdate = onUpdate;
    this.#timeoutSec = timeoutSec;
  }

  async run(): Promise<void> {
    if (activeReceiver) throw new Error("a Telegram poller is already running in this process");
    activeReceiver = this;
    this.#running = true;
    let failures = 0;
    try {
      while (this.#running) {
        this.#controller = new AbortController();
        let updates: Update[];
        try {
          updates = await this.#api.getUpdates({ offset: this.#offset, timeout: this.#timeoutSec, allowed_updates: ["message"] }, this.#controller.signal);
          failures = 0;
        } catch (e) {
          if (!this.#running || isAbortError(e)) break;
          const err = e as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
          if (err.error_code === 409) throw new ConflictError(`Telegram 409 Conflict: another process is polling this bot token (${err.description ?? ""})`);
          if (err.error_code === 401) throw new Error("Telegram rejected the bot token (401)");
          const delay = err.error_code === 429 && err.parameters?.retry_after ? err.parameters.retry_after * 1000 : backoffDelay(failures++, 1000);
          logger.warn({ evt: "poll_error", code: err.error_code, err: err.description ?? String(e), retryInMs: delay });
          await sleep(delay).catch(() => {});
          continue;
        }
        for (const u of updates) {
          this.#offset = u.update_id + 1;
          try {
            this.#onUpdate(u);
          } catch (e) {
            logger.error({ evt: "update_handler_error", id: u.update_id, err: e });
          }
        }
      }
    } finally {
      this.#running = false;
      if (activeReceiver === this) activeReceiver = undefined;
    }
  }

  // Aborts the in-flight getUpdates, then acknowledges what we've already handled so a
  // restart doesn't replay it.
  async stop(): Promise<void> {
    this.#running = false;
    this.#controller?.abort();
    if (this.#offset === 0) return;
    try {
      await this.#api.getUpdates({ offset: this.#offset, timeout: 0, limit: 1 }, AbortSignal.timeout(3000));
    } catch {}
  }
}
