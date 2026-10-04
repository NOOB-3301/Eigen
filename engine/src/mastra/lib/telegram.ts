/** Telegram handlers extracted for reuse by the primary and specialist bots. */
import { truncate } from "lodash-es";
import type { ChatQueue } from "./chat-queue.ts";
import { restoreActionId, shortenApprovalButtons } from "./callback-ids.ts";
import type { HomePaths } from "./home.ts";
import type { Mcp } from "./tools/mcp.ts";
import type { State } from "./state.ts";

export type TelegramHandlers = ReturnType<typeof makeTelegramHandlers>;

export function makeTelegramHandlers({
  queue,
  mcp,
  paths,
  readState,
  agentId,
  slashHandler,
}: {
  queue: ChatQueue;
  mcp: Mcp;
  paths: HomePaths;
  readState: () => State;
  agentId: string;
  slashHandler: ReturnType<(typeof import("./commands.ts"))["slashHandler"]>;
}) {
  return {
    streaming: true,
    toolDisplay: (e: { kind: string; displayName: string; argsSummary: string }) =>
      e.kind === "running" && readState().verbose ? { kind: "post", message: `🔧 ${e.displayName} ${truncate(e.argsSummary, { length: 120 })}` } : undefined,
    handlers: {
      onDirectMessage: async (thread: any, message: any, run: any) => queue.push(thread.id, () => run(thread, message)),
      onAction: async (event: any, defaultHandler: any) => {
        event.actionId = restoreActionId(event.actionId);
        return defaultHandler();
      },
      onMention: false,
      onSubscribedMessage: false,
      onSlashCommand: slashHandler,
    },
  };
}
