"use client";
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { Link2, Unplug } from "lucide-react";
import { cn } from "@/lib/cn";
import { useBuilder } from "./context";
import { TINT } from "./kinds";
import type { Group, Ref } from "./model";

export type LinkData = { group: Group; connected: boolean; /** The node this cable belongs to (the component end). */ nodeId: string; title: string; ref: Ref | null; /** Phone layout: cables run up a spine to the left of the column. */ stack?: boolean };
export type LinkEdgeT = Edge<LinkData, "link">;

/** A cable from a component to the agent. It carries the disconnect button: hover or select the cable (or its node) to see it, Delete does the same. */
export const LinkEdge = memo(function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<LinkEdgeT>) {
  const api = useBuilder();
  const stack = data?.stack === true;
  const [path, bx, by] = stack
    ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset: 30, borderRadius: 16 })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.32 });
  // On the spine, each button sits beside its own node; elsewhere it sits at the middle of the cable.
  const [lx, ly] = stack ? [sourceX - 30, sourceY] : [bx, by];
  const g = data?.group ?? "tools";
  const connected = data?.connected ?? true;
  const active = api.hovered === data?.nodeId || api.selectedId === data?.nodeId || selected;
  const ref = data?.ref ?? null;
  const verb = ref?.kind === "trigger" ? (connected ? "Switch off" : "Switch on") : "Disconnect";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        style={{ stroke: TINT[g].cssVar, strokeWidth: active ? 2.6 : 1.8, strokeOpacity: connected ? 0.85 : 0.5, strokeDasharray: connected ? undefined : "5 5" }}
      />
      {ref && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={`${verb} ${data?.title}`}
            title={`${verb} ${data?.title}`}
            onClick={() => (connected ? api.disconnect(ref) : api.connect(ref))}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            className={cn(
              "nodrag nopan pointer-events-auto absolute grid size-6 place-items-center rounded-full border border-line-strong bg-panel text-ink-3 shadow-sm transition-opacity hover:text-bad focus-visible:opacity-100",
              active ? "opacity-100" : "opacity-0 [@media(hover:none)]:opacity-70",
            )}
          >
            {connected ? <Unplug size={12} aria-hidden /> : <Link2 size={12} aria-hidden />}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const builderEdgeTypes = { link: LinkEdge };
