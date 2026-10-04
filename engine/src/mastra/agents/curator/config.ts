import { agentConfig } from "@mastra/core/agent";
import { getConfig, toMastraModel } from "../../lib/config.ts";

const config = getConfig();

export default agentConfig({
  model: () => toMastraModel(config.models[config.curatorModel ?? config.defaultModel]!),
  workspace: undefined,
});
