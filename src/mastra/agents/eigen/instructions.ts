import { agentInstructions } from "@mastra/core/agent";
import { getConfig } from "../../lib/config.ts";
import { homePaths } from "../../lib/home.ts";
import { buildInstructions } from "../../lib/instructions.ts";

export default agentInstructions(() => buildInstructions(homePaths(), getConfig().timezone));
