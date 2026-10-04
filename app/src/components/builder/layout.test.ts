import { describe, expect, it } from "vitest";
import type { RootInfo } from "../../lib/types";
import type { Draft } from "../../lib/client/draft";
import { AGENT_H, AGENT_W, CAP, layoutBuilder, type VNode } from "./layout";
import { addTrigger, connect, deriveItems, type Ctx } from "./model";

const titles = { think: "Thinks with", tools: "Can use", reach: "Reaches it, wakes it" };
const root = (servers: number): RootInfo => ({
  defaultModel: "fast",
  models: [{ key: "fast", id: "p/fast" }],
  mcpServers: Array.from({ length: servers }, (_, i) => ({ name: `srv${i}`, enabled: true, trusted: false })),
  defaults: { maxSteps: 25, lastMessages: 20, semanticRecall: { enabled: false, topK: 4, messageRange: 2 }, observational: { enabled: false } },
});
const library = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `skill-${String(i).padStart(3, "0")}`, name: `skill-${i}`, description: `Skill ${i}` }));
const draft = (config: Record<string, unknown> = {}): Draft => ({ config: { id: "a", name: "A", role: "r", description: "d", ...config }, instructionsText: "x", soulText: "" });
const lay = (d: Draft, servers = 3, skills = 3) => {
  const ctx: Ctx = { agentId: "a", root: root(servers), skills: library(skills) };
  return layoutBuilder(deriveItems(d, ctx), titles);
};
const overlap = (a: VNode, b: VNode) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("builder layout", () => {
  it("never overlaps two nodes, with a plain agent, a busy one and a huge library", () => {
    const busy = draft({ primary: true, tools: { builtin: ["workspace", "schedule"], mcp: { inherit: "all", servers: { mine: { command: "x" } } } }, triggers: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, type: "cron", cron: "0 9 * * *", prompt: "p" })) });
    for (const d of [draft(), busy]) for (const [servers, skills] of [[0, 0], [3, 3], [12, 100]] as const) {
      const { nodes } = lay(d, servers, skills);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(overlap(nodes[i]!, nodes[j]!), `${nodes[i]!.id} vs ${nodes[j]!.id}`).toBe(false);
    }
  });

  it("leaves out the schedule slot for a specialist unless its file lists the tool", () => {
    const ids = (d: Draft) => lay(d).nodes.map((n) => n.id);
    expect(ids(draft())).not.toContain("schedule");
    expect(ids(draft({ tools: { builtin: ["workspace", "schedule"] } }))).toContain("schedule");
    expect(ids(draft({ primary: true }))).toContain("schedule");
  });

  it("stacks everything in one column under the agent on a phone, with no overlap and every cable on the left", () => {
    const ctx: Ctx = { agentId: "a", root: root(3), skills: library(100) };
    const d = draft({ primary: true, tools: { builtin: ["workspace", "schedule"], mcp: { inherit: "all", servers: { mine: { command: "x" } } } }, triggers: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, type: "cron", cron: "0 9 * * *", prompt: "p" })) });
    const { nodes, edges } = layoutBuilder(deriveItems(d, ctx), titles, "stack");
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(overlap(nodes[i]!, nodes[j]!), `${nodes[i]!.id} vs ${nodes[j]!.id}`).toBe(false);
    const agent = nodes.find((n) => n.id === "agent")!;
    const comps = nodes.filter((n) => n.type !== "agent" && n.type !== "label");
    expect(comps.every((n) => n.y > agent.y + agent.h)).toBe(true);
    expect(new Set(comps.map((n) => n.x)).size).toBe(1);
    expect(edges.every((e) => e.side === "stack")).toBe(true);
    // same components as the wide layout, just placed differently
    const wide = layoutBuilder(deriveItems(d, ctx), titles, "wide");
    expect(nodes.map((n) => n.id).sort()).toEqual(wide.nodes.map((n) => n.id).sort());
  });

  it("is the same every time it is asked", () => {
    const d = draft({ memory: { semanticRecall: { enabled: true } } });
    expect(lay(d)).toEqual(lay(d));
  });

  it("changes only the node that was connected: nothing else moves", () => {
    const ctx: Ctx = { agentId: "a", root: root(3), skills: library(3) };
    const before = layoutBuilder(deriveItems(draft(), ctx), titles);
    const after = layoutBuilder(deriveItems(connect(draft(), { kind: "semantic" }, ctx), ctx), titles);
    const pos = (l: typeof before) => Object.fromEntries(l.nodes.map((n) => [n.id, [n.x, n.y]]));
    expect(pos(after)).toEqual(pos(before));
    expect(before.nodes.find((n) => n.id === "semantic")?.type).toBe("ghost");
    expect(after.nodes.find((n) => n.id === "semantic")?.type).toBe("item");
    expect(after.edges.length).toBe(before.edges.length + 1);
    // the same holds for a root server in a small catalog
    const m0 = layoutBuilder(deriveItems(draft(), ctx), titles);
    const m1 = layoutBuilder(deriveItems(connect(draft(), { kind: "mcp", name: "srv1" }, ctx), ctx), titles);
    expect(pos(m1)).toEqual(pos(m0));
  });

  it("puts the thinking components left, the tools right, the bot and triggers above", () => {
    const { nodes } = lay(draft({ triggers: [{ id: "daily", type: "cron", cron: "0 9 * * *", prompt: "p" }] }));
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    for (const id of ["model", "instructions", "soul", "recent", "semantic", "observational"]) expect(at(id).x + at(id).w).toBeLessThan(-AGENT_W / 2);
    for (const id of ["workspace", "mcp:srv0", "skill:skill-000"]) expect(at(id).x).toBeGreaterThan(AGENT_W / 2);
    for (const id of ["telegram", "trigger:daily", "adder:trigger"]) expect(at(id).y + at(id).h).toBeLessThan(-AGENT_H / 2);
    expect(at("trigger:daily").type).toBe("item");
  });

  it("keeps a 100-skill library to a handful of nodes", () => {
    const { nodes, edges } = lay(draft(), 3, 100); // skills.inherit defaults to all: every skill is connected
    expect(nodes.filter((n) => n.id.startsWith("skill:")).length).toBe(CAP);
    const overflow = nodes.find((n) => n.id === "overflow:skill");
    expect(overflow && "items" in overflow ? overflow.items.length : 0).toBe(100 - CAP);
    expect(nodes.length).toBeLessThan(40);
    expect(edges.length).toBeLessThan(40);
  });

  it("summarises unconnected skills behind one ghost, or draws them when there are very few", () => {
    const none = lay(draft({ skills: { inherit: "none" } }), 3, 100).nodes;
    expect(none.filter((n) => n.id.startsWith("skill:")).length).toBe(0);
    expect(none.find((n) => n.id === "adder:skills")).toMatchObject({ count: 100 });
    const few = lay(draft({ skills: { inherit: "none" } }), 3, 2).nodes;
    expect(few.filter((n) => n.type === "ghost" && n.id.startsWith("skill:")).length).toBe(2);
  });

  it("shows a big root catalog only by what is connected", () => {
    const { nodes } = lay(draft({ tools: { mcp: { inherit: ["srv1"] } } }), 12, 0);
    expect(nodes.filter((n) => n.id.startsWith("mcp:")).map((n) => n.id)).toEqual(["mcp:srv1"]);
    expect(nodes.find((n) => n.id === "adder:mcp-more")).toMatchObject({ count: 11 });
  });

  it("grows the top row for every trigger, and a disabled trigger stays a node with a dashed (unconnected) edge", () => {
    const d = addTrigger(draft(), { id: "gh", type: "github-pr", enabled: false, repo: "a/b", tokenEnv: "GITHUB_TOKEN", prompt: "p" });
    const { nodes, edges } = lay(d);
    expect(nodes.find((n) => n.id === "trigger:gh")?.type).toBe("item");
    expect(edges.find((e) => e.id === "e:trigger:gh")).toMatchObject({ connected: false });
  });
});
