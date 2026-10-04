/**
 * Request guard for the studio. The studio writes files the engine executes (instructions, MCP server commands), so a
 * webpage the user happens to visit must never be able to drive it:
 *
 *  - Host must be a loopback origin on our port (or one listed in EIGEN_APP_ORIGINS). Defeats DNS rebinding.
 *  - Mutations need Content-Type: application/json, which forces a CORS preflight on any cross-origin caller,
 *    and we answer every preflight (OPTIONS) with 403 and never send CORS allow headers.
 *  - If the browser tells us where the request came from (Origin, Sec-Fetch-Site), it must be us.
 *
 * Pure (no node:* imports) so the same code runs in proxy.ts and inside each route handler (defense in depth).
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedOrigins(): Set<string> {
  const port = process.env.PORT || "4100";
  const set = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
  for (const raw of (process.env.EIGEN_APP_ORIGINS ?? "").split(",")) {
    const o = raw.trim();
    if (!o) continue;
    try {
      set.add(new URL(o).origin);
    } catch {
      /* ignore malformed entries */
    }
  }
  return set;
}

const deny = (status: number, issue: string) =>
  new Response(JSON.stringify({ ok: false, issues: [issue] }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const isJson = (req: Request) => /^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "");

/** Host check only: applied to every request, pages included (the page embeds the agent snapshot). */
export function checkHost(req: Request): Response | null {
  const hosts = new Set([...allowedOrigins()].map((o) => new URL(o).host));
  const host = (req.headers.get("host") ?? "").toLowerCase();
  return hosts.has(host) ? null : deny(403, "host not allowed");
}

/** Full check for /api/*. Returns a Response to send back, or null when the request may proceed. */
export function guardApi(req: Request): Response | null {
  const bad = checkHost(req);
  if (bad) return bad;
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return deny(403, "cross-origin requests are not allowed");
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins().has(origin)) return deny(403, "origin not allowed");
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || (site === "same-site" && MUTATING.has(method))) return deny(403, "cross-site requests are not allowed");
  if (MUTATING.has(method) && !isJson(req)) return deny(415, "Content-Type must be application/json");
  return null;
}
