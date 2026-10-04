import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sortBy } from "lodash-es";
import type { HomePaths } from "./home.ts";

const KEEP = 100;

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

/** The agent edits groundrules.md itself; every changed version is copied where it cannot reach, so a bad edit can be undone. Returns the snapshot path, or undefined when nothing changed. */
export function snapshotGroundRules(p: HomePaths, now = new Date()) {
  const current = read(p.groundRulesFile);
  if (current === undefined) return undefined;
  mkdirSync(p.groundRulesHistoryDir, { recursive: true });
  const files = sortBy(readdirSync(p.groundRulesHistoryDir).filter((f) => f.endsWith(".md")));
  const last = files.at(-1);
  if (last && read(join(p.groundRulesHistoryDir, last)) === current) return undefined;
  const target = join(p.groundRulesHistoryDir, `${now.toISOString().replaceAll(":", "-")}.md`);
  copyFileSync(p.groundRulesFile, target);
  files.slice(0, Math.max(0, files.length + 1 - KEEP)).forEach((f) => rmSync(join(p.groundRulesHistoryDir, f), { force: true }));
  return target;
}
