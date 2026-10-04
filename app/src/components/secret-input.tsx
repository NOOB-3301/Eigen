"use client";
import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, KeyRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { deleteSecret, putSecret, refreshSecrets } from "@/lib/client/secrets";

/**
 * Write-only field for one variable in ONE agent's .env (~/.eigen/agents/<agentId>/.env). It can say whether the variable is set and let you
 * replace or remove it, but nothing in the studio can read the value back: the typed text is cleared the moment it is sent.
 */
export function SecretInput({ agentId, name, set, label, onSaved }: { agentId: string; name: string; set: boolean; label?: string; onSaved?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // What we just did, until the parent's `set` catches up with it.
  const [local, setLocal] = useState<{ base: boolean; value: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = local && local.base === set ? local.value : set;

  const done = (next: boolean) => {
    setLocal({ base: set, value: next });
    void refreshSecrets(agentId);
    onSaved?.();
  };

  const save = async () => {
    const v = value;
    if (!v) return;
    setValue("");
    setEditing(false);
    setBusy(true);
    setError(null);
    const err = await putSecret(agentId, name, v);
    setBusy(false);
    if (err) setError(err);
    else done(true);
  };

  const remove = async () => {
    setConfirmRemove(false);
    setBusy(true);
    setError(null);
    const err = await deleteSecret(agentId, name);
    setBusy(false);
    if (err) setError(err);
    else done(false);
  };

  const title = label ?? name;
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2.5" data-secret-name={name}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <KeyRound size={14} className="shrink-0 text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] text-ink">{title}</div>
          <div className={cn("flex items-center gap-1.5 text-[12px]", shown ? "text-ok" : "text-ink-3")} role="status">
            <span aria-hidden className={cn("size-1.5 rounded-full", shown ? "bg-ok" : "border border-ink-3")} />
            {busy ? "Saving…" : shown ? "Set (hidden)" : "Not set"}
          </div>
        </div>
        {!editing && (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" disabled={busy} onClick={() => { setEditing(true); setConfirmRemove(false); setTimeout(() => input.current?.focus(), 30); }} aria-label={`${shown ? "Replace" : "Set"} ${title}`}>
              {shown ? "Replace" : "Set value"}
            </Button>
            {shown && !confirmRemove && (
              <Button variant="quiet" disabled={busy} onClick={() => setConfirmRemove(true)} aria-label={`Remove ${title}`}>
                <Trash2 size={13} /> Remove
              </Button>
            )}
            {shown && confirmRemove && (
              <>
                <Button variant="danger" disabled={busy} onClick={remove}>
                  Remove from .env
                </Button>
                <Button variant="quiet" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {/* No exit animation on purpose: an exiting element keeps its last props, which would keep the typed value in the DOM after saving. */}
      {editing && (
        <motion.form
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          className="overflow-hidden"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-wrap items-center gap-2 pt-2.5">
            <input
              ref={input}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              aria-label={`New value for ${title}`}
              placeholder="Paste the value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-1p-ignore
              data-lpignore="true"
              className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-1.5 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink-3 focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
            />
            <Button variant="primary" type="submit" disabled={!value}>
              <Check size={13} /> Save to .env
            </Button>
            <Button variant="quiet" onClick={() => { setValue(""); setEditing(false); }}>
              Cancel
            </Button>
          </div>
          <p className="pt-1.5 text-[11.5px] text-ink-3">Written to this agent&apos;s own .env. It is never shown again, here or anywhere in the studio.</p>
        </motion.form>
      )}
      {error && (
        <p role="alert" className="pt-2 text-[12px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
