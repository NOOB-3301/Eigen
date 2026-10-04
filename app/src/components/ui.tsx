"use client";
import { useEffect, useId, useRef, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AgentStatus } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";

export const spring = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const;
export const softSpring = { type: "spring", stiffness: 260, damping: 30 } as const;

/* ---------------------------------------------------------------------------------------------- */

export const STATUS: Record<AgentStatus, { label: string; tone: string; hint: string }> = {
  loaded: { label: "Loaded", tone: "bg-ok", hint: "Running with the current files" },
  stale: { label: "Stale", tone: "bg-warn", hint: "The file is invalid; the last good version keeps running" },
  invalid: { label: "Invalid", tone: "bg-bad", hint: "Never loaded: the config has problems" },
  disabled: { label: "Disabled", tone: "bg-off", hint: "Turned off in its config" },
  offline: { label: "Engine offline", tone: "", hint: "The engine is not running, so load status is unknown" },
};

export function StatusDot({ status, className, pulse }: { status: AgentStatus; className?: string; pulse?: boolean }) {
  const s = STATUS[status];
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      {status === "offline" ? (
        <span className="size-2.5 rounded-full border-[1.5px] border-dashed border-off" />
      ) : (
        <>
          {pulse && status === "loaded" && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-50", s.tone)} />}
          <span className={cn("relative size-2.5 rounded-full", s.tone)} />
        </>
      )}
    </span>
  );
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span title={STATUS[status].hint} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink-2">
      <StatusDot status={status} className="size-2" />
      {STATUS[status].label}
    </span>
  );
}

/** Stable hue per agent id so each module keeps its color across sessions and themes. */
export const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function Monogram({ id, name, size = 36, className }: { id: string; name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("monogram grid shrink-0 place-items-center rounded-[10px] font-semibold", className)}
      style={{ ["--h" as string]: hueOf(id), width: size, height: size, fontSize: size * 0.42 }}
    >
      {(name.trim()[0] ?? id[0] ?? "?").toUpperCase()}
    </span>
  );
}

/* ---------------------------------------------------------------------------------------------- */

type Variant = "primary" | "ghost" | "quiet" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50",
  ghost: "border border-line bg-panel text-ink hover:bg-raised hover:border-line-strong disabled:opacity-50",
  quiet: "text-ink-2 hover:bg-raised hover:text-ink disabled:opacity-40",
  danger: "bg-bad text-white hover:brightness-110 disabled:opacity-50",
};

export function Button({ variant = "ghost", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...p}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-[background,color,filter,border-color] disabled:cursor-not-allowed",
        VARIANT[variant],
        className,
      )}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1.5 py-px font-mono text-[11px] text-ink-3">{children}</kbd>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-sunken",
      )}
    >
      <motion.span layout transition={spring} className={cn("block size-3.5 rounded-full shadow-sm", checked ? "ml-[18px] bg-accent-ink" : "ml-[2px] bg-ink-3")} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]!;
                onChange(next.value);
              }
            }}
            tabIndex={on ? 0 : -1}
            className={cn("relative h-7 rounded-md px-2.5 text-[12.5px] transition-colors", on ? "text-ink" : "text-ink-3 hover:text-ink-2")}
          >
            {on && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-md border border-line bg-panel shadow-sm" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-sunken", className)} />;
}

/* ---------------------------------------------------------------------------------------------- */

/** Modal dialog: focus trap, Escape to close, focus restored to the opener, scrim click closes. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = (initialFocus && ref.current?.querySelector<HTMLElement>(initialFocus)) || ref.current?.querySelector<HTMLElement>("input,textarea,select,button");
      el?.focus();
    }, 20);
    return () => {
      clearTimeout(t);
      opener?.focus?.();
    };
  }, [open, initialFocus]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key !== "Tab" || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled"));
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const mounted = useSyncExternalStore(noop, () => true, () => false);
  if (!mounted) return null;
  // Portaled to <body> so a transformed ancestor (the sliding inspector) never becomes its containing block.
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-start justify-center overflow-y-auto px-4 pt-[12vh] pb-8" onKeyDown={onKeyDown}>
          <motion.div
            className="fixed inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={spring}
            className={cn("relative w-full max-w-lg rounded-2xl border border-line bg-panel shadow-float", className)}
          >
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
            {description && (
              <p id={descId} className="sr-only">
                {description}
              </p>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const noop = () => () => {};
