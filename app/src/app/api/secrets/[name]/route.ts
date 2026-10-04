import { setSecret, unsetSecret } from "@eigen/engine/envfile";
import { ENV_NAME, SetSecretRequest } from "@eigen/engine/schema";
import { paths } from "@/lib/server/home";
import { guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

const badName = () => json({ ok: false, issues: ["name: must be an upper-case variable name (A-Z, 0-9, _), starting with a letter"] }, 400);

/** Write-only: sets NAME in ~/.eigen/.env. The value is never echoed (not in the answer, not in an error). */
export async function PUT(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { name } = await ctx.params;
  if (!ENV_NAME.test(name)) return badName();
  const body = await readBody(req, SetSecretRequest);
  if ("error" in body) return body.error;
  try {
    setSecret(paths(), name, body.data.value);
    return json({ ok: true });
  } catch (e) {
    // The engine's messages describe the rule that failed, never the value; strip it anyway.
    const msg = (e instanceof Error ? e.message : "could not store the value").replaceAll(body.data.value, "[value]");
    return json({ ok: false, issues: [msg.slice(0, 200)] }, 400);
  }
}

/** Removes every line for NAME. `removed` says whether there was one. */
export async function DELETE(req: Request, ctx: Ctx) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const { name } = await ctx.params;
  if (!ENV_NAME.test(name)) return badName();
  try {
    return json({ ok: true, removed: unsetSecret(paths(), name) });
  } catch {
    return json({ ok: false, issues: ["could not update .env"] }, 500);
  }
}
