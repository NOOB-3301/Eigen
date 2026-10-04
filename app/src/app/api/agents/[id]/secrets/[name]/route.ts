import { ENV_NAME, SetSecretRequest } from "@eigen/engine/schema";
import { setAgentSecret, unsetAgentSecret } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { agentOr, guard, json, readBody } from "@/lib/server/http";
import { refusalOf } from "@/lib/server/secrets";

export const dynamic = "force-dynamic";

const badName = () => json({ ok: false, issues: ["name: must be an upper-case variable name (A-Z, 0-9, _), starting with a letter"] }, 400);

/** Write-only: sets NAME in this agent's own .env. The value is never echoed (not in the answer, not in an error). */
export async function PUT(req: Request, ctx: RouteContext<"/api/agents/[id]/secrets/[name]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id, name } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  if (!ENV_NAME.test(name)) return badName();
  const body = await readBody(req, SetSecretRequest);
  if ("error" in body) return body.error;
  try {
    const r = setAgentSecret(paths(), id, name, body.data.value);
    return r.status === 200 ? json({ ok: true }) : json({ ok: false, issues: [`no agent "${id}"`] }, r.status);
  } catch (e) {
    return json({ ok: false, issues: [refusalOf(e, body.data.value)] }, 400);
  }
}

/** Removes every line for NAME from this agent's .env. `removed` says whether there was one. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/agents/[id]/secrets/[name]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { id, name } = await ctx.params;
  const missing = agentOr(id);
  if (missing) return missing;
  if (!ENV_NAME.test(name)) return badName();
  try {
    const r = unsetAgentSecret(paths(), id, name);
    return r.status === 200 ? json({ ok: true, removed: r.removed }) : json({ ok: false, issues: [`no agent "${id}"`] }, r.status);
  } catch {
    return json({ ok: false, issues: ["could not update this agent's .env"] }, 500);
  }
}
