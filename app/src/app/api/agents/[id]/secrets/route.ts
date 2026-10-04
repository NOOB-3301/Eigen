import type { ListSecretsResponse } from "@eigen/engine/schema";
import { agentSecrets } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { agentOr, failure, guard, json } from "@/lib/server/http";
import { extraNames } from "@/lib/server/secrets";

export const dynamic = "force-dynamic";

/** Which names this agent's config uses and whether each is set in ITS .env. `?names=A,B` adds names typed but not saved. Never a value. */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]/secrets">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  try {
    return json({ secrets: agentSecrets(paths(), id, extraNames(req.url)) ?? [] } satisfies ListSecretsResponse);
  } catch (e) {
    return failure(e);
  }
}
