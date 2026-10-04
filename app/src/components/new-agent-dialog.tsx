"use client";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { FleetResponse } from "@/lib/types";
import { createAgent, keys } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { Button, Modal } from "@/components/ui";
import { inputCls } from "@/components/builder/panels/fields";
import { keyFor, MODEL_PRESETS, slugify, toCreateRequest, type NewAgentForm } from "@/components/fleet/new-agent";

const EMPTY: NewAgentForm = { name: "", id: "", role: "", description: "", modelId: MODEL_PRESETS[0]!.id, modelUrl: "", instructions: "" };

/**
 * Creates a standalone agent: its own folder with config.json (one model), instructions.md and an empty .env. On success the builder
 * opens for it, and the toast names the key to set (the agent cannot think until its model's key is in its own .env).
 */
export function NewAgentDialog({ open, onClose, fleet, onCreated }: { open: boolean; onClose: () => void; fleet?: FleetResponse; onCreated: (id: string) => void }) {
  const { mutate } = useSWRConfig();
  const [form, setForm] = useState<NewAgentForm>(EMPTY);
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [tried, setTried] = useState(false);

  const effective = { ...form, id: idTouched ? form.id : slugify(form.name) };
  const { req, errors } = toCreateRequest(effective, fleet?.agents.map((a) => a.id) ?? []);
  const key = keyFor(effective.modelId, effective.modelUrl);
  const preset = MODEL_PRESETS.find((p) => p.id === effective.modelId && (p.url ?? "") === effective.modelUrl);
  const set = (patch: Partial<NewAgentForm>) => setForm((f) => ({ ...f, ...patch }));

  const reset = () => {
    setForm(EMPTY);
    setIdTouched(false);
    setServerIssues([]);
    setTried(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!req) return;
    setBusy(true);
    setServerIssues([]);
    const r = await createAgent(req).catch((err: Error) => ({ status: 0, body: { ok: false as const, issues: [err.message] } }));
    setBusy(false);
    if (!r.body.ok) {
      setServerIssues(r.body.issues ?? [`could not create (${r.status})`]);
      return;
    }
    toast.success(`Created ${req.name}`, {
      description: key ? `Set ${key} in its keys (the LLM node) so it can think.` : "It runs on a local model, so it needs no key.",
      duration: 8000,
    });
    await mutate(keys.fleet);
    onCreated(req.id);
    reset();
    onClose();
  };

  // The id error shows at once (it is derived as you type); the others after the first submit.
  const err = (k: string) => (tried || (k === "id" && effective.id) ? errors[k] : undefined);

  return (
    <Modal open={open} onClose={onClose} title="New agent" description="Creates a standalone agent with its own folder, keys and memory." className="max-w-xl">
      <form onSubmit={submit} noValidate>
        <div className="border-b border-line px-5 pt-5 pb-4">
          <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">New agent</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            Its own folder, ~/.eigen/agents/{effective.id || "<id>"}, with its own model, keys, memory and skills. Nothing is shared with other agents.
          </p>
        </div>
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <Field label="Name" error={err("name")}>
            {(a) => <input {...a} autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Researcher" className={inputCls(!!a["aria-invalid"])} />}
          </Field>
          <Field label="Id" error={err("id")} hint="Folder name; it cannot be changed later.">
            {(a) => (
              <input
                {...a}
                value={effective.id}
                spellCheck={false}
                onChange={(e) => {
                  setIdTouched(true);
                  set({ id: e.target.value });
                }}
                placeholder="researcher"
                className={cn(inputCls(!!a["aria-invalid"]), "font-mono text-[13px]")}
              />
            )}
          </Field>
          <Field label="Role" error={err("role")} hint="A short label for the canvas.">
            {(a) => <input {...a} value={form.role} onChange={(e) => set({ role: e.target.value })} placeholder="researcher" className={inputCls(!!a["aria-invalid"])} />}
          </Field>
          <Field label="Description" error={err("description")}>
            {(a) => <input {...a} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Finds sources and summarizes them." className={inputCls(!!a["aria-invalid"])} />}
          </Field>

          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-[12.5px] font-medium text-ink-2">Model</legend>
            <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Model presets">
              {MODEL_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  title={p.hint}
                  aria-pressed={preset?.key === p.key}
                  onClick={() => set({ modelId: p.id, modelUrl: p.url ?? "" })}
                  className={cn(
                    "h-7 rounded-full border px-2.5 text-[12px] transition-colors",
                    preset?.key === p.key ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-raised",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model id" error={err("model")} hint='"provider/model", as Mastra spells it.'>
                {(a) => <input {...a} value={form.modelId} spellCheck={false} onChange={(e) => set({ modelId: e.target.value })} className={cn(inputCls(!!a["aria-invalid"]), "font-mono text-[13px]")} />}
              </Field>
              <Field label="Server URL" error={err("url")} hint="Optional: an OpenAI-compatible endpoint.">
                {(a) => (
                  <input
                    {...a}
                    value={form.modelUrl}
                    spellCheck={false}
                    onChange={(e) => set({ modelUrl: e.target.value })}
                    placeholder="http://localhost:11434/v1"
                    className={cn(inputCls(!!a["aria-invalid"]), "font-mono text-[13px]")}
                  />
                )}
              </Field>
            </div>
            <p className="mt-2 text-[12px] text-ink-3" role="status">
              {key ? (
                <>
                  Reads its key from <span className="font-mono text-ink-2">{key}</span> in this agent&apos;s own keys. You set it in the builder next.
                </>
              ) : (
                "A local model: no key needed."
              )}
            </p>
          </fieldset>

          <div className="sm:col-span-2">
            <Field label="Instructions" error={err("instructions")} hint="Optional. Who it is and how it works; a short starter is written when left empty.">
              {(a) => (
                <textarea
                  {...a}
                  rows={4}
                  value={form.instructions}
                  onChange={(e) => set({ instructions: e.target.value })}
                  placeholder="You find sources on the web and return a short, cited summary."
                  className={cn(inputCls(!!a["aria-invalid"]), "resize-y")}
                />
              )}
            </Field>
          </div>
        </div>
        {serverIssues.length > 0 && (
          <ul role="alert" className="mx-5 mb-4 space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
            {serverIssues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />} Create agent
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (a: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode }) {
  const id = `new-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
        {label}
      </label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": error || hint ? `${id}-d` : undefined })}
      {(error || hint) && (
        <p id={`${id}-d`} className={cn("mt-1 text-[12px]", error ? "text-bad" : "text-ink-3")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
