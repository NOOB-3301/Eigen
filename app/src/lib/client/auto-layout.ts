import { agentNodeId, type Topology } from "@eigen/engine/schema";
import type { Layout } from "@/lib/types";

export const NODE_SIZE: Record<string, { w: number; h: number }> = {
  agent: { w: 264, h: 132 },
  channel: { w: 224, h: 72 },
  mcp: { w: 200, h: 60 },
};

/** Space between a bot and its agent, and between an agent and its tool servers. */
const LINK_GAP = 64;
/** Space between two islands: wide enough that nobody reads two agents as wired together. */
const ISLAND_GAP_X = 140;
const ISLAND_GAP_Y = 110;
const MCP_GAP = 16;

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Every agent is an island: its Telegram bot on the left, the agent, its MCP servers stacked on the right. Islands go in a grid, left to
 * right, a roughly square number of columns. Saved positions win; an auto-placed island takes the next grid slot where it overlaps
 * nothing already placed, and a bot or server without a saved position is put beside wherever its agent ended up.
 * Saved keys for nodes that no longer exist are ignored.
 */
export function autoLayout(topology: Topology, saved: Layout): Layout {
  const typeOf = new Map<string, string>(topology.nodes.map((n) => [n.id, n.type]));
  const out: Layout = {};
  const placed: Rect[] = [];
  for (const [id, p] of Object.entries(saved)) {
    const t = typeOf.get(id);
    if (!t) continue;
    out[id] = p;
    placed.push({ ...p, ...NODE_SIZE[t]! });
  }
  const overlaps = (r: Rect) => placed.some((p) => r.x < p.x + p.w + 16 && r.x + r.w + 16 > p.x && r.y < p.y + p.h + 16 && r.y + r.h + 16 > p.y);

  const bot = new Map<string, string>();
  const servers = new Map<string, string[]>();
  for (const n of topology.nodes) {
    if (n.type === "channel") bot.set(agentNodeId(n.data.agentId), n.id);
    if (n.type === "mcp") servers.set(agentNodeId(n.data.agentId), [...(servers.get(agentNodeId(n.data.agentId)) ?? []), n.id]);
  }
  const A = NODE_SIZE.agent!;
  const C = NODE_SIZE.channel!;
  const M = NODE_SIZE.mcp!;
  const stackH = (k: number) => k * M.h + Math.max(0, k - 1) * MCP_GAP;
  // One cell size for every island, so the grid stays a grid: a bot lane on the left, the widest server column on the right.
  const anyBot = bot.size > 0;
  const anyMcp = servers.size > 0;
  const laneW = anyBot ? C.w + LINK_GAP : 0;
  const cellW = laneW + A.w + (anyMcp ? LINK_GAP + M.w : 0) + ISLAND_GAP_X;
  const cellH = Math.max(A.h, ...[...servers.values()].map((s) => stackH(s.length))) + ISLAND_GAP_Y;

  const agents = topology.nodes.filter((n) => n.type === "agent");
  const cols = Math.max(1, Math.ceil(Math.sqrt(agents.length)));
  let slot = 0;
  for (const a of agents) {
    if (out[a.id]) continue;
    const islandOf = (s: number): Rect => {
      const x = (s % cols) * cellW + laneW;
      const y = Math.floor(s / cols) * cellH;
      return { x: x - laneW, y, w: cellW - ISLAND_GAP_X, h: cellH - ISLAND_GAP_Y };
    };
    let guard = 0;
    while (overlaps(islandOf(slot)) && guard++ < 500) slot++;
    const island = islandOf(slot++);
    const r = { x: island.x + laneW, y: island.y + (island.h - A.h) / 2, ...A };
    out[a.id] = { x: r.x, y: Math.round(r.y) };
    placed.push(r);
  }

  // Bots and servers last, beside their agent (auto-placed or saved). A bot nudges upward, a server downward, away from neighbours.
  for (const [agentId, botId] of bot) {
    const a = out[agentId];
    if (!a || out[botId]) continue;
    const r = { x: a.x - LINK_GAP - C.w, y: a.y + (A.h - C.h) / 2, ...C };
    let guard = 0;
    while (overlaps(r) && guard++ < 200) r.y -= 24;
    out[botId] = { x: r.x, y: Math.round(r.y) };
    placed.push(r);
  }
  for (const [agentId, ids] of servers) {
    const a = out[agentId];
    if (!a) continue;
    let y = a.y + A.h / 2 - stackH(ids.length) / 2;
    for (const id of ids) {
      if (out[id]) continue;
      const r = { x: a.x + A.w + LINK_GAP, y, ...M };
      let guard = 0;
      while (overlaps(r) && guard++ < 200) r.y += 24;
      out[id] = { x: r.x, y: Math.round(r.y) };
      placed.push(r);
      y = r.y + M.h + MCP_GAP;
    }
  }
  return out;
}
