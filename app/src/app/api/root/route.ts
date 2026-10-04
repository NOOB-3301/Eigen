import { rootInfo } from "@/lib/server/fleet";
import { failure, guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Non-secret root config info (model keys, MCP server names, inherited defaults). */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return json(rootInfo());
  } catch (e) {
    return failure(e);
  }
}
