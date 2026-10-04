import { describe, expect, it } from "vitest";
import type { Draft } from "../../lib/client/draft";
import { AGENT_H, AGENT_W, CAP, layoutBuilder, type VNode } from "./layout";
import { addTrigger, connect, deriveItems, disconnect, type Ctx } from "./model";

const library = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `skill-${String(i).padStart(3, "0")}`, name: `skill-${i}`, description: `Skill ${i}` }));
const draft = (config: Record<string, unknown> = {}): Draft => ({ config: { id: "a", name: "A", models: { main: { id: "p/m" } }, model: "main", ...config }, instructionsText: "x", soulText: "" });
const ctxOf = (skills = 3): Ctx => ({ agentId: "a", skills: library(skills) });
const lay = (d: Draft, skills = 3, mode: "wide" | "stack" = "wide") => layoutBuilder(deriveItems(d, ctxOf(skills)), mode);
const overlap = (a: VNode, b: VNode) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const servers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`srv${i}`, { command: "x" }]));
const busy = draft({
  tools: { builtin: ["workspace", "schedule"], mcp: servers(9) },
  memory: { semanticRecall: { enabled: true }, observational: { enabled: true }, subconscious: { enabled: true } },
  triggers: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, type: "cron", cron: "0 9 * * *", prompt: "p" })),
});
const noOverlap = (nodes: VNode[]) => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(overlap(nodes[i]!, nodes[j]!), `${nodes[i]!.id} vs ${nodes[j]!.id}`).toBe(false);
};

describe("builder layout", () => {
  it("never overlaps two nodes, with a plain agent, a busy one and a huge library, wide or stacked", () => {
    for (const d of [draft(), busy]) for (const skills of [0, 3, 100]) for (const mode of ["wide", "stack"] as const) noOverlap(lay(d, skills, mode).nodes);
  });

  it("lays the chain out right to left from the agent: llm, storage, memory blocks, subconscious", () => {
    const { nodes } = lay(busy);
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const right = (id: string) => at(id).x + at(id).w;
    expect(right("llm")).toBeLessThan(-AGENT_W / 2);
    expect(right("storage")).toBeLessThan(at("llm").x);
    for (const b of ["lastMessages", "workingMemory", "semanticRecall", "observational"]) expect(right(b)).toBeLessThan(at("storage").x);
    expect(right("subconscious")).toBeLessThan(at("semanticRecall").x);
    // the subconscious sits between the two blocks it reads
    expect(at("subconscious").y).toBeGreaterThan(at("semanticRecall").y);
    expect(at("subconscious").y).toBeLessThan(at("observational").y);
    for (const id of ["workspace", "mcp:srv0", "skill:skill-000"]) expect(at(id).x).toBeGreaterThan(AGENT_W / 2);
    for (const id of ["instructions", "soul"]) expect(at(id).y + at(id).h).toBeLessThan(-AGENT_H / 2);
    for (const id of ["telegram", "trigger:t0", "adder:trigger"]) expect(at(id).y).toBeGreaterThan(AGENT_H / 2);
  });

  it("draws an edge for each real data relation, and none for what is off", () => {
    const edges = (d: Draft) => lay(d).edges.map((e) => `${e.source}->${e.target}`);
    const plain = edges(draft());
    expect(plain).toEqual(expect.arrayContaining(["llm->agent", "storage->llm", "lastMessages->storage", "workingMemory->storage", "instructions->agent", "workspace->agent"]));
    expect(plain.some((e) => e.startsWith("semanticRecall") || e.startsWith("subconscious") || e.startsWith("soul") || e.startsWith("telegram"))).toBe(false);
    expect(edges(busy)).toEqual(expect.arrayContaining(["subconscious->semanticRecall", "subconscious->observational", "semanticRecall->storage", "observational->storage"]));
    // stateless: storage and every block are ghosts, only llm -> agent is left of the agent
    const stateless = edges(disconnect(draft(), { kind: "storage" }, ctxOf()));
    expect(stateless.filter((e) => ["storage", "lastMessages", "workingMemory"].some((k) => e.startsWith(k)))).toEqual([]);
    expect(lay(disconnect(draft(), { kind: "storage" }, ctxOf())).nodes.find((n) => n.id === "storage")?.type).toBe("ghost");
  });

  it("chain cables arrive on the node's 'in' handle, the agent's own on the side they sit", () => {
    const { edges } = lay(busy);
    const e = (id: string) => edges.find((x) => x.id === id)!;
    expect(e("e:storage->llm").targetHandle).toBe("in");
    expect(e("e:subconscious->observational").targetHandle).toBe("in");
    expect(e("e:llm->agent").targetHandle).toBe("left");
    expect(e("e:workspace->agent").targetHandle).toBe("right");
    expect(e("e:instructions->agent").targetHandle).toBe("top");
    expect(e("e:trigger:t0->agent").targetHandle).toBe("bottom");
    expect(lay(busy, 3, "stack").edges.every((x) => x.side === "stack" && (x.targetHandle === "in" || x.targetHandle === "left"))).toBe(true);
  });

  it("stacks the same nodes in one column under the agent on a phone", () => {
    const { nodes } = lay(busy, 100, "stack");
    const agent = nodes.find((n) => n.id === "agent")!;
    const comps = nodes.filter((n) => n.type !== "agent" && n.type !== "label");
    expect(comps.every((n) => n.y > agent.y + agent.h)).toBe(true);
    expect(new Set(comps.map((n) => n.x)).size).toBe(1);
    expect(nodes.map((n) => n.id).sort()).toEqual(lay(busy, 100, "wide").nodes.map((n) => n.id).sort());
  });

  it("is the same every time, and connecting a component changes only that node", () => {
    expect(lay(busy)).toEqual(lay(busy));
    const ctx = ctxOf();
    const pos = (l: ReturnType<typeof lay>) => Object.fromEntries(l.nodes.map((n) => [n.id, [n.x, n.y]]));
    for (const ref of [{ kind: "semanticRecall" }, { kind: "subconscious" }, { kind: "soul" }, { kind: "telegram" }] as const) {
      const before = layoutBuilder(deriveItems(draft(), ctx));
      const after = layoutBuilder(deriveItems(connect(draft(), ref, ctx), ctx));
      expect(pos(after)).toEqual(pos(before));
      expect(before.nodes.find((n) => n.id === ref.kind)?.type).toBe("ghost");
      expect(after.nodes.find((n) => n.id === ref.kind)?.type).toBe("item");
    }
  });

  it("keeps a 100-skill library and a dozen MCP servers to a handful of nodes", () => {
    const { nodes } = lay(draft({ tools: { mcp: servers(12) } }), 100);
    expect(nodes.filter((n) => n.id.startsWith("skill:")).length).toBe(CAP);
    expect(nodes.filter((n) => n.id.startsWith("mcp:")).length).toBe(CAP);
    const more = nodes.find((n) => n.id === "overflow:skill");
    expect(more && "items" in more ? more.items.length : 0).toBe(100 - CAP);
    expect(nodes.find((n) => n.id === "overflow:mcp")).toBeTruthy();
    expect(nodes.length).toBeLessThan(45);
  });

  it("summarises unconnected skills behind one node, or draws them when there are very few", () => {
    expect(lay(draft({ skills: { enabled: [] } }), 100).nodes.find((n) => n.id === "adder:skills")).toMatchObject({ count: 100 });
    expect(lay(draft({ skills: { enabled: [] } }), 2).nodes.filter((n) => n.type === "ghost" && n.id.startsWith("skill:")).length).toBe(2);
  });

  it("a switched-off trigger or MCP server stays a node with a dashed (unconnected) edge", () => {
    const d = addTrigger(draft({ tools: { mcp: { off: { command: "x", enabled: false } } } }), { id: "gh", type: "github-pr", enabled: false, repo: "a/b", tokenEnv: "GITHUB_TOKEN", prompt: "p" });
    const { nodes, edges } = lay(d);
    expect(nodes.find((n) => n.id === "trigger:gh")?.type).toBe("item");
    expect(edges.find((e) => e.id === "e:trigger:gh->agent")).toMatchObject({ connected: false });
    expect(edges.find((e) => e.id === "e:mcp:off->agent")).toMatchObject({ connected: false });
  });
});
