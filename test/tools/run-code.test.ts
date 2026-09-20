import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../../src/core/agent.ts";
import { executeTool } from "../../src/tools/gateway.ts";
import { killAll } from "../../src/tools/builtin/shell-session.ts";

const registry = createBuiltinTools();
const home = mkdtempSync(join(tmpdir(), "eigen-runcode-"));
let prevHome: string | undefined;
beforeAll(() => {
  prevHome = process.env.EIGEN_HOME;
  process.env.EIGEN_HOME = home;
});
afterAll(() => {
  process.env.EIGEN_HOME = prevHome;
  killAll();
});

const run = (args: Record<string, unknown>, sessionId = "rc") =>
  executeTool({ id: "r", name: "run_code", args }, { registry, signal: new AbortController().signal, sessionId, timeoutMs: 20_000, maxTimeoutMs: 60_000, maxOutputChars: 50_000 });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((p) => p.text ?? "").join("\n");

describe("run_code", () => {
  it("runs a python snippet and saves it under the workspace", async () => {
    const r = await run({ language: "python", code: "print(sum(range(10)))" });
    expect(r.kind).toBe("ok");
    expect(text(r)).toMatch(/saved to .*workspace\/snippets\/.*\.py\n\$ python3 .*\nexit code 0\n45/);
    expect(readdirSync(join(home, "workspace", "snippets")).some((f) => f.endsWith(".py"))).toBe(true);
  });

  it("runs javascript and typescript snippets", async () => {
    expect(text(await run({ language: "javascript", code: "console.log([1,2,3].map(x => x * 2).join(','))" }))).toContain("2,4,6");
    const ts = await run({ language: "typescript", code: "const n: number = 21; console.log(n * 2);" });
    expect(text(ts)).toMatch(/exit code 0[\s\S]*42/);
  });

  it("runs an existing file with arguments, including ones with quotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eigen-rc-file-"));
    const file = join(dir, "args.py");
    writeFileSync(file, "import sys\nprint('|'.join(sys.argv[1:]))\n");
    expect(text(await run({ language: "python", path: file, args: ["a b", "it's"] }))).toContain("a b|it's");
  });

  it("inherits the session shell's cwd", async () => {
    await executeTool({ id: "x", name: "shell_exec", args: { command: "cd /tmp" } }, { registry, signal: new AbortController().signal, sessionId: "rc-cwd", timeoutMs: 5000, maxOutputChars: 1000 });
    expect(text(await run({ language: "bash", code: "pwd" }, "rc-cwd"))).toMatch(/(\/private)?\/tmp/);
  });

  it("reports non-zero exits as errors", async () => {
    const r = await run({ language: "python", code: "raise SystemExit(3)" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("exit code 3");
  });

  it("rejects both or neither of code/path, and a missing absolute file", async () => {
    expect((await run({ language: "python" })).kind).toBe("invalid_args");
    expect((await run({ language: "python", code: "print(1)", path: "/x.py" })).kind).toBe("invalid_args");
    const missing = await run({ language: "python", path: "/nonexistent/eigen/x.py" });
    expect(missing.kind).toBe("tool_error");
    expect(text(missing)).toContain("file not found");
  });
});
