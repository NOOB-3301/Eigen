import { TelegramCheckRequest, type TelegramCheckResponse } from "@eigen/engine/schema";
import { guard, readBody } from "@/lib/server/http";
import { cleanText, forwardProbe } from "@/lib/server/probe";

export const dynamic = "force-dynamic";

/** getMe with the token held in the named .env variable. The token itself never passes through the studio. */
export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, TelegramCheckRequest);
  if ("error" in body) return body.error;
  return forwardProbe("/eigen/telegram/check", body.data, 15_000, (r): TelegramCheckResponse => ({
    ok: r.ok === true,
    username: cleanText(r.username, 64),
    error: cleanText(r.error),
  }));
}
