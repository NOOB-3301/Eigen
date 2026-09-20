import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBuiltinTools } from "../../src/core/agent.ts";
import { executeTool } from "../../src/tools/gateway.ts";
import type { ExecContext } from "../../src/tools/gateway.ts";
import { configureShellEnv, killAll, resetSession } from "../../src/tools/builtin/shell-session.ts";
import { defineRawTool, defineTool, ToolRegistry } from "../../src/tools/registry.ts";

const registry = createBuiltinTools();
let n = 0;
const sid = () => `shell-test-${process.pid}-${n++}`;

function sh(sessionId: string, command: string, extra: Partial<ExecContext> & { timeoutSec?: number } = {}) {
  const { timeoutSec, ...ctx } = extra;
  return executeTool(
    { id: `c${n++}`, name: "shell_exec", args: { command, ...(timeoutSec ? { timeoutSec } : {}) } },
    { registry, signal: new AbortController().signal, sessionId, timeoutMs: 10_000, maxTimeoutMs: 60_000, maxOutputChars: 50_000, ...ctx },
  );
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((p) => p.text ?? "").join("\n");

afterAll(() => killAll());

describe("persistent shell_exec", () => {
  it("keeps cwd and exported vars between calls, isolated per session", async () => {
    const a = sid();
    const b = sid();
    await sh(a, "cd /tmp && export EIGEN_X=42");
    const r = await sh(a, 'pwd; echo "x=$EIGEN_X"');
    expect(text(r)).toMatch(/exit code 0\n(\/private)?\/tmp\nx=42/);
    expect(text(await sh(b, 'pwd; echo "x=$EIGEN_X"'))).toContain(`${homedir()}\nx=`);
  });

  it("reports exit codes and keeps stdout/stderr order", async () => {
    const r = await sh(sid(), "echo out; echo err >&2; exit_code_test() { return 7; }; exit_code_test");
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("exit code 7\nout\nerr");
  });

  it("does not hang on stdin readers, prompts, or syntax errors", async () => {
    const s = sid();
    const t = Date.now();
    expect(text(await sh(s, "cat; read x; echo after"))).toContain("after");
    expect(text(await sh(s, "sudo -n true"))).toMatch(/exit code [1-9]/);
    expect(text(await sh(s, "echo 'unclosed"))).toMatch(/exit code [1-9][\s\S]*(unexpected EOF|matching)/);
    expect(text(await sh(s, "echo still-alive"))).toContain("still-alive");
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("abort kills the process group, and the next call gets a fresh shell with a note", async () => {
    const s = sid();
    await sh(s, "cd /tmp");
    const c = new AbortController();
    setTimeout(() => c.abort(), 200);
    const t = Date.now();
    const r = await sh(s, "sleep 31 | cat", { signal: c.signal });
    expect(r.kind).toBe("aborted");
    expect(Date.now() - t).toBeLessThan(1500);
    await new Promise((res) => setTimeout(res, 100));
    expect(execSync("ps -axo pid,command | grep '^ *[0-9]* sleep 31' || true").toString().trim()).toBe("");
    const next = text(await sh(s, "pwd"));
    expect(next).toContain("previous command was killed");
    expect(next).toContain(homedir());
  });

  it("times out at the default, and timeoutSec extends it", async () => {
    const s = sid();
    const r = await sh(s, "sleep 2", { timeoutMs: 500 });
    expect(r.kind).toBe("timeout");
    expect(text(r)).toContain("500 ms");
    const ok = await sh(s, "sleep 1.2; echo done", { timeoutMs: 500, timeoutSec: 3 });
    expect(ok.kind).toBe("ok");
    expect(text(ok)).toContain("done");
  });

  it("`exit` resets the shell and the next call works", async () => {
    const s = sid();
    const r = await sh(s, "exit 3");
    expect(text(r)).toContain("state reset");
    expect(text(await sh(s, "echo back"))).toContain("back");
  });

  it("does not expose eigen secrets to commands", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-secret-123";
    process.env.MY_BOT_CRED = "bot-secret-456";
    configureShellEnv(["MY_BOT_CRED"]);
    const out = text(await sh(sid(), "env"));
    expect(out).not.toContain("sk-secret-123");
    expect(out).not.toContain("bot-secret-456");
    expect(out).toContain("PATH=");
  });

  it("resetSession gives a fresh shell", async () => {
    const s = sid();
    await sh(s, "cd /tmp");
    resetSession(s);
    const out = text(await sh(s, "pwd"));
    expect(out).toContain(homedir());
    expect(out).not.toContain("previous command was killed");
  });

  it("caps output but still finds the end of the command", async () => {
    const r = await sh(sid(), "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo tail-marker");
    expect(text(r)).toContain("exit code 0");
  });
});

describe("tool-requested timeouts in the gateway", () => {
  const slow = defineTool({
    name: "slow",
    description: "",
    inputSchema: z.object({ ms: z.number(), want: z.number().optional() }),
    timeoutMs: ({ want }) => want,
    execute: ({ ms }, { signal }) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => res("ok"), ms);
        signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("x"))));
      }),
  });
  const reg = new ToolRegistry().register(slow);
  const exec = (args: object, maxTimeoutMs = 60_000) =>
    executeTool({ id: "t", name: "slow", args: args as never }, { registry: reg, signal: new AbortController().signal, sessionId: "s", timeoutMs: 100, maxTimeoutMs, maxOutputChars: 1000 });

  it("uses the default when the tool asks for nothing", async () => {
    expect((await exec({ ms: 300 })).kind).toBe("timeout");
  });
  it("honors a requested longer timeout", async () => {
    expect((await exec({ ms: 300, want: 2000 })).kind).toBe("ok");
  });
  it("clamps requests above maxTimeoutMs", async () => {
    const r = await exec({ ms: 1500, want: 999_999 }, 1000);
    expect(r.kind).toBe("timeout");
    expect(text(r)).toContain("1000 ms");
  });
});

describe("raw JSON Schema tools (MCP seam)", () => {
  const raw = defineRawTool({
    name: "mcp__demo__echo",
    description: "echo",
    inputSchema: { jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    execute: async (input) => `got ${JSON.stringify(input)}`,
  });
  const reg = new ToolRegistry().register(raw);

  it("exposes the schema unchanged to the model", () => {
    expect(reg.defs()[0]).toEqual({ name: "mcp__demo__echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
  });

  it("passes arguments through without zod validation, still through the gateway", async () => {
    const r = await executeTool(
      { id: "m", name: "mcp__demo__echo", args: { anything: 1 } },
      { registry: reg, signal: new AbortController().signal, sessionId: "s", timeoutMs: 1000, maxOutputChars: 100 },
    );
    expect(r.kind).toBe("ok");
    expect(text(r)).toBe('got {"anything":1}');
  });
});
