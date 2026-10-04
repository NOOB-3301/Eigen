import type { ListSecretsResponse } from "@eigen/engine/schema";
import { failure, guard, json } from "@/lib/server/http";
import { secretList } from "@/lib/server/secrets";

export const dynamic = "force-dynamic";

/** Which env names the configs reference and whether each is set. `?names=A,B` adds names the editor has typed but not saved. Never a value. */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    const extra = (new URL(req.url).searchParams.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    return json({ secrets: secretList(extra) } satisfies ListSecretsResponse);
  } catch (e) {
    return failure(e);
  }
}
