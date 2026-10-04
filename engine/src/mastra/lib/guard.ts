/**
 * Request checks for the engine's /eigen/* routes. The engine binds to 127.0.0.1 and is called only by the studio's Next server, never by a browser, so:
 *  - Host must be a loopback name on the engine's own port. A page on another site can make a victim's browser reach 127.0.0.1 through DNS rebinding,
 *    and then the Host header still carries the attacker's name.
 *  - A mutating request must be JSON and carry no Origin. A browser always adds Origin to a cross-site POST, and a non-JSON content type is the
 *    one way to POST cross-site without a CORS preflight.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const hostAllowed = (host: string | null | undefined, port: number) => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host?.trim().toLowerCase() ?? "");
  return !!m && LOOPBACK.has(m[1]!) && Number(m[2] ?? 80) === port;
};

export function denyEngineRequest(req: Request, port: number): Response | null {
  if (!hostAllowed(req.headers.get("host"), port)) return Response.json({ error: "host not allowed" }, { status: 403 });
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (req.headers.get("origin")) return Response.json({ error: "browser requests are not allowed" }, { status: 403 });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return Response.json({ error: "send application/json" }, { status: 415 });
  return null;
}
