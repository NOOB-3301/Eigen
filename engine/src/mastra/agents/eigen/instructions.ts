import { join } from "node:path";
import { agentInstructions } from "@mastra/core/agent";
import { getConfig } from "../../lib/config.ts";
import { paths, PRIMARY_ID, registry } from "../../lib/fleet.ts";
import { buildInstructions, readText, type PrimaryPrompt } from "../../lib/instructions.ts";

/** The primary's `instructions` settings; with no loaded .agents/eigen it is the classic prompt (prompts/system.md + soul + memory). */
const prompt = (): PrimaryPrompt => {
  const i = registry.resolved(PRIMARY_ID)?.instructions;
  return i ? { text: i.inline ?? readText(join(paths.agentsDir, PRIMARY_ID, i.file)), soul: i.includeSoul, memory: i.includeMemoryFiles } : {};
};

export default agentInstructions(() => buildInstructions(paths, getConfig().timezone, undefined, prompt()));
