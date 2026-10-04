import type { Topology } from "@eigen/engine/schema";
import type { Layout } from "@/lib/types";

export const NODE_SIZE: Record<string, { w: number; h: number }> = {
  agent: { w: 264, h: 132 },
  channel: { w: 208, h: 76 },
  mcp: { w: 200, h: 60 },
};

const COL_GAP = 120;
const ROW_GAP = 36;

/**
 * Layered layout without dagre: column 0 is the channel, then agents by delegation depth from the primary
 * (BFS over "delegates" edges), then MCP servers. Saved positions win; auto-placed nodes are nudged down until
 * they no longer overlap anything already placed.
 */
export function autoLayout(topology: Topology, saved: Layout): Layout {
  const depth = new Map<string, number>();
  const agents = topology.nodes.filter((n) => n.type === "agent");
  const primary = agents.find((n) => n.type === "agent" && n.data.primary && n.data.enabled);
  const delegates = topology.edges.filter((e) => e.type === "delegates");
  if (primary) {
    depth.set(primary.id, 1);
    const queue = [primary.id as string];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of delegates)
        if (e.source === cur && !depth.has(e.target)) {
          depth.set(e.target, depth.get(cur)! + 1);
          queue.push(e.target);
        }
    }
  }
  const maxAgentDepth = Math.max(1, ...depth.values());
  for (const a of agents) if (!depth.has(a.id)) depth.set(a.id, primary ? 2 : 1);
  const agentCols = Math.max(maxAgentDepth, ...agents.map((a) => depth.get(a.id)!));

  const columns = new Map<number, string[]>();
  const colOf = (id: string, type: string) => (type === "channel" ? 0 : type === "mcp" ? agentCols + 1 : depth.get(id)!);
  for (const n of topology.nodes) {
    const c = colOf(n.id, n.type);
    columns.set(c, [...(columns.get(c) ?? []), n.id]);
  }

  const typeOf = new Map<string, string>(topology.nodes.map((n) => [n.id, n.type]));
  const out: Layout = {};
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const [id, p] of Object.entries(saved)) {
    const t = typeOf.get(id);
    if (!t) continue;
    out[id] = p;
    placed.push({ ...p, ...NODE_SIZE[t]! });
  }

  // Column x: channel, agents, mcp. Widths come from the widest node type in the column.
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c <= agentCols + 1; c++) {
    colX[c] = x;
    const w = c === 0 ? NODE_SIZE.channel!.w : c === agentCols + 1 ? NODE_SIZE.mcp!.w : NODE_SIZE.agent!.w;
    x += w + COL_GAP;
  }

  const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
    placed.some((p) => r.x < p.x + p.w + 16 && r.x + r.w + 16 > p.x && r.y < p.y + p.h + 16 && r.y + r.h + 16 > p.y);

  for (const [c, ids] of columns) {
    const todo = ids.filter((id) => !out[id]);
    if (!todo.length) continue;
    const heights = todo.map((id) => NODE_SIZE[typeOf.get(id)!]!.h);
    const total = heights.reduce((s, h) => s + h, 0) + ROW_GAP * (todo.length - 1);
    let y = -total / 2;
    todo.forEach((id, i) => {
      const size = NODE_SIZE[typeOf.get(id)!]!;
      const r = { x: colX[c]!, y, ...size };
      let guard = 0;
      while (overlaps(r) && guard++ < 200) r.y += 24;
      out[id] = { x: r.x, y: Math.round(r.y) };
      placed.push(r);
      y = r.y + heights[i]! + ROW_GAP;
    });
  }
  return out;
}
