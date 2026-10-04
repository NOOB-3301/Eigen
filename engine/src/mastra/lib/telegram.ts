/**
 * One Telegram bot = one adapter polling one token. The primary builds its bot at boot from root `telegram`; every other agent
 * that has `telegram.enabled` gets its own, built when the agent loads and stopped when it is replaced or removed.
 *
 * Telegram allows exactly one getUpdates poller per token (a second one gets 409 and the two fight), and Mastra's
 * `removeAgent` does not stop an agent's channels, so a bot is stopped here, explicitly, before a replacement is added.
 */
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { ChannelConfig, SlashCommandChannelHandler } from "@mastra/core/channels";
import { truncate } from "lodash-es";
import { restoreActionId, shortenApprovalButtons } from "./callback-ids.ts";
import type { ChatQueue } from "./chat-queue.ts";
import type { TelegramRuntime } from "./schema.ts";
import { redact } from "./secrets.ts";

/** Without this Telegram keeps whatever allowed_updates an earlier getUpdates set, and Approve/Deny taps (callback_query) never arrive. */
export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"] as const;

/** A request that has not failed this long after it was sent is a healthy long poll (Telegram answers a conflict or a bad token at once). */
const CONFIRM_MS = 800;

export type TelegramBot = {
  adapter: ReturnType<typeof createTelegramAdapter>;
  state(): TelegramRuntime;
  /** Called on every state change. Returns the unsubscribe function. */
  subscribe(fn: (t: TelegramRuntime) => void): () => void;
  /** Stops polling and disconnects; resolves once no request of this bot is in flight. Idempotent. */
  stop(): Promise<void>;
};

type Fetch = (method: string, payload?: unknown, request?: unknown) => Promise<any>;

const same = (a: TelegramRuntime, b: TelegramRuntime) => a.state === b.state && a.username === b.username && a.error === b.error && a.restartRequired === b.restartRequired;

export function createBot({ token, allowedUserIds, apiBaseUrl = process.env.TELEGRAM_API_BASE_URL }: { token: string; allowedUserIds: number[]; apiBaseUrl?: string }): TelegramBot {
  // The adapter answers anyone when the list is empty, so a bot without an allow-list is never built.
  if (allowedUserIds.length === 0) throw new Error("telegram: no allowed user ids; the bot would answer anyone");
  const adapter = shortenApprovalButtons(
    createTelegramAdapter({ botToken: token, allowedUserIds, mode: "polling", longPolling: { allowedUpdates: [...ALLOWED_UPDATES] }, ...(apiBaseUrl && { apiBaseUrl }) }),
  );

  let current: TelegramRuntime = { state: "starting" };
  let username: string | undefined;
  let stopped = false;
  let confirm: NodeJS.Timeout | undefined;
  const subs = new Set<(t: TelegramRuntime) => void>();

  const set = (next: TelegramRuntime) => {
    if (stopped || same(current, next)) return;
    current = next;
    for (const fn of subs) fn(current);
  };
  /** Never lets the token into a message: Telegram and fetch errors can quote the URL. */
  const scrub = (e: unknown) => redact(String((e as Error)?.message ?? e)).split(token).join("[redacted]").slice(0, 300);

  // The adapter reports nothing about its polling, so watch the two calls that say whether the bot works. Same technique as shortenApprovalButtons: wrap a method on this instance.
  const inner = adapter as unknown as { telegramFetch: Fetch; startPolling: (config?: unknown) => Promise<void> };
  const call = inner.telegramFetch.bind(adapter);
  inner.telegramFetch = async (method, payload, request) => {
    if (method === "getUpdates" && current.state !== "polling") {
      clearTimeout(confirm);
      confirm = setTimeout(() => set({ state: "polling", username }), CONFIRM_MS);
    }
    try {
      const result = await call(method, payload, request);
      if (method === "getMe") {
        username = (result as { username?: string } | undefined)?.username;
        if (current.state === "error") set({ state: "starting", username });
      }
      if (method === "getUpdates") {
        clearTimeout(confirm);
        set({ state: "polling", username });
      }
      return result;
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      // deleteWebhook is the first call startPolling makes: when it fails, Mastra only logs the rejected initialize() and polling never starts.
      if (!aborted && (method === "getUpdates" || method === "getMe" || method === "deleteWebhook")) {
        clearTimeout(confirm);
        set({ state: "error", username, error: scrub(e) });
      }
      throw e;
    }
  };

  // initialize() runs fire-and-forget inside Mastra.addAgent; a stop() that lands first must not be undone by a late startPolling().
  const start = inner.startPolling.bind(adapter);
  inner.startPolling = async (config) => {
    if (!stopped) await start(config);
  };

  return {
    adapter,
    state: () => current,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(confirm);
      subs.clear();
      await adapter.stopPolling().catch(() => undefined);
      await adapter.disconnect().catch(() => undefined);
    },
  };
}

/** Message handling shared by the primary and specialist bots: per-chat queue, slash commands, Approve/Deny buttons, optional tool chatter. */
export function telegramChannels(bot: Pick<TelegramBot, "adapter">, { queue, slash, verbose }: { queue: ChatQueue; slash: SlashCommandChannelHandler; verbose: () => boolean }): ChannelConfig {
  return {
    adapters: {
      telegram: {
        adapter: bot.adapter,
        streaming: true,
        // Tool chatter is hidden unless /verbose is on; approval prompts still render as Approve/Deny buttons.
        toolDisplay: (e) => (e.kind === "running" && verbose() ? { kind: "post", message: `🔧 ${e.displayName} ${truncate(e.argsSummary, { length: 120 })}` } : undefined),
      },
    },
    handlers: {
      // Hand the message to the queue and return, so the adapter keeps polling and /stop works mid-run.
      onDirectMessage: async (thread, message, run) => queue.push(thread.id, () => run(thread, message)),
      // Approve/Deny buttons carry a shortened tool-call id (Telegram's 64-byte limit); put the real one back before Mastra looks the call up.
      onAction: async (event, defaultHandler) => {
        event.actionId = restoreActionId(event.actionId);
        return defaultHandler();
      },
      onMention: false,
      onSubscribedMessage: false,
      onSlashCommand: slash,
    },
  };
}
