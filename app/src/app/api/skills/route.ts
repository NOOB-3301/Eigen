import { CreateSkillRequest, type ListSkillsResponse } from "@eigen/engine/schema";
import { createSkill, listSkills } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** ListSkillsResponse: every skill under ~/.eigen/skills, with the agents whose skills.inherit names it. */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return json({ skills: listSkills(paths()) } satisfies ListSkillsResponse);
  } catch (e) {
    return failure(e);
  }
}

/** CreateSkillRequest -> SkillWriteResponse (200 / 400 issues / 409 exists). */
export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, CreateSkillRequest);
  if ("error" in body) return body.error;
  try {
    const r = createSkill(paths(), body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
