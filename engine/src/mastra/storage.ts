import { LibSQLStore } from "@mastra/libsql";
import { readyPaths } from "./lib/home.ts";

export default new LibSQLStore({ id: "eigen-storage", url: `file:${readyPaths().dbFile}` });
