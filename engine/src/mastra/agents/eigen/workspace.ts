import { getConfig } from "../../lib/config.ts";
import { readyPaths } from "../../lib/home.ts";
import { reconcileSkills } from "../../lib/skills.ts";
import { makeWorkspace } from "../../lib/tools/workspace.ts";

const paths = readyPaths();
reconcileSkills(paths); // start from a consistent skill set

export default makeWorkspace(paths, getConfig());
