import { getConfig } from "../../lib/config.ts";
import { readyPaths } from "../../lib/home.ts";
import { makeMemory } from "../../lib/memory.ts";

export default makeMemory(readyPaths(), getConfig());
