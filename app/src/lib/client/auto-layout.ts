import type { Topology } from "@eigen/engine/schema";
import type { Layout } from "@/lib/types";

export const NODE_SIZE: Record<string, { w: number; h: number }> = {
  agent: { w: 264, h: 132 },
  channel: { w: 224, h: 84 },
  mcp: { w: 200, h: 60 },
};

const COL_GAP = 120;
const ROW_GAP = 36;
/** Space between a bot node and the agent it answers as. */
const BOT_GAP = 56;
/** A bot sits a little above its agent's midline, so the cable arriving at the agent's left handle does not run through it. */
const BOT_LIFT = 44;

/**
 * Layered layout without dagre: agents by delegation depth from the primary (BFS over "delegates" edges), then MCP servers.
 * Each Telegram bot (`channel:telegram:<agentId>`) sits left of its agent, in a lane reserved in that agent's column.
 * Saved positions win; auto-placed nodes are nudged until they no longer overlap anything already placed.
 * A saved key for a node that no longer exists (like the old single `channel:telegram`) is ignored.
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

  // Bots: the ones whose agent exists get a lane beside it; any other is an orphan and goes in a column of its own on the far left.
  const agentIds = new Set(agents.map((a) => a.id as string));
  const botAgent = new Map<string, string>();
  for (const n of topology.nodes) if (n.type === "channel" && n.data.routesTo && agentIds.has(`agent:${n.data.routesTo}`)) botAgent.set(n.id, `agent:${n.data.routesTo}`);
  const orphans = topology.nodes.filter((n) => n.type === "channel" && !botAgent.has(n.id));
  const laneCols = new Set([...botAgent.values()].map((id) => depth.get(id)!));

  const columns = new Map<number, string[]>();
  const colOf = (id: string, type: string) => (type === "channel" ? 0 : type === "mcp" ? agentCols + 1 : depth.get(id)!);
  for (const n of topology.nodes) {
    if (botAgent.has(n.id)) continue;
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

  // Column x (where an agent's left edge goes): orphans, then per agent depth [bot lane] + agent, then MCP servers.
  const colX: number[] = [];
  let x = 0;
  colX[0] = 0;
  if (orphans.length) x = NODE_SIZE.channel!.w + COL_GAP;
  for (let c = 1; c <= agentCols; c++) {
    x += laneCols.has(c) ? NODE_SIZE.channel!.w + BOT_GAP : 0;
    colX[c] = x;
    x += NODE_SIZE.agent!.w + COL_GAP;
  }
  colX[agentCols + 1] = x;

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

  // Bots go last, relative to wherever their agent ended up (auto-placed or saved); they nudge upward, away from the agents below.
  for (const [botId, agentId] of botAgent) {
    if (out[botId]) continue;
    const a = out[agentId]!;
    const size = NODE_SIZE.channel!;
    const r = { x: a.x - BOT_GAP - size.w, y: a.y - BOT_LIFT, ...size };
    let guard = 0;
    while (overlaps(r) && guard++ < 200) r.y -= 24;
    out[botId] = { x: r.x, y: Math.round(r.y) };
    placed.push(r);
  }
  return out;
}
