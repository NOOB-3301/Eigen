"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Blocks, Check, Crown, FileWarning, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import type { FleetResponse, RootInfo } from "@/lib/types";
import { cn } from "@/lib/cn";
import { Button, Kbd, Monogram, Skeleton, StatusBadge, Switch, spring } from "@/components/ui";
import type { SettingsSection } from "@/components/settings/settings-dialog";
import { Form, type FormCtx } from "./fields";
import { AdvancedPanel, MemoryPanel, OverviewPanel, PromptPanel, ToolsPanel, type PanelProps } from "./panels";
import { Banner } from "./banner";
import { Conflict } from "./review";
import { PrimaryDialog, TrashDialog } from "./agent-dialogs";
import { useAgentDraft, type Phase } from "./use-agent-draft";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "prompt", label: "Prompt" },
  { key: "tools", label: "Tools" },
  { key: "memory", label: "Memory" },
  { key: "advanced", label: "Advanced" },
] as const;
type Tab = (typeof TABS)[number]["key"];

type Props = {
  id: string;
  fleet: FleetResponse;
  root?: RootInfo;
  engineOnline: boolean;
  onClose: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** Opens this agent in the builder (the component canvas). */
  onOpenBuilder: (id: string) => void;
  className?: string;
  style?: React.CSSProperties;
};

export function Inspector({ id, fleet, root, engineOnline, onClose, onOpenSettings, onOpenBuilder, className, style }: Props) {
  const { data, error, notFound, refetch, draft, dirty, phase, setPhase, external, validation, errors, set, setConfig, setInstructions, save, discard, reloadTheirs } = useAgentDraft({ id, root, engineOnline });
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Tab>("overview");
  const [confirm, setConfirm] = useState<null | "primary" | "trash">(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const form: FormCtx | null = draft ? { config: draft.config, set, errors } : null;

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

  const panelProps: PanelProps = {
    id,
    root,
    agents: fleet.agents,
    instructionsText: draft?.instructionsText ?? "",
    setInstructions,
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
        <Button variant="ghost" onClick={() => onOpenBuilder(id)} className="h-8 shrink-0 px-2.5" title="Wire this agent's model, memory, tools and triggers on a canvas">
          <Blocks size={14} /> Open builder
        </Button>
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
                {tab === "advanced" && <AdvancedPanel {...panelProps} onJson={setConfig} />}
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
