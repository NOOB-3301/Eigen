"use client";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref as ReactRef } from "react";
import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, useUpdateNodeInternals, type Connection, type NodeChange, type OnBeforeDelete } from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import type { BuilderLayout, VNode } from "./layout";
import { builderEdgeTypes, type LinkEdgeT } from "./edges";
import { builderNodeTypes, type BuilderNode } from "./nodes";

/** Room left around the composition for the toolbar (top) and the apply bar (bottom). */
const FIT_PADDING = { top: "128px", bottom: "104px", left: "32px", right: "32px" } as const;

export type BuilderCanvasApi = {
  fit: () => void;
  /** A side sheet now covers this many px on the right: fit the composition into what is left (unless the user has taken over the view). */
  setCover: (px: number) => void;
  /** Bring one node out from under that sheet if it is still hidden. */
  reveal: (nodeId: string) => void;
};

type Props = {
  layout: BuilderLayout;
  selectedId: string | null;
  phone: boolean;
  /** A node was clicked or activated with Enter. */
  onActivate: (nodeId: string) => void;
  onPaneClick: () => void;
  /** A cable was dragged from a ghost to the agent (or the other way). */
  onConnectGhost: (nodeId: string) => void;
  /** Delete was pressed on a selected component or cable. */
  onDelete: (nodeId: string) => void;
  onHover: (nodeId: string | null) => void;
  apiRef: ReactRef<BuilderCanvasApi>;
};

export function BuilderCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

function ariaFor(v: VNode): string | undefined {
  switch (v.type) {
    case "agent":
      return "The agent. Press Enter to edit its name, limits and delegation.";
    case "item":
      return `${v.item.title}, ${v.item.type}, ${v.item.connected ? "connected" : "switched off"}. Press Enter to edit it${v.item.locked ? "." : ", Delete to disconnect it."}`;
    case "ghost":
      return `${v.item.title}, ${v.item.type}, not connected. Press Enter to read about it, or use its Connect button.`;
    case "overflow":
      return `${v.items.length} more connected ${v.kind === "mcp" ? "MCP servers" : "skills"}. Press Enter to manage them.`;
    case "adder":
      return v.adder === "private-mcp" ? "Add an MCP server" : v.adder === "trigger" ? "Add a trigger" : "Open the list of components that are not connected";
    case "label":
      return undefined;
  }
}

function toNodes(vnodes: VNode[], selectedId: string | null, prev: BuilderNode[]): BuilderNode[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  return vnodes.map((v) => ({
    id: v.id,
    type: v.type,
    position: { x: v.x, y: v.y },
    // Only a first-paint hint: React Flow measures the real size.
    initialWidth: v.w,
    initialHeight: v.h,
    measured: old.get(v.id)?.measured,
    data: { v },
    draggable: false,
    selectable: v.type !== "label",
    focusable: v.type !== "label",
    // Delete on a node is handled by onKeyDown, so it also works on a node that is focused but not selected.
    deletable: false,
    connectable: v.type === "ghost",
    selected: v.id === selectedId,
    ariaLabel: ariaFor(v),
    ...(v.type === "label" ? { style: { pointerEvents: "none" as const } } : {}),
  }));
}

function Flow({ layout, selectedId, phone, onActivate, onPaneClick, onConnectGhost, onDelete, onHover, apiRef }: Props) {
  const rf = useReactFlow<BuilderNode, LinkEdgeT>();
  const reduce = useReducedMotion();
  const cover = useRef(0);
  // Once the user pans or zooms, the view is theirs: a sheet opening may nudge a hidden node into sight, but never refits.
  const touched = useRef(false);
  // View moves run one after another: a move computed from a view that is still gliding would drift.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const fit = useCallback(() => {
    touched.current = false;
    void rf.fitView({ padding: { ...FIT_PADDING, right: `${cover.current + 32}px` }, maxZoom: 1, duration: reduce ? 0 : 450 });
  }, [rf, reduce]);
  const move = useCallback(
    (dx: number) => {
      queue.current = queue.current.then(() => {
        const vp = rf.getViewport();
        return rf.setViewport({ ...vp, x: vp.x + dx }, { duration: reduce ? 0 : 350 });
      });
    },
    [rf, reduce],
  );

  // The nodes live in state, and carry the sizes React Flow measures: it reads a node that arrives without one as "not measured", forgets where
  // its handles are, and then a cable has nothing to attach to. Rebuilding them from the layout keeps what it measured.
  const [nodes, setNodes] = useState<BuilderNode[]>(() => toNodes(layout.nodes, selectedId, []));
  const [from, setFrom] = useState({ layout: layout.nodes, selectedId });
  if (from.layout !== layout.nodes || from.selectedId !== selectedId) {
    setFrom({ layout: layout.nodes, selectedId });
    setNodes((prev) => toNodes(layout.nodes, selectedId, prev));
  }

  // Cables attach to handles React Flow has measured, and it forgets those whenever a node is rebuilt a moment after it was measured (a skill list
  // arriving, an engine event); a node that kept its size is then never looked at again. Asking for a fresh measure after each rebuild is the supported fix.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(layout.nodes.map((n) => n.id)));
    return () => cancelAnimationFrame(frame);
  }, [layout.nodes, updateNodeInternals]);

  const edges = useMemo<LinkEdgeT[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: "agent",
        sourceHandle: "out",
        targetHandle: e.side === "stack" ? "left" : e.side,
        type: "link",
        selectable: !!e.item && !e.item.locked,
        focusable: false,
        deletable: !!e.item && !e.item.locked,
        data: { group: e.group, connected: e.connected, nodeId: e.source, title: e.item?.title ?? "", ref: e.item && !e.item.locked ? e.item.ref : null, stack: e.side === "stack" },
      })),
    [layout.edges],
  );

  const ghosts = useMemo(() => new Set(layout.nodes.filter((n) => n.type === "ghost" && !n.item.blocked).map((n) => n.id)), [layout.nodes]);

  useEffect(() => {
    // First paint: the whole composition on a desktop; on a phone the agent at a readable size (the rest is a pan away).
    if (phone) void rf.setViewport({ x: window.innerWidth / 2, y: 128, zoom: 0.92 }, { duration: 0 });
    else void rf.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: 0 });
    // Only on mount: later layout changes must not move the user's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    apiRef,
    () => ({
      fit,
      setCover(px) {
        if (px === cover.current) return;
        cover.current = px;
        if (touched.current) return;
        void rf.fitView({ padding: { ...FIT_PADDING, right: `${px + 32}px` }, maxZoom: 1, duration: reduce ? 0 : 400 });
      },
      reveal(nodeId) {
        const n = rf.getNode(nodeId);
        if (!n || !cover.current) return;
        const right = rf.flowToScreenPosition({ x: n.position.x + (n.measured?.width ?? n.initialWidth ?? 0), y: n.position.y }).x;
        const limit = window.innerWidth - cover.current - 24;
        if (right <= limit) return;
        move(limit - right);
      },
    }),
    [rf, reduce, move, fit],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      for (const c of changes) if (c.type === "select" && c.selected) onActivate(c.id);
      // Selection is ours (the open panel); everything else (measured sizes) is React Flow's to keep.
      setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "select"), ns));
    },
    [onActivate],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const other = c.source === "agent" ? c.target : c.source;
      if (ghosts.has(other)) onConnectGhost(other);
    },
    [ghosts, onConnectGhost],
  );

  const isValidConnection = useCallback(
    (c: { source: string; target: string }) => (c.source === "agent" && ghosts.has(c.target)) || (c.target === "agent" && ghosts.has(c.source)),
    [ghosts],
  );

  // The graph is derived from the draft, so the canvas never removes anything itself: Delete asks the builder to disconnect, and we veto the removal.
  const onBeforeDelete = useCallback<OnBeforeDelete<BuilderNode, LinkEdgeT>>(
    async ({ nodes: ns, edges: es }) => {
      const id = ns[0]?.id ?? es[0]?.data?.nodeId;
      if (id) onDelete(id);
      return false;
    },
    [onDelete],
  );

  return (
    <ReactFlow<BuilderNode, LinkEdgeT>
      className="builder-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={builderNodeTypes}
      edgeTypes={builderEdgeTypes}
      onNodesChange={onNodesChange}
      onPaneClick={onPaneClick}
      // A move that came from the pointer has an event; the ones this component starts do not. (A plain click also "starts" a move, so only real movement counts.)
      onMove={(e) => {
        if (e) touched.current = true;
      }}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onBeforeDelete={onBeforeDelete}
      onNodeMouseEnter={(_, n) => onHover(n.id)}
      onNodeMouseLeave={() => onHover(null)}
      onEdgeMouseEnter={(_, e) => onHover(e.data?.nodeId ?? null)}
      onEdgeMouseLeave={() => onHover(null)}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={56}
      nodesDraggable={false}
      nodesFocusable
      edgesFocusable={false}
      elementsSelectable
      deleteKeyCode="Delete"
      onKeyDown={(e) => {
        if (e.key !== "Delete" || !(e.target instanceof HTMLElement) || !e.target.classList.contains("react-flow__node")) return;
        const id = e.target.dataset.id;
        if (id) onDelete(id);
      }}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      minZoom={0.2}
      maxZoom={1.6}
      attributionPosition="bottom-left"
      aria-label="Agent builder canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--canvas-dot)" />
      <Controls showInteractive={false} position="bottom-right" aria-label="Zoom controls" className="!bottom-24 sm:!bottom-4" onFitView={fit} />
    </ReactFlow>
  );
}
