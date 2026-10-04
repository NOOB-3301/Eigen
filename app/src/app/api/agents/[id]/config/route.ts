import { AgentId, UpdateAgentConfigRequest } from "@eigen/engine/schema";
import { writeAgent } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** UpdateAgentConfigRequest -> UpdateAgentConfigResponse (200 / 400 issues / 404 / 409 etag). The engine's watcher rebuilds the agent. */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/config">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!AgentId.safeParse(id).success) return json({ ok: false, issues: ["id: must be a lowercase slug"] }, 400);
  const body = await readBody(req, UpdateAgentConfigRequest);
  if ("error" in body) return body.error;
  try {
    const r = writeAgent(paths(), id, body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
