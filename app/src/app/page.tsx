import { readLayout } from "@eigen/engine/store";
import { Studio } from "@/components/studio";
import { fleet, rootInfo } from "@/lib/server/fleet";
import { paths } from "@/lib/server/home";
import type { Layout, RootInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Server-renders the first snapshot so the canvas paints with data; SWR + SSE take over from there. */
export default async function Page() {
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
  return <Studio initialFleet={initialFleet} initialRoot={initialRoot} initialLayout={initialLayout} />;
}
