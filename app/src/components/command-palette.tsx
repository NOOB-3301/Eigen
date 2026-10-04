"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Blocks, Maximize2, Plus, Search, SunMoon } from "lucide-react";
import type { AgentSummary } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Kbd, Monogram, StatusDot, spring } from "@/components/ui";

type Item = { key: string; label: string; sub?: string; icon: React.ReactNode; run: () => void; group: "Agents" | "Builder" | "Actions"; trailing?: React.ReactNode };

/** Subsequence match with a bonus for word starts; good enough for a few dozen agents. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let i = 0;
  let s = 0;
  for (const c of t) if (c === q[i]) {
    i++;
    s++;
  }
  return i === q.length ? s : 0;
}

export function CommandPalette({
  open,
  onClose,
  agents,
  onJump,
  onBuild,
  builderId,
  currentId,
  onCreate,
  onToggleTheme,
  onFit,
}: {
  open: boolean;
  onClose: () => void;
  agents: AgentSummary[];
  onJump: (id: string) => void;
  /** Open the builder for an agent, or (null) go back to the team. */
  onBuild: (id: string | null) => void;
  /** The agent whose builder is open, if any. */
  builderId: string | null;
  /** The agent in focus (builder or summary card), offered as "Build" even before anything is typed. */
  currentId: string | null;
  onCreate: () => void;
  onToggleTheme: () => void;
  onFit: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      setQ("");
      setActive(0);
      opener?.focus?.();
    };
  }, [open]);

  const items = useMemo<Item[]>(() => {
    // "build re" finds "Build Researcher": the word is a hint, not part of the search.
    const asBuild = /^build\b/.test(q.trim().toLowerCase());
    const query = q.trim().toLowerCase().replace(/^build\s*/, "");
    const agentItems: Item[] = agents
      .map((a) => ({ a, s: Math.max(score(query, a.name), score(query, a.id), score(query, a.role) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
      .map(({ a }) => ({
        key: `agent:${a.id}`,
        group: "Agents",
        label: a.name,
        sub: a.role,
        icon: <Monogram id={a.id} name={a.name} size={24} />,
        trailing: (
          <span className="flex items-center gap-2">
            <StatusDot status={a.runtime.status} />
          </span>
        ),
        run: () => onJump(a.id),
      }));
    // With nothing typed, offer only the agent in focus; typing (or "build ...") offers every match.
    const buildItems: Item[] = agents
      .filter((a) => (query || asBuild ? score(query, a.name) + score(query, a.id) > 0 : a.id === currentId))
      .map((a) => ({ key: `build:${a.id}`, group: "Builder" as const, label: `Build ${a.name}`, sub: "wire its components", icon: <Blocks size={15} />, run: () => onBuild(a.id) }));
    const actions: Item[] = [
      { key: "create", group: "Actions", label: "Create agent", icon: <Plus size={15} />, run: onCreate },
      ...(builderId ? [{ key: "team", group: "Actions" as const, label: "Back to all agents", icon: <ArrowLeft size={15} />, run: () => onBuild(null) }] : [{ key: "fit", group: "Actions" as const, label: "Fit every agent in view", icon: <Maximize2 size={14} />, run: onFit }]),
      { key: "theme", group: "Actions", label: "Switch theme", icon: <SunMoon size={15} />, run: onToggleTheme },
    ].filter((a) => !query || score(query, a.label) > 0 || a.key === "create") as Item[];
    // Typing "build ..." puts the builder first; otherwise agents come first, as before.
    return asBuild ? [...buildItems, ...actions] : [...agentItems, ...buildItems, ...actions];
  }, [agents, q, onJump, onBuild, builderId, currentId, onCreate, onToggleTheme, onFit]);

  const clamped = Math.min(active, Math.max(0, items.length - 1));
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(clamped);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") e.preventDefault();
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]" onKeyDown={onKeyDown}>
          <motion.div className="fixed inset-0 bg-[var(--scrim)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
            transition={spring}
            className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-panel shadow-float"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="text-ink-3" />
              <input
                ref={inputRef}
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={items[clamped] ? `${listId}-${clamped}` : undefined}
                aria-autocomplete="list"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder="Jump to an agent or run a command"
                className="h-12 flex-1 bg-transparent text-[14.5px] text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <Kbd>esc</Kbd>
            </div>
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                const on = i === clamped;
                return (
                  <li key={it.key} role="presentation">
                    {header && <div className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3">{header}</div>}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(i)}
                      className={cn("relative flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[13.5px]", on ? "text-ink" : "text-ink-2")}
                    >
                      {on && <motion.span layoutId="palette-active" transition={{ ...spring, stiffness: 600 }} className="absolute inset-0 rounded-lg bg-raised" />}
                      <span className="relative grid size-6 place-items-center text-ink-2">{it.icon}</span>
                      <span className="relative min-w-0 flex-1 truncate">
                        {it.label}
                        {it.sub && <span className="ml-2 text-ink-3">{it.sub}</span>}
                      </span>
                      {it.trailing && <span className="relative">{it.trailing}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
