import { resolve } from "node:path";
import { eigenHome, homePaths, seedHome } from "../src/mastra/lib/home.ts";

const paths = homePaths(eigenHome());
const created = seedHome(paths, resolve(import.meta.dirname, "../defaults"));

console.log(created.length ? `Created in ${paths.home}:\n  ${created.join("\n  ")}` : `${paths.home} is already set up.`);
console.log(`\nNext: fill in ${paths.envFile} (bot token, API key) and set telegram.allowedUserIds in ${paths.configFile}.`);
console.log(`Agents live in ${paths.agentsDir}/<id>/ (config.json + instructions.md); the primary "eigen" uses ${paths.systemPromptFile}. Add a folder there, or use the studio, to add specialists.`);
