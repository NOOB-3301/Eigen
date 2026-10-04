"use client";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A label, a control, and one line under it: the error when there is one, else the hint. Unlike the inspector's Field it needs no
 * form context, because the editors here are controlled by plain props. The control gets the id and the aria wiring.
 */
export function FormField({
  label,
  hint,
  error,
  aside,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Right-aligned next to the label (a counter, a link). */
  aside?: ReactNode;
  children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <label htmlFor={id} className="text-[12.5px] font-medium text-ink-2">
          {label}
        </label>
        {aside && <div className="ml-auto text-[12px] text-ink-3">{aside}</div>}
      </div>
      {children({ id, describedBy: note ? noteId : undefined, invalid: !!error })}
      {note && (
        <p id={noteId} role={error ? "alert" : undefined} className={cn("mt-1.5 text-[12px]", error ? "text-bad" : "text-ink-3")}>
          {note}
        </p>
      )}
    </div>
  );
}
