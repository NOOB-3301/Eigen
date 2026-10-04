import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const PORT = 4171;
const SESSION = "e2e-studio-session";

function addAgent(p: HomePaths, id: string, patch: Record<string, unknown> = {}) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), `You are the ${id}.`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `Does ${id} work.`, ...patch }));
}

const user = (text: string) => ({ id: `u-${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text }] });
const chat = (id: string, message: unknown, init: RequestInit = {}, session = SESSION) =>
  fetch(`${eigen!.url}/eigen/chat/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, message }), ...init });
const chunks = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, any>);
const textOf = (cs: Array<Record<string, any>>) => cs.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
/** fetch cannot forge Host, so the DNS-rebinding case goes through node:http. */
const rawStatus = (host: string, body = JSON.stringify({ session: SESSION, message: user("hi") })) =>
  new Promise<number>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/eigen/chat/eigen", headers: { host, "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end(body);
  });
const history = async (id: string, session = SESSION) => (await fetch(`${eigen!.url}/eigen/chat/${id}/${session}`)).json() as Promise<any>;

describe("studio chat (built server)", () => {
  it("streams a reply; the primary shares the Telegram resource in a separate thread, an isolated agent does not", async () => {
    const turns: Turn[] = [{ text: "Nice to meet you, Sam" }, { text: "studio answer" }];
    eigen = await startEigen(turns, {}, { port: PORT, prepare: (p) => addAgent(p, "spec") });
    eigen.tg.say("my favourite fruit is mango pudding");
    await waitFor(() => eigen!.tg.sent().some((t) => t.includes("Nice to meet you, Sam")));
    const sentBefore = eigen.tg.sent().length;

    // The isolated agent first: once the primary asked the same question, recall would find that question instead.
    const iso = await chat("spec", user("what pudding fruit do i like"));
    expect(iso.status).toBe(200);
    expect(textOf(await chunks(iso))).toBe("studio answer");
    expect(JSON.stringify(eigen.llm.requests.at(-1))).not.toContain("mango");

    const res = await chat("eigen", user("what pudding fruit do i like"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const cs = await chunks(res);
    expect(textOf(cs)).toBe("studio answer");
    expect(cs.find((c) => c.type === "start")?.messageMetadata?.model).toBeTruthy();
    // Same resource as the Telegram chat, but a thread of its own; the isolated agent's thread lives on another resource.
    const threads = async (resource: string, agent: string) =>
      ((await eigen!.api(`/memory/threads?resourceId=${encodeURIComponent(resource)}&agentId=${agent}`)).threads ?? []) as Array<{ id: string; metadata?: Record<string, unknown> }>;
    const shared = await threads("telegram:7", "eigen");
    expect(shared.map((t) => t.id)).toContain(`studio:eigen:${SESSION}`);
    expect(shared.some((t) => t.metadata?.channel_platform === "telegram")).toBe(true);
    expect((await threads("spec:telegram:7", "spec")).map((t) => t.id)).toEqual([`studio:spec:${SESSION}`]);
    expect((await threads("telegram:7", "spec")).map((t) => t.id)).not.toContain(`studio:spec:${SESSION}`);
    // The studio thread holds only the studio turn, and nothing went to Telegram.
    const h = await history("eigen");
    expect(h.memory).toEqual({ scope: "shared", telegramUserId: 7 });
    expect(JSON.stringify(h.messages)).toContain("studio answer");
    expect(JSON.stringify(h.messages)).not.toContain("Nice to meet you");
    expect(eigen.tg.sent().length).toBe(sentBefore);
    expect((await history("spec")).memory.scope).toBe("isolated");
  });

  it("refuses a disabled or unknown agent, a foreign Host and a browser Origin", async () => {
    eigen = await startEigen([{ text: "x" }], {}, { port: PORT, prepare: (p) => addAgent(p, "off", { enabled: false }) });
    for (const id of ["off", "nobody"]) {
      const r = await chat(id, user("hi"));
      expect(r.status, id).toBe(404);
      expect(((await r.json()) as { error: string }).error).toMatch(/disabled or invalid/);
    }
    expect((await fetch(`${eigen.url}/eigen/chat/off/${SESSION}`)).status).toBe(404);
    expect(await rawStatus(`evil.example:${PORT}`)).toBe(403);
    expect(await rawStatus(`127.0.0.1:${PORT}`, "{}")).toBe(400);
    expect((await chat("eigen", user("hi"), { headers: { "content-type": "application/json", origin: "http://evil.example" } })).status).toBe(403);
    expect((await chat("eigen", user("hi"), { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(eigen.llm.requests.length).toBe(0);
  });

  it("asks for approval on a risky command; Approve runs it in the same run, Deny does not", async () => {
    const rm: Turn = { calls: [{ name: "bash", args: { command: "rm -rf ./scratch && echo removed-scratch" } }] };
    eigen = await startEigen([rm, { text: "cleaned up" }, rm, { text: "left it" }], {}, { port: PORT });

    const answer = async (approved: boolean) => {
      const first = await chunks(await chat("eigen", user("clean the scratch dir")));
      const ask = first.find((c) => c.type === "tool-approval-request");
      expect(ask, JSON.stringify(first).slice(0, 800)).toBeTruthy();
      const input = first.find((c) => c.type === "tool-input-available" && c.toolCallId === ask!.toolCallId)!;
      const msg = {
        id: first.find((c) => c.type === "start")!.messageId,
        role: "assistant",
        parts: [{ type: `tool-${input.toolName}`, toolCallId: ask!.toolCallId, state: "approval-responded", input: input.input, approval: { id: ask!.approvalId, approved } }],
      };
      return chunks(await chat("eigen", msg));
    };

    const yes = await answer(true);
    const out = yes.find((c) => c.type === "tool-output-available");
    expect(JSON.stringify(out)).toContain("removed-scratch");
    expect(textOf(yes)).toBe("cleaned up");

    const no = await answer(false);
    expect(no.some((c) => c.type === "tool-output-denied")).toBe(true);
    expect(no.some((c) => c.type === "tool-output-available")).toBe(false);
  });

  it("stops the agent's run when the caller aborts mid-stream", async () => {
    eigen = await startEigen([{ text: "too late", delayMs: 4000 }], {}, { port: PORT });
    const ctl = new AbortController();
    const res = await chat("eigen", user("take your time"), { signal: ctl.signal });
    expect(res.status).toBe(200);
    await waitFor(() => eigen!.llm.requests.length > 0);
    ctl.abort();
    await new Promise((r) => setTimeout(r, 5000));
    // The model's late answer never landed in memory: the run ended with the request.
    const h = await history("eigen");
    expect(JSON.stringify(h.messages)).toContain("take your time");
    expect(JSON.stringify(h.messages)).not.toContain("too late");
  });
});
