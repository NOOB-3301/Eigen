"use client";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { agentNodeId } from "@eigen/engine/schema";
import type { FleetResponse } from "@/lib/types";
import { keys, trashAgent } from "@/lib/client/api";
import { Button, Modal } from "@/components/ui";

/** Moves the whole agent folder (config, .env, memory, skills, sandbox) to the trash. Nothing is erased. */
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
    // Optimistically drop the agent's island (agent, bot, MCP servers) so it animates out right away.
    const own = (n: FleetResponse["topology"]["nodes"][number]) => n.id === agentNodeId(id) || ("agentId" in n.data && n.data.agentId === id);
    void mutate(
      keys.fleet,
      (f?: FleetResponse) => {
        if (!f) return f;
        const gone = new Set(f.topology.nodes.filter(own).map((n) => n.id));
        return {
          ...f,
          agents: f.agents.filter((a) => a.id !== id),
          topology: { nodes: f.topology.nodes.filter((n) => !gone.has(n.id)), edges: f.topology.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) },
        };
      },
      { revalidate: true },
    );
    toast(`Moved ${name} to the trash`, { description: "Its whole folder (config, keys, memory, skills) is in agents/.trash; nothing was erased." });
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
        <p className="mt-2 text-[13px] text-ink-2">The engine stops it and its bot. Its folder, with its keys, memory and skills, moves to agents/.trash, so you can restore it by moving it back.</p>
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
