import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import { makeWorkspace } from "../src/mastra/lib/workspace.ts";
import { fakeLlm, type Turn } from "./helpers/fake-llm.ts";
import { tmpHome } from "./helpers/home.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function setup(turns: Turn[] | ((p: HomePaths) => Turn[]), prepare?: (sandboxDir: string) => void) {
  const p = tmpHome();
  prepare?.(p.sandboxDir);
  const llm = await fakeLlm(typeof turns === "function" ? turns(p) : turns);
  closers.push(llm.close);
  const workspace = makeWorkspace(p, loadConfig(p.configFile), "none");
  const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, workspace });
  const mastra = new Mastra({ agents: { t: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "test.db")}` }) });
  const toolOutputs = () => llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)));
  return { p, llm, agent: mastra.getAgent("t"), toolOutputs };
}

const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });
const bash = (command: string, extra: Record<string, unknown> = {}) => call("bash", { description: "test", command, ...extra });

describe("agent tools (real agent, fake model)", () => {
  it("exposes read, write, edit and bash, plus Mastra's skill tools", async () => {
    const { agent, llm } = await setup([{ text: "hi" }]);
    await agent.generate("go");
    expect(llm.requests[0]!.tools!.map((t) => t.function.name).sort()).toEqual(["bash", "edit", "read", "skill", "skill_read", "skill_search", "write"]);
  });

  it("writes, reads and edits files inside the sandbox", async () => {
    const { agent, p, toolOutputs } = await setup([
      call("write", { path: "notes.md", content: "hello world" }),
      call("read", { path: "notes.md" }),
      call("edit", { path: "notes.md", old_string: "world", new_string: "there" }),
      { text: "done" },
    ]);
    await agent.generate("go", { maxSteps: 8 });
    expect(readFileSync(join(p.sandboxDir, "notes.md"), "utf8")).toBe("hello there");
    expect(toolOutputs().join("\n")).toContain("hello world");
  });

  it("runs bash in the sandbox with a secret-free environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak-0123456789";
    const { agent, p, toolOutputs } = await setup([bash("pwd; printenv"), { text: "ok" }]);
    await agent.generate("go");
    delete process.env.ANTHROPIC_API_KEY;
    const out = toolOutputs().join("\n");
    expect(out).toContain(p.sandboxDir);
    expect(out).toContain(`HOME=${p.sandboxHomeDir}`);
    expect(out).not.toContain("sk-should-not-leak");
  });

  it("denies reads outside the sandbox, including its own .env", async () => {
    const { agent, toolOutputs } = await setup((p) => [call("read", { path: p.envFile }), { text: "ok" }]);
    await agent.generate("go");
    expect(toolOutputs().join("\n")).toMatch(/Permission denied.*outside the workspace/);
  });

  it("requires a read before editing an existing file", async () => {
    const { agent, toolOutputs } = await setup([call("edit", { path: "pre.md", old_string: "a", new_string: "b" }), { text: "ok" }], (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pre.md"), "abc");
    });
    await agent.generate("go");
    expect(toolOutputs().join("\n")).toContain("has not been read");
  });

  it("refuses background commands and audits the refusal", async () => {
    const { agent, p, toolOutputs } = await setup([bash("sleep 1", { background: true }), { text: "ok" }]);
    await agent.generate("go");
    expect(toolOutputs().join("\n")).toContain("not available");
    expect(readFileSync(p.auditFile, "utf8")).toContain('"outcome":"refused"');
  });

  it("holds a risky command for approval, runs it only once approved", async () => {
    const { agent, p } = await setup([bash("rm -rf victim"), { text: "ok" }], (dir) => mkdirSync(join(dir, "victim"), { recursive: true }));
    const held = await agent.generate("go");
    expect(held.finishReason).toBe("suspended");
    expect(existsSync(join(p.sandboxDir, "victim"))).toBe(true);

    await agent.approveToolCallGenerate({ runId: held.runId!, toolCallId: held.suspendPayload.toolCallId });
    expect(existsSync(join(p.sandboxDir, "victim"))).toBe(false);
  });

  it("does not run a declined command", async () => {
    const { agent, p } = await setup([bash("rm -rf victim"), { text: "ok" }], (dir) => mkdirSync(join(dir, "victim"), { recursive: true }));
    const held = await agent.generate("go");
    await agent.declineToolCallGenerate({ runId: held.runId!, toolCallId: held.suspendPayload.toolCallId });
    expect(existsSync(join(p.sandboxDir, "victim"))).toBe(true);
  });
});
