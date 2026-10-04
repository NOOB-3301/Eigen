"use client";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, ChevronUp, Loader2, Rocket } from "lucide-react";
import type { Draft } from "@/lib/client/draft";
import { cn } from "@/lib/cn";
import { Button, Kbd, spring } from "@/components/ui";
import { Conflict, DraftDiff } from "./review";
import type { Phase } from "./use-agent-draft";
import type { Change } from "./model";

type Status = { tone: string; icon: React.ReactNode; text: string };

function statusOf(phase: Phase, dirty: boolean, changes: Change[], issues: string[], engineOnline: boolean): Status {
  switch (phase.k) {
    case "saving":
      return { tone: "text-ink-2", icon: <Loader2 size={14} className="animate-spin" />, text: "Applying…" };
    case "waiting":
      return { tone: "text-ink-2", icon: <Loader2 size={14} className="animate-spin" />, text: "Applied. Waiting for the engine to reload…" };
    case "reloaded":
      return { tone: "text-ok", icon: <Check size={15} strokeWidth={2.6} />, text: "Live. The engine reloaded this agent." };
    case "saved-offline":
      return { tone: "text-ink-2", icon: <Check size={15} />, text: "Saved to disk. The engine loads it when it starts." };
    case "saved-prompt":
      return { tone: "text-ok", icon: <Check size={15} strokeWidth={2.6} />, text: "Saved. It applies from the agent's next message." };
    case "saved-unconfirmed":
      return { tone: "text-ink-2", icon: <Check size={15} />, text: "Saved. The engine has not confirmed a reload yet." };
    case "rejected":
      return { tone: "text-warn", icon: <AlertTriangle size={14} />, text: `Saved, but the engine rejected it: ${phase.problems[0] ?? "see the problems on the agent"}` };
    case "invalid":
      return { tone: "text-bad", icon: <AlertTriangle size={14} />, text: `Not applied: ${phase.issues[0] ?? "invalid config"}` };
    case "error":
      return { tone: "text-bad", icon: <AlertTriangle size={14} />, text: `Not applied: ${phase.message}` };
    case "conflict":
      return { tone: "text-warn", icon: <AlertTriangle size={14} />, text: "Not applied: this agent changed on disk." };
    default:
      if (dirty && issues.length) return { tone: "text-bad", icon: <AlertTriangle size={14} />, text: issues.length === 1 ? issues[0]! : `${issues.length} problems to fix before applying` };
      if (dirty) return { tone: "text-ink", icon: <span className="size-2 rounded-full bg-accent" aria-hidden />, text: `${changes.length} ${changes.length === 1 ? "change" : "changes"} staged${engineOnline ? "" : ". The engine is offline; it loads them when it starts"}` };
      return { tone: "text-ink-3", icon: <span className="size-2 rounded-full border border-line-strong" aria-hidden />, text: "No changes. The canvas shows what is applied." };
  }
}

type Props = {
  phase: Phase;
  dirty: boolean;
  changes: Change[];
  issues: string[];
  engineOnline: boolean;
  base: Draft | null;
  draft: Draft | null;
  agentId: string;
  reviewOpen: boolean;
  setReviewOpen: (open: boolean) => void;
  onApply: () => void;
  onDiscard: () => void;
  onKeepEditing: () => void;
  onReloadTheirs: () => void;
  onOverwrite: (etag: string) => void;
  /** Jump to the node a problem belongs to. */
  onFocusProblem?: () => void;
  /** Right inset in px so the bar centres in what a side panel leaves uncovered. */
  inset: number;
};

/** The one place a change becomes real: it counts what is staged, shows what it is, and applies it (conflicts, issues, the engine reload). */
export function ApplyBar({ phase, dirty, changes, issues, engineOnline, base, draft, agentId, reviewOpen, setReviewOpen, onApply, onDiscard, onKeepEditing, onReloadTheirs, onOverwrite, inset }: Props) {
  const status = statusOf(phase, dirty, changes, issues, engineOnline);
  const busy = phase.k === "saving";
  const canApply = dirty && issues.length === 0 && !busy && phase.k !== "conflict";
  const open = reviewOpen && (dirty || phase.k === "conflict");
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3 sm:pb-4 sm:transition-[padding] sm:duration-300" style={{ paddingRight: inset ? inset + 12 : undefined }}>
      <motion.section layout transition={spring} aria-label="Staged changes" className="pointer-events-auto w-full max-w-[680px] overflow-hidden rounded-2xl border border-line bg-panel shadow-float">
        <AnimatePresence initial={false}>
          {(open || phase.k === "conflict") && draft && base && (
            <motion.div key="review" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              {phase.k === "conflict" ? (
                <Conflict id={agentId} mine={draft} onReloadTheirs={onReloadTheirs} onOverwrite={onOverwrite} onCancel={onKeepEditing} />
              ) : (
                <div className="max-h-[46dvh] space-y-3 overflow-y-auto border-b border-line px-4 py-3.5">
                  <ul aria-label="Staged changes" className="grid gap-1 text-[13px] text-ink">
                    {changes.map((c) => (
                      <li key={c.id} className="flex items-start gap-2">
                        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                        {c.label}
                      </li>
                    ))}
                  </ul>
                  {issues.length > 0 && (
                    <ul role="alert" aria-label="Problems" className="space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
                      {issues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  )}
                  {phase.k === "invalid" && phase.issues.length > 1 && (
                    <ul role="alert" aria-label="What the server refused" className="space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
                      {phase.issues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  )}
                  <DraftDiff before={base} after={draft} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
          <div className="min-w-0 flex-1" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p key={phase.k + status.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={spring} className={cn("flex items-center gap-2 text-[13px]", status.tone)}>
                <span className="shrink-0">{status.icon}</span>
                <span className="line-clamp-2">{status.text}</span>
              </motion.p>
            </AnimatePresence>
          </div>
          {dirty && (
            <Button variant="quiet" onClick={() => setReviewOpen(!open)} aria-expanded={open} className="px-2.5">
              <ChevronUp size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden /> <span className="hidden sm:inline">Review</span>
            </Button>
          )}
          {dirty && !busy && (
            <Button variant="quiet" onClick={onDiscard}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={onApply} disabled={!canApply} aria-keyshortcuts="Meta+S" className="h-9">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Apply <Kbd>⌘S</Kbd>
          </Button>
        </div>
      </motion.section>
    </div>
  );
}
