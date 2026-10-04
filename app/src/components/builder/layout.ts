/**
 * Where everything sits on the builder canvas. Derived, never dragged: the same agent always lays out the same way,
 * and connecting or disconnecting a component changes ONE node (ghost <-> connected) and moves nothing else.
 *
 *                                                  Prompt: [instructions] [soul]
 *                 Memory
 *   [subconscious] [semantic recall]
 *                  [observational]    [storage] -> [llm] ->   AGENT   <- Can use: workspace, schedule, MCP servers, skills
 *                  [last messages]
 *                  [working memory]
 *                                                  Reaches it: [telegram] [trigger] ... [+ trigger]
 *
 * Edges are data relations: a memory block feeds the storage, the storage feeds the LLM, the subconscious reads both recall blocks.
 * On a phone ("stack") the same slots run in one column under the agent, and every cable runs along a spine on their left.
 *
 * A library of 100 skills is never 100 nodes: at most CAP connected ones are drawn, the rest fold into one "+N more" node,
 * and the ones that are not connected live in the palette behind one summary node.
 * Pure (no React) so it is tested directly.
 */
import { AGENT_NODE, type Group, type Item, type Kind } from "./model";

export const NODE_W = 260;
export const NODE_H = 58;
export const AGENT_W = 300;
export const AGENT_H = 176;
const GAP = 10;
const PITCH = NODE_H + GAP;
/** Between two columns of the chain: room for a cable with an arrow. */
const CHAIN_GAP = 64;
const COL_GAP = 130;
const ROW_GAP = 16;
const LABEL_H = 20;
/** Most nodes drawn per collection (MCP servers, skills); the rest fold into one summary node. */
export const CAP = 5;
/** Ghost skills are drawn one by one only while there are this few; otherwise one summary node stands for them. */
const GHOST_SKILLS = 3;
/** The bot and the triggers sit under the agent, two per row, so the row never reaches the tool column. */
const PER_ROW = 2;

/** Which side of the node its outgoing cable leaves from: the opposite of where it sits relative to what it feeds. */
export type Side = "chain" | "right" | "top" | "bottom" | "stack";
export type Adder = "mcp" | "trigger" | "skills";
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
/** `targetHandle`: the agent's side the cable arrives on, or "in" on a chain node. */
export type VEdge = { id: string; source: string; target: string; targetHandle: "left" | "right" | "top" | "bottom" | "in"; side: Side; group: Group; item: Item | null; connected: boolean };
export type BuilderLayout = { nodes: VNode[]; edges: VEdge[] };

export const GROUP_TITLE: Record<Group, string> = { think: "Prompt", memory: "Memory", tools: "Can use", reach: "Reaches it, wakes it" };

/** What goes in a slot, before it has a place. */
type Slot = { item: Item } | { overflow: "mcp" | "skill"; items: Item[] } | { adder: Adder; count: number };

const byKind = (items: Item[], k: Kind) => items.filter((i) => i.ref.kind === k);
const one = (items: Item[], k: Kind) => ({ item: byKind(items, k)[0]! });

/** The tool column: built-ins, MCP servers, skills, each collection folded at CAP. */
function toolSlots(items: Item[]): Slot[] {
  const tools: Slot[] = [one(items, "workspace"), one(items, "schedule")];
  const mcp = byKind(items, "mcp");
  mcp.slice(0, CAP).forEach((item) => tools.push({ item }));
  if (mcp.length > CAP) tools.push({ overflow: "mcp", items: mcp.slice(CAP) });
  tools.push({ adder: "mcp", count: 0 });

  const skills = byKind(items, "skill");
  const on = skills.filter((i) => i.connected);
  const off = skills.filter((i) => !i.connected);
  on.slice(0, CAP).forEach((item) => tools.push({ item }));
  if (on.length > CAP) tools.push({ overflow: "skill", items: on.slice(CAP) });
  if (off.length > 0 && off.length <= GHOST_SKILLS) off.forEach((item) => tools.push({ item }));
  else tools.push({ adder: "skills", count: off.length });
  return tools;
}

/** A node that exists in the config is drawn as a component even while switched off (an MCP entry, a trigger): it keeps its settings. */
const drawnAsItem = (i: Item) => i.connected || i.ref.kind === "trigger" || i.ref.kind === "mcp";

export function layoutBuilder(items: Item[], mode: LayoutMode = "wide"): BuilderLayout {
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  const stack = mode === "stack";

  /** Where each node's cable arrives: the agent's side for its own components, "in" for a chain node. */
  const arrive = (target: string, side: Side): VEdge["targetHandle"] => {
    if (target !== AGENT_NODE) return "in";
    return side === "chain" || side === "stack" ? "left" : side;
  };

  const emit = (slot: Slot, x: number, y: number, side: Side, group: Group) => {
    const box = { x, y, w: NODE_W, h: NODE_H };
    if ("item" in slot) {
      const item = slot.item;
      const live = drawnAsItem(item);
      nodes.push(live ? { ...box, id: item.id, type: "item", item, side } : { ...box, id: item.id, type: "ghost", item, side });
      if (live) for (const t of item.targets) edges.push({ id: `e:${item.id}->${t}`, source: item.id, target: t, targetHandle: arrive(t, side), side, group, item, connected: item.connected });
    } else if ("overflow" in slot) {
      const id = `overflow:${slot.overflow}`;
      nodes.push({ ...box, id, type: "overflow", kind: slot.overflow, items: slot.items, side });
      edges.push({ id: `e:${id}->agent`, source: id, target: AGENT_NODE, targetHandle: arrive(AGENT_NODE, side), side, group, item: null, connected: true });
    } else nodes.push({ ...box, id: `adder:${slot.adder}`, type: "adder", adder: slot.adder, count: slot.count, side });
  };
  const label = (group: Group, x: number, top: number, w = NODE_W) => nodes.push({ id: `label:${group}`, type: "label", group, text: GROUP_TITLE[group], x, y: top - LABEL_H - 8, w, h: LABEL_H });

  // The two blocks the subconscious reads come first, so its cables stay short.
  const memory = ["semanticRecall", "observational", "lastMessages", "workingMemory"] as const;
  const prompt: Slot[] = [one(items, "instructions"), one(items, "soul")];
  const reach: Slot[] = [one(items, "telegram"), ...byKind(items, "trigger").map((item) => ({ item })), { adder: "trigger", count: 0 }];

  if (stack) {
    nodes.push({ id: AGENT_NODE, type: "agent", x: -AGENT_W / 2, y: 0, w: AGENT_W, h: AGENT_H });
    const groups: Array<[Group, Slot[]]> = [
      ["think", [one(items, "llm"), ...prompt]],
      ["memory", [one(items, "storage"), ...memory.map((b) => one(items, b)), one(items, "subconscious")]],
      ["tools", toolSlots(items)],
      ["reach", reach],
    ];
    let y = AGENT_H + 20 + LABEL_H + 8;
    for (const [group, slots] of groups) {
      label(group, -NODE_W / 2, y);
      for (const slot of slots) {
        emit(slot, -NODE_W / 2, y, "stack", group);
        y += PITCH;
      }
      y += 20 + LABEL_H + 8;
    }
    // The LLM is "Thinks with" in a column, so its label says so.
    (nodes.find((n) => n.id === "label:think") as Extract<VNode, { type: "label" }>).text = "Thinks with";
    return { nodes, edges };
  }

  nodes.push({ id: AGENT_NODE, type: "agent", x: -AGENT_W / 2, y: -AGENT_H / 2, w: AGENT_W, h: AGENT_H });
  // The chain, right to left from the agent: llm, storage, the memory blocks, the subconscious. All centred on the agent's middle.
  const llmX = -AGENT_W / 2 - CHAIN_GAP - NODE_W;
  const storageX = llmX - CHAIN_GAP - NODE_W;
  const memX = storageX - CHAIN_GAP - NODE_W;
  const subX = memX - CHAIN_GAP - NODE_W;
  const memTop = -(memory.length * PITCH - GAP) / 2;
  emit(one(items, "llm"), llmX, -NODE_H / 2, "chain", "think");
  emit(one(items, "storage"), storageX, -NODE_H / 2, "chain", "memory");
  memory.forEach((b, i) => emit(one(items, b), memX, memTop + i * PITCH, "chain", "memory"));
  // Level with the gap between the two blocks it reads (semantic recall and observational are the first two).
  emit(one(items, "subconscious"), subX, memTop + PITCH / 2, "chain", "memory");
  label("memory", memX, memTop);

  // Tools hang from the same line as the memory column, on the right.
  const rightX = AGENT_W / 2 + COL_GAP;
  toolSlots(items).forEach((slot, i) => emit(slot, rightX, memTop + i * PITCH, "right", "tools"));
  label("tools", rightX, memTop);

  // Prompt pieces in one row above the agent, reach rows below it; both centred on the agent.
  const rowX = (n: number, inRow: number) => (n - (inRow - 1) / 2) * (NODE_W + ROW_GAP) - NODE_W / 2;
  const promptY = -AGENT_H / 2 - 64 - NODE_H;
  prompt.forEach((slot, n) => emit(slot, rowX(n, prompt.length), promptY, "top", "think"));
  label("think", rowX(0, prompt.length), promptY, prompt.length * (NODE_W + ROW_GAP) - ROW_GAP);
  const reachY = AGENT_H / 2 + 64;
  reach.forEach((slot, n) => {
    const row = Math.floor(n / PER_ROW);
    const inRow = Math.min(PER_ROW, reach.length - row * PER_ROW);
    emit(slot, rowX(n % PER_ROW, inRow), reachY + row * (NODE_H + ROW_GAP), "bottom", "reach");
  });
  label("reach", rowX(0, Math.min(PER_ROW, reach.length)), reachY, Math.min(PER_ROW, reach.length) * (NODE_W + ROW_GAP) - ROW_GAP);
  return { nodes, edges };
}
