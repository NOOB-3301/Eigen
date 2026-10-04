"use client";
import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "eigen-theme";
const subs = new Set<() => void>();

function read(): ThemePref {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(t: ThemePref) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: still apply for this session */
  }
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  subs.forEach((s) => s());
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    subs.delete(cb);
    mq.removeEventListener("change", cb);
  };
};

/** Theme preference plus what it resolves to right now. */
export function useTheme() {
  const pref = useSyncExternalStore(subscribe, read, () => "system" as ThemePref);
  const dark = useSyncExternalStore(
    subscribe,
    () => (pref === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : pref === "dark"),
    () => false,
  );
  const cycle = useCallback(() => apply(pref === "system" ? "light" : pref === "light" ? "dark" : "system"), [pref]);
  return { pref, resolved: dark ? ("dark" as const) : ("light" as const), set: apply, cycle };
}

const ICON = { system: Monitor, light: Sun, dark: Moon };
const LABEL = { system: "Theme: match system", light: "Theme: light", dark: "Theme: dark" };

export function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const Icon = ICON[pref];
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`${LABEL[pref]}. Switch theme`}
      title={LABEL[pref]}
      className="relative grid size-8 place-items-center overflow-hidden rounded-lg text-ink-2 transition-colors hover:bg-raised hover:text-ink"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={pref}
          initial={{ y: 14, opacity: 0, rotate: -40 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          exit={{ y: -14, opacity: 0, rotate: 40 }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
          className="grid place-items-center"
        >
          <Icon size={16} strokeWidth={1.8} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
