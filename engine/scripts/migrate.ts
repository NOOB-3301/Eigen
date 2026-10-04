import { eigenHome, readyPaths, seedAgents } from "../src/mastra/lib/home.ts";

/** Multi-agent layout: adds .agents/eigen/config.json for an existing single-agent home. Idempotent; never moves or deletes anything. */
const paths = readyPaths(eigenHome());
const created = seedAgents(paths);

console.log(
  created.length
    ? `Migrated ${paths.home}: created ${created.join(", ")}.\nThe primary agent "eigen" keeps prompts/system.md, SOUL.md, memory/, data/, sandbox/ and skills/ exactly where they are.`
    : `${paths.agentsDir} already has agents; nothing to do.`,
);
