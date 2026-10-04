import { agentConfig } from "@mastra/core/agent";
import { TokenLimiterProcessor } from "@mastra/core/processors";
import { delegationContext, toolsFromServers } from "../../lib/agents.ts";
import { boot } from "../../lib/boot.ts";
import { makeChatQueue } from "../../lib/chat-queue.ts";
import { slashHandler } from "../../lib/commands.ts";
import { getConfig, toMastraModel, tokenBudget } from "../../lib/config.ts";
import { mcp, paths, PRIMARY_ID, registry } from "../../lib/fleet.ts";
import { liveMemory } from "../../lib/memory.ts";
import { mergeSystemProcessor } from "../../lib/merge-system.ts";
import { orgScopeProcessor } from "../../lib/org-scope.ts";
import { createBot, telegramChannels } from "../../lib/telegram.ts";
import { makeScheduleTool } from "../../lib/tools/schedule.ts";
import { activeModel, readState } from "../../lib/state.ts";

const config = await boot();
await mcp.load(config);
const scheduleTool = makeScheduleTool();
const queue = makeChatQueue();

/** The primary's settings from .agents/eigen/config.json; until that loads (or if it never does), the root config alone. */
const self = () => registry.resolved(PRIMARY_ID);
const baseModel = () => self()?.modelKey;
const model = () => ((cfg) => cfg.models[activeModel(cfg, readState(paths), baseModel())]!)(getConfig());

// The primary's bot is the root bot, built once at boot (changes to it apply on restart; the registry reports that as `restartRequired`).
const bot = createBot({ token: process.env[config.telegram.tokenEnv]!, allowedUserIds: config.telegram.allowedUserIds });
registry.trackBot(PRIMARY_ID, bot, { tokenEnv: config.telegram.tokenEnv, allowedUserIds: config.telegram.allowedUserIds });

export default agentConfig({
  model: () => toMastraModel(model()),
  // Root memory settings with the primary's own overrides (lastMessages, semanticRecall, observational) on top. Rebuilt when one of them changes, so no restart.
  memory: liveMemory(paths, () => ({ ...getConfig(), memory: self()?.memory ?? getConfig().memory })),
  defaultOptions: () => ({ maxSteps: self()?.maxSteps ?? getConfig().limits.maxSteps, delegation: delegationContext(registry.resolved) }),
  inputProcessors: () =>
    ((m) => [orgScopeProcessor, ...(tokenBudget(m) ? [new TokenLimiterProcessor({ limit: tokenBudget(m) as number })] : []), ...(m.url ? [mergeSystemProcessor] : [])])(model()),
  tools: () => {
    const r = self();
    return { ...(r ? toolsFromServers(mcp.tools(), r.mcp.inherited, mcp.state().servers) : mcp.tools()), ...((r?.builtinTools.includes("schedule") ?? true) && { schedule: scheduleTool }) };
  },
  // Specialists that accept work from the primary. Attaching here is the fallback for when server.ts did not run first.
  agents: async ({ mastra }) => {
    if (mastra) await registry.attach(mastra);
    return registry.subAgents(PRIMARY_ID);
  },
  channels: telegramChannels(bot, {
    queue,
    verbose: () => !!readState(paths).verbose,
    slash: slashHandler({ paths, mcp, queue, agentId: PRIMARY_ID, baseModel, rescan: () => registry.reload() }),
  }),
});
