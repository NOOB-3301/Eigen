"use client";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { MarkdownSurface } from "./markdown-surface";
import { SOUL_PLACEHOLDER, SOUL_STARTER } from "./soul-starter";

/**
 * Markdown editor for an agent's soul (the persona block of its prompt, a file in its own folder).
 * Controlled: the builder owns the draft, and the text is saved with the config on Apply.
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
