"use client";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { inputCls } from "@/components/builder/panels/fields";
import { countLines } from "./format";

/** The engine refuses more than this for a soul or a SKILL.md (UpdateAgentConfigRequest.soulText, WriteSkillRequest). */
export const MAX_TEXT = 100_000;

/**
 * A plain writing surface for markdown: monospace, soft-wrapped, with a line and character count against the limit.
 * Tab is left alone on purpose, so the keyboard can always move on to the next control. `action` sits at the right of the count line.
 */
export function MarkdownSurface({
  value,
  onChange,
  label,
  readOnly,
  placeholder,
  rows = 14,
  invalid,
  action,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  readOnly?: boolean;
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  action?: ReactNode;
}) {
  const countId = useId();
  const over = value.length > MAX_TEXT;
  const near = value.length > MAX_TEXT * 0.9;
  const lines = countLines(value);
  return (
    <div>
      <textarea
        aria-label={label}
        aria-describedby={countId}
        aria-invalid={invalid || over || undefined}
        value={value}
        readOnly={readOnly}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputCls(invalid || over), "min-h-40 resize-y font-mono text-[13px] leading-[1.6]", readOnly && "cursor-default bg-sunken text-ink-2 focus:bg-sunken")}
      />
      <div className="mt-1.5 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-3">
        <span id={countId} className={cn("tabular-nums", near && !over && "text-warn", over && "text-bad")}>
          {lines.toLocaleString("en-US")} {lines === 1 ? "line" : "lines"} · {value.length.toLocaleString("en-US")} / {MAX_TEXT.toLocaleString("en-US")} characters{over ? ` (${(value.length - MAX_TEXT).toLocaleString("en-US")} too many)` : ""}
        </span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
    </div>
  );
}
