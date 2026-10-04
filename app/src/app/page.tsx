import { AgentId } from "@eigen/engine/schema";
import { readLayout } from "@eigen/engine/store";
import { Studio } from "@/components/studio";
import { fleet, rootInfo } from "@/lib/server/fleet";
import { paths } from "@/lib/server/home";
import type { SettingsSection } from "@/components/settings/settings-dialog";
import type { Layout, RootInfo } from "@/lib/types";

const SECTIONS: SettingsSection[] = ["models", "telegram", "memory", "sandbox", "tools", "advanced"];

export const dynamic = "force-dynamic";

/** Server-renders the first snapshot so the canvas paints with data; SWR + SSE take over from there. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const wanted = params.settings;
  const initialSettings = SECTIONS.find((s) => s === wanted);
  // ?agent=<id> opens that agent's inspector; with &view=builder it opens the builder. Anything that is not a valid agent id is ignored.
  const agentParam = typeof params.agent === "string" && AgentId.safeParse(params.agent).success ? params.agent : undefined;
  const initialBuilder = params.view === "builder" ? agentParam : undefined;
  const initialFleet = await fleet();
  let initialRoot: RootInfo | undefined;
  try {
    initialRoot = rootInfo();
  } catch {
    initialRoot = undefined;
  }
  let initialLayout: Layout = {};
  try {
    initialLayout = readLayout(paths());
  } catch {
    /* no layout yet */
  }
  return <Studio initialFleet={initialFleet} initialRoot={initialRoot} initialLayout={initialLayout} initialSettings={initialSettings} initialBuilder={initialBuilder} initialAgent={agentParam} />;
}
