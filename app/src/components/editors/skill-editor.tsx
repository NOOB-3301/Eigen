"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { createSkill, deleteSkill, saveSkill, useSkill, useSkills } from "@/lib/client/library";
import { NewSkillDialog, SkillEditorView, SkillLibraryView } from "./skill-views";
import { isConflict, type SavePhase } from "./parts";

/** The skill library: list, search, create. Pick one to edit. */
export function SkillLibrary({ agentId, onPick, selected }: { agentId: string; onPick: (slug: string) => void; selected?: string | null }) {
  const { skills, isLoading } = useSkills(agentId);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <SkillLibraryView skills={skills} loading={isLoading && skills.length === 0} selected={selected} onPick={onPick} onNew={() => setCreating(true)} />
      <NewSkillDialog
        open={creating}
        onClose={() => setCreating(false)}
        existing={skills.map((s) => s.slug)}
        onCreate={async (input) => {
          const r = await createSkill(agentId, input);
          if (r.ok) toast.success(`Created ${input.slug}`, { description: "Its SKILL.md is in this agent's skills folder. Connect it to let the agent load it." });
          return r;
        }}
        onCreated={onPick}
      />
    </>
  );
}

/** Edits and saves one skill's SKILL.md in one agent's library, on its own (etag, validation, conflict). Read-only for ClawHub skills. */
export function SkillEditor(props: { agentId: string; slug: string; onClose?: () => void; onDeleted?: () => void }) {
  // Keyed by slug so picking another skill starts from a clean draft instead of carrying the last one over.
  return <SkillEditorBody key={props.slug} {...props} />;
}

function SkillEditorBody({ agentId, slug, onClose, onDeleted }: { agentId: string; slug: string; onClose?: () => void; onDeleted?: () => void }) {
  const { skill, isLoading, error, refresh } = useSkill(agentId, slug);
  const { skills } = useSkills(agentId);
  // null until the first keystroke: the text on disk is shown (and follows it) until then.
  const [draft, setDraft] = useState<string | null>(null);
  const [phase, setPhase] = useState<SavePhase>({ k: "idle" });
  const [trash, setTrash] = useState<{ busy: boolean; done?: boolean; error?: string }>({ busy: false });
  // The version the draft started from. A save sends it, so it fails instead of overwriting a file that moved on.
  const base = useRef<string | undefined>(undefined);

  // Once the folder is moved its cache is empty. Until the parent closes the editor, show the skeleton rather than a "not found" error.
  const closing = trash.busy || !!trash.done;
  const text = draft ?? skill?.text ?? "";
  const dirty = draft !== null && draft !== skill?.text;

  const change = (next: string) => {
    if (draft === null) base.current = skill?.etag;
    setDraft(next);
    setPhase((p) => (p.k === "error" || p.k === "saved" ? { k: "idle" } : p));
  };

  const save = async (etag: string | undefined) => {
    if (draft === null || phase.k === "saving") return;
    const sent = draft;
    setPhase({ k: "saving" });
    const r = await saveSkill(agentId, slug, sent, etag).catch((e: unknown) => ({ ok: false as const, issues: [e instanceof Error ? e.message : "the request failed"] }));
    if (r.ok) {
      // saveSkill has already refreshed this skill and the list. Keep anything typed while the save was in flight; it is based on the version just written.
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

  const discard = () => {
    setDraft(null);
    setPhase({ k: "idle" });
  };

  const moveToTrash = async () => {
    if (trash.busy) return;
    setTrash({ busy: true });
    const r = await deleteSkill(agentId, slug).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "the request failed" }));
    if (!r.ok) {
      setTrash({ busy: false, error: r.error ?? "the folder could not be moved" });
      return;
    }
    setTrash({ busy: false, done: true });
    toast.success(`Moved ${slug} to the trash`, { description: "The folder is in the agent's .trash." });
    onDeleted?.();
  };

  return (
    <SkillEditorView
      slug={slug}
      origin={skill?.origin ?? "user"}
      loading={!skill && (isLoading || closing)}
      loadError={!skill && !isLoading && !closing ? (error ?? "The skill was not found.") : undefined}
      text={text}
      onChange={change}
      dirty={dirty}
      phase={phase}
      theirs={skill?.text ?? null}
      files={skill?.files ?? []}
      problem={skill?.problem}
      enabled={skills.find((s) => s.slug === slug)?.enabled ?? false}
      trashing={trash.busy}
      trashError={trash.error}
      onSave={() => void save(base.current)}
      onDiscard={discard}
      onLoadTheirs={discard}
      onOverwrite={() => void save(skill?.etag)}
      onKeepEditing={() => setPhase({ k: "idle" })}
      onTrash={() => void moveToTrash()}
      onClose={onClose}
    />
  );
}
