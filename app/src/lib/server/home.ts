import { statSync } from "node:fs";
import { loadConfig, type Config } from "@eigen/engine/config";
import { homePaths, type HomePaths } from "@eigen/engine/home";

/** Resolved per call so EIGEN_HOME changes (tests) are honoured; it is cheap. */
export const paths = (): HomePaths => homePaths();

let cache: { mtimeMs: number; config: Config } | undefined;

/** Root config.json, re-read whenever the file changes (no restart needed). Throws with a readable message when invalid. */
export function rootConfig(): Config {
  const file = paths().configFile;
  const mtimeMs = statSync(file).mtimeMs;
  if (cache?.mtimeMs !== mtimeMs) cache = { mtimeMs, config: loadConfig(file) };
  return cache.config;
}

/** Strip anything that looks like a filesystem path from messages bound for the browser. */
export const scrubPaths = (msg: string) => msg.replaceAll(paths().home, "~/.eigen");
