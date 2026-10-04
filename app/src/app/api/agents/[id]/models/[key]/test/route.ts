import { ModelKey, type ModelTestResponse } from "@eigen/engine/schema";
import { readAgent } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { agentOr, failure, guard, json } from "@/lib/server/http";
import { cleanText, forwardProbe } from "@/lib/server/probe";

export const dynamic = "force-dynamic";

/** One tiny prompt to one of this agent's models, with this agent's key, run by the engine. 404 when the saved config has no such model. */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/models/[key]/test">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id, key } = await ctx.params;
  const missing = agentOr(id, "error");
  if (missing) return missing;
  if (!ModelKey.safeParse(key).success) return json({ ok: false, ms: 0, error: "key: letters, digits, '_' or '-'" }, 400);
  try {
    const models = (readAgent(paths(), id)?.config as { models?: unknown } | undefined)?.models;
    if (!models || typeof models !== "object" || !Object.hasOwn(models, key)) return json({ ok: false, ms: 0, error: "no such model in the saved config; apply first" }, 404);
  } catch (e) {
    return failure(e);
  }
  return forwardProbe(`/eigen/agents/${id}/models/${encodeURIComponent(key)}/test`, {}, 30_000, (r): ModelTestResponse => ({
    ok: r.ok === true,
    ms: typeof r.ms === "number" ? Math.round(r.ms) : 0,
    reply: cleanText(r.reply, 400),
    error: cleanText(r.error),
  }));
}
