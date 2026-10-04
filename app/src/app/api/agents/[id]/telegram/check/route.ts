import { TelegramCheckRequest, type TelegramCheckResponse } from "@eigen/engine/schema";
import { agentOr, guard, readBody } from "@/lib/server/http";
import { cleanText, forwardProbe } from "@/lib/server/probe";

export const dynamic = "force-dynamic";

/** getMe with the token held in that variable of THIS agent's .env, run by the engine. The token never passes through the studio. */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/telegram/check">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const missing = agentOr(id, "error");
  if (missing) return missing;
  const body = await readBody(req, TelegramCheckRequest);
  if ("error" in body) return body.error;
  return forwardProbe(`/eigen/agents/${id}/telegram/check`, body.data, 15_000, (r): TelegramCheckResponse => ({
    ok: r.ok === true,
    username: cleanText(r.username, 64),
    error: cleanText(r.error),
  }));
}
