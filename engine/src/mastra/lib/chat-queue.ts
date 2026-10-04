/**
 * Runs each chat's messages one at a time, without holding up the Telegram poller.
 * (A message that arrives while a run is finishing can be lost, so overlapping is not an option.)
 */
export function makeChatQueue(onError: (e: unknown) => void = (e) => console.error("chat run failed:", e)) {
  const tails = new Map<string, Promise<unknown>>();
  const epochs = new Map<string, number>();
  const epoch = (chat: string) => epochs.get(chat) ?? 0;

  return {
    push(chat: string, job: () => Promise<void>) {
      const queuedAt = epoch(chat);
      const next = (tails.get(chat) ?? Promise.resolve()).then(() => (queuedAt === epoch(chat) ? job() : undefined)).catch(onError);
      tails.set(chat, next);
    },
    /** Drops everything still waiting for this chat (the run in progress is not touched). */
    clear: (chat: string) => void epochs.set(chat, epoch(chat) + 1),
  };
}

export type ChatQueue = ReturnType<typeof makeChatQueue>;
