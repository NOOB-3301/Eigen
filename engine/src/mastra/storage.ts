import { LibSQLStore } from "@mastra/libsql";
import { readyHome } from "./lib/home.ts";

/** Mastra's own storage (workflow snapshots, traces, the chat adapters' state). No agent memory lives here: each agent has its own storage. */
export default new LibSQLStore({ id: "eigen-engine", url: `file:${readyHome().engineDbFile}` });
