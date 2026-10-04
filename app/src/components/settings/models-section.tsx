"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FlaskConical, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Field, Section, errorAt, inputCls, useForm } from "@/components/inspector/fields";
import { SecretInput } from "@/components/secret-input";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { testModel } from "@/lib/client/probes";
import { useSecrets } from "@/lib/client/secrets";
import { Callout, Labeled, ModelRefField, SelectInput, useRoot, type Obj } from "./controls";
import { canon, MODEL_KEY } from "./validate";

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;

const PRESETS: Array<{ label: string; hint: string; key: string; model: Obj }> = [
  { label: "OpenAI", hint: "api.openai.com", key: "openai", model: { id: "openai/gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" } },
  { label: "Anthropic", hint: "api.anthropic.com", key: "claude", model: { id: "anthropic/claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" } },
  { label: "Ollama (local)", hint: "localhost:11434", key: "local", model: { id: "ollama/gemma4:e4b", url: "http://localhost:11434/v1", contextWindow: 28000 } },
  { label: "OpenAI-compatible server", hint: "any base URL", key: "custom", model: { id: "custom/model-name", url: "http://localhost:8000/v1", apiKeyEnv: "CUSTOM_API_KEY" } },
];

function uniqueKey(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export function ModelsSection() {
  const { config, set, errors } = useForm();
  const { base } = useRoot();
  const models = (config.models ?? {}) as Record<string, Obj>;
  const keys = Object.keys(models);
  const baseKeys = Object.keys((base.models ?? {}) as Obj);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const add = (preset: (typeof PRESETS)[number]) => {
    const key = uniqueKey(preset.key, keys);
    set("models", { ...models, [key]: { ...preset.model } });
    if (!config.defaultModel) set("defaultModel", key);
    setJustAdded(key);
  };

  const referencedBy = (k: string) =>
    [
      config.defaultModel === k && "the default model",
      config.curatorModel === k && "the curator",
      (config.memory as Obj | undefined)?.observational && ((config.memory as Obj).observational as Obj).model === k && "observational memory",
      (config.memory as Obj | undefined)?.knowledge && ((config.memory as Obj).knowledge as Obj).model === k && "knowledge memory",
    ].filter(Boolean) as string[];

  return (
    <>
      <Section title="Defaults" hint="Agents that do not pick a model use the default. The curator writes your nightly memory notes.">
        <Field label="Default model" path="defaultModel">
          {({ id, describedBy, invalid }) => (
            <SelectInput id={id} describedBy={describedBy} invalid={invalid} className="max-w-xs" value={typeof config.defaultModel === "string" ? config.defaultModel : ""} onChange={(v) => set("defaultModel", v || undefined)} options={[{ value: "", label: "Pick a model" }, ...keys.map((k) => ({ value: k, label: k }))]} />
          )}
        </Field>
        <ModelRefField label="Curator model" path="curatorModel" emptyLabel="Same as default" hint="A cheaper or local model is fine here." />
      </Section>

      <Section title="Models" hint="Each entry is a name agents refer to. Keys are kept in ~/.eigen/.env, never in config.json.">
        {errors.models && keys.length === 0 && <Callout tone="bad">{errors.models}</Callout>}
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>
            {keys.map((k) => (
              <motion.li key={k} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
                <ModelCard
                  modelKey={k}
                  value={models[k] ?? {}}
                  saved={baseKeys.includes(k)}
                  initiallyOpen={k === justAdded}
                  usedBy={referencedBy(k)}
                  onChange={(next) => set("models", { ...models, [k]: next })}
                  onRename={(to) => {
                    set("models", Object.fromEntries(Object.entries(models).map(([key, v]) => [key === k ? to : key, v])));
                    if (config.defaultModel === k) set("defaultModel", to);
                    setJustAdded(to);
                  }}
                  onRemove={() => {
                    const rest = { ...models };
                    delete rest[k];
                    set("models", rest);
                  }}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <div>
          <div className="mb-2 text-[12.5px] font-medium text-ink-2">Add a model</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p.label} variant="ghost" onClick={() => add(p)} title={p.hint}>
                <Plus size={13} /> {p.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}

function ModelCard({ modelKey, value, saved, initiallyOpen, usedBy, onChange, onRename, onRemove }: { modelKey: string; value: Obj; saved: boolean; initiallyOpen: boolean; usedBy: string[]; onChange: (v: Obj) => void; onRename: (k: string) => void; onRemove: () => void }) {
  const { errors, config } = useForm();
  const { base } = useRoot();
  const prefix = `models.${modelKey}`;
  const problem = errorAt(errors, prefix);
  const [open, setOpen] = useState(initiallyOpen || !!problem);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; text?: string }>({ state: "idle" });
  const [confirm, setConfirm] = useState(false);
  const [keyDraft, setKeyDraft] = useState(modelKey);

  const apiKeyEnv = typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : "";
  const { isSet } = useSecrets(ENV.test(apiKeyEnv) ? [apiKeyEnv] : []);
  const savedValue = (base.models as Record<string, Obj> | undefined)?.[modelKey];
  const changed = !saved || canon(savedValue) !== canon(value);
  const patch = (field: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[field];
    else next[field] = v;
    onChange(next);
  };

  const run = async () => {
    setTest({ state: "running" });
    const r = await testModel(modelKey);
    setTest(r.ok ? { state: "ok", text: `${r.ms} ms${r.reply ? ` · "${r.reply.slice(0, 80)}"` : ""}` } : { state: "fail", text: r.error ?? "failed" });
  };

  const url = typeof value.url === "string" ? value.url : "";
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    host = url;
  }
  const keyMissing = !!apiKeyEnv && ENV.test(apiKeyEnv) && !isSet(apiKeyEnv);
  const isDefault = config.defaultModel === modelKey;

  return (
    <div data-problem={!!problem} className={cn("rounded-xl border bg-panel", problem ? "border-bad/60" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronDown size={15} className={cn("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} aria-hidden />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-mono text-[13px] font-semibold text-ink">{modelKey}</span>
              {isDefault && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">default</span>}
              {!saved && <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-3">unsaved</span>}
              {keyMissing && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">key not set</span>}
            </span>
            <span className="block truncate font-mono text-[12px] text-ink-3">
              {typeof value.id === "string" ? value.id : "no id"}
              {host && ` · ${host}`}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          onClick={run}
          disabled={test.state === "running" || changed}
          title={changed ? "Save your changes to this model first. The test runs the saved version." : "Send one tiny prompt to this model"}
          aria-label={`Test ${modelKey}`}
        >
          {test.state === "running" ? <LoaderCircle size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {test.state !== "idle" && test.state !== "running" && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} role="status" className={cn("overflow-hidden px-3 pb-2 text-[12.5px]", test.state === "ok" ? "text-ok" : "text-bad")}>
            {test.state === "ok" ? "Works: " : "Failed: "}
            {test.text}
          </motion.p>
        )}
      </AnimatePresence>
      {problem && !open && <p className="px-3 pb-2 text-[12px] text-bad">{problem}</p>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-4 border-t border-line px-4 py-4">
              {errors[prefix] && (saved || MODEL_KEY.test(modelKey)) && (
                <p role="alert" className="text-[12.5px] text-bad">
                  {errors[prefix]}
                </p>
              )}
              <Labeled
                label="Name"
                hint={saved ? "Agents refer to this name, so it cannot change once saved." : "What agents call it. Fixed once saved."}
                error={!saved && !MODEL_KEY.test(modelKey) ? errors[prefix] : undefined}
              >
                {({ id }) =>
                  saved ? (
                    <input id={id} value={modelKey} readOnly className={cn(inputCls(), "max-w-xs bg-sunken font-mono text-[13px] text-ink-3")} />
                  ) : (
                    <input
                      id={id}
                      value={keyDraft}
                      spellCheck={false}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onBlur={() => {
                        const to = keyDraft.trim();
                        if (to && to !== modelKey && !Object.hasOwn((config.models ?? {}) as Obj, to)) onRename(to);
                        else setKeyDraft(modelKey);
                      }}
                      className={cn(inputCls(), "max-w-xs font-mono text-[13px]")}
                    />
                  )
                }
              </Labeled>
              <Labeled label="Model id" hint="provider/model, e.g. openai/gpt-4o-mini or ollama/gemma4:e4b" error={errors[`${prefix}.id`]}>
                {({ id, invalid }) => <input id={id} value={typeof value.id === "string" ? value.id : ""} spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("id", e.target.value)} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
              </Labeled>
              <Labeled label="Base URL" hint="Leave empty for hosted providers. For Ollama or any OpenAI-compatible server, e.g. http://localhost:11434/v1" error={errors[`${prefix}.url`]}>
                {({ id, invalid }) => <input id={id} value={url} placeholder="https://…" spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("url", e.target.value)} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
              </Labeled>
              <Labeled label="API key variable" hint="The name of the .env variable that holds the key (not the key itself)." error={errors[`${prefix}.apiKeyEnv`]}>
                {({ id, invalid }) => <input id={id} value={apiKeyEnv} placeholder="OPENAI_API_KEY" spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("apiKeyEnv", e.target.value.trim())} className={cn(inputCls(invalid), "max-w-sm font-mono text-[13px]")} />}
              </Labeled>
              {apiKeyEnv && (ENV.test(apiKeyEnv) ? <SecretInput name={apiKeyEnv} set={isSet(apiKeyEnv)} label={apiKeyEnv} /> : <Callout tone="warn">Use an upper-case name such as OPENAI_API_KEY to set the key from here.</Callout>)}
              <div className="grid gap-4 sm:grid-cols-2">
                <ModelNum label="Context window" hint="Tokens. Set it for local servers that silently cut long prompts (Ollama)." value={value.contextWindow} error={errors[`${prefix}.contextWindow`]} onChange={(v) => patch("contextWindow", v)} placeholder="not limited" />
                <ModelNum label="Reply reserve" hint="Tokens kept free for the answer. Default 4,096." value={value.replyReserve} error={errors[`${prefix}.replyReserve`]} onChange={(v) => patch("replyReserve", v)} placeholder="4096" />
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                {usedBy.length > 0 ? (
                  <p className="text-[12px] text-ink-3">Used as {usedBy.join(" and ")}. Pick another model there before removing it.</p>
                ) : confirm ? (
                  <>
                    <span className="text-[12.5px] text-ink-2">Remove {modelKey}?</span>
                    <Button variant="danger" onClick={onRemove}>
                      Remove
                    </Button>
                    <Button variant="quiet" onClick={() => setConfirm(false)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button variant="quiet" onClick={() => setConfirm(true)} aria-label={`Remove ${modelKey}`}>
                    <Trash2 size={13} /> Remove model
                  </Button>
                )}
                {saved && usedBy.length === 0 && !confirm && <span className="text-[12px] text-ink-3">If an agent still uses it, saving is refused and tells you which.</span>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModelNum({ label, hint, value, error, onChange, placeholder }: { label: string; hint: string; value: unknown; error?: string; onChange: (v: number | undefined) => void; placeholder: string }) {
  return (
    <Labeled label={label} hint={hint} error={error}>
      {({ id, invalid }) => (
        <input id={id} type="number" inputMode="numeric" min={1} aria-invalid={invalid} placeholder={placeholder} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} className={cn(inputCls(invalid), "w-40 font-mono tabular-nums")} />
      )}
    </Labeled>
  );
}
