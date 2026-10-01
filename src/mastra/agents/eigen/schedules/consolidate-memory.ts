import { defineSchedule } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { getConfig } from "../../../lib/config.ts";
import { runConsolidation } from "../../../lib/consolidate.ts";

const { timezone, memory } = getConfig();

export default defineSchedule({
  cron: memory.consolidationCron,
  timezone,
  name: "memory consolidation",
  handler: async ({ mastra }) => {
    await runConsolidation(mastra as Mastra);
    return null; // the work is done here; no agent run
  },
});
