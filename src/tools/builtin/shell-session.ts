import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { ToolOutput } from "../registry.ts";

// One long-lived bash per chat session, so cd / export / venv activation persist
// between tool calls like a real terminal.

const MAX_CAPTURE = 1_000_000;
const TAIL_KEEP = 8_192;
const SECRET_RE = /(TOKEN|SECRET|API_?KEY|PASSWORD)/i;

let secretNames = new Set<string>();

// Called at startup with the env var names config.json points at (API keys, bot token).
export function configureShellEnv(names: string[]): void {
  secretNames = new Set(names);
}

// The shell runs model-chosen commands; it must not be able to read eigen's secrets.
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!secretNames.has(k) && !SECRET_RE.test(k)) env[k] = v;
  return env;
}

type Shell = { proc: ChildProcessWithoutNullStreams; closed: boolean; queue: Promise<unknown> };

const shells = new Map<string, Shell>();
const resetNotice = new Set<string>(); // sessions whose previous shell was killed

function spawnShell(): Shell {
  const proc = spawn("/bin/bash", ["--noprofile", "--norc"], { cwd: homedir(), detached: true, env: scrubbedEnv() });
  const sh: Shell = { proc, closed: false, queue: Promise.resolve() };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdin.on("error", () => {}); // EPIPE after the shell died; handled via "close"
  proc.on("close", () => (sh.closed = true));
  proc.on("error", () => (sh.closed = true));
  proc.stdin.write("exec 2>&1\n"); // one stream keeps stdout/stderr in their real order
  return sh;
}

function kill(sh: Shell): void {
  try {
    process.kill(-sh.proc.pid!, "SIGKILL"); // whole process group: bash and its children
  } catch {}
  sh.closed = true;
}

export type ShellResult = { exitCode: number | null; output: string; reset: boolean; resetBefore: boolean };

export function run(sessionId: string, command: string, signal: AbortSignal): Promise<ShellResult> {
  let sh = shells.get(sessionId);
  if (!sh || sh.closed) {
    sh = spawnShell();
    shells.set(sessionId, sh);
  }
  const target = sh;
  // Tool calls are sequential per session already; the chain makes it a guarantee.
  const p = target.queue.then(() => exec(sessionId, target, command, signal));
  target.queue = p.catch(() => {});
  return p;
}

function exec(sessionId: string, sh: Shell, command: string, signal: AbortSignal): Promise<ShellResult> {
  const resetBefore = resetNotice.delete(sessionId);
  return new Promise((resolve) => {
    if (sh.closed || signal.aborted) return resolve({ exitCode: null, output: "", reset: true, resetBefore });
    const marker = `__EIGEN_END_${randomBytes(8).toString("hex")}__`;
    let buf = "";
    let head: string | undefined; // set once output exceeds MAX_CAPTURE
    let settled = false;

    const output = (s: string) => (head === undefined ? s : `${head}\n[... output truncated ...]\n${s}`);
    const finish = (r: Omit<ShellResult, "resetBefore">) => {
      if (settled) return;
      settled = true;
      sh.proc.stdout.off("data", onData);
      sh.proc.stderr.off("data", onData);
      sh.proc.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (r.reset) {
        if (shells.get(sessionId) === sh) shells.delete(sessionId);
        resetNotice.add(sessionId);
      }
      resolve({ ...r, resetBefore });
    };
    const onData = (d: string) => {
      buf += d;
      const i = buf.indexOf(marker);
      if (i >= 0) {
        const rest = buf.slice(i + marker.length);
        const nl = rest.indexOf("\n");
        if (nl < 0) return; // exit code not fully arrived yet
        return finish({ exitCode: Number(rest.slice(0, nl)), output: output(buf.slice(0, i).replace(/\n+$/, "")), reset: false });
      }
      if (buf.length > MAX_CAPTURE) {
        head ??= buf.slice(0, MAX_CAPTURE / 2);
        buf = buf.slice(-TAIL_KEEP); // still long enough to find the marker
      }
    };
    const onClose = () => finish({ exitCode: null, output: output(buf), reset: true }); // e.g. `exit`
    const onAbort = () => {
      kill(sh);
      finish({ exitCode: null, output: output(buf), reset: true });
    };

    sh.proc.stdout.on("data", onData);
    sh.proc.stderr.on("data", onData);
    sh.proc.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    // base64 + eval: a syntax error (unclosed quote) becomes an ordinary bash error and the
    // marker still prints. </dev/null: prompts fail fast and nothing can eat the marker line.
    const b64 = Buffer.from(command, "utf8").toString("base64");
    sh.proc.stdin.write(`eval "$(printf %s '${b64}' | base64 -d)" </dev/null; printf '\\n${marker}%s\\n' "$?"\n`);
  });
}

export function resetSession(sessionId: string): void {
  const sh = shells.get(sessionId);
  if (sh) kill(sh);
  shells.delete(sessionId);
  resetNotice.delete(sessionId);
}

export function killAll(): void {
  for (const id of [...shells.keys()]) resetSession(id);
}

export function formatResult(r: ShellResult, prefix = ""): ToolOutput {
  const notes: string[] = [];
  if (r.resetBefore) notes.push("[note: the previous command was killed, so this is a fresh shell: cwd is home and earlier exports are gone]");
  const status = r.exitCode === null ? "shell exited or was killed; state reset (cwd back to home)" : `exit code ${r.exitCode}`;
  const text = [...notes, `${prefix}${status}`, r.output || "(no output)"].join("\n");
  return { content: [{ type: "text", text }], isError: r.exitCode !== 0 };
}
