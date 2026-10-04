"use client";

/** The skill library: list, search, create. Pick one to edit. INTERFACE ONLY: the editors worker builds it. */
export function SkillLibrary({ onPick, selected }: { onPick: (slug: string) => void; selected?: string | null }) {
  void onPick;
  void selected;
  return <div>Skill library</div>;
}

/** Edits and saves one skill's SKILL.md on its own (etag, validation, conflict). Read-only for ClawHub skills. */
export function SkillEditor({ slug, onClose, onDeleted }: { slug: string; onClose?: () => void; onDeleted?: () => void }) {
  void onClose;
  void onDeleted;
  return <div>Skill editor: {slug}</div>;
}
