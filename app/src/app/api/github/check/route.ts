import { GithubCheckRequest, type GithubCheckResponse } from "@eigen/engine/schema";
import { guard, readBody } from "@/lib/server/http";
import { cleanText, forwardProbe } from "@/lib/server/probe";

export const dynamic = "force-dynamic";

/** Can the token held in the named .env variable read that repo's pull requests? The browser only ever sends the variable NAME. */
export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, GithubCheckRequest);
  if ("error" in body) return body.error;
  return forwardProbe("/eigen/github/check", body.data, 20_000, (r): GithubCheckResponse => ({
    ok: r.ok === true,
    login: cleanText(r.login, 100),
    openPulls: typeof r.openPulls === "number" && Number.isFinite(r.openPulls) ? Math.max(0, Math.round(r.openPulls)) : undefined,
    error: cleanText(r.error),
  }));
}
