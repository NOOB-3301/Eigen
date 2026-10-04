import { AgentId } from "@eigen/engine/schema";
import { readLayout } from "@eigen/engine/store";
import { Studio } from "@/components/studio";
import { fleet } from "@/lib/server/fleet";
import { paths } from "@/lib/server/home";
import type { Layout } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Server-renders the first snapshot so the canvas paints with data; SWR + SSE take over from there. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // ?agent=<id> selects that agent on the fleet view; with &view=builder it opens its builder. Anything that is not a valid agent id is ignored.
  const agentParam = typeof params.agent === "string" && AgentId.safeParse(params.agent).success ? params.agent : undefined;
  const initialBuilder = params.view === "builder" ? agentParam : undefined;
  const initialFleet = await fleet();
  let initialLayout: Layout = {};
  try {
    initialLayout = readLayout(paths());
  } catch {
    /* no layout yet */
  }
  return <Studio initialFleet={initialFleet} initialLayout={initialLayout} initialBuilder={initialBuilder} initialAgent={agentParam} />;
}
