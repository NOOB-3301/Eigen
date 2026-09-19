import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import type { Logger } from "pino";

export type { Logger };

const level = process.env.EIGEN_LOG_LEVEL ?? "info";

// Live binding: modules read `logger` at call time, so swapping in the file-backed
// logger after the home dir is known reaches every caller.
export let logger: Logger = pino({ level });

export function initLogger(logFile: string): Logger {
  mkdirSync(dirname(logFile), { recursive: true });
  logger = pino(
    { level },
    pino.multistream([
      { stream: process.stdout, level: level as pino.Level },
      // Sync: log volume is low, and async streams lose lines (or throw) on process.exit.
      { stream: pino.destination({ dest: logFile, sync: true, mkdir: true }), level: level as pino.Level },
    ]),
  );
  return logger;
}
