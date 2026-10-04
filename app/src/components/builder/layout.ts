/**
 * Where everything sits on the builder canvas. Derived, never dragged: the same agent always lays out the same way,
 * and connecting or disconnecting a component changes ONE node (ghost <-> connected) and moves nothing else.
 *
 *            Reaches it, wakes it:  [telegram] [trigger] [trigger] [+ trigger]
 *
 *   Thinks with           AGENT            Can use
 *   model                                  workspace
 *   instructions                           schedule
 *   soul                                   mcp servers ...
 *   recent messages                        skills ...
 *   semantic recall
 *   observational memory
 *
 * On a phone ("stack") the same slots run in one column under the agent, and every cable runs up a spine on their left.
 *
 * A library of 100 skills is never 100 nodes: at most CAP connected ones are drawn, the rest fold into one "+N more" node,
 * and the ones that are not connected live in the palette behind one summary ghost.
 * Pure (no React) so it is tested directly.
 */
import type { Group, Item, Kind } from "./model";

export const NODE_W = 280;
export const NODE_H = 58;
export const AGENT_W = 300;
export const AGENT_H = 176;
const GAP = 10;
const PITCH = NODE_H + GAP;
const COL_GAP = 130;
const ROW_GAP = 16;
const LABEL_H = 20;
/** Most nodes drawn per collection (MCP servers, skills); the rest fold into one summary node. */
export const CAP = 5;
/** A root catalog this small is shown whole (each server a node, connected or ghost); a bigger one shows only what is connected. */
const WHOLE_CATALOG = 6;
/** Ghost skills are drawn one by one only while there are this few; otherwise one summary ghost stands for them. */
const GHOST_SKILLS = 3;
const PER_ROW = 4;

export type Side = "left" | "right" | "top" | "stack";
export type Adder = "private-mcp" | "trigger" | "mcp-more" | "skills";
export type LayoutMode = "wide" | "stack";

type Box = { id: string; x: number; y: number; w: number; h: number };
export type VNode = Box &
  (
    | { type: "agent" }
    | { type: "item"; item: Item; side: Side }
    | { type: "ghost"; item: Item; side: Side }
    | { type: "overflow"; kind: "mcp" | "skill"; items: Item[]; side: Side }
    | { type: "adder"; adder: Adder; count: number; side: Side }
    | { type: "label"; group: Group; text: string }
  );
export type VEdge = { id: string; source: string; target: string; side: Side; group: Group; item: Item | null; overflow?: boolean; connected: boolean };
export type BuilderLayout = { nodes: VNode[]; edges: VEdge[] };

const THINK: Kind[] = ["model", "instructions", "soul", "recent", "semantic", "observational"];

/** What goes in a slot, before it has a place. */
type Slot = { item: Item } | { overflow: "mcp" | "skill"; items: Item[] } | { adder: Adder; count: number };

/** The slots of each group, in order. The same list feeds both placements. */
function slotsOf(items: Item[]): Record<Group, Slot[]> {
  const byKind = (k: Kind) => items.filter((i) => i.ref.kind === k);
  const think: Slot[] = THINK.map((k) => ({ item: byKind(k)[0]! }));

  // Built-in tools. A specialist is not offered the schedule tool; if its file lists it anyway, it stays as a node that says it does nothing.
  const tools: Slot[] = [{ item: byKind("workspace")[0]! }];
  const schedule = byKind("schedule")[0]!;
  if (schedule.connected || !schedule.unavailable) tools.push({ item: schedule });

  // MCP servers. A small catalog is shown whole, so a server keeps its slot whether it is connected or not; a big one shows only what is connected.
  const root = byKind("mcp");
  const whole = root.length <= WHOLE_CATALOG;
  const mcp = [...(whole ? root : root.filter((i) => i.connected)), ...byKind("private-mcp")];
  let drawn = 0;
  for (const i of mcp) if (!i.connected || ++drawn <= CAP) tools.push({ item: i });
  const folded = mcp.filter((i) => i.connected).slice(CAP);
  if (folded.length) tools.push({ overflow: "mcp", items: folded });
  const unused = root.filter((i) => !i.connected).length;
  if (!whole && unused) tools.push({ adder: "mcp-more", count: unused });
  tools.push({ adder: "private-mcp", count: 0 });

  // Skills.
  const skills = byKind("skill");
  const on = skills.filter((i) => i.connected);
  const off = skills.filter((i) => !i.connected);
  on.slice(0, CAP).forEach((i) => tools.push({ item: i }));
  if (on.length > CAP) tools.push({ overflow: "skill", items: on.slice(CAP) });
  if (off.length > 0 && off.length <= GHOST_SKILLS) off.forEach((i) => tools.push({ item: i }));
  else if (off.length > GHOST_SKILLS || skills.length === 0) tools.push({ adder: "skills", count: off.length });

  // The bot, then one node per trigger, then the add-trigger slot.
  const reach: Slot[] = [{ item: byKind("telegram")[0]! }, ...byKind("trigger").map((item) => ({ item })), { adder: "trigger", count: 0 }];
  return { think, tools, reach };
}

export function layoutBuilder(items: Item[], titles: Record<Group, string>, mode: LayoutMode = "wide"): BuilderLayout {
  const slots = slotsOf(items);
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];

  const emit = (slot: Slot, x: number, y: number, side: Side, group: Group) => {
    const box = { x, y, w: NODE_W, h: NODE_H };
    if ("item" in slot) {
      const item = slot.item;
      const live = item.connected || item.ref.kind === "trigger";
      nodes.push(live ? { ...box, id: item.id, type: "item", item, side } : { ...box, id: item.id, type: "ghost", item, side });
      if (live) edges.push({ id: `e:${item.id}`, source: item.id, target: "agent", side, group, item, connected: item.connected });
    } else if ("overflow" in slot) {
      const id = `overflow:${slot.overflow}`;
      nodes.push({ ...box, id, type: "overflow", kind: slot.overflow, items: slot.items, side });
      edges.push({ id: `e:${id}`, source: id, target: "agent", side, group, item: null, overflow: true, connected: true });
    } else nodes.push({ ...box, id: `adder:${slot.adder}`, type: "adder", adder: slot.adder, count: slot.count, side });
  };
  const label = (group: Group, x: number, bottom: number, w = NODE_W) => nodes.push({ id: `label:${group}`, type: "label", group, text: titles[group], x, y: bottom - LABEL_H - 8, w, h: LABEL_H });

  if (mode === "stack") {
    nodes.push({ id: "agent", type: "agent", x: -AGENT_W / 2, y: 0, w: AGENT_W, h: AGENT_H });
    let y = AGENT_H + 20 + LABEL_H + 8;
    for (const group of ["think", "tools", "reach"] as const) {
      label(group, -NODE_W / 2, y);
      for (const slot of slots[group]) {
        emit(slot, -NODE_W / 2, y, "stack", group);
        y += PITCH;
      }
      y += 20 + LABEL_H + 8;
    }
    return { nodes, edges };
  }

  nodes.push({ id: "agent", type: "agent", x: -AGENT_W / 2, y: -AGENT_H / 2, w: AGENT_W, h: AGENT_H });
  const leftX = -(AGENT_W / 2 + COL_GAP + NODE_W);
  const rightX = AGENT_W / 2 + COL_GAP;
  // Both columns hang from the same line, so a column growing never moves the other one.
  const top = -(THINK.length * PITCH - GAP) / 2;
  slots.think.forEach((slot, i) => emit(slot, leftX, top + i * PITCH, "left", "think"));
  slots.tools.forEach((slot, i) => emit(slot, rightX, top + i * PITCH, "right", "tools"));

  // Top: rows of PER_ROW, stacking upward from just above the columns.
  const reach = slots.reach;
  const rows = Math.ceil(reach.length / PER_ROW);
  const rowBottom = top - 76;
  reach.forEach((slot, n) => {
    const row = Math.floor(n / PER_ROW);
    const inRow = Math.min(PER_ROW, reach.length - row * PER_ROW);
    const x = ((n % PER_ROW) - (inRow - 1) / 2) * (NODE_W + ROW_GAP) - NODE_W / 2;
    emit(slot, x, rowBottom - NODE_H - row * (NODE_H + ROW_GAP), "top", "reach");
  });

  label("think", leftX, top);
  label("tools", rightX, top);
  const widest = Math.min(PER_ROW, reach.length) * (NODE_W + ROW_GAP) - ROW_GAP;
  label("reach", -widest / 2, rowBottom - NODE_H - (rows - 1) * (NODE_H + ROW_GAP), widest);
  return { nodes, edges };
}
