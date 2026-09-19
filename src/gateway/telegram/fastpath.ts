import type { Update } from "grammy/types";
import { logger } from "../../util/logger.ts";

export type FastPathHandlers = {
  onCommand(chatId: number, text: string): void;
  onText(chatId: number, text: string): void;
  onUnsupported(chatId: number): void;
};

export type FastPathAction = "ignored" | "rejected" | "duplicate" | "command" | "text" | "unsupported";

const DEDUPE_MAX = 2000;

// Runs inside the poll loop, so it must stay synchronous and fast: filter, dedupe, route.
// Anything slow happens in the handlers, which never block polling.
export function createFastPath(allowedUserIds: number[], h: FastPathHandlers): (u: Update) => FastPathAction {
  const allowed = new Set(allowedUserIds);
  const seen = new Set<number>();

  return (u) => {
    const started = performance.now();
    const action = route(u);
    logger.info({ evt: "update", id: u.update_id, action, latencyMs: Math.round((performance.now() - started) * 100) / 100 });
    return action;
  };

  function route(u: Update): FastPathAction {
    if (seen.has(u.update_id)) return "duplicate";
    seen.add(u.update_id);
    if (seen.size > DEDUPE_MAX) seen.delete(seen.values().next().value!);

    const msg = u.message; // edited_message and everything else is ignored
    if (!msg) return "ignored";
    if (msg.chat.type !== "private") return "ignored";
    if (!msg.from || !allowed.has(msg.from.id)) return "rejected"; // silent
    if (typeof msg.text !== "string") {
      h.onUnsupported(msg.chat.id);
      return "unsupported";
    }
    if (msg.text.startsWith("/")) {
      h.onCommand(msg.chat.id, msg.text);
      return "command";
    }
    h.onText(msg.chat.id, msg.text);
    return "text";
  }
}
