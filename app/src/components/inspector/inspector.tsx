"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, Check, Crown, FileWarning, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import type { GetAgentResponse } from "@eigen/engine/schema";
import type { FleetResponse, RootInfo } from "@/lib/types";
import { ApiError, fetcher, keys, saveConfig, trashAgent, useAgent } from "@/lib/client/api";
import { awaitingReload, onAgentEvent } from "@/lib/client/events";
import { issuesByPath, validateDraft } from "@/lib/client/validate";
import { lineDiff } from "@/lib/client/diff";
import { cn } from "@/lib/cn";
import { Button, Kbd, Modal, Monogram, Skeleton, StatusBadge, Switch, spring } from "@/components/ui";
import type { SettingsSection } from "@/components/settings/settings-dialog";
import { Form, setPath, type FormCtx } from "./fields";
import { AdvancedPanel, MemoryPanel, OverviewPanel, PromptPanel, ToolsPanel, type PanelProps } from "./panels";

type Obj = Record<string, unknown>;
type Draft = { config: Obj; instructionsText: string };
type Base = Draft & { etag: string };

type Phase =
  | { k: "idle" }
  | { k: "saving" }
  | { k: "waiting" }
  | { k: "reloaded" }
  | { k: "saved-offline" }
  | { k: "saved-prompt" }
  | { k: "saved-unconfirmed" }
  | { k: "rejected"; problems: string[] }
  | { k: "invalid"; issues: string[] }
  | { k: "conflict" }
  | { k: "error"; message: string };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "prompt", label: "Prompt" },
  { key: "tools", label: "Tools" },
  { key: "memory", label: "Memory" },
  { key: "advanced", label: "Advanced" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Key-order-independent JSON, so "dirty" means a real change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const baseOf = (d: GetAgentResponse): Base => ({ config: (d.config ?? {}) as Obj, instructionsText: d.instructionsText ?? "", etag: d.etag });

type Props = {
  id: string;
  fleet: FleetResponse;
  root?: RootInfo;
  engineOnline: boolean;
  onClose: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  className?: string;
  style?: React.CSSProperties;
};

export function Inspector({ id, fleet, root, engineOnline, onClose, onOpenSettings, className, style }: Props) {
  const { data, error, mutate: refetch } = useAgent(id);
  const { mutate } = useSWRConfig();
  const reduce = useReducedMotion();
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [tab, setTab] = useState<Tab>("overview");
  const [external, setExternal] = useState(false);
  const [confirm, setConfirm] = useState<null | "primary" | "trash">(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dirty = !!(base && draft && (stable(base.config) !== stable(draft.config) || base.instructionsText !== draft.instructionsText));

  // Adopt server data when we have no local edits; otherwise flag that the file moved underneath us.
  // (Adjusting state while rendering, keyed on the data object, instead of an effect.)
  const [seen, setSeen] = useState<GetAgentResponse | undefined>(undefined);
  if (data && data !== seen) {
    setSeen(data);
    if (!base) {
      const b = baseOf(data);
      setBase(b);
      setDraft({ config: b.config, instructionsText: b.instructionsText });
    } else if (data.etag === base.etag) {
      if (data.instructionsText !== null && data.instructionsText !== base.instructionsText && !dirty) {
        setBase({ ...base, instructionsText: data.instructionsText });
        setDraft((d) => d && { ...d, instructionsText: data.instructionsText ?? "" });
      }
    } else if (phase.k !== "saving") {
      if (!dirty) {
        const b = baseOf(data);
        setBase(b);
        setDraft({ config: b.config, instructionsText: b.instructionsText });
        setExternal(false);
      } else setExternal(true);
    }
  }

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // Settle the save when the engine reports back for this agent.
  useEffect(
    () =>
      onAgentEvent((ev) => {
        if (!("id" in ev) || ev.id !== id) return;
        setPhase((p) => {
          if (p.k !== "waiting") return p;
          clearTimeout(waitTimer.current);
          awaitingReload.delete(id);
          if (ev.type === "agent.loaded") {
            toast.success("Saved, engine reloaded", { description: `${draft?.config.name ?? id} is running the new config.` });
            return { k: "reloaded" };
          }
          if (ev.type === "agent.error") return { k: "rejected", problems: ev.problems };
          return p;
        });
      }),
    [id, draft?.config.name],
  );
  useEffect(() => () => {
    clearTimeout(waitTimer.current);
    awaitingReload.delete(id);
  }, [id]);

  const validation = useMemo(() => (draft ? validateDraft(id, draft.config, root) : null), [draft, id, root]);
  const errors = useMemo(() => ({ ...issuesByPath(phase.k === "invalid" ? phase.issues : []), ...(validation?.byPath ?? {}) }), [phase, validation]);

  const set = useCallback((path: string, value: unknown) => {
    setDraft((d) => d && { ...d, config: setPath(d.config, path, value) });
    setPhase((p) => (p.k === "invalid" || p.k === "reloaded" || p.k === "saved-offline" || p.k === "saved-prompt" || p.k === "saved-unconfirmed" || p.k === "error" ? { k: "idle" } : p));
  }, []);
  const form: FormCtx | null = draft ? { config: draft.config, set, errors } : null;

  /** Optimistic canvas update: the node shows the new name/model/state before the engine confirms. */
  const optimistic = useCallback(
    (cfg: Obj) => {
      void mutate(
        keys.fleet,
        (f?: FleetResponse) => {
          if (!f) return f;
          const patch = (a: FleetResponse["agents"][number]) =>
            a.id !== id
              ? a
              : {
                  ...a,
                  name: typeof cfg.name === "string" ? cfg.name : a.name,
                  role: typeof cfg.role === "string" ? cfg.role : a.role,
                  enabled: cfg.enabled !== false,
                  modelKey: typeof cfg.model === "string" ? cfg.model : (root?.defaultModel ?? a.modelKey),
                };
          return {
            ...f,
            agents: f.agents.map(patch),
            overrides: { ...f.overrides, [id]: [...(f.overrides[id] ?? []).filter((o) => o !== "model"), ...(cfg.model !== undefined ? ["model"] : [])] },
            topology: {
              ...f.topology,
              nodes: f.topology.nodes.map((n) => (n.type === "agent" && n.data.id === id ? { ...n, data: { ...n.data, ...patch(n.data) } } : n)),
            },
          };
        },
        { revalidate: false },
      );
    },
    [id, mutate, root?.defaultModel],
  );

  const save = useCallback(
    async (etagOverride?: string) => {
      if (!draft || !base) return;
      const configChanged = stable(base.config) !== stable(draft.config);
      const inline = typeof (draft.config.instructions as Obj | undefined)?.inline === "string";
      const promptChanged = draft.instructionsText !== base.instructionsText;
      setPhase({ k: "saving" });
      setExternal(false);
      if (configChanged) optimistic(draft.config);
      if (configChanged && engineOnline) awaitingReload.add(id);
      let r;
      try {
        r = await saveConfig(id, { config: draft.config, etag: etagOverride ?? base.etag, ...(promptChanged && !inline ? { instructionsText: draft.instructionsText } : {}) });
      } catch (e) {
        awaitingReload.delete(id);
        setPhase({ k: "error", message: (e as Error).message });
        void mutate(keys.fleet);
        return;
      }
      if (r.body.ok) {
        setBase({ ...draft, etag: r.body.etag });
        void refetch();
        void mutate(keys.fleet);
        if (!configChanged) {
          setPhase({ k: "saved-prompt" });
          toast.success("Prompt saved", { description: "It applies from the agent's next message." });
        } else if (!engineOnline) {
          awaitingReload.delete(id);
          setPhase({ k: "saved-offline" });
          toast("Saved to disk", { description: "The engine is offline; it loads this when it starts." });
        } else {
          setPhase({ k: "waiting" });
          clearTimeout(waitTimer.current);
          waitTimer.current = setTimeout(() => {
            awaitingReload.delete(id);
            setPhase((p) => (p.k === "waiting" ? { k: "saved-unconfirmed" } : p));
          }, 8000);
        }
        return;
      }
      awaitingReload.delete(id);
      void mutate(keys.fleet); // undo the optimistic patch
      if (r.status === 409) setPhase({ k: "conflict" });
      else if (r.status === 400) setPhase({ k: "invalid", issues: r.body.issues ?? ["the server rejected the config"] });
      else setPhase({ k: "error", message: r.body.issues?.[0] ?? `save failed (${r.status})` });
    },
    [draft, base, id, engineOnline, optimistic, refetch, mutate],
  );

  const discard = () => {
    if (!base) return;
    setDraft({ config: base.config, instructionsText: base.instructionsText });
    setPhase({ k: "idle" });
  };

  const reloadTheirs = useCallback(async () => {
    const theirs = await refetch();
    if (!theirs) return;
    const b = baseOf(theirs);
    setBase(b);
    setDraft({ config: b.config, instructionsText: b.instructionsText });
    setExternal(false);
    setPhase({ k: "idle" });
  }, [refetch]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && validation?.ok && phase.k !== "saving") void save();
    }
    if (e.key === "Escape" && !confirm) {
      e.stopPropagation();
      onClose();
    }
  };

  const summary = fleet.agents.find((a) => a.id === id);
  const runtime = data?.runtime ?? summary?.runtime;
  const name = (typeof draft?.config.name === "string" && draft.config.name) || summary?.name || id;
  const isPrimary = draft?.config.primary === true;
  const enabled = draft?.config.enabled !== false;
  const notFound = error instanceof ApiError && error.status === 404;

  const panelProps: PanelProps = {
    id,
    root,
    agents: fleet.agents,
    instructionsText: draft?.instructionsText ?? "",
    setInstructions: (t) => {
      setDraft((d) => d && { ...d, instructionsText: t });
      setPhase((p) => (p.k === "idle" || p.k === "saving" || p.k === "waiting" || p.k === "conflict" ? p : { k: "idle" }));
    },
    hasInstructionsFile: data?.instructionsText !== null,
    runtime,
    resolved: data?.resolved,
    engineOnline,
    openSettings: onOpenSettings,
  };

  return (
    <motion.aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={`insp-${id}`}
      onKeyDown={onKeyDown}
      initial={reduce ? { opacity: 0 } : { x: "104%" }}
      animate={reduce ? { opacity: 1 } : { x: 0 }}
      exit={reduce ? { opacity: 0 } : { x: "104%" }}
      transition={spring}
      className={cn("flex flex-col overflow-hidden border-l border-line bg-panel shadow-float", className)}
      style={style}
    >
      {/* Header */}
      <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
        <Monogram id={id} name={name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 id={`insp-${id}`} ref={headingRef} tabIndex={-1} className="truncate text-[17px] font-semibold tracking-[-0.015em] text-ink focus:outline-none">
              {name}
            </h2>
            {isPrimary && <Crown size={14} className="shrink-0 text-crown" aria-label="primary" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-ink-3">@{id}</span>
            {runtime && <StatusBadge status={runtime.status} />}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close inspector" className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
      </header>

      {draft && (
        <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Switch label="Enabled" checked={enabled} onChange={(v) => set("enabled", v ? undefined : false)} />
            {enabled ? "Enabled" : "Disabled"}
          </label>
          <div className="ml-auto flex items-center gap-1">
            {!isPrimary && (
              <Button variant="quiet" onClick={() => setConfirm("primary")} className="h-7 px-2 text-[12.5px]">
                <Crown size={13} /> Make primary
              </Button>
            )}
            <Button
              variant="quiet"
              onClick={() => setConfirm("trash")}
              disabled={isPrimary}
              title={isPrimary ? "The primary cannot be removed. Make another agent primary first." : "Move to trash"}
              className="h-7 px-2 text-[12.5px] hover:text-bad"
            >
              <Trash2 size={13} /> Trash
            </Button>
          </div>
        </div>
      )}

      {/* Banners */}
      <AnimatePresence initial={false}>
        {runtime && (runtime.status === "stale" || runtime.status === "invalid" || runtime.problems.length > 0) && (
          <Banner key="problems" tone={runtime.status === "stale" ? "warn" : "bad"} icon={<AlertTriangle size={14} />}>
            <p className="font-medium">
              {runtime.status === "stale"
                ? "The file has problems. The engine keeps running the last good version."
                : runtime.status === "invalid"
                  ? "This agent is not loaded. Fix these problems and save."
                  : "These problems will stop the engine from loading this agent."}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {runtime.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Banner>
        )}
        {external && (
          <Banner key="external" tone="warn" icon={<FileWarning size={14} />}>
            <div className="flex items-center gap-3">
              <p className="flex-1">The file changed on disk while you were editing.</p>
              <Button variant="ghost" className="h-7" onClick={reloadTheirs}>
                <RefreshCw size={12} /> Load theirs
              </Button>
            </div>
          </Banner>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <Tabs id={id} tab={tab} setTab={setTab} errors={errors} />

      <div role="tabpanel" id={`panel-${id}-${tab}`} aria-labelledby={`tab-${id}-${tab}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {notFound ? (
          <div className="p-6 text-[13px] text-ink-2">This agent no longer exists. It may have been moved to the trash.</div>
        ) : error && !data ? (
          <div className="p-6 text-[13px] text-bad">Could not load this agent: {(error as Error).message}</div>
        ) : !form ? (
          <InspectorSkeleton />
        ) : (
          <Form.Provider value={form}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
                {tab === "overview" && <OverviewPanel {...panelProps} />}
                {tab === "prompt" && <PromptPanel {...panelProps} />}
                {tab === "tools" && <ToolsPanel {...panelProps} />}
                {tab === "memory" && <MemoryPanel {...panelProps} />}
                {tab === "advanced" && <AdvancedPanel {...panelProps} onJson={(c) => setDraft((d) => d && { ...d, config: c })} />}
              </motion.div>
            </AnimatePresence>
          </Form.Provider>
        )}
      </div>

      <AnimatePresence initial={false}>
        {phase.k === "conflict" && draft && <Conflict key="conflict" id={id} mine={draft} onReloadTheirs={reloadTheirs} onOverwrite={(etag) => void save(etag)} onCancel={() => setPhase({ k: "idle" })} />}
      </AnimatePresence>

      <Footer phase={phase} dirty={dirty} issues={validation?.issues ?? []} engineOnline={engineOnline} onSave={() => void save()} onDiscard={discard} />

      <PrimaryDialog open={confirm === "primary"} onClose={() => setConfirm(null)} id={id} name={name} fleet={fleet} dirty={dirty} onDone={() => void refetch()} />
      <TrashDialog open={confirm === "trash"} onClose={() => setConfirm(null)} id={id} name={name} onDone={onClose} />
    </motion.aside>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Tabs({ id, tab, setTab, errors }: { id: string; tab: Tab; setTab: (t: Tab) => void; errors: Record<string, string> }) {
  // Which tab owns which config paths, so a tab can show that it has an error.
  const owns: Record<Tab, RegExp> = {
    overview: /^(id|name|role|description|model|primary|enabled|delegation|telegram)/,
    prompt: /^instructions/,
    tools: /^tools/,
    memory: /^memory/,
    advanced: /^(limits|sandbox|schemaVersion|config$)/,
  };
  return (
    <div role="tablist" aria-label="Agent settings" className="flex gap-1 border-b border-line px-3">
      {TABS.map((t, i) => {
        const on = t.key === tab;
        const bad = Object.keys(errors).some((p) => owns[t.key].test(p));
        return (
          <button
            key={t.key}
            id={`tab-${id}-${t.key}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`panel-${id}-${t.key}`}
            tabIndex={on ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
              setTab(next.key);
              document.getElementById(`tab-${id}-${next.key}`)?.focus();
            }}
            className={cn("relative px-2.5 pt-2.5 pb-2 text-[13px] transition-colors", on ? "text-ink" : "text-ink-3 hover:text-ink-2")}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {bad && <span className="size-1.5 rounded-full bg-bad" aria-label="has errors" />}
            </span>
            {on && <motion.span layoutId={`tab-underline-${id}`} transition={spring} className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "warn" | "bad"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div
      role="status"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className={cn("flex gap-2.5 border-b px-5 py-3 text-[12.5px]", tone === "warn" ? "border-warn/30 bg-warn/8 text-ink" : "border-bad/30 bg-bad/8 text-ink")}>
        <span className={cn("mt-0.5", tone === "warn" ? "text-warn" : "text-bad")}>{icon}</span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </motion.div>
  );
}

function InspectorSkeleton() {
  return (
    <div className="space-y-5 p-5" aria-busy="true" aria-label="Loading agent">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className={cn("h-9 w-full", i === 2 && "h-24")} />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Footer({ phase, dirty, issues, engineOnline, onSave, onDiscard }: { phase: Phase; dirty: boolean; issues: string[]; engineOnline: boolean; onSave: () => void; onDiscard: () => void }) {
  const status = (() => {
    switch (phase.k) {
      case "saving":
        return { tone: "text-ink-2", icon: <Loader2 size={13} className="animate-spin" />, text: "Saving…" };
      case "waiting":
        return { tone: "text-ink-2", icon: <Loader2 size={13} className="animate-spin" />, text: "Saved. Waiting for the engine to reload…" };
      case "reloaded":
        return { tone: "text-ok", icon: <Check size={14} strokeWidth={2.6} />, text: "Saved, engine reloaded" };
      case "saved-offline":
        return { tone: "text-ink-2", icon: <Check size={14} />, text: "Saved to disk. The engine loads it when it starts." };
      case "saved-prompt":
        return { tone: "text-ok", icon: <Check size={14} strokeWidth={2.6} />, text: "Prompt saved. It applies from the next message." };
      case "saved-unconfirmed":
        return { tone: "text-ink-2", icon: <Check size={14} />, text: "Saved. The engine has not confirmed a reload yet." };
      case "rejected":
        return { tone: "text-warn", icon: <AlertTriangle size={13} />, text: `Saved, but the engine rejected it: ${phase.problems[0] ?? "see problems above"}` };
      case "invalid":
        return { tone: "text-bad", icon: <AlertTriangle size={13} />, text: `Not saved: ${phase.issues[0] ?? "invalid config"}` };
      case "error":
        return { tone: "text-bad", icon: <AlertTriangle size={13} />, text: `Not saved: ${phase.message}` };
      case "conflict":
        return { tone: "text-warn", icon: <AlertTriangle size={13} />, text: "Not saved: someone else changed this file." };
      default:
        if (dirty && issues.length) return { tone: "text-bad", icon: <AlertTriangle size={13} />, text: issues.length === 1 ? issues[0]! : `${issues.length} problems to fix before saving` };
        if (dirty) return { tone: "text-ink-2", icon: null, text: engineOnline ? "Unsaved changes. The engine reloads on save." : "Unsaved changes." };
        return null;
    }
  })();
  const canSave = dirty && issues.length === 0 && phase.k !== "saving" && phase.k !== "conflict";
  return (
    <footer className="flex min-h-[56px] items-center gap-3 border-t border-line bg-raised/60 px-5 py-2.5">
      <div className="min-w-0 flex-1" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          {status && (
            <motion.p
              key={phase.k + status.text}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={spring}
              className={cn("flex items-center gap-1.5 text-[12.5px]", status.tone)}
            >
              {status.icon && <span className="shrink-0">{status.icon}</span>}
              <span className="line-clamp-2">{status.text}</span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      {dirty && phase.k !== "saving" && (
        <Button variant="quiet" onClick={onDiscard}>
          Discard
        </Button>
      )}
      <Button variant="primary" onClick={onSave} disabled={!canSave} aria-keyshortcuts="Meta+S">
        Save <Kbd>⌘S</Kbd>
      </Button>
    </footer>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Conflict({ id, mine, onReloadTheirs, onOverwrite, onCancel }: { id: string; mine: Draft; onReloadTheirs: () => void; onOverwrite: (etag: string) => void; onCancel: () => void }) {
  const [theirs, setTheirs] = useState<GetAgentResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetcher<GetAgentResponse>(keys.agent(id)).then(setTheirs, (e: Error) => setErr(e.message));
  }, [id]);
  const configDiff = theirs ? lineDiff(JSON.stringify(theirs.config, null, 2), JSON.stringify(mine.config, null, 2)) : [];
  const promptDiff = theirs && (theirs.instructionsText ?? "") !== mine.instructionsText ? lineDiff(theirs.instructionsText ?? "", mine.instructionsText) : [];
  const changed = (d: typeof configDiff) => d.some((l) => l.kind !== "same");
  return (
    <motion.section
      aria-label="Edit conflict"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={spring}
      className="overflow-hidden border-t border-warn/40 bg-warn/6"
    >
      <div className="space-y-3 px-5 py-4">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">This agent changed on disk since you opened it</h3>
          <p className="text-[12.5px] text-ink-2">Lines marked + are yours, − are on disk now.</p>
        </div>
        {err && <p className="text-[12.5px] text-bad">{err}</p>}
        {!theirs && !err && <Skeleton className="h-24 w-full" />}
        {theirs && (
          <div className="max-h-56 overflow-auto rounded-lg border border-line bg-sunken font-mono text-[11.5px] leading-[1.55]">
            {changed(configDiff) && <DiffBlock title="config.json" lines={configDiff} />}
            {promptDiff.length > 0 && <DiffBlock title="instructions" lines={promptDiff} />}
            {!changed(configDiff) && promptDiff.length === 0 && <p className="p-3 font-sans text-ink-3">No differences in content; only the file version changed.</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onReloadTheirs}>
            <RefreshCw size={13} /> Reload theirs
          </Button>
          <Button variant="primary" disabled={!theirs} onClick={() => theirs && onOverwrite(theirs.etag)}>
            Overwrite with mine
          </Button>
          <Button variant="quiet" onClick={onCancel} className="ml-auto">
            Keep editing
          </Button>
        </div>
      </div>
    </motion.section>
  );
}

function DiffBlock({ title, lines }: { title: string; lines: ReturnType<typeof lineDiff> }) {
  // Collapse long unchanged runs to keep the conflict readable.
  const out: Array<{ kind: string; text: string }> = [];
  let run: typeof lines = [];
  const flush = () => {
    if (run.length > 4) out.push(run[0]!, { kind: "gap", text: `… ${run.length - 2} unchanged lines` }, run[run.length - 1]!);
    else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.kind === "same") run.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return (
    <div>
      <div className="sticky top-0 border-b border-line bg-raised px-3 py-1 font-sans text-[11.5px] text-ink-3">{title}</div>
      {out.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre-wrap",
            l.kind === "add" && "bg-ok/12 text-ink",
            l.kind === "del" && "bg-bad/12 text-ink-2",
            l.kind === "same" && "text-ink-3",
            l.kind === "gap" && "py-0.5 font-sans text-[11px] text-ink-3 italic",
          )}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : l.kind === "gap" ? "" : "  "}
          {l.text}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function PrimaryDialog({ open, onClose, id, name, fleet, dirty, onDone }: { open: boolean; onClose: () => void; id: string; name: string; fleet: FleetResponse; dirty: boolean; onDone: () => void }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const current = fleet.agents.find((a) => a.primary && a.enabled && a.id !== id);

  const run = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const target = await fetcher<GetAgentResponse>(keys.agent(id));
      const tc = target.config as Obj & { delegation?: Obj };
      const accepts = tc.delegation?.acceptsFrom;
      // The primary cannot accept delegation "from primary"; flip it to "none" (the schema default would be "primary").
      const next = { ...tc, primary: true, enabled: true, delegation: { ...(tc.delegation ?? {}), acceptsFrom: accepts === "any" ? "any" : "none" } };
      const r1 = await saveConfig(id, { config: next, etag: target.etag });
      if (!r1.body.ok) throw new Error(r1.body.issues?.join("\n") ?? `could not update ${id} (${r1.status})`);
      if (current) {
        const old = await fetcher<GetAgentResponse>(keys.agent(current.id));
        const r2 = await saveConfig(current.id, { config: { ...(old.config as Obj), primary: false }, etag: old.etag });
        if (!r2.body.ok) throw new Error(`${name} is primary now, but ${current.name} could not be demoted: ${r2.body.issues?.join("; ") ?? r2.status}. Fix it so exactly one agent is primary.`);
      }
      toast.success(`${name} is now the primary`, { description: current ? `${current.name} is a regular agent now.` : undefined });
      void mutate(keys.fleet);
      if (current) void mutate(keys.agent(current.id));
      onDone();
      onClose();
    } catch (e) {
      setIssues((e as Error).message.split("\n"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Make ${name} the primary`}>
      <div className="p-5">
        <div className="flex items-center gap-2 text-crown">
          <Crown size={18} />
          <h3 className="text-[15px] font-semibold text-ink">Make {name} the primary?</h3>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">
          Exactly one enabled agent must be primary. The primary owns the Telegram channel and supervises the team.
        </p>
        <ol className="mt-3 space-y-1.5 text-[13px] text-ink">
          <li className="flex gap-2">
            <span className="text-ink-3">1.</span>
            <span>
              {name} becomes primary and takes over the Telegram channel.
            </span>
          </li>
          {current && (
            <li className="flex gap-2">
              <span className="text-ink-3">2.</span>
              <span>{current.name} stops being primary. Both files are saved one after the other.</span>
            </li>
          )}
        </ol>
        {dirty && <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn">Save or discard your unsaved changes first.</p>}
        {issues.length > 0 && (
          <ul role="alert" className="mt-3 space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={busy || dirty}>
            {busy && <Loader2 size={13} className="animate-spin" />} Make primary
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TrashDialog({ open, onClose, id, name, onDone }: { open: boolean; onClose: () => void; id: string; name: string; onDone: () => void }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const r = await trashAgent(id).catch((e: Error) => ({ status: 0, body: { ok: false, issues: [e.message] } }));
    setBusy(false);
    if (!r.body.ok) {
      setErr(r.body.issues?.[0] ?? "could not move to trash");
      return;
    }
    // Optimistically drop the node so it animates out right away.
    void mutate(
      keys.fleet,
      (f?: FleetResponse) =>
        f && {
          ...f,
          agents: f.agents.filter((a) => a.id !== id),
          topology: {
            nodes: f.topology.nodes.filter((n) => n.id !== `agent:${id}` && !(n.type === "mcp" && n.data.owner === id)),
            edges: f.topology.edges.filter((e) => e.source !== `agent:${id}` && e.target !== `agent:${id}`),
          },
        },
      { revalidate: true },
    );
    toast(`Moved ${name} to the trash`, { description: "Its folder is in .agents/.trash; nothing was erased." });
    onClose();
    onDone();
  };
  return (
    <Modal open={open} onClose={onClose} title={`Move ${name} to the trash`}>
      <div className="p-5">
        <div className="flex items-center gap-2 text-bad">
          <Trash2 size={17} />
          <h3 className="text-[15px] font-semibold text-ink">Move {name} to the trash?</h3>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">The engine unloads it. Its folder moves to .agents/.trash, so you can restore it by moving it back.</p>
        {err && (
          <p role="alert" className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />} Move to trash
          </Button>
        </div>
      </div>
    </Modal>
  );
}

