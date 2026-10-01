import { getConfig } from "../../lib/config.ts";
import { readyPaths } from "../../lib/home.ts";
import { makeWorkspace } from "../../lib/workspace.ts";

export default makeWorkspace(readyPaths(), getConfig());
