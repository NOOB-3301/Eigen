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
  const wanted = (await searchParams).settings;
  const initialSettings = SECTIONS.find((s) => s === wanted);
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
  return <Studio initialFleet={initialFleet} initialRoot={initialRoot} initialLayout={initialLayout} initialSettings={initialSettings} />;
}
