import type { ListTriggerRunsResponse } from "@eigen/engine/schema";
import { agentOr, guard } from "@/lib/server/http";
import { forwardEngine } from "@/lib/server/probe";
import { cleanRun } from "@/lib/server/triggers";

export const dynamic = "force-dynamic";

/** ListTriggerRunsResponse, newest first, from the engine (it keeps the run log; offline: 503 { ok:false, error }). `?limit=` 1..200, default 50. */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]/triggers/runs">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  const asked = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
  return forwardEngine(`/eigen/agents/${id}/triggers/runs?limit=${limit}`, { method: "GET", timeoutMs: 5_000 }, (raw): ListTriggerRunsResponse | null =>
    Array.isArray(raw.runs) ? { runs: raw.runs.slice(0, limit).flatMap((r) => cleanRun(r) ?? []) } : null,
  );
}
