import { appendFileSync } from "node:fs";
import { PinoLogger } from "@mastra/loggers";
import { FileTransport } from "@mastra/loggers/file";
import { readyPaths } from "./lib/home.ts";

const { logFile } = readyPaths();
appendFileSync(logFile, ""); // FileTransport throws if the file doesn't exist

export default new PinoLogger({
  name: "eigen",
  // level: (process.env.EIGEN_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info",
  level: "debug",
  transports: { file: new FileTransport({ path: logFile }) },
});
