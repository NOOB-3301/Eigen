import { createTelegramAdapter } from "@chat-adapter/telegram";
import { agentConfig } from "@mastra/core/agent";
import { TokenLimiterProcessor } from "@mastra/core/processors";
import { truncate } from "lodash-es";
import { boot } from "../../lib/boot.ts";
import { restoreActionId, shortenApprovalButtons } from "../../lib/callback-ids.ts";
import { makeChatQueue } from "../../lib/chat-queue.ts";
import { slashHandler } from "../../lib/commands.ts";
import { getConfig, toMastraModel, tokenBudget } from "../../lib/config.ts";
import { readyPaths } from "../../lib/home.ts";
import { mergeSystemProcessor } from "../../lib/merge-system.ts";
import { orgScopeProcessor } from "../../lib/org-scope.ts";
import { makeMcp } from "../../lib/tools/mcp.ts";
import { makeScheduleTool } from "../../lib/tools/schedule.ts";
import { activeModel, readState } from "../../lib/state.ts";

const config = await boot();
const paths = readyPaths();
const mcp = makeMcp();
await mcp.load(config);
const scheduleTool = makeScheduleTool();
const queue = makeChatQueue();

const model = () => ((cfg) => cfg.models[activeModel(cfg, readState(paths))]!)(getConfig());

const telegram = shortenApprovalButtons(createTelegramAdapter({
  botToken: process.env[config.telegram.tokenEnv],
  allowedUserIds: config.telegram.allowedUserIds,
  mode: "polling",
  // Without this Telegram keeps whatever allowed_updates an earlier getUpdates set, and Approve/Deny taps (callback_query) never arrive.
  longPolling: { allowedUpdates: ["message", "edited_message", "callback_query"] },
}));

export default agentConfig({
  model: () => toMastraModel(model()),
  defaultOptions: { maxSteps: config.limits.maxSteps },
  inputProcessors: () =>
    ((m) => [orgScopeProcessor, ...(tokenBudget(m) ? [new TokenLimiterProcessor({ limit: tokenBudget(m) as number })] : []), ...(m.url ? [mergeSystemProcessor] : [])])(model()),
  tools: () => ({ ...mcp.tools(), schedule: scheduleTool }),
  channels: {
    adapters: {
      telegram: {
        adapter: telegram,
        streaming: true,
        // Tool chatter is hidden unless /verbose is on; approval prompts still render as Approve/Deny buttons.
        toolDisplay: (e) => (e.kind === "running" && readState(paths).verbose ? { kind: "post", message: `🔧 ${e.displayName} ${truncate(e.argsSummary, { length: 120 })}` } : undefined),
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
      onSlashCommand: slashHandler({ paths, mcp, queue, agentId: "eigen" }),
    },
  },
});
