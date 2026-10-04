"use client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { TriggerRun } from "@eigen/engine/schema";
import { useAgent } from "@/lib/client/api";
import { runTriggerNow, useTriggerRuns } from "@/lib/client/triggers";
import { TriggerRunsView, type TriggerRow } from "./trigger-runs-view";

/** A clock that ticks, so "5 min ago" stays true while the panel is open. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const firstLine = (s: string | undefined, max = 160) => {
  const line = (s ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What to tell the user once a manual run is over. */
function announce(id: string, r: { ok: boolean; run?: TriggerRun; error?: string }) {
  if (!r.ok || r.run?.status === "error") {
    toast.error(`${id} did not complete`, { description: firstLine(r.run?.error ?? r.error) || "The engine gave no reason." });
    return;
  }
  toast.success(`${id} finished`, { description: [firstLine(r.run?.reply), r.run?.delivered ? "Sent to Telegram." : "The reply is in the run history."].filter(Boolean).join(" ") });
}

/** Run history of an agent's triggers, newest first, with a "Run now" per trigger. */
export function TriggerRuns({ agentId, triggerId }: { agentId: string; triggerId?: string }) {
  const { runs, isLoading } = useTriggerRuns(agentId);
  const { data: agent } = useAgent(agentId);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(30_000);

  const runtimes = agent?.runtime.triggers;
  const saved: TriggerRow[] = useMemo(() => (agent?.config.triggers ?? []).map((t) => ({ id: t.id, type: t.type, runtime: runtimes?.find((r) => r.id === t.id) })), [agent, runtimes]);
  const triggers = triggerId ? saved.filter((t) => t.id === triggerId) : saved;

  const run = async (id: string) => {
    // The view disables the button while it runs; this keeps any other caller from starting a second run.
    if (running.has(id)) return;
    setRunning((r) => new Set(r).add(id));
    try {
      announce(id, await runTriggerNow(agentId, id));
    } catch (e) {
      toast.error(`${id} did not complete`, { description: e instanceof Error ? e.message : "The request failed." });
    } finally {
      setRunning((r) => {
        const next = new Set(r);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <TriggerRunsView
      runs={triggerId ? runs.filter((r) => r.triggerId === triggerId) : runs}
      loading={isLoading}
      triggers={triggers}
      unsaved={!!triggerId && !!agent && triggers.length === 0}
      engineOffline={agent?.runtime.status === "offline"}
      running={running}
      onRun={(id) => void run(id)}
      now={now}
    />
  );
}
