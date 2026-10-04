import { WriteSharedSoulRequest } from "@eigen/engine/schema";
import { readSharedSoul, writeSharedSoul } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GetSharedSoulResponse: ~/.eigen/SOUL.md ("" when it does not exist yet). */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return json(readSharedSoul(paths()));
  } catch (e) {
    return failure(e);
  }
}

/** WriteSharedSoulRequest -> SharedSoulWriteResponse (200 / 400 / 409 etag). Agents on the shared soul read it on their next message. */
export async function PUT(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, WriteSharedSoulRequest);
  if ("error" in body) return body.error;
  try {
    const r = writeSharedSoul(paths(), body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
