import { z } from "zod";
import { readLayout, writeLayout } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const NodeKey = z.string().regex(/^(agent|channel|mcp):[A-Za-z0-9_./-]{1,80}$/);
const Point = z.object({ x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) });
const LayoutBody = z.record(NodeKey, Point).refine((l) => Object.keys(l).length <= 500, "too many nodes");

export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    const raw = readLayout(paths());
    const r = LayoutBody.safeParse(raw);
    return json(r.success ? r.data : {});
  } catch (e) {
    return failure(e);
  }
}

/** Replaces the saved positions. Positions live outside agent files, so this never reloads an agent. */
export async function PUT(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, LayoutBody);
  if ("error" in body) return body.error;
  try {
    writeLayout(paths(), body.data);
    return json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
