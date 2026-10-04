"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { AnimatePresence, motion } from "motion/react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Plus, Search, Settings as SettingsIcon } from "lucide-react";
import type { AgentEvent, GetAgentResponse } from "@eigen/engine/schema";
import type { FleetResponse, Layout, RootInfo } from "@/lib/types";
import { keys, useFleet, useLayout, useRoot } from "@/lib/client/api";
import { applyTelegramToAgent, applyTelegramToFleet, awaitingReload, fleetHasBot, onAgentEvent, useEventStream } from "@/lib/client/events";
import { cn } from "@/lib/cn";
import { Button, Kbd, softSpring } from "@/components/ui";
import { ThemeToggle, useTheme } from "@/components/theme";
import { Canvas, type CanvasApi } from "@/components/canvas/flow";
import { CABLES } from "@/components/canvas/edges";
import { Inspector } from "@/components/inspector/inspector";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { CommandPalette } from "@/components/command-palette";
import { AgentList } from "@/components/agent-list";
import { SettingsDialog, type SettingsSection } from "@/components/settings/settings-dialog";

type Props = { initialFleet: FleetResponse; initialRoot?: RootInfo; initialLayout: Layout; initialSettings?: SettingsSection };

export function Studio({ initialFleet, initialRoot, initialLayout, initialSettings }: Props) {
  return (
    <SWRConfig value={{ fallback: { [keys.fleet]: initialFleet, [keys.root]: initialRoot, [keys.layout]: initialLayout } }}>
      <StudioInner initialEngine={initialFleet.engine} initialSettings={initialSettings} />
    </SWRConfig>
  );
}

const useMedia = (q: string) =>
  useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );

function StudioInner({ initialEngine, initialSettings }: { initialEngine: "online" | "offline"; initialSettings?: SettingsSection }) {
  const { data: fleet } = useFleet();
  const { data: root } = useRoot();
  const { data: layout } = useLayout();
  const { mutate } = useSWRConfig();
  const theme = useTheme();
  const stream = useEventStream(initialEngine);
  const phone = useMedia("(max-width: 639px)");
  const wide = useMedia("(min-width: 1024px)");
  const [selected, setSelected] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; section?: SettingsSection }>({ open: !!initialSettings, section: initialSettings });
  const canvas = useRef<CanvasApi>(null);
  const pendingFocus = useRef<string | null>(null);

  const engine = stream.connected ? stream.engine : (fleet?.engine ?? initialEngine);
  const engineOnline = engine === "online";
  const inspectorWidth = phone ? 0 : wide ? 480 : 420;

  // When the engine comes or goes, statuses change wholesale: refetch.
  useEffect(() => {
    void mutate(keys.fleet);
  }, [engine, mutate]);

  // Live updates: every event revalidates; loaded/error also toast (batched, and quiet for agents an open editor is tracking).
  const names = useRef(new Map<string, string>());
  useEffect(() => {
    fleet?.agents.forEach((a) => names.current.set(a.id, a.name));
  }, [fleet]);
  useEffect(() => {
    let loaded: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (loaded.length === 1) toast.success(`${names.current.get(loaded[0]!) ?? loaded[0]} reloaded`, { description: "Running the latest files." });
      else if (loaded.length > 1) toast.success(`${loaded.length} agents reloaded`, { description: loaded.map((id) => names.current.get(id) ?? id).join(", ") });
      loaded = [];
    };
    const off = onAgentEvent((ev: AgentEvent) => {
      if (ev.type === "agent.telegram") {
        // The event is the new state itself: patch both caches in place. Only a bot that has no node yet needs the topology refetched.
        let refetch = false;
        void mutate(
          keys.fleet,
          (f?: FleetResponse) => {
            if (!f) return f;
            refetch = ev.telegram.state !== "off" && !fleetHasBot(f, ev.id);
            return applyTelegramToFleet(f, ev.id, ev.telegram);
          },
          { revalidate: false },
        ).then(() => refetch && mutate(keys.fleet));
        void mutate(keys.agent(ev.id), (a?: GetAgentResponse) => a && applyTelegramToAgent(a, ev.telegram), { revalidate: false });
        if (ev.telegram.state === "error")
          toast.error(`${names.current.get(ev.id) ?? ev.id}'s Telegram bot has a problem`, { id: `tg-${ev.id}`, description: ev.telegram.error ?? "Telegram rejected the bot." });
        return;
      }
      void mutate(keys.fleet);
      if (ev.type === "fleet.changed") {
        void mutate(keys.root);
        void mutate((k) => typeof k === "string" && k.startsWith("/api/agents/"), undefined, { revalidate: true });
        return;
      }
      void mutate(keys.agent(ev.id));
      if (awaitingReload.has(ev.id)) return;
      if (ev.type === "agent.loaded") {
        loaded.push(ev.id);
        clearTimeout(timer);
        timer = setTimeout(flush, 500);
      } else if (ev.type === "agent.error") {
        toast.error(`${names.current.get(ev.id) ?? ev.id} has problems`, {
          description: `${ev.problems[0] ?? "Invalid config."}${ev.stale ? " The last good version keeps running." : ""}`,
        });
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [mutate]);

  // Close the inspector if its agent disappears (trashed elsewhere); focus agents that just got created.
  useEffect(() => {
    if (!fleet) return;
    if (selected && !fleet.agents.some((a) => a.id === selected) && pendingFocus.current !== selected) setSelected(null);
    const want = pendingFocus.current;
    if (want && fleet.agents.some((a) => a.id === want)) {
      pendingFocus.current = null;
      setTimeout(() => canvas.current?.focus(want), 80);
    }
  }, [fleet, selected]);

  const select = useCallback((id: string | null) => setSelected(id), []);
  const close = useCallback(() => {
    const id = selected;
    setSelected(null);
    // Return focus to the node the drawer was opened from.
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="agent:${id}"]`)?.focus(), 50);
  }, [selected]);

  const openSettings = useCallback((section?: SettingsSection) => setSettings({ open: true, section }), []);
  const closeSettings = useCallback(() => {
    setSettings((s) => ({ ...s, open: false }));
    // Drop a ?settings= deep link so a reload does not reopen the dialog.
    const url = new URL(window.location.href);
    if (url.searchParams.has("settings")) {
      url.searchParams.delete("settings");
      window.history.replaceState(null, "", url);
    }
  }, []);

  const jump = useCallback((id: string) => {
    setSelected(id);
    canvas.current?.focus(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const problems = fleet?.fleetProblems ?? [];
  const agentCount = fleet?.agents.length ?? 0;
  const brokenCount = fleet?.agents.filter((a) => a.runtime.problems.length > 0).length ?? 0;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-canvas">
      {/* Canvas / list */}
      <main className="absolute inset-0 isolate" aria-label="Agent team">
        {fleet && !phone && <Canvas fleet={fleet} savedLayout={layout ?? {}} selectedId={selected} onSelect={select} occludedRight={selected ? inspectorWidth : 0} drawerWidth={inspectorWidth} apiRef={canvas} />}
        {fleet && phone && <AgentList fleet={fleet} onOpen={setSelected} onCreate={() => setNewOpen(true)} />}
      </main>

      {/* Top bar */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-3 sm:gap-3 sm:p-4">
        <div className="pointer-events-auto flex h-11 min-w-0 items-center gap-3 rounded-xl border border-line bg-panel/90 pr-2 pl-3.5 shadow-float backdrop-blur-md">
          <Wordmark />
          <span className="hidden h-4 w-px bg-line sm:block" aria-hidden />
          <span className="hidden text-[12.5px] whitespace-nowrap text-ink-2 tabular-nums sm:inline">
            {agentCount} {agentCount === 1 ? "agent" : "agents"}
          </span>
          {brokenCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-bad/12 px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap text-bad" title={`${brokenCount} with problems`}>
              <AlertTriangle size={11} /> {brokenCount}
              <span className="hidden sm:inline">with problems</span>
            </span>
          )}
        </div>
        <div className="pointer-events-auto ml-auto flex h-11 items-center gap-1 rounded-xl border border-line bg-panel/90 px-1.5 shadow-float backdrop-blur-md">
          <EngineIndicator online={engineOnline} />
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-ink-3 transition-colors hover:bg-raised hover:text-ink-2 md:flex"
            aria-label="Open command palette"
            aria-keyshortcuts="Meta+K"
          >
            <Search size={14} /> Jump to agent <Kbd>⌘K</Kbd>
          </button>
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Open command palette" className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-raised md:hidden">
            <Search size={15} />
          </button>
          <Button variant="primary" onClick={() => setNewOpen(true)} className="h-8">
            <Plus size={14} strokeWidth={2.4} /> <span className="hidden sm:inline">New agent</span>
          </Button>
          <button type="button" onClick={() => openSettings()} aria-label="Open settings" title="Settings: models, Telegram, memory, tools" className="grid size-8 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-raised hover:text-ink">
            <SettingsIcon size={15} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* Fleet-wide problems */}
      <AnimatePresence>
        {problems.length > 0 && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={softSpring}
            className="absolute top-[68px] left-1/2 z-10 w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-xl border border-warn/40 bg-panel px-4 py-2.5 text-[12.5px] shadow-float sm:top-[76px]"
          >
            <div className="flex gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
              <ul className="space-y-0.5 text-ink">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cable legend */}
      {!phone && fleet && fleet.agents.length > 0 && (
        <aside aria-label="Edge legend" className="absolute bottom-4 left-4 z-10 rounded-xl border border-line bg-panel/90 px-3 py-2.5 shadow-float backdrop-blur-md">
          <ul className="grid gap-1.5">
            {CABLES.map((c) => (
              <li key={c.kind} className="flex items-center gap-2.5 text-[12px] text-ink-2">
                <svg width="28" height="6" aria-hidden>
                  <line x1="1" y1="3" x2="27" y2="3" stroke={`var(--cable-${c.kind})`} strokeWidth="2" strokeLinecap="round" />
                </svg>
                {c.label}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {/* Empty state */}
      {fleet && fleet.agents.length === 0 && (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="max-w-sm text-center">
            <h2 className="text-[17px] font-semibold text-ink">{fleet.rootError ? "The root config.json cannot be read" : "No agents yet"}</h2>
            <p className="mt-1.5 text-[13px] text-ink-2">
              {fleet.rootError ? "Fix the problem shown above; the studio updates as soon as the file is valid." : "Create the first one. It gets its own folder in ~/.eigen/.agents."}
            </p>
            {!fleet.rootError && (
              <Button variant="primary" className="mt-4" onClick={() => setNewOpen(true)}>
                <Plus size={14} /> Create an agent
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Inspector */}
      <AnimatePresence>
        {selected && fleet && (
          <Inspector
            key={selected}
            id={selected}
            fleet={fleet}
            root={root}
            engineOnline={engineOnline}
            onClose={close}
            onOpenSettings={openSettings}
            className={cn("absolute top-0 right-0 bottom-0 z-30", phone ? "w-full" : "sm:top-[76px] sm:right-4 sm:bottom-4 sm:rounded-2xl sm:border")}
            style={phone ? undefined : { width: inspectorWidth }}
          />
        )}
      </AnimatePresence>

      <NewAgentDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        fleet={fleet}
        root={root}
        onCreated={(id) => {
          pendingFocus.current = id;
          setSelected(id);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={fleet?.agents ?? []}
        onJump={jump}
        onCreate={() => setNewOpen(true)}
        onToggleTheme={theme.cycle}
        onFit={() => canvas.current?.fit()}
        onSettings={openSettings}
      />
      <SettingsDialog open={settings.open} onClose={closeSettings} section={settings.section} />
      <Toaster
        theme={theme.resolved}
        position="bottom-center"
        toastOptions={{ classNames: { toast: "!bg-panel !border-line !text-ink !shadow-float !rounded-xl", description: "!text-ink-2" } }}
      />
    </div>
  );
}

function Wordmark() {
  // Eigen as in eigenvector: a vector that keeps its direction. The mark is a short arrow on a fixed axis.
  return (
    <span className="flex items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="text-accent">
        <line x1="2" y1="16" x2="16" y2="2" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
        <line x1="4" y1="14" x2="12" y2="6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M12.5 5.5 L8.6 6.2 M12.5 5.5 L11.8 9.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      </svg>
      <span className="text-[14.5px] font-semibold tracking-[-0.02em] text-ink">eigen</span>
      <span className="hidden text-[14.5px] tracking-[-0.02em] text-ink-3 sm:inline">studio</span>
    </span>
  );
}

function EngineIndicator({ online }: { online: boolean }) {
  return (
    <span
      className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] text-ink-2"
      role="status"
      title={online ? "The engine is running and reloads agents as you save." : "The engine is not running. Edits are saved to disk and load when it starts."}
    >
      <span className="relative flex size-2">
        {online && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />}
        <span className={cn("relative size-2 rounded-full", online ? "bg-ok" : "border-[1.5px] border-dashed border-off")} />
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={String(online)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={softSpring} className="hidden sm:inline">
          {online ? "Engine live" : "Engine offline"}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
