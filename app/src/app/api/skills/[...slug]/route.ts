import { SkillSlug, WriteSkillRequest } from "@eigen/engine/schema";
import { readSkill, trashSkill, writeSkill } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** A catch-all because "@owner/slug" spans two segments. */
type Ctx = { params: Promise<{ slug: string[] }> };

const badSlug = () => json({ ok: false, issues: ["slug: must be a lowercase slug such as pdf-tools, or @owner/slug"] }, 400);

/**
 * The slug the URL names, or null. Segments are decoded once more in case the client sent "%40owner%2Fslug" as one segment; the
 * result must still pass SkillSlug, and the store re-checks it against the file system (no "..", no symlinks, inside the library).
 */
async function slugOf(ctx: Ctx): Promise<string | null> {
  try {
    const slug = (await ctx.params).slug.map((s) => decodeURIComponent(s)).join("/");
    return SkillSlug.safeParse(slug).success ? slug : null;
  } catch {
    return null; // malformed percent-encoding
  }
}

/** GetSkillResponse */
export async function GET(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const slug = await slugOf(ctx);
  if (!slug) return badSlug();
  try {
    const s = readSkill(paths(), slug);
    return s ? json(s) : json({ ok: false, issues: [`no skill "${slug}"`] }, 404);
  } catch (e) {
    return failure(e);
  }
}

/** WriteSkillRequest -> SkillWriteResponse (200 / 400 issues / 403 ClawHub / 404 / 409 etag). */
export async function PUT(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const slug = await slugOf(ctx);
  if (!slug) return badSlug();
  const body = await readBody(req, WriteSkillRequest);
  if ("error" in body) return body.error;
  try {
    const r = writeSkill(paths(), slug, body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}

/** Moves the folder to ~/.eigen/skills/.trash (never erased). The response does not include the path. */
export async function DELETE(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const slug = await slugOf(ctx);
  if (!slug) return badSlug();
  try {
    const r = trashSkill(paths(), slug);
    return r.status === 200 ? json({ ok: true }) : json({ ok: false, error: r.error, issues: [r.error] }, r.status);
  } catch (e) {
    return failure(e);
  }
}
