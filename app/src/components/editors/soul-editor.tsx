"use client";
import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { RefreshCw, Sparkles } from "lucide-react";
import { saveSharedSoul, useSharedSoul } from "@/lib/client/library";
import { Button, Skeleton } from "@/components/ui";
import { Callout } from "@/components/settings/controls";
import { MAX_TEXT, MarkdownSurface } from "./markdown-surface";
import { ConflictBanner, SaveBar, saveShortcut, saveStatus, isConflict, type SavePhase } from "./parts";
import { SOUL_PLACEHOLDER, SOUL_STARTER } from "./soul-starter";

/**
 * Markdown editor for a soul (the persona block of an agent's prompt).
 * Controlled: the builder owns the draft and its save (agent soul text rides along with the config save).
 */
export function SoulEditor({ value, onChange, label, readOnly }: { value: string; onChange: (next: string) => void; label: string; readOnly?: boolean }) {
  return (
    <MarkdownSurface
      value={value}
      onChange={onChange}
      label={label}
      readOnly={readOnly}
      placeholder={SOUL_PLACEHOLDER}
      rows={12}
      action={
        !readOnly &&
        value.trim() === "" && (
          <Button variant="ghost" className="h-7" onClick={() => onChange(SOUL_STARTER)}>
            <Sparkles size={13} aria-hidden /> Insert starter
          </Button>
        )
      }
    />
  );
}

/* ---------------------------------------------------------------------------------------------- */

export type SharedSoulViewProps = {
  loading: boolean;
  /** The file could not be read (the studio is not reachable, or SOUL.md is unreadable). */
  failed: boolean;
  text: string;
  onChange: (next: string) => void;
  dirty: boolean;
  phase: SavePhase;
  /** What is on disk now, for the conflict diff. */
  theirs: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onLoadTheirs: () => void;
  onOverwrite: () => void;
  onKeepEditing: () => void;
  onRetry: () => void;
};

/** The shared soul as a pure view: all data and callbacks arrive as props. */
export function SharedSoulView(p: SharedSoulViewProps) {
  const saving = p.phase.k === "saving";
  const over = p.text.length > MAX_TEXT;
  const canSave = p.dirty && !over && !saving && p.phase.k !== "conflict";
  const status = saveStatus(p.phase, p.dirty, { savedText: "Saved. Agents on the shared soul read it on their next message.", problems: over ? [`The soul is over the ${MAX_TEXT.toLocaleString("en-US")} character limit.`] : [] });
  return (
    <div className="space-y-3" onKeyDown={saveShortcut(() => canSave && p.onSave())}>
      <Callout title="Shared soul: ~/.eigen/SOUL.md">
        Every agent whose soul is set to Shared reads this file at the start of its next message, so a change here reaches all of them at once. Agents with their own soul, or none, are not affected.
      </Callout>
      {p.loading && <Skeleton className="h-64 w-full" />}
      {!p.loading && p.failed && (
        <Callout tone="bad" title="Could not read SOUL.md">
          <div className="mt-2">
            <Button variant="ghost" onClick={p.onRetry}>
              <RefreshCw size={13} /> Try again
            </Button>
          </div>
        </Callout>
      )}
      {!p.loading && !p.failed && (
        <>
          <AnimatePresence initial={false}>
            {p.phase.k === "conflict" && <ConflictBanner key="conflict" what="SOUL.md" mine={p.text} theirs={p.theirs} onLoadTheirs={p.onLoadTheirs} onOverwrite={p.onOverwrite} onKeepEditing={p.onKeepEditing} />}
          </AnimatePresence>
          <MarkdownSurface
            value={p.text}
            onChange={p.onChange}
            label="Shared soul (SOUL.md)"
            placeholder={SOUL_PLACEHOLDER}
            rows={16}
            action={
              p.text.trim() === "" && (
                <Button variant="ghost" className="h-7" onClick={() => p.onChange(SOUL_STARTER)}>
                  <Sparkles size={13} aria-hidden /> Insert starter
                </Button>
              )
            }
          />
          <SaveBar status={status} dirty={p.dirty} canSave={canSave} saving={saving} onSave={p.onSave} onDiscard={p.onDiscard} />
        </>
      )}
    </div>
  );
}

/** Edits and saves the SHARED ~/.eigen/SOUL.md on its own (it belongs to every agent on soul.source "shared"). */
export function SharedSoulEditor() {
  const { soul, isLoading, refresh } = useSharedSoul();
  // null until the first keystroke: the text on disk is shown (and follows it) until then.
  const [draft, setDraft] = useState<string | null>(null);
  const [phase, setPhase] = useState<SavePhase>({ k: "idle" });
  // The version the draft started from. A save sends it, so it fails instead of overwriting a file that moved on.
  const base = useRef<string | undefined>(undefined);

  const text = draft ?? soul?.text ?? "";
  const dirty = draft !== null && draft !== soul?.text;

  const change = (next: string) => {
    if (draft === null) base.current = soul?.etag;
    setDraft(next);
    setPhase((p) => (p.k === "error" || p.k === "saved" ? { k: "idle" } : p));
  };

  const save = async (etag: string | undefined) => {
    if (draft === null || phase.k === "saving") return;
    const sent = draft;
    setPhase({ k: "saving" });
    const r = await saveSharedSoul(sent, etag).catch((e: unknown) => ({ ok: false as const, issues: [e instanceof Error ? e.message : "the request failed"] }));
    if (r.ok) {
      // saveSharedSoul has already refreshed what is on disk. Keep anything typed while the save was in flight; it is based on the version just written.
      base.current = r.etag;
      setDraft((cur) => (cur === sent ? null : cur));
      setPhase({ k: "saved" });
    } else if (isConflict(r)) {
      await refresh();
      setPhase({ k: "conflict" });
    } else {
      setPhase({ k: "error", issues: r.issues ?? [] });
    }
  };

  return (
    <SharedSoulView
      loading={isLoading && !soul}
      failed={!isLoading && !soul}
      text={text}
      onChange={change}
      dirty={dirty}
      phase={phase}
      theirs={soul?.text ?? null}
      onSave={() => void save(base.current)}
      onDiscard={() => {
        setDraft(null);
        setPhase({ k: "idle" });
      }}
      onLoadTheirs={() => {
        setDraft(null);
        setPhase({ k: "idle" });
      }}
      onOverwrite={() => void save(soul?.etag)}
      onKeepEditing={() => setPhase({ k: "idle" })}
      onRetry={() => void refresh()}
    />
  );
}
