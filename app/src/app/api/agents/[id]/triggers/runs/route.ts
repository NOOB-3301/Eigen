import { AgentId, type ListTriggerRunsResponse } from "@eigen/engine/schema";
import { guard, json } from "@/lib/server/http";
import { forwardEngine } from "@/lib/server/probe";
import { cleanRun } from "@/lib/server/triggers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** ListTriggerRunsResponse, newest first, from the engine (it keeps the run log). `?limit=` 1..200, default 50. */
export async function GET(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!AgentId.safeParse(id).success) return json({ ok: false, issues: ["id: must be a lowercase slug"] }, 400);
  const asked = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
  return forwardEngine(`/eigen/agents/${id}/triggers/runs?limit=${limit}`, { method: "GET", timeoutMs: 5_000 }, (raw): ListTriggerRunsResponse | null =>
    Array.isArray(raw.runs) ? { runs: raw.runs.slice(0, limit).flatMap((r) => cleanRun(r) ?? []) } : null,
  );
}
