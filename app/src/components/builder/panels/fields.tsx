"use client";
import { createContext, useContext, useId, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { getPath, setPath } from "@/lib/client/draft";

/* Draft access: every builder panel field reads and writes the raw config by dotted path (the pure helpers live in lib/client/draft.ts). */

type Obj = Record<string, unknown>;
export { getPath, setPath };

export type FormCtx = {
  config: Obj;
  set: (path: string, value: unknown) => void;
  errors: Record<string, string>;
};
export const Form = createContext<FormCtx | null>(null);
export function useForm() {
  const f = useContext(Form);
  if (!f) throw new Error("useForm outside <Form>");
  return f;
}

/** First error at this path or below it ("memory" also shows "memory.lastMessages"). */
export function errorAt(errors: Record<string, string>, path: string) {
  return errors[path] ?? Object.entries(errors).find(([k]) => k.startsWith(`${path}.`))?.[1];
}

/* ---------------------------------------------------------------------------------------------- */

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-5 last:border-b-0">
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 max-w-[60ch] text-[12.5px] text-ink-3">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  path,
  hint,
  children,
  aside,
}: {
  label: string;
  path?: string;
  hint?: string;
  children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  aside?: ReactNode;
}) {
  const id = useId();
  const { errors } = useForm();
  const error = path ? errorAt(errors, path) : undefined;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint && hintId, error && errId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <label htmlFor={id} className="text-[12.5px] font-medium text-ink-2">
          {label}
        </label>
        <div className="ml-auto flex items-center gap-1.5">{aside}</div>
      </div>
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-[12px] text-ink-3">
          {hint}
        </p>
      )}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            id={errId}
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 text-[12px] text-bad"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

export const inputCls = (invalid?: boolean) =>
  cn(
    "w-full rounded-lg border bg-raised px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-3 transition-colors focus:bg-panel focus:outline-none focus-visible:outline-2 focus-visible:outline-accent",
    invalid ? "border-bad" : "border-line hover:border-line-strong",
  );

export function TextField({ label, path, hint, multiline, placeholder, rows = 3 }: { label: string; path: string; hint?: string; multiline?: boolean; placeholder?: string; rows?: number }) {
  const { config, set } = useForm();
  const v = getPath(config, path);
  const value = typeof v === "string" ? v : "";
  return (
    <Field label={label} path={path} hint={hint}>
      {({ id, describedBy, invalid }) =>
        multiline ? (
          <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={rows} value={value} placeholder={placeholder} onChange={(e) => set(path, e.target.value)} className={cn(inputCls(invalid), "resize-y leading-relaxed")} />
        ) : (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid} value={value} placeholder={placeholder} onChange={(e) => set(path, e.target.value)} className={inputCls(invalid)} />
        )
      }
    </Field>
  );
}

export function NumberInput({ id, value, onChange, invalid, describedBy, min = 1 }: { id?: string; value: number | undefined; onChange: (v: number | undefined) => void; invalid?: boolean; describedBy?: string; min?: number }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      className={cn(inputCls(invalid), "w-28 font-mono tabular-nums")}
    />
  );
}

export function SwitchRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>}
      </div>
      <div className="pt-0.5">{children}</div>
    </div>
  );
}

export function ChipToggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors",
        on ? "border-accent/60 bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
