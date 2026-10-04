import { CreateAgentRequest } from "@eigen/engine/schema";
import { createAgent } from "@eigen/engine/store";
import { fleet } from "@/lib/server/fleet";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** FleetResponse: the engine snapshot when it answers, else one computed from the agent folders with every status "offline". */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  return json(await fleet());
}

/** CreateAgentRequest -> UpdateAgentConfigResponse: 200 { ok, etag } / 400 { issues } / 409 the id exists. */
export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, CreateAgentRequest);
  if ("error" in body) return body.error;
  try {
    const r = createAgent(paths(), body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
