import type { TriggerRun } from "@eigen/engine/schema";
import { cleanText } from "./probe";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Rebuilds a TriggerRun from what the engine sent, field by field: nothing unexpected passes, and free text is redacted again. Null when it is not a run. */
export function cleanRun(v: unknown): TriggerRun | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const status = r.status === "running" || r.status === "ok" || r.status === "error" ? r.status : null;
  const type = r.type === "cron" || r.type === "github-pr" ? r.type : null;
  const id = str(r.id, 100);
  const agentId = str(r.agentId, 64);
  const triggerId = str(r.triggerId, 64);
  const startedAt = str(r.startedAt, 40);
  if (!status || !type || !id || !agentId || !triggerId || !startedAt) return null;
  return {
    id,
    agentId,
    triggerId,
    type,
    status,
    startedAt,
    finishedAt: str(r.finishedAt, 40),
    subject: cleanText(r.subject, 300) ?? "",
    reply: cleanText(r.reply, 8000),
    error: cleanText(r.error, 1000),
    delivered: typeof r.delivered === "boolean" ? r.delivered : undefined,
    deliveryError: cleanText(r.deliveryError, 300),
  };
}
