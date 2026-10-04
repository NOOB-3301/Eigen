import { AgentId, TriggerId, type RunTriggerResponse } from "@eigen/engine/schema";
import { guard, json } from "@/lib/server/http";
import { cleanText, forwardEngine } from "@/lib/server/probe";
import { cleanRun } from "@/lib/server/triggers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; triggerId: string }> };

/** Fires one trigger now (RunTriggerResponse). The engine answers when the run has finished, at most 5 minutes later. */
export async function POST(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id, triggerId } = await ctx.params;
  if (!AgentId.safeParse(id).success) return json({ ok: false, error: "id: must be a lowercase slug" }, 400);
  if (!TriggerId.safeParse(triggerId).success) return json({ ok: false, error: "triggerId: must be a lowercase slug" }, 400);
  return forwardEngine(`/eigen/agents/${id}/triggers/${triggerId}/run`, { body: {}, timeoutMs: 310_000 }, (raw): RunTriggerResponse | null =>
    typeof raw.ok === "boolean" ? { ok: raw.ok, run: cleanRun(raw.run) ?? undefined, error: cleanText(raw.error) } : null,
  );
}
