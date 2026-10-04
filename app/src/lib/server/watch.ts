import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { paths } from "./home";

type Listener = () => void;
type Hub = { home: string; listeners: Set<Listener>; watchers: FSWatcher[]; timer?: NodeJS.Timeout };

/**
 * One process-wide watcher on ~/.eigen/.agents (recursive) and the root config.json, fanned out to every
 * open fallback SSE stream. Debounced because an atomic save is a write + rename. Survives dev HMR via globalThis.
 */
const g = globalThis as typeof globalThis & { __eigenWatchHub?: Hub };

function start(home: string): Hub {
  const p = paths();
  const hub: Hub = { home, listeners: new Set(), watchers: [] };
  const fire = (file?: string | null) => {
    if (file && /\.tmp$/.test(file)) return;
    clearTimeout(hub.timer);
    hub.timer = setTimeout(() => hub.listeners.forEach((l) => l()), 150);
  };
  mkdirSync(p.agentsDir, { recursive: true });
  try {
    hub.watchers.push(watch(p.agentsDir, { recursive: true }, (_e, f) => fire(f && String(f))));
  } catch (e) {
    console.warn("[eigen] cannot watch agents folder:", (e as Error).message);
  }
  try {
    hub.watchers.push(watch(p.home, (_e, f) => f && String(f) === "config.json" && fire()));
  } catch {
    /* root config watching is best-effort */
  }
  return hub;
}

export function onFleetChange(listener: Listener): () => void {
  const home = paths().home;
  let hub = g.__eigenWatchHub;
  if (!hub || hub.home !== home) {
    hub?.watchers.forEach((w) => w.close());
    hub = g.__eigenWatchHub = start(home);
  }
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
    if (!hub.listeners.size) {
      hub.watchers.forEach((w) => w.close());
      if (g.__eigenWatchHub === hub) delete g.__eigenWatchHub;
    }
  };
}
