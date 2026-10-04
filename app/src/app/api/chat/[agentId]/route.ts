import { chatHistory, proxyChat } from "@/lib/server/chat";
import { guard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** One chat turn, streamed from the engine (AI SDK UI-message stream). The browser never talks to the engine itself. */
export async function POST(req: Request, ctx: RouteContext<"/api/chat/[agentId]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  return proxyChat(req, (await ctx.params).agentId);
}

/** The earlier messages of one studio session (?session=...). */
export async function GET(req: Request, ctx: RouteContext<"/api/chat/[agentId]">) {
  const blocked = guard(req);
  if (blocked) return blocked;
  return chatHistory((await ctx.params).agentId, new URL(req.url).searchParams.get("session"));
}
