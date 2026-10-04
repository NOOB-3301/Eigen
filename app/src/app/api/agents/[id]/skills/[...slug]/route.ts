import { SkillSlug, WriteSkillRequest } from "@eigen/engine/schema";
import { readSkill, trashSkill, writeSkill } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { agentOr, failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** A catch-all because "@owner/slug" spans two segments. */
type Ctx = RouteContext<"/api/agents/[id]/skills/[...slug]">;

const badSlug = () => json({ ok: false, issues: ["slug: must be a lowercase slug such as pdf-tools, or @owner/slug"] }, 400);

/**
 * The agent and slug the URL names, or the Response that refuses them. Segments are decoded once more in case the client sent
 * "%40owner%2Fslug" as one segment; the result must still pass SkillSlug, and the store re-checks it against the file system (no "..",
 * no symlinks, inside this agent's skills/).
 */
async function target(ctx: Ctx): Promise<{ id: string; slug: string } | { refused: Response }> {
  const { id, slug: parts } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return { refused: missing };
  try {
    const slug = parts.map((s) => decodeURIComponent(s)).join("/");
    return SkillSlug.safeParse(slug).success ? { id, slug } : { refused: badSlug() };
  } catch {
    return { refused: badSlug() }; // malformed percent-encoding
  }
}

/** GetSkillResponse */
export async function GET(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const t = await target(ctx);
  if ("refused" in t) return t.refused;
  try {
    const s = readSkill(paths(), t.id, t.slug);
    return s ? json(s) : json({ ok: false, issues: [`no skill "${t.slug}"`] }, 404);
  } catch (e) {
    return failure(e);
  }
}

/** WriteSkillRequest -> SkillWriteResponse (200 / 400 issues / 403 ClawHub / 404 / 409 etag). */
export async function PUT(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const t = await target(ctx);
  if ("refused" in t) return t.refused;
  const body = await readBody(req, WriteSkillRequest);
  if ("error" in body) return body.error;
  try {
    const r = writeSkill(paths(), t.id, t.slug, body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}

/** Moves the folder to the agent's .trash/ (never erased). The response does not include the path. */
export async function DELETE(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const t = await target(ctx);
  if ("refused" in t) return t.refused;
  try {
    const r = trashSkill(paths(), t.id, t.slug);
    return r.status === 200 ? json({ ok: true }) : json({ ok: false, error: r.error, issues: [r.error] }, r.status);
  } catch (e) {
    return failure(e);
  }
}
