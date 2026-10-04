"use client";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Ban, Check, ChevronRight, Loader2, ShieldQuestion, TriangleAlert, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, softSpring } from "@/components/ui";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

const MAX_SHOWN = 4000;

const show = (v: unknown) => {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}\n… ${s.length - MAX_SHOWN} more characters` : s;
};

/** One line of what the call was for, from its arguments ({"command":"ls -la"} -> ls -la). */
const summary = (input: unknown) => {
  if (input && typeof input === "object") {
    const vals = Object.values(input).filter((v) => typeof v === "string" || typeof v === "number");
    if (vals.length) return vals.join(" · ");
  }
  return typeof input === "string" ? input : "";
};

export const toolName = (p: ToolPart) => (p.type === "dynamic-tool" ? p.toolName : p.type.slice("tool-".length));

const STATE: Record<ToolPart["state"], { label: string; icon: React.ReactNode; tone: string }> = {
  "input-streaming": { label: "Preparing", icon: <Loader2 size={13} className="animate-spin" />, tone: "text-ink-3" },
  "input-available": { label: "Running", icon: <Loader2 size={13} className="animate-spin" />, tone: "text-accent" },
  "approval-requested": { label: "Needs approval", icon: <ShieldQuestion size={13} />, tone: "text-warn" },
  "approval-responded": { label: "Answered", icon: <Loader2 size={13} className="animate-spin" />, tone: "text-ink-3" },
  "output-available": { label: "Done", icon: <Check size={13} />, tone: "text-ok" },
  "output-error": { label: "Failed", icon: <TriangleAlert size={13} />, tone: "text-bad" },
  "output-denied": { label: "Denied", icon: <Ban size={13} />, tone: "text-ink-3" },
};

/**
 * A tool call as a compact card: name, a one-line summary, state. Expands to the (truncated) arguments and result.
 * A call waiting for approval opens itself and offers Approve / Deny; the answer resumes the suspended run in the engine.
 */
export function ToolCard({ part, onAnswer, answerable }: { part: ToolPart; onAnswer: (id: string, approved: boolean) => void; answerable: boolean }) {
  const pending = part.state === "approval-requested";
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const s = STATE[part.state];
  const expanded = open || pending;
  const output = part.state === "output-available" ? part.output : part.state === "output-error" ? part.errorText : undefined;

  return (
    <div className={cn("my-1.5 overflow-hidden rounded-lg border bg-raised/60", pending ? "border-warn/50" : "border-line")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-raised"
      >
        <ChevronRight size={13} className={cn("shrink-0 text-ink-3 transition-transform", expanded && "rotate-90")} />
        <Wrench size={12} className="shrink-0 text-ink-3" />
        <span className="shrink-0 font-mono font-medium text-ink">{toolName(part)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{summary(part.input)}</span>
        <span className={cn("flex shrink-0 items-center gap-1", s.tone)}>
          {s.icon}
          <span className="max-[420px]:sr-only">{s.label}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t border-line px-2.5 py-2">
              <Block label="Arguments" text={show(part.input)} />
              {output !== undefined && <Block label={part.state === "output-error" ? "Error" : "Result"} text={show(output)} />}
              {pending && (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="mr-auto text-[12px] text-ink-2">Run this tool?</span>
                  <Button variant="ghost" className="h-7 px-2.5 text-[12.5px]" disabled={!answerable} onClick={() => onAnswer(part.approval.id, false)}>
                    <Ban size={13} /> Deny
                  </Button>
                  <Button variant="primary" className="h-7 px-2.5 text-[12.5px]" disabled={!answerable} onClick={() => onAnswer(part.approval.id, true)}>
                    <Check size={13} /> Approve
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">{label}</div>
      <pre className="max-h-56 overflow-auto rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{text}</pre>
    </div>
  );
}
