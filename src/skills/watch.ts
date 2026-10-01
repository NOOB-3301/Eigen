import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";
import type { SkillStore } from "./store.ts";
import { logger } from "../util/logger.ts";

const DEBOUNCE_MS = 500;

// Picks up files written outside the store: the user editing custom/, or the model
// writing a skill with shell_exec.
export function watchSkills(store: SkillStore, onChange: () => void): FSWatcher | undefined {
  const dir = store.root();
  mkdirSync(dir, { recursive: true });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dir, { recursive: true }, (_evt, file) => {
      if (file && !/SKILL\.md$|\.md$/.test(String(file))) return; // ignore .meta.json churn
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changed = store.reloadIfChanged();
        logger.info({ evt: "skills_watch_reload", changed, count: store.count().total });
        onChange();
      }, DEBOUNCE_MS);
    });
    return watcher;
  } catch (e) {
    logger.warn({ evt: "skills_watch_failed", err: (e as Error).message });
    return undefined;
  }
}
