"use client";

/**
 * Markdown editor for a soul (the persona block of an agent's prompt). INTERFACE ONLY: the editors worker builds it.
 * Controlled: the builder owns the draft and its save (agent soul text rides along with the config save).
 */
export function SoulEditor({ value, onChange, label, readOnly }: { value: string; onChange: (next: string) => void; label: string; readOnly?: boolean }) {
  return <textarea aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} className="h-64 w-full" />;
}

/** Edits and saves the SHARED ~/.eigen/SOUL.md on its own (it belongs to every agent on soul.source "shared"). */
export function SharedSoulEditor() {
  return <div>Shared soul editor</div>;
}
