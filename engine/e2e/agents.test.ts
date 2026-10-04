import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentEvent, ListAgentsResponse } from "../src/mastra/lib/schema.ts";
import type { Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const MCP_SERVER = join(import.meta.dirname, "../test/helpers/mcp-server.ts");
const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });
const replied = (text: string) => () => eigen!.tg.sent().some((t) => t.includes(text));

function addAgent(p: HomePaths, id: string, patch: Record<string, unknown> = {}, instructions = `You are the ${id}.`) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), instructions);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `Does ${id} work.`, ...patch }));
}

const get = async <T,>(path: string, init?: RequestInit) => {
  const r = await fetch(`${eigen!.url}${path}`, init);
  return { status: r.status, headers: r.headers, body: (await r.json()) as T };
};

/** Collects SSE events from /eigen/agents/events until stopped. */
async function subscribe() {
  const ctl = new AbortController();
  const res = await fetch(`${eigen!.url}/eigen/agents/events`, { signal: ctl.signal });
  const events: AgentEvent[] = [];
  let raw = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      raw += dec.decode(chunk, { stream: true });
      for (const m of raw.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]!));
      raw = raw.slice(raw.lastIndexOf("\n\n") + 2);
    }
  })().catch(() => undefined);
  return { res, events, close: () => ctl.abort() };
}

describe("agent fleet (built server)", () => {
  it("loads specialists at boot, serves the runtime API, and hot-adds a new agent folder", async () => {
    eigen = await startEigen([call("agent-researcher", { prompt: "find the answer" }), { text: "researcher says 42" }, { text: "final: 42" }], {}, {
      port: 4193,
      prepare: (p) => addAgent(p, "researcher", {}, "You research carefully."),
    });

    const list = await get<ListAgentsResponse>("/eigen/agents");
    expect(list.status).toBe(200);
    expect(list.body.agents.map((a) => [a.id, a.runtime.status])).toEqual([
      ["eigen", "loaded"],
      ["researcher", "loaded"],
    ]);
    expect(list.body.fleetProblems).toEqual([]);
    expect(list.body.topology.edges.map((e) => e.id)).toContain("delegates:eigen->researcher");

    const cross = await get("/eigen/agents", { headers: { origin: "https://evil.example" } });
    expect(cross.headers.get("access-control-allow-origin")).toBeNull();
    expect((await get("/eigen/agents/researcher")).body).toMatchObject({ id: "researcher", runtime: { status: "loaded" }, resolved: { id: "researcher" } });
    expect((await get("/eigen/agents/nobody")).status).toBe(404);

    const sse = await subscribe();
    expect(sse.res.headers.get("content-type")).toContain("text/event-stream");
    addAgent(eigen.p, "writer");
    await waitFor(() => sse.events.some((e) => e.type === "agent.loaded" && e.id === "writer"), 10_000);
    sse.close();
    expect((await get<ListAgentsResponse>("/eigen/agents")).body.agents.map((a) => a.id)).toEqual(["eigen", "researcher", "writer"]);

    eigen.tg.say("ask the researcher");
    await waitFor(replied("final: 42"));
    const [primary, sub] = eigen.llm.requests;
    expect(primary!.tools?.map((t) => t.function.name)).toEqual(expect.arrayContaining(["agent-researcher", "agent-writer"]));
    const subSystem = sub!.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    expect(subSystem).toContain("You research carefully.");
    expect(subSystem).not.toContain("<operating_instructions>");
    expect(sub!.messages.filter((m) => m.role === "user").map((m) => String(m.content))).toEqual(["find the answer"]);
  });

  it("a specialist's untrusted MCP call still asks for approval in Telegram", async () => {
    eigen = await startEigen([call("agent-researcher", { prompt: "echo ping" }), call("demo_echo", { text: "ping" }), { text: "researcher done" }, { text: "all done" }], {
      mcpServers: { demo: { command: process.execPath, args: [MCP_SERVER] } },
    }, { port: 4198, prepare: (p) => addAgent(p, "researcher", { tools: { mcp: { inherit: ["demo"] } } }) });

    eigen.tg.say("use the researcher");
    await waitFor(() => eigen!.tg.calls.some((c) => c.body.reply_markup?.inline_keyboard?.length), 20_000);
    const keyboard = eigen.tg.calls.map((c) => c.body.reply_markup?.inline_keyboard).find((k) => k?.length);
    eigen.tg.press((keyboard.flat() as Array<{ text: string; callback_data: string }>).find((b) => /approve/i.test(b.text))!.callback_data);
    await waitFor(replied("all done"), 20_000);
    const toolOutput = eigen.llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content))).join("\n");
    expect(toolOutput).toContain("ping");
  });
});
