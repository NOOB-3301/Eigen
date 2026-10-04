import { AgentId } from "@eigen/engine/schema";
import { trashAgent } from "@eigen/engine/store";
import { agentDetail } from "@/lib/server/fleet";
import { paths } from "@/lib/server/home";
import { failure, guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const badId = () => json({ ok: false, issues: ["id: must be a lowercase slug"] }, 400);

/** GetAgentResponse */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!AgentId.safeParse(id).success) return badId();
  try {
    const detail = await agentDetail(id);
    return detail ? json(detail) : json({ ok: false, issues: [`no agent "${id}"`] }, 404);
  } catch (e) {
    return failure(e);
  }
}

/** Moves the whole folder to agents/.trash (never erased); the engine notices and stops the agent. The response does not include the path. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!AgentId.safeParse(id).success) return badId();
  try {
    const r = trashAgent(paths(), id);
    return r.status === 200 ? json({ ok: true }) : json({ ok: false, issues: [r.error] }, r.status);
  } catch (e) {
    return failure(e);
  }
}
