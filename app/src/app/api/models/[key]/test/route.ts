import type { ModelTestResponse } from "@eigen/engine/schema";
import { rootConfig } from "@/lib/server/home";
import { failure, guard, json } from "@/lib/server/http";
import { cleanText, forwardProbe } from "@/lib/server/probe";

export const dynamic = "force-dynamic";

/** One tiny prompt to a root model, run by the engine (it holds the API key). 404 when the saved config has no such model. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { key } = await ctx.params;
  try {
    if (!Object.hasOwn(rootConfig().models, key)) return json({ ok: false, ms: 0, error: "no such model in the saved config; save first" }, 404);
  } catch (e) {
    return failure(e);
  }
  return forwardProbe(`/eigen/models/${encodeURIComponent(key)}/test`, {}, 30_000, (r): ModelTestResponse => ({
    ok: r.ok === true,
    ms: typeof r.ms === "number" ? Math.round(r.ms) : 0,
    reply: cleanText(r.reply, 400),
    error: cleanText(r.error),
  }));
}
