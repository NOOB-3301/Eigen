import { z } from "zod";
import type { Part, ToolCall } from "../core/types.ts";
import type { ToolRegistry } from "./registry.ts";
import { isAbortError, whenAborted } from "../util/abort.ts";

export type ToolResultKind = "ok" | "tool_error" | "unknown_tool" | "invalid_args" | "timeout" | "aborted";

export type ToolExecResult = { callId: string; content: Part[]; isError: boolean; kind: ToolResultKind; durationMs: number };

export type ExecContext = {
  registry: ToolRegistry;
  signal: AbortSignal;
  sessionId: string;
  timeoutMs: number;
  maxOutputChars: number;
};

// Seam for later policy/approval/audit hooks. Intentionally empty in v0.
export type ToolHook = (call: ToolCall, input: unknown, ctx: ExecContext) => Promise<void>;
const hooks: ToolHook[] = [];

const text = (t: string): Part[] => [{ type: "text", text: t }];

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[... output truncated: ${s.length - max} more characters]`;
}

function postProcess(content: Part[], max: number): Part[] {
  let budget = max;
  return content.map((p) => {
    if (p.type !== "text") return p;
    const out = truncate(p.text, Math.max(0, budget));
    budget -= p.text.length;
    return { type: "text", text: out };
  });
}

type Stage = { ok: true; input: unknown } | { ok: false; kind: ToolResultKind; message: string };

function validate(call: ToolCall, ctx: ExecContext): Stage {
  const tool = ctx.registry.get(call.name);
  if (!tool) {
    const near = ctx.registry.closest(call.name);
    return { ok: false, kind: "unknown_tool", message: `Unknown tool "${call.name}". Valid tools: ${near.join(", ")}${near.length < ctx.registry.names().length ? " (closest matches)" : ""}.` };
  }
  if (call.argsError) return { ok: false, kind: "invalid_args", message: `Invalid arguments for ${call.name}: ${call.argsError}` };
  const parsed = tool.inputSchema.safeParse(call.args);
  if (!parsed.success) return { ok: false, kind: "invalid_args", message: `Invalid arguments for ${call.name}:\n${z.prettifyError(parsed.error)}` };
  return { ok: true, input: parsed.data };
}

// The single entry point for running any tool: validate -> hooks -> run -> post-process.
export async function executeTool(call: ToolCall, ctx: ExecContext): Promise<ToolExecResult> {
  const started = Date.now();
  const done = (kind: ToolResultKind, content: Part[], isError: boolean): ToolExecResult => ({
    callId: call.id,
    content: postProcess(content, ctx.maxOutputChars),
    isError,
    kind,
    durationMs: Date.now() - started,
  });

  const v = validate(call, ctx);
  if (!v.ok) return done(v.kind, text(v.message), true);

  for (const hook of hooks) await hook(call, v.input, ctx);

  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  try {
    const tool = ctx.registry.get(call.name)!;
    // Race so a tool that ignores its signal still can't hold the run hostage.
    const out = await Promise.race([tool.execute(v.input, { signal, sessionId: ctx.sessionId }), whenAborted(signal)]);
    if (typeof out === "string") return done("ok", text(out || "(no output)"), false);
    return done(out.isError ? "tool_error" : "ok", out.content.length ? out.content : text("(no output)"), !!out.isError);
  } catch (e) {
    if (ctx.signal.aborted) return done("aborted", text("Cancelled by user."), true);
    if (timeout.aborted) return done("timeout", text(`Tool timed out after ${ctx.timeoutMs} ms.`), true);
    const msg = isAbortError(e) ? "aborted" : (e as Error)?.message ?? String(e);
    return done("tool_error", text(`Tool failed: ${msg}`), true);
  }
}
