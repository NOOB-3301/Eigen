import { join } from "node:path";
import { agentInstructions } from "@mastra/core/agent";
import { getConfig } from "../../lib/config.ts";
import { paths, PRIMARY_ID, registry } from "../../lib/fleet.ts";
import { buildInstructions, readText, type PrimaryPrompt } from "../../lib/instructions.ts";
import { soulText } from "../../lib/soul.ts";

/** The primary's settings; with no loaded .agents/eigen it is the classic prompt (prompts/system.md + shared soul + memory). */
const prompt = (): PrimaryPrompt => {
  const r = registry.resolved(PRIMARY_ID);
  if (!r) return {};
  const dir = join(paths.agentsDir, PRIMARY_ID);
  return { text: r.instructions.inline ?? readText(join(dir, r.instructions.file)), soul: soulText(r.soul, paths, dir), memory: r.instructions.includeMemoryFiles };
};

export default agentInstructions(() => buildInstructions(paths, getConfig().timezone, undefined, prompt()));
