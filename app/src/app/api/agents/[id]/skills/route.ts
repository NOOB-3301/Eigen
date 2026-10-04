import { CreateSkillRequest, type ListSkillsResponse } from "@eigen/engine/schema";
import { createSkill, listSkills } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { agentOr, failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** ListSkillsResponse: every skill in this agent's skills/, with whether the agent loads it. */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]/skills">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  try {
    return json({ skills: listSkills(paths(), id) ?? [] } satisfies ListSkillsResponse);
  } catch (e) {
    return failure(e);
  }
}

/** CreateSkillRequest -> SkillWriteResponse (200 / 400 issues / 404 / 409 exists). */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/skills">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  const body = await readBody(req, CreateSkillRequest);
  if ("error" in body) return body.error;
  try {
    const r = createSkill(paths(), id, body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
