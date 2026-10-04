import { eigenHome, readyHome } from "../src/mastra/lib/home.ts";

/** Creates the home folders (and, once, backs up a home from before standalone agents). Agents are created in the studio, never here. */
const paths = readyHome(eigenHome());

console.log(`Eigen home: ${paths.home}
  agents:  ${paths.agentsDir}/<id>/   one folder per agent (config.json, instructions.md, its own .env)
  engine:  ${paths.engineDir}/        the engine's own database and logs`);
console.log(`\nNext: npm run dev (from the repo root), then open the studio at http://localhost:4100 and create your first agent.`);
