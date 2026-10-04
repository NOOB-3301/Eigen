import { getConfig } from "../../lib/config.ts";
import { PRIMARY_ID, registry } from "../../lib/fleet.ts";
import { readyPaths } from "../../lib/home.ts";
import { reconcileSkills } from "../../lib/skills.ts";
import { makeWorkspace } from "../../lib/tools/workspace.ts";
import logger from "../../logger.ts";

const paths = readyPaths();
reconcileSkills(paths); // start from a consistent skill set

// Built once by Mastra, so the skill selection is read from the primary's config on every turn instead of at boot.
export default makeWorkspace(paths, getConfig(), undefined, "eigen", {
  skills: () => registry.resolved(PRIMARY_ID)?.skills.inherit ?? "all",
  log: (msg) => logger.warn(`skills: ${msg}`),
});
