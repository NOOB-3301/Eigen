import { z } from "zod";
import { createAgent } from "@eigen/engine/store";
import type { AgentConfigInput } from "@eigen/engine/schema";
import { fleet } from "@/lib/server/fleet";
import { paths, rootConfig } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Engine snapshot when reachable, else computed from the agent files with every status "offline". */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  return json(await fleet());
}

const CreateAgentRequest = z.object({
  config: z.record(z.string(), z.unknown()),
  instructionsText: z.string().max(200_000).optional(),
});

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, CreateAgentRequest);
  if ("error" in body) return body.error;
  try {
    const r = createAgent(paths(), rootConfig(), body.data.config as AgentConfigInput, body.data.instructionsText);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
