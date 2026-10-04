"use client";
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { motion } from "motion/react";
import type { TopologyEdge } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";

export type CableData = { kind: TopologyEdge["type"]; label?: string; dim?: boolean; hot?: boolean };
export type CableEdge = Edge<CableData, "cable">;

const COLOR: Record<TopologyEdge["type"], string> = {
  routes: "var(--cable-routes)",
  delegates: "var(--cable-delegates)",
  uses: "var(--cable-uses)",
};

export const CABLES: Array<{ kind: TopologyEdge["type"]; label: string }> = [
  { kind: "routes", label: "Telegram bot" },
  { kind: "delegates", label: "Can delegate to" },
  { kind: "uses", label: "Uses tool server" },
];

/** A patch cable: soft base stroke; delegation cables carry a moving signal (static when reduced motion is on). */
export const Cable = memo(function Cable({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<CableEdge>) {
  const kind = data?.kind ?? "uses";
  const [path, mx, my] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const [lx, ly] = [mx, my];
  const color = COLOR[kind];
  const opacity = data?.dim ? 0.18 : 1;
  return (
    <>
      <motion.g initial={{ opacity: 0 }} animate={{ opacity }} transition={{ duration: 0.35 }}>
        <BaseEdge
          id={id}
          path={path}
          style={{
            stroke: color,
            strokeWidth: data?.hot ? 2.4 : kind === "uses" ? 1.4 : 1.8,
            strokeOpacity: kind === "uses" ? 0.7 : 0.85,
          }}
        />
        {kind === "delegates" && <path d={path} className="cable-signal" style={{ stroke: color, strokeWidth: 3.2, strokeLinecap: "round", fill: "none" }} />}
      </motion.g>
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-none absolute rounded-md border bg-panel px-1.5 py-px font-mono text-[11px] transition-opacity",
              data.dim && "opacity-20",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, color, borderColor: `color-mix(in oklab, ${color} 40%, transparent)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { cable: Cable };
