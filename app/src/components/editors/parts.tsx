"use client";
import { useMemo, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { lineDiff } from "@/lib/client/diff";
import { cn } from "@/lib/cn";
import { Button, Kbd, Skeleton, spring } from "@/components/ui";

/* Pieces the soul, skill and trigger editors share: the save bar, the edit-conflict banner and the save state machine's types. */

/** Where a self-saving editor is. `conflict`: the file changed on disk since this draft was started. */
export type SavePhase = { k: "idle" } | { k: "saving" } | { k: "saved" } | { k: "error"; issues: string[] } | { k: "conflict" };

type SaveWrite = { ok: true } | { ok: false; issues?: string[]; etag?: string };

/** A write refused with the file's current etag is a 409 (changed since you opened it); every other refusal carries issues only. */
export const isConflict = (r: SaveWrite) => !r.ok && r.etag !== undefined;

/** Cmd/Ctrl+S saves where the editor saves itself. Stops there, so a surrounding panel's own shortcut does not also fire, and never opens the browser's save dialog. */
export const saveShortcut = (onSave: () => void) => (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  e.stopPropagation();
  onSave();
};

type Tone = "info" | "ok" | "warn" | "bad";
export type SaveStatus = { tone: Tone; text: string; busy?: boolean } | null;

const TONE: Record<Tone, string> = { info: "text-ink-2", ok: "text-ok", warn: "text-warn", bad: "text-bad" };

export function saveStatus(phase: SavePhase, dirty: boolean, opts: { savedText: string; problems?: string[] }): SaveStatus {
  switch (phase.k) {
    case "saving":
      return { tone: "info", text: "Saving…", busy: true };
    case "saved":
      return dirty ? { tone: "info", text: "Unsaved changes" } : { tone: "ok", text: opts.savedText };
    case "error":
      return { tone: "bad", text: `Not saved: ${phase.issues[0] ?? "the write failed"}` };
    case "conflict":
      return { tone: "warn", text: "Not saved: the file changed on disk since you opened it." };
    default:
      if (dirty && opts.problems?.length) return { tone: "bad", text: opts.problems.length === 1 ? opts.problems[0]! : `${opts.problems.length} problems to fix before saving` };
      return dirty ? { tone: "info", text: "Unsaved changes" } : null;
  }
}

export function SaveBar({ status, dirty, canSave, saving, onSave, onDiscard }: { status: SaveStatus; dirty: boolean; canSave: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
      <div role="status" className="min-w-0 flex-1 basis-52">
        <AnimatePresence mode="popLayout" initial={false}>
          {status && (
            <motion.p key={status.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={spring} className={cn("flex items-center gap-1.5 text-[12.5px]", TONE[status.tone])}>
              {status.busy ? <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden /> : status.tone === "ok" ? <Check size={14} strokeWidth={2.6} className="shrink-0" aria-hidden /> : status.tone === "bad" || status.tone === "warn" ? <TriangleAlert size={13} className="shrink-0" aria-hidden /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />}
              <span className="line-clamp-2">{status.text}</span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      {dirty && !saving && (
        <Button variant="quiet" onClick={onDiscard}>
          Discard changes
        </Button>
      )}
      <Button variant="primary" onClick={onSave} disabled={!canSave} aria-keyshortcuts="Meta+S Control+S">
        {saving && <LoaderCircle size={13} className="animate-spin" aria-hidden />} Save
        <span className="hidden sm:inline">
          <Kbd>⌘S</Kbd>
        </span>
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * Shown when a save hits a file that changed on disk. `theirs` is what is on disk now (null while it loads).
 * The diff reads: + is yours, - is on disk.
 */
export function ConflictBanner({ what, mine, theirs, busy, onLoadTheirs, onOverwrite, onKeepEditing }: { what: string; mine: string; theirs: string | null; busy?: boolean; onLoadTheirs: () => void; onOverwrite: () => void; onKeepEditing: () => void }) {
  const rows = useMemo(() => (theirs === null ? [] : collapse(lineDiff(theirs, mine))), [theirs, mine]);
  const same = theirs !== null && rows.every((r) => r.kind === "same");
  return (
    <motion.section aria-label="Edit conflict" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden rounded-lg border border-warn/40 bg-warn/6">
      <div className="space-y-3 px-4 py-3.5">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">{what} changed on disk since you opened it</h3>
          <p className="text-[12.5px] text-ink-2">Lines marked + are yours, lines marked − are on disk now.</p>
        </div>
        {theirs === null && <Skeleton className="h-20 w-full" />}
        {theirs !== null && (
          <div tabIndex={0} role="group" aria-label={`Differences in ${what}`} className="max-h-48 overflow-auto rounded-lg border border-line bg-sunken font-mono text-[11.5px] leading-[1.55]">
            {same ? (
              <p className="p-3 font-sans text-ink-3">No differences in content; only the file version changed.</p>
            ) : (
              rows.map((l, i) => (
                <div key={i} className={cn("px-3 whitespace-pre-wrap", l.kind === "add" && "bg-ok/12 text-ink", l.kind === "del" && "bg-bad/12 text-ink-2", l.kind === "same" && "text-ink-3", l.kind === "gap" && "py-0.5 font-sans text-[11px] text-ink-3 italic")}>
                  {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : l.kind === "gap" ? "" : "  "}
                  {l.text}
                </div>
              ))
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={onLoadTheirs}>
            <RefreshCw size={13} /> Load theirs
          </Button>
          <Button variant="primary" disabled={busy || theirs === null} onClick={onOverwrite}>
            {busy && <LoaderCircle size={13} className="animate-spin" aria-hidden />} Overwrite with mine
          </Button>
          <Button variant="quiet" onClick={onKeepEditing} className="sm:ml-auto">
            Keep editing
          </Button>
        </div>
      </div>
    </motion.section>
  );
}

type Row = { kind: "same" | "add" | "del" | "gap"; text: string };

/** Long unchanged runs shrink to their first and last line plus a count, so the change stays in view. */
function collapse(lines: ReturnType<typeof lineDiff>): Row[] {
  const out: Row[] = [];
  let run: Row[] = [];
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
  return out;
}
