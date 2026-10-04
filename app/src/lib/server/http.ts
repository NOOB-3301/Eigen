import type { z } from "zod";
import { scrubPaths } from "./home";
import { guardApi, isJson } from "./guard";

/** Re-run the proxy guard inside the handler, so the rules hold even if the proxy matcher ever misses a route. */
export const guard = guardApi;

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Parses a JSON body against a schema; returns a 400 Response on failure. */
export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<{ data: z.infer<S> } | { error: Response }> {
  // Enforced here too (not only in proxy.ts): a non-JSON body type is how a cross-site form/text POST avoids a preflight.
  if (!isJson(req)) return { error: json({ ok: false, issues: ["Content-Type must be application/json"] }, 415) };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: json({ ok: false, issues: ["body: must be JSON"] }, 400) };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { error: json({ ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, 400) };
  return { data: r.data };
}

/** Turns unexpected failures (unreadable root config, bad id) into a JSON error without leaking paths. */
export function failure(e: unknown, status = 500) {
  const msg = scrubPaths(e instanceof Error ? e.message : String(e));
  return json({ ok: false, issues: [msg] }, /invalid agent id/.test(msg) ? 400 : status);
}
