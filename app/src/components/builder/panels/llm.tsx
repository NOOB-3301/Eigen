"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FlaskConical, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { ModelKey, defaultApiKeyEnv } from "@eigen/engine/schema";
import { stable, type Draft } from "@/lib/client/draft";
import { testModel } from "@/lib/client/probes";
import { useSecrets } from "@/lib/client/secrets";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";
import { freeModelKey, modelUsers, removeModel, renameModel, setModel } from "../model";
import { Callout, Labeled, SelectInput, type Obj } from "./controls";
import type { PanelCtx } from "./connection";
import { Field, Section, errorAt, inputCls, useForm } from "./fields";
import { KeyField } from "./key-field";

const PRESETS: Array<{ label: string; hint: string; key: string; model: Obj }> = [
  { label: "Anthropic", hint: "api.anthropic.com", key: "claude", model: { id: "anthropic/claude-sonnet-5-5" } },
  { label: "OpenAI", hint: "api.openai.com", key: "openai", model: { id: "openai/gpt-4o-mini" } },
  { label: "Ollama (local)", hint: "localhost:11434", key: "local", model: { id: "ollama/gemma4:e4b", url: "http://localhost:11434/v1", contextWindow: 28000 } },
  { label: "OpenAI-compatible server", hint: "any base URL", key: "custom", model: { id: "custom/model-name", url: "http://localhost:8000/v1", apiKeyEnv: "CUSTOM_API_KEY" } },
];

const modelsOf = (d: Draft | null) => ((d?.config.models ?? {}) as Record<string, Obj>);
/** The key variable an entry reads, as the engine decides it (an id that does not parse yet has none). */
const keyEnvOf = (m: Obj) => (typeof m.id === "string" && m.id.includes("/") ? defaultApiKeyEnv({ id: m.id, url: typeof m.url === "string" ? m.url : undefined, apiKeyEnv: typeof m.apiKeyEnv === "string" ? m.apiKeyEnv : undefined }) : undefined);

/** The LLM node: this agent's own model catalog, and which one it thinks with. */
export function LlmBody({ ctx }: { ctx: PanelCtx }) {
  const { config, set } = useForm();
  const models = modelsOf(ctx.draft);
  const keys = Object.keys(models);
  const current = typeof config.model === "string" ? config.model : "";
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const add = (preset: (typeof PRESETS)[number]) => {
    const key = freeModelKey(ctx.draft, preset.key);
    ctx.update((d) => setModel(d, key, { ...preset.model }));
    setJustAdded(key);
  };

  return (
    <>
      <Section title="Thinks with" hint="The model this agent answers with. In chat, /model switches between this agent's models.">
        <Field label="Model" path="model">
          {({ id, describedBy, invalid }) => (
            <SelectInput
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              className="max-w-sm"
              value={current}
              onChange={(v) => set("model", v)}
              options={[...(current && !(current in models) ? [{ value: current, label: `${current} (missing)` }] : []), ...keys.map((k) => ({ value: k, label: `${k} (${String(models[k]?.id ?? "no id")})` }))]}
            />
          )}
        </Field>
      </Section>
      <Section title="Models" hint="Only this agent uses these. Keys live in this agent's .env, never in config.json.">
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>
            {keys.map((k) => (
              <motion.li key={k} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
                <ModelCard ctx={ctx} modelKey={k} value={models[k] ?? {}} initiallyOpen={k === justAdded} onRenamed={setJustAdded} />
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

function ModelCard({ ctx, modelKey, value, initiallyOpen, onRenamed }: { ctx: PanelCtx; modelKey: string; value: Obj; initiallyOpen: boolean; onRenamed: (key: string) => void }) {
  const { errors, config } = useForm();
  const prefix = `models.${modelKey}`;
  const problem = errorAt(errors, prefix);
  const [open, setOpen] = useState(initiallyOpen || !!problem);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; text?: string }>({ state: "idle" });
  const [confirm, setConfirm] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState(modelKey);

  const saved = modelsOf(ctx.base)[modelKey];
  // Test runs the SAVED config, so an entry with unapplied edits would test something else than what is on screen.
  const changed = !saved || stable(saved) !== stable(value);
  const keyEnv = keyEnvOf(value);
  const { isSet } = useSecrets(ctx.agentId, keyEnv ? [keyEnv] : []);
  const users = modelUsers(config, modelKey);
  const patch = (field: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[field];
    else next[field] = v;
    ctx.update((d) => setModel(d, modelKey, next));
  };

  const run = async () => {
    setTest({ state: "running" });
    const r = await testModel(ctx.agentId, modelKey);
    setTest(r.ok ? { state: "ok", text: `${r.ms} ms${r.reply ? ` · "${r.reply.slice(0, 80)}"` : ""}` } : { state: "fail", text: r.error ?? "failed" });
  };

  const remove = () => {
    const r = removeModel(ctx.draft, modelKey);
    if ("error" in r) return setRefusal(r.error);
    ctx.update((d) => {
      const again = removeModel(d, modelKey);
      return "draft" in again ? again.draft : d;
    });
  };

  const url = typeof value.url === "string" ? value.url : "";
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    host = url;
  }
  const keyMissing = !!keyEnv && !isSet(keyEnv);

  return (
    <div data-problem={!!problem} className={cn("rounded-xl border bg-panel", problem ? "border-bad/60" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronDown size={15} className={cn("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} aria-hidden />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-mono text-[13px] font-semibold text-ink">{modelKey}</span>
              {config.model === modelKey && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">in use</span>}
              {!saved && <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-3">not applied</span>}
              {keyMissing && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">key not set</span>}
            </span>
            <span className="block truncate font-mono text-[12px] text-ink-3">
              {typeof value.id === "string" ? value.id : "no id"}
              {host && ` · ${host}`}
            </span>
          </span>
        </button>
        <Button variant="ghost" onClick={run} disabled={test.state === "running" || changed} title={changed ? "Apply your changes to this model first. The test runs the applied version." : "Send one tiny prompt to this model"} aria-label={`Test ${modelKey}`}>
          {test.state === "running" ? <LoaderCircle size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {test.state !== "idle" && test.state !== "running" && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} role="status" className={cn("overflow-hidden px-3 pb-2 text-[12.5px] break-words", test.state === "ok" ? "text-ok" : "text-bad")}>
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
              {errors[prefix] && (
                <p role="alert" className="text-[12.5px] text-bad">
                  {errors[prefix]}
                </p>
              )}
              <Labeled label="Name" hint={saved ? "Fixed once applied: /model and the memory settings refer to it." : "What the agent and its memory refer to. Letters, digits, '_' or '-'."}>
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
                        if (to !== modelKey && ModelKey.safeParse(to).success && !(to in modelsOf(ctx.draft))) {
                          ctx.update((d) => renameModel(d, modelKey, to));
                          onRenamed(to);
                        } else setKeyDraft(modelKey);
                      }}
                      className={cn(inputCls(), "max-w-xs font-mono text-[13px]")}
                    />
                  )
                }
              </Labeled>
              <Labeled label="Model id" hint="provider/model, e.g. anthropic/claude-sonnet-5-5 or ollama/gemma4:e4b" error={errors[`${prefix}.id`]}>
                {({ id, invalid }) => <input id={id} value={typeof value.id === "string" ? value.id : ""} spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("id", e.target.value.trim())} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
              </Labeled>
              <Labeled label="Base URL" hint="Leave empty for hosted providers. For Ollama or any OpenAI-compatible server, e.g. http://localhost:11434/v1" error={errors[`${prefix}.url`]}>
                {({ id, invalid }) => <input id={id} value={url} placeholder="https://…" spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("url", e.target.value.trim())} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
              </Labeled>
              <KeyField agentId={ctx.agentId} path={`${prefix}.apiKeyEnv`} label="API key variable" effective={keyEnv} hint={url && !value.apiKeyEnv ? "A model with a base URL needs no key unless you name one." : "Empty: the provider's usual name, shown greyed out."} secretLabel={`${keyEnv ?? ""} (${modelKey})`} />
              <div className="grid gap-4 sm:grid-cols-2">
                <ModelNum label="Context window" hint="Tokens. Set it for servers that silently cut long prompts (Ollama)." value={value.contextWindow} error={errors[`${prefix}.contextWindow`]} onChange={(v) => patch("contextWindow", v)} placeholder="not limited" />
                <ModelNum label="Reply reserve" hint="Tokens kept free for the answer. Default 4,096." value={value.replyReserve} error={errors[`${prefix}.replyReserve`]} onChange={(v) => patch("replyReserve", v)} placeholder="4096" />
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                {users.length > 0 ? (
                  <p className="text-[12px] text-ink-3">Used as {users.join(" and ")}. Pick another model there before removing it.</p>
                ) : confirm ? (
                  <>
                    <span className="text-[12.5px] text-ink-2">Remove {modelKey}?</span>
                    <Button variant="danger" onClick={remove}>
                      Remove
                    </Button>
                    <Button variant="quiet" onClick={() => setConfirm(false)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button variant="quiet" onClick={() => (setConfirm(true), setRefusal(null))} aria-label={`Remove ${modelKey}`}>
                    <Trash2 size={13} /> Remove model
                  </Button>
                )}
              </div>
              {refusal && <Callout tone="warn">{refusal}</Callout>}
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
