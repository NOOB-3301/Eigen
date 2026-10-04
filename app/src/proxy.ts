import { NextResponse, type NextRequest } from "next/server";
import { checkHost, guardApi } from "@/lib/server/guard";

/** Runs before every route: Host allowlist everywhere, the full cross-site guard on /api. Handlers re-check too. */
export function proxy(request: NextRequest) {
  const blocked = request.nextUrl.pathname.startsWith("/api/") ? guardApi(request) : checkHost(request);
  return blocked ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
