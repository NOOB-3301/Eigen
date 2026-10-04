import { TriggerId, type RunTriggerResponse } from "@eigen/engine/schema";
import { agentOr, guard, json } from "@/lib/server/http";
import { cleanText, forwardEngine } from "@/lib/server/probe";
import { cleanRun } from "@/lib/server/triggers";

export const dynamic = "force-dynamic";

/** Fires one trigger now (RunTriggerResponse). The engine answers when the run has finished, at most 5 minutes later. */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/triggers/[triggerId]/run">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id, triggerId } = await ctx.params;
  const missing = agentOr(id, "error");
  if (missing) return missing;
  if (!TriggerId.safeParse(triggerId).success) return json({ ok: false, error: "triggerId: must be a lowercase slug" }, 400);
  return forwardEngine(`/eigen/agents/${id}/triggers/${triggerId}/run`, { body: {}, timeoutMs: 310_000 }, (raw): RunTriggerResponse | null =>
    typeof raw.ok === "boolean" ? { ok: raw.ok, run: cleanRun(raw.run) ?? undefined, error: cleanText(raw.error) } : null,
  );
}
