"use client";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Crown, Loader2, Trash2 } from "lucide-react";
import type { GetAgentResponse } from "@eigen/engine/schema";
import type { FleetResponse } from "@/lib/types";
import { fetcher, keys, saveConfig, trashAgent } from "@/lib/client/api";
import { Button, Modal } from "@/components/ui";

type Obj = Record<string, unknown>;

export function PrimaryDialog({ open, onClose, id, name, fleet, dirty, onDone }: { open: boolean; onClose: () => void; id: string; name: string; fleet: FleetResponse; dirty: boolean; onDone: () => void }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const current = fleet.agents.find((a) => a.primary && a.enabled && a.id !== id);

  const run = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const target = await fetcher<GetAgentResponse>(keys.agent(id));
      const tc = target.config as Obj & { delegation?: Obj };
      const accepts = tc.delegation?.acceptsFrom;
      // The primary cannot accept delegation "from primary"; flip it to "none" (the schema default would be "primary").
      const next = { ...tc, primary: true, enabled: true, delegation: { ...(tc.delegation ?? {}), acceptsFrom: accepts === "any" ? "any" : "none" } };
      const r1 = await saveConfig(id, { config: next, etag: target.etag });
      if (!r1.body.ok) throw new Error(r1.body.issues?.join("\n") ?? `could not update ${id} (${r1.status})`);
      if (current) {
        const old = await fetcher<GetAgentResponse>(keys.agent(current.id));
        const r2 = await saveConfig(current.id, { config: { ...(old.config as Obj), primary: false }, etag: old.etag });
        if (!r2.body.ok) throw new Error(`${name} is primary now, but ${current.name} could not be demoted: ${r2.body.issues?.join("; ") ?? r2.status}. Fix it so exactly one agent is primary.`);
      }
      toast.success(`${name} is now the primary`, { description: current ? `${current.name} is a regular agent now.` : undefined });
      void mutate(keys.fleet);
      if (current) void mutate(keys.agent(current.id));
      onDone();
      onClose();
    } catch (e) {
      setIssues((e as Error).message.split("\n"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Make ${name} the primary`}>
      <div className="p-5">
        <div className="flex items-center gap-2 text-crown">
          <Crown size={18} />
          <h3 className="text-[15px] font-semibold text-ink">Make {name} the primary?</h3>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">Exactly one enabled agent must be primary. The primary owns the Telegram channel and supervises the team.</p>
        <ol className="mt-3 space-y-1.5 text-[13px] text-ink">
          <li className="flex gap-2">
            <span className="text-ink-3">1.</span>
            <span>{name} becomes primary and takes over the Telegram channel.</span>
          </li>
          {current && (
            <li className="flex gap-2">
              <span className="text-ink-3">2.</span>
              <span>{current.name} stops being primary. Both files are saved one after the other.</span>
            </li>
          )}
        </ol>
        {dirty && <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn">Save or discard your unsaved changes first.</p>}
        {issues.length > 0 && (
          <ul role="alert" className="mt-3 space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={busy || dirty}>
            {busy && <Loader2 size={13} className="animate-spin" />} Make primary
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function TrashDialog({ open, onClose, id, name, onDone }: { open: boolean; onClose: () => void; id: string; name: string; onDone: () => void }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const r = await trashAgent(id).catch((e: Error) => ({ status: 0, body: { ok: false, issues: [e.message] } }));
    setBusy(false);
    if (!r.body.ok) {
      setErr(r.body.issues?.[0] ?? "could not move to trash");
      return;
    }
    // Optimistically drop the node so it animates out right away.
    void mutate(
      keys.fleet,
      (f?: FleetResponse) =>
        f && {
          ...f,
          agents: f.agents.filter((a) => a.id !== id),
          topology: {
            nodes: f.topology.nodes.filter((n) => n.id !== `agent:${id}` && !(n.type === "mcp" && n.data.owner === id)),
            edges: f.topology.edges.filter((e) => e.source !== `agent:${id}` && e.target !== `agent:${id}`),
          },
        },
      { revalidate: true },
    );
    toast(`Moved ${name} to the trash`, { description: "Its folder is in .agents/.trash; nothing was erased." });
    onClose();
    onDone();
  };
  return (
    <Modal open={open} onClose={onClose} title={`Move ${name} to the trash`}>
      <div className="p-5">
        <div className="flex items-center gap-2 text-bad">
          <Trash2 size={17} />
          <h3 className="text-[15px] font-semibold text-ink">Move {name} to the trash?</h3>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">The engine unloads it. Its folder moves to .agents/.trash, so you can restore it by moving it back.</p>
        {err && (
          <p role="alert" className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />} Move to trash
          </Button>
        </div>
      </div>
    </Modal>
  );
}
