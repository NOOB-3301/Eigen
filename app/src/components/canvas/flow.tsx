"use client";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type NodeChange } from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import { agentNodeId, type Topology } from "@eigen/engine/schema";
import type { FleetResponse, Layout } from "@/lib/types";
import { autoLayout, NODE_SIZE } from "@/lib/client/auto-layout";
import { putLayout } from "@/lib/client/api";
import { STATUS } from "@/components/ui";
import { nodeTypes, type StudioNode } from "./nodes";
import { edgeTypes, type CableEdge } from "./edges";

export type CanvasApi = { focus: (agentId: string) => void; fit: () => void };

type Props = {
  fleet: FleetResponse;
  savedLayout: Layout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Width in px covered by the inspector on the right, so focusing centers in the visible area. */
  occludedRight: number;
  /** Width the inspector takes when open (used before it is open, when a click is about to open it). */
  drawerWidth: number;
  apiRef: Ref<CanvasApi>;
};

export function Canvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

const LEAVE_MS = 280;

function ariaFor(n: Topology["nodes"][number]): string {
  if (n.type === "agent") return `Agent ${n.data.name}${n.data.primary ? ", primary" : ""}, ${STATUS[n.data.runtime.status].label}${n.data.runtime.problems.length ? `, ${n.data.runtime.problems.length} problems` : ""}`;
  if (n.type === "channel") return `Telegram bot${n.data.username ? ` @${n.data.username}` : ""} for ${n.data.routesTo || "nobody"}, ${n.data.state}`;
  return `Tool server ${n.data.name}`;
}

function toNodes(fleet: FleetResponse, positions: Layout, prev: Map<string, StudioNode>, initial: boolean): StudioNode[] {
  return fleet.topology.nodes.map((t) => {
    const old = prev.get(t.id);
    const pos = old?.position ?? positions[t.id] ?? { x: 0, y: 0 };
    // First paint: one orchestrated sweep left to right. Later arrivals animate on their own.
    const enterDelay = initial ? Math.min(0.5, Math.max(0, pos.x) / 1600) : 0;
    const base = { id: t.id, position: pos, ariaLabel: ariaFor(t), selected: old?.selected ?? false, width: NODE_SIZE[t.type]!.w };
    if (t.type === "agent") return { ...base, type: "agent", data: { ...t.data, overrides: fleet.overrides[t.data.id] ?? [], enterDelay } } as StudioNode;
    if (t.type === "channel") return { ...base, type: "channel", data: { ...t.data, offline: fleet.engine === "offline", enterDelay }, selectable: false } as StudioNode;
    return { ...base, type: "mcp", data: { ...t.data, enterDelay }, selectable: false } as StudioNode;
  });
}

function Flow({ fleet, savedLayout, selectedId, onSelect, occludedRight, drawerWidth, apiRef }: Props) {
  const rf = useReactFlow<StudioNode, CableEdge>();
  const reduce = useReducedMotion();
  const positions = useRef<Layout>({ ...savedLayout });
  const [nodes, setNodes] = useState<StudioNode[]>(() => toNodes(fleet, autoLayout(fleet.topology, savedLayout), new Map(), true));
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // A newer saved layout (another tab, reload) fills in positions we have not touched this session.
  useEffect(() => {
    positions.current = { ...savedLayout, ...positions.current };
  }, [savedLayout]);

  // Reconcile the server topology with what is on screen: keep positions, animate arrivals and departures.
  useEffect(() => {
    setNodes((prev) => {
      const prevMap = new Map(prev.filter((n) => !n.data.leaving).map((n) => [n.id, n]));
      // Nodes already on screen count as placed, so a newcomer is put next to them, never on top.
      const onScreen = Object.fromEntries([...prevMap].map(([id, n]) => [id, n.position]));
      const auto = autoLayout(fleet.topology, { ...positions.current, ...onScreen });
      const next = toNodes(fleet, auto, prevMap, false);
      const ids = new Set(next.map((n) => n.id));
      const leaving = prev
        .filter((n) => !ids.has(n.id))
        .map((n) => ({ ...n, draggable: false, selectable: false, data: { ...n.data, leaving: true } }) as StudioNode);
      if (leaving.length) {
        const t = setTimeout(() => {
          timers.current.delete(t);
          setNodes((cur) => cur.filter((n) => !(n.data.leaving && leaving.some((l) => l.id === n.id))));
        }, LEAVE_MS);
        timers.current.add(t);
      }
      return [...next, ...leaving];
    });
  }, [fleet]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const selNode = selectedId ? agentNodeId(selectedId) : null;
  const shownNodes = useMemo(() => nodes.map((n) => (n.selected === (n.id === selNode) ? n : { ...n, selected: n.id === selNode })), [nodes, selNode]);

  const edges = useMemo<CableEdge[]>(
    () =>
      fleet.topology.edges.map((e) => {
        const touches = selNode && (e.source === selNode || e.target === selNode);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "cable",
          selectable: false,
          focusable: false,
          data: { kind: e.type, label: e.label, dim: !!selNode && !touches, hot: !!touches },
        };
      }),
    [fleet.topology.edges, selNode],
  );

  /** If the inspector is about to cover the node, pan it into the visible part of the canvas. */
  const revealIfCovered = useCallback(
    (agentId: string) => {
      const n = rf.getNode(agentNodeId(agentId));
      if (!n || !drawerWidth) return;
      const right = rf.flowToScreenPosition({ x: n.position.x + NODE_SIZE.agent!.w, y: n.position.y }).x;
      if (right > window.innerWidth - drawerWidth - 24) {
        const zoom = rf.getZoom();
        const size = NODE_SIZE.agent!;
        rf.setCenter(n.position.x + size.w / 2 + drawerWidth / 2 / zoom, n.position.y + size.h / 2, { zoom, duration: reduce ? 0 : 450 });
      }
    },
    [rf, drawerWidth, reduce],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StudioNode>[]) => {
      for (const c of changes)
        if (c.type === "select" && c.selected && c.id.startsWith("agent:")) {
          const id = c.id.slice("agent:".length);
          onSelect(id);
          revealIfCovered(id);
        }
      setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "select"), ns));
    },
    [onSelect, revealIfCovered],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onNodeDragStop = useCallback((_: unknown, _n: StudioNode, dragged: StudioNode[]) => {
    for (const n of dragged) positions.current[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const live = new Set(rf.getNodes().map((n) => n.id));
      void putLayout(Object.fromEntries(Object.entries(positions.current).filter(([id]) => live.has(id))));
    }, 450);
  }, [rf]);

  useImperativeHandle(
    apiRef,
    () => ({
      focus(agentId) {
        const n = rf.getNode(agentNodeId(agentId));
        if (!n) return;
        const zoom = Math.max(rf.getZoom(), 0.95);
        const size = NODE_SIZE.agent!;
        rf.setCenter(n.position.x + size.w / 2 + occludedRight / 2 / zoom, n.position.y + size.h / 2, { zoom, duration: reduce ? 0 : 550 });
      },
      fit() {
        void rf.fitView({ padding: 0.25, maxZoom: 1.1, duration: reduce ? 0 : 500 });
      },
    }),
    [rf, occludedRight, reduce],
  );

  return (
    <ReactFlow<StudioNode, CableEdge>
      nodes={shownNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      edgesFocusable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      nodesFocusable
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.05 }}
      minZoom={0.25}
      maxZoom={1.8}
      attributionPosition="bottom-center"
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      aria-label="Agent team canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--canvas-dot)" />
      <Controls showInteractive={false} position="bottom-right" aria-label="Zoom controls" />
    </ReactFlow>
  );
}
