"use client";
import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ENV_NAME, type AgentConfigInput } from "@eigen/engine/schema";
import type { FleetResponse, RootInfo } from "@/lib/types";
import { createAgent, keys } from "@/lib/client/api";
import { useSecrets } from "@/lib/client/secrets";
import { validateDraft } from "@/lib/client/validate";
import { cn } from "@/lib/cn";
import { Button, Modal, Segmented, Switch } from "@/components/ui";
import { inputCls } from "@/components/inspector/fields";
import { SecretInput } from "@/components/secret-input";
import { suggestTokenEnv } from "@/components/canvas/telegram-state";

const PRESETS = {
  minimal: { label: "Files only", builtin: ["workspace"], inherit: "none" },
  planner: { label: "Files and schedule", builtin: ["workspace", "schedule"], inherit: "none" },
  full: { label: "Everything", builtin: ["workspace", "schedule", "skills"], inherit: "all" },
} as const;
type Preset = keyof typeof PRESETS;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

export function NewAgentDialog({ open, onClose, fleet, root, onCreated }: { open: boolean; onClose: () => void; fleet?: FleetResponse; root?: RootInfo; onCreated: (id: string) => void }) {
  const { mutate } = useSWRConfig();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [preset, setPreset] = useState<Preset>("minimal");
  const [bot, setBot] = useState(false);
  const [tokenEnv, setTokenEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [tried, setTried] = useState(false);

  const effectiveId = idTouched ? id : slugify(name);
  // The token variable follows the id until it is edited by hand.
  const effectiveToken = tokenEnv || suggestTokenEnv(effectiveId);
  const tokenValid = ENV_NAME.test(effectiveToken);
  const { isSet } = useSecrets(bot && tokenValid ? [effectiveToken] : []);
  const config = useMemo<AgentConfigInput>(() => {
    const p = PRESETS[preset];
    return {
      id: effectiveId,
      name: name.trim(),
      role: role.trim(),
      description: description.trim(),
      ...(model ? { model } : {}),
      tools: { builtin: [...p.builtin], mcp: { inherit: p.inherit } },
      ...(bot ? { telegram: { enabled: true, tokenEnv: effectiveToken } } : {}),
    };
  }, [effectiveId, name, role, description, model, preset, bot, effectiveToken]);

  const v = validateDraft(effectiveId, config, root);
  const taken = fleet?.agents.some((a) => a.id === effectiveId);
  const tokenOwner = bot ? fleet?.agents.find((a) => a.id !== effectiveId && a.enabled && a.telegram.enabled && a.telegram.tokenEnv === effectiveToken) : undefined;
  const errors: Record<string, string> = {
    ...v.byPath,
    ...(taken ? { id: "an agent with this id already exists" } : {}),
    ...(tokenOwner ? { "telegram.tokenEnv": `${tokenOwner.name} already uses this variable; one bot token can serve only one agent` } : {}),
  };
  const ok = v.ok && !taken && !tokenOwner;

  const reset = () => {
    setName("");
    setId("");
    setIdTouched(false);
    setRole("");
    setDescription("");
    setModel("");
    setPreset("minimal");
    setBot(false);
    setTokenEnv("");
    setServerIssues([]);
    setTried(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ok) return;
    setBusy(true);
    setServerIssues([]);
    const r = await createAgent(config).catch((err: Error) => ({ status: 0, body: { ok: false as const, issues: [err.message] } }));
    setBusy(false);
    if (!r.body.ok) {
      setServerIssues(r.body.issues ?? [`could not create (${r.status})`]);
      return;
    }
    toast.success(`Created ${config.name}`, { description: "Its folder is in ~/.eigen/.agents. The engine picks it up on its own." });
    await mutate(keys.fleet);
    onCreated(effectiveId);
    reset();
    onClose();
  };

  const err = (k: string) => (tried || k === "id" ? errors[k] : undefined);

  return (
    <Modal open={open} onClose={onClose} title="New agent" description="Creates a folder with config.json and instructions.md." className="max-w-xl">
      <form onSubmit={submit} noValidate>
        <div className="border-b border-line px-5 pt-5 pb-4">
          <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">New agent</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Creates ~/.eigen/.agents/{effectiveId || "<id>"} with a config and a starter prompt.</p>
        </div>
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <L label="Name" error={err("name")}>
            {(a) => <input {...a} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" className={inputCls(!!a["aria-invalid"])} />}
          </L>
          <L label="Id" error={effectiveId ? err("id") : undefined} hint="Folder name; can't be changed later.">
            {(a) => (
              <input
                {...a}
                value={effectiveId}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value);
                }}
                placeholder="researcher"
                className={cn(inputCls(!!a["aria-invalid"]), "font-mono text-[13px]")}
              />
            )}
          </L>
          <L label="Role" error={err("role")} hint="Short label for the canvas.">
            {(a) => <input {...a} value={role} onChange={(e) => setRole(e.target.value)} placeholder="researcher" className={inputCls(!!a["aria-invalid"])} />}
          </L>
          <L label="Model" error={err("model")}>
            {(a) => (
              <select {...a} value={model} onChange={(e) => setModel(e.target.value)} className={cn(inputCls(false), "font-mono text-[13px]")}>
                <option value="">Root default ({root?.defaultModel ?? "…"})</option>
                {root?.models.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key} ({m.id})
                  </option>
                ))}
              </select>
            )}
          </L>
          <div className="sm:col-span-2">
            <L label="Description" error={err("description")} hint="The primary reads this to decide when to delegate. Write it for a model.">
              {(a) => <textarea {...a} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Finds sources on the web and returns a short, cited summary." className={cn(inputCls(!!a["aria-invalid"]), "resize-y")} />}
            </L>
          </div>
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Tools</div>
            <Segmented label="Tools" value={preset} onChange={setPreset} options={Object.entries(PRESETS).map(([value, p]) => ({ value: value as Preset, label: p.label }))} />
            <p className="mt-1.5 text-[12px] text-ink-3">
              {PRESETS[preset].builtin.join(", ")}
              {PRESETS[preset].inherit === "all" ? ", plus every shared tool server" : ""}. You can change this later.
            </p>
          </div>
          <div className="sm:col-span-2">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-ink-2">Give it a Telegram bot</div>
                <p className="mt-0.5 text-[12px] text-ink-3">Optional. Chat with this agent in its own Telegram chat; create the bot with @BotFather. You can also do this later.</p>
              </div>
              <Switch label="Give it a Telegram bot" checked={bot} onChange={setBot} />
            </div>
            {bot && (
              <div className="mt-3 grid gap-3 rounded-xl border border-line p-3">
                <L label="Token variable" error={err("telegram.tokenEnv")} hint="The name of the line in ~/.eigen/.env that will hold the token.">
                  {(a) => (
                    <input
                      {...a}
                      value={effectiveToken}
                      spellCheck={false}
                      autoCapitalize="characters"
                      onChange={(e) => setTokenEnv(e.target.value.toUpperCase().replace(/\s+/g, ""))}
                      className={cn(inputCls(!!a["aria-invalid"]), "font-mono text-[13px]")}
                    />
                  )}
                </L>
                {tokenValid && <SecretInput name={effectiveToken} set={isSet(effectiveToken)} label="Bot token" />}
              </div>
            )}
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

function L({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (a: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode }) {
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
