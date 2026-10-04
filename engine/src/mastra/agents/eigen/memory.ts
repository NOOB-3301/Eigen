import { getConfig } from "../../lib/config.ts";
import { paths, PRIMARY_ID, registry } from "../../lib/fleet.ts";
import { makeMemory } from "../../lib/memory.ts";

/** Root memory settings with the primary's own overrides (lastMessages, semanticRecall, observational) on top. */
export default makeMemory(paths, () => ({ ...getConfig(), memory: registry.resolved(PRIMARY_ID)?.memory ?? getConfig().memory }));
