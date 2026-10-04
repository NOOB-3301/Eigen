"use client";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { ChevronDown, Info, Plus, TriangleAlert, X } from "lucide-react";
import type { Config } from "@eigen/engine/config";
import { Field, SwitchRow, getPath, inputCls, useForm } from "@/components/inspector/fields";
import { Button, Segmented, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";

export type Obj = Record<string, unknown>;

/* Settings-wide context: the schema defaults (shown as placeholders) and the saved file (what Test and rename rules compare against). */
export type RootCtx = { defaults: Config; base: Obj };
export const Root = createContext<RootCtx | null>(null);
export function useRoot() {
  const r = useContext(Root);
  if (!r) throw new Error("useRoot outside <Root>");
  return r;
}

/* ---------------------------------------------------------------------------------------------- */
/* Context-free pieces (also used by McpServerForm, which lives in the agent inspector too)         */
/* ---------------------------------------------------------------------------------------------- */

export function Labeled({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (a: { id: string; invalid: boolean }) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
        {label}
      </label>
      {children({ id, invalid: !!error })}
      {error ? (
        <p role="alert" className="mt-1.5 text-[12px] text-bad">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[12px] text-ink-3">{hint}</p>
      )}
    </div>
  );
}

const TONE = {
  info: "border-line bg-raised text-ink-2",
  warn: "border-warn/40 bg-warn/8 text-ink",
  bad: "border-bad/40 bg-bad/8 text-ink",
} as const;

export function Callout({ tone = "info", title, children }: { tone?: keyof typeof TONE; title?: string; children?: ReactNode }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <div role={tone === "info" ? undefined : "note"} className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed", TONE[tone])}>
      <Icon size={15} className={cn("mt-0.5 shrink-0", tone === "warn" && "text-warn", tone === "bad" && "text-bad", tone === "info" && "text-ink-3")} aria-hidden />
      <div className="min-w-0">
        {title && <div className="font-medium text-ink">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** One entry per line. Keeps its own text so blank lines and half-typed entries survive until the value really changes. */
export function LineList({ value, onChange, placeholder, rows = 3, id, invalid, mono = true }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number; id?: string; invalid?: boolean; mono?: boolean }) {
  const joined = value.join("\n");
  const [text, setText] = useState(joined);
  const [prev, setPrev] = useState(joined);
  const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (joined !== prev) {
    setPrev(joined);
    if (lines(text).join("\n") !== joined) setText(joined);
  }
  return (
    <textarea
      id={id}
      rows={rows}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      aria-invalid={invalid}
      onChange={(e) => {
        setText(e.target.value);
        onChange(lines(e.target.value));
      }}
      className={cn(inputCls(invalid), "resize-y leading-relaxed", mono && "font-mono text-[12.5px]")}
    />
  );
}

/** Name = value rows (MCP env and headers). `renderValue` lets a row draw extra controls under its value (secret input, warnings). */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "NAME",
  valuePlaceholder = "value or env:NAME",
  renderExtra,
  addLabel = "Add",
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string> | undefined) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  renderExtra?: (key: string, val: string) => ReactNode;
  addLabel?: string;
}) {
  // Rows keep their order and allow a blank or duplicate key while typing; the record is rebuilt from them.
  const entries = Object.entries(value);
  const [rows, setRows] = useState<Array<[string, string]>>(entries);
  const sig = JSON.stringify(entries);
  const [prev, setPrev] = useState(sig);
  if (sig !== prev) {
    setPrev(sig);
    const mine = JSON.stringify(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    if (mine !== sig) setRows(entries);
  }
  const push = (next: Array<[string, string]>) => {
    setRows(next);
    const rec: Record<string, string> = {};
    for (const [k, v] of next) if (k.trim()) rec[k.trim()] = v;
    onChange(Object.keys(rec).length ? rec : undefined);
  };
  return (
    <div className="space-y-2">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <div className="flex items-center gap-2">
            <input aria-label={`${keyPlaceholder} ${i + 1}`} value={k} placeholder={keyPlaceholder} spellCheck={false} onChange={(e) => push(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className={cn(inputCls(), "w-[38%] font-mono text-[12.5px]")} />
            <input aria-label={`Value ${i + 1}`} value={v} placeholder={valuePlaceholder} spellCheck={false} onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className={cn(inputCls(), "min-w-0 flex-1 font-mono text-[12.5px]")} />
            <Button variant="quiet" aria-label={`Remove row ${i + 1}`} className="px-2" onClick={() => push(rows.filter((_, j) => j !== i))}>
              <X size={14} />
            </Button>
          </div>
          {k.trim() && renderExtra?.(k.trim(), v)}
        </div>
      ))}
      <Button variant="ghost" onClick={() => push([...rows, ["", ""]])}>
        <Plus size={13} /> {addLabel}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Form-bound fields: read and write the draft by dotted path; an unset value falls back to the default */
/* ---------------------------------------------------------------------------------------------- */

const defaultOf = (defaults: Config, path: string) => getPath(defaults, path);
const sameAsDefault = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function NumField({ label, path, hint, min = 1, width = "w-36" }: { label: string; path: string; hint?: string; min?: number; width?: string }) {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const def = defaultOf(defaults, path) as number | undefined;
  const v = getPath(config, path) as number | undefined;
  return (
    <Field label={label} path={path} hint={hint ?? (def !== undefined ? `Default ${def.toLocaleString("en-US")}` : undefined)}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          placeholder={def !== undefined ? String(def) : undefined}
          value={v ?? ""}
          onChange={(e) => set(path, e.target.value === "" ? undefined : Number(e.target.value))}
          className={cn(inputCls(invalid), width, "font-mono tabular-nums")}
        />
      )}
    </Field>
  );
}

export function StrField({ label, path, hint, placeholder, mono = false }: { label: string; path: string; hint?: string; placeholder?: string; mono?: boolean }) {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const def = defaultOf(defaults, path) as string | undefined;
  const v = getPath(config, path);
  return (
    <Field label={label} path={path} hint={hint ?? (def ? `Default ${def}` : undefined)}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          spellCheck={false}
          placeholder={placeholder ?? def}
          value={typeof v === "string" ? v : ""}
          onChange={(e) => set(path, e.target.value === "" ? undefined : e.target.value)}
          className={cn(inputCls(invalid), mono && "font-mono text-[13px]")}
        />
      )}
    </Field>
  );
}

export function BoolField({ label, path, hint }: { label: string; path: string; hint?: string }) {
  const { config, set } = useForm();
  const { defaults, base } = useRoot();
  const def = defaultOf(defaults, path) as boolean;
  const v = getPath(config, path);
  const on = typeof v === "boolean" ? v : def;
  return (
    <SwitchRow label={label} hint={hint}>
      <Switch label={label} checked={on} onChange={(next) => set(path, sameAsDefault(next, def) && getPath(base, path) === undefined ? undefined : next)} />
    </SwitchRow>
  );
}

export function ChoiceField<T extends string>({ label, path, options, hint }: { label: string; path: string; options: Array<{ value: T; label: string }>; hint?: string }) {
  const { config, set } = useForm();
  const { defaults, base } = useRoot();
  const def = defaultOf(defaults, path) as T;
  const v = getPath(config, path) as T | undefined;
  return (
    <Field label={label} path={path} hint={hint}>
      {() => <Segmented label={label} value={v ?? def} options={options} onChange={(next) => set(path, next === def && getPath(base, path) === undefined ? undefined : next)} />}
    </Field>
  );
}

export function SelectInput({ id, value, onChange, options, invalid, describedBy, className }: { id?: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; invalid?: boolean; describedBy?: string; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <select id={id} value={value} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} className={cn(inputCls(invalid), "appearance-none pr-9")}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3" />
    </div>
  );
}

/** A root model reference (observational / knowledge / curator). Empty = "use the default". */
export function ModelRefField({ label, path, hint, emptyLabel }: { label: string; path: string; hint?: string; emptyLabel: string }) {
  const { config, set } = useForm();
  const models = Object.keys((config.models ?? {}) as Obj);
  const v = getPath(config, path);
  const cur = typeof v === "string" ? v : "";
  const options = [{ value: "", label: emptyLabel }, ...(cur && !models.includes(cur) ? [{ value: cur, label: `${cur} (missing)` }] : []), ...models.map((k) => ({ value: k, label: k }))];
  return (
    <Field label={label} path={path} hint={hint}>
      {({ id, describedBy, invalid }) => <SelectInput id={id} describedBy={describedBy} invalid={invalid} value={cur} onChange={(x) => set(path, x || undefined)} options={options} className="max-w-xs" />}
    </Field>
  );
}

/** List of lines bound to a path. `int` stores numbers; a line that is not a whole number is kept as text so validation can point at it. */
export function ListField({ label, path, hint, placeholder, int = false, rows = 3, mono = true }: { label: string; path: string; hint?: string; placeholder?: string; int?: boolean; rows?: number; mono?: boolean }) {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const raw = getPath(config, path);
  const def = defaultOf(defaults, path) as unknown[] | undefined;
  const list = (Array.isArray(raw) ? raw : []).map(String);
  return (
    <Field label={label} path={path} hint={hint}>
      {({ id, invalid }) => (
        <LineList
          id={id}
          invalid={invalid}
          mono={mono}
          rows={rows}
          value={list}
          placeholder={placeholder ?? (def?.length ? def.join("\n") : undefined)}
          onChange={(lines) => set(path, int ? lines.map((l) => (/^-?\d+$/.test(l) ? Number(l) : l)) : lines)}
        />
      )}
    </Field>
  );
}

export const modelKeys = (config: Obj) => Object.keys((config.models ?? {}) as Obj);
