import { createTelegramAdapter } from "@chat-adapter/telegram";
import { agentConfig } from "@mastra/core/agent";
import { boot } from "../../lib/boot.ts";
import { toMastraModel } from "../../lib/config.ts";

const config = await boot();

const telegram = createTelegramAdapter({
  botToken: process.env[config.telegram.tokenEnv],
  allowedUserIds: config.telegram.allowedUserIds,
  mode: "polling",
});

export default agentConfig({
  model: () => toMastraModel(config.models[config.defaultModel]!),
  defaultOptions: { maxSteps: config.limits.maxSteps },
  channels: {
    // toolDisplay returning undefined hides tool chatter; approval prompts still render as Approve/Deny buttons.
    adapters: { telegram: { adapter: telegram, streaming: true, toolDisplay: () => undefined } },
    handlers: { onMention: false, onSubscribedMessage: false },
  },
});
