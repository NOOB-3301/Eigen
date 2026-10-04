import { AgentId, UpdateAgentConfigRequest } from "@eigen/engine/schema";
import { writeAgent } from "@eigen/engine/store";
import { agentDetail } from "@/lib/server/fleet";
import { paths, rootConfig } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const badId = () => json({ ok: false, issues: ["id: must be a lowercase slug"] }, 400);

/** Same body as GET /api/agents/:id (the editor's view of the files). */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]/config">) {
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

/** UpdateAgentConfigRequest -> UpdateAgentConfigResponse (200 / 400 issues / 404 / 409 etag). */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/config">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!AgentId.safeParse(id).success) return badId();
  const body = await readBody(req, UpdateAgentConfigRequest);
  if ("error" in body) return body.error;
  try {
    const r = writeAgent(paths(), rootConfig(), id, body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
