"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd, spring } from "@/components/ui";
import { TINT } from "./kinds";
import type { Group } from "./model";

/** The sections of the palette. They follow the canvas (left, right, top), with the right-hand side split into its three kinds of thing. */
export type PaletteSection = "think" | "builtin" | "mcp" | "skills" | "reach";
export const SECTION_TITLE: Record<PaletteSection, string> = { think: "Thinks with", builtin: "Built-in tools", mcp: "MCP servers", skills: "Skills", reach: "Reaches it, wakes it" };
export const SECTION_GROUP: Record<PaletteSection, Group> = { think: "think", builtin: "tools", mcp: "tools", skills: "tools", reach: "reach" };

export type PaletteEntry = {
  key: string;
  section: PaletteSection;
  /** What it is, for search and the row ("Memory", "MCP server"). */
  type: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  /** Why it cannot be added from here. */
  blocked?: string;
  /** Opens something instead of connecting (the skill library). */
  action?: boolean;
  run: () => void;
};

/** Most rows drawn per section while nothing is typed: a 100-skill library is searched, not scrolled. */
const PER_SECTION = 12;

const norm = (s: string) => s.toLowerCase();
const matches = (e: PaletteEntry, q: string) => !q || [e.title, e.detail, e.type, SECTION_TITLE[e.section]].some((t) => norm(t).includes(q));

export function AddPalette({ open, onClose, entries, initialSection, agentName }: { open: boolean; onClose: () => void; entries: PaletteEntry[]; initialSection: PaletteSection | null; agentName: string }) {
  const [q, setQ] = useState("");
  const [section, setSection] = useState<PaletteSection | null>(initialSection);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const reduce = useReducedMotion();

  // A fresh palette each time it opens, on the section the adder node asked for.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQ("");
      setActive(0);
      setSection(initialSection);
    }
  }

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => opener?.focus?.();
  }, [open]);

  const query = norm(q.trim());
  const sections = (Object.keys(SECTION_TITLE) as PaletteSection[]).filter((s) => entries.some((e) => e.section === s));
  const shown = useMemo(() => {
    const out: Array<{ section: PaletteSection; rows: PaletteEntry[]; more: number }> = [];
    for (const s of sections) {
      if (section && s !== section) continue;
      const all = entries.filter((e) => e.section === s && matches(e, query));
      if (!all.length) continue;
      const rows = query || section ? all : all.slice(0, PER_SECTION);
      out.push({ section: s, rows, more: all.length - rows.length });
    }
    return out;
    // `sections` derives from `entries`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, section]);
  const flat = shown.flatMap((s) => s.rows);
  const clamped = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  const choose = (i: number) => {
    const e = flat[i];
    if (!e || e.blocked) return;
    onClose();
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, flat.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % Math.max(1, flat.length));
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      choose(clamped);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let index = -1;
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[8vh] sm:px-4 sm:pt-[12vh]" onKeyDown={onKeyDown}>
          <motion.div className="fixed inset-0 bg-[var(--scrim)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Add a component to ${agentName}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -6 }}
            transition={spring}
            className="relative flex max-h-[80dvh] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-float"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="text-ink-3" aria-hidden />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={flat[clamped] ? `${listId}-${clamped}` : undefined}
                aria-autocomplete="list"
                aria-label="Search components"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder="Search memory, tools, servers, skills, triggers"
                className="h-12 min-w-0 flex-1 bg-transparent text-[14.5px] text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <Kbd>esc</Kbd>
            </div>
            <div role="group" aria-label="Show" className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
              {[null, ...sections].map((s) => (
                <button
                  key={s ?? "all"}
                  type="button"
                  aria-pressed={section === s}
                  onClick={() => {
                    setSection(s);
                    setActive(0);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12.5px] transition-colors",
                    section === s ? "border-accent/60 bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink",
                  )}
                >
                  {s ? SECTION_TITLE[s] : "All"}
                </button>
              ))}
            </div>
            <ul id={listId} ref={listRef} role="listbox" aria-label="Components that are not connected" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
              {shown.length === 0 && <li className="px-3 py-8 text-center text-[13px] text-ink-3">{entries.length === 0 ? "Everything is connected." : "Nothing matches that."}</li>}
              {shown.map((s) => (
                <li key={s.section} role="presentation">
                  <div className="px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium text-ink-3">{SECTION_TITLE[s.section]}</div>
                  <ul role="presentation">
                    {s.rows.map((e) => {
                      index += 1;
                      const i = index;
                      const on = i === clamped;
                      const Icon = e.icon;
                      return (
                        <li key={e.key} role="presentation">
                          <div
                            id={`${listId}-${i}`}
                            data-index={i}
                            role="option"
                            aria-selected={on}
                            aria-disabled={!!e.blocked}
                            onMouseMove={() => setActive(i)}
                            onClick={() => choose(i)}
                            className={cn("relative flex min-h-[52px] items-center gap-3 rounded-lg px-2.5 py-2", e.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer", on ? "text-ink" : "text-ink-2")}
                          >
                            {on && <motion.span layoutId="add-active" transition={{ ...spring, stiffness: 600 }} className="absolute inset-0 rounded-lg bg-raised" />}
                            <span className={cn("relative grid size-9 shrink-0 place-items-center rounded-lg", TINT[SECTION_GROUP[e.section]].tile)}>
                              <Icon size={16} aria-hidden />
                            </span>
                            <span className="relative min-w-0 flex-1">
                              <span className={cn("block truncate text-[13.5px] font-medium", (e.section === "mcp" || e.section === "skills") && !e.action && "font-mono text-[12.5px]")}>{e.title}</span>
                              <span className="block truncate text-[12px] text-ink-3">{e.blocked ?? e.detail}</span>
                            </span>
                            {!e.blocked && (
                              <span className="relative inline-flex items-center gap-1 text-[12px] text-ink-3">
                                <Plus size={12} aria-hidden /> {e.action ? "Open" : "Connect"}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                    {s.more > 0 && <li className="px-2.5 py-1.5 text-[12px] text-ink-3">{s.more} more. Type to search them.</li>}
                  </ul>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
