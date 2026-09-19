import type { Limits } from "../config/schema.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { UsageTracker } from "../models/usage.ts";
import type { ChatResult } from "../models/provider.ts";
import { ModelError, withRetry } from "../models/errors.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { executeTool } from "../tools/gateway.ts";
import { buildContext, ContextTooLargeError } from "./context.ts";
import type { AgentEvent, DoneReason } from "./events.ts";
import type { Session } from "./session.ts";
import type { Part, ToolCall } from "./types.ts";
import { logger } from "../util/logger.ts";

export type LoopDeps = {
  models: ModelRegistry;
  tools: ToolRegistry;
  limits: Limits;
  usage: UsageTracker;
  emit: (e: AgentEvent) => void;
};

type RunCtx = { session: Session; runId: string; deps: LoopDeps };

function textParts(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

const ERROR_HINT: Record<ModelError["kind"], string> = {
  transient: "The model provider is having trouble (gave up after retries)",
  rate_limited: "Rate limited by the model provider (gave up after retries)",
  auth: "Authentication with the model provider failed; check the API key in ~/.eigen/.env",
  bad_request: "The model provider rejected the request",
  context_overflow: "The conversation is too long for this model; try /new",
};

export type RunInput = { text: string; runId: string; channel: string };

export async function runLoop(session: Session, input: RunInput, signal: AbortSignal, deps: LoopDeps): Promise<DoneReason> {
  const { text: userText, runId, channel } = input;
  const { limits, emit } = deps;
  const ctx: RunCtx = { session, runId, deps };
  const sid = session.id;
  const timeout = AbortSignal.timeout(limits.runTimeoutMs);
  const runSignal = AbortSignal.any([signal, timeout]);
  let tokens = 0;
  let step = 0;
  let badStreak = 0;
  let emptyRetried = false;

  const fail = (message: string, reason: DoneReason = "error"): DoneReason => {
    emit({ type: "error", sessionId: sid, runId, message });
    return finish(reason);
  };
  const finish = (reason: DoneReason): DoneReason => {
    emit({ type: "done", sessionId: sid, runId, reason, steps: step, tokens });
    logger.info({ evt: "run_done", session: sid, runId, reason, steps: step, tokens });
    return reason;
  };
  const stopped = (): DoneReason =>
    signal.aborted ? finish("cancelled") : fail(`Run stopped: exceeded the ${Math.round(limits.runTimeoutMs / 1000)}s time limit.`, "limit");

  const entryName = session.model;
  const entry = deps.models.entry(entryName);
  if (deps.usage.overCap(entryName, entry.dailyTokenCap)) {
    return fail(`Daily token cap for "${entryName}" reached (${deps.usage.today(entryName)} / ${entry.dailyTokenCap}). Switch with /model or wait until tomorrow.`, "limit");
  }

  session.messages.push({ role: "user", parts: [{ type: "text", text: userText }] });
  emit({ type: "run_start", sessionId: sid, runId, channel });

  while (step < limits.maxSteps) {
    if (runSignal.aborted) return stopped();
    step++;
    // Re-read each step: /model may switch the session mid-run.
    const name = session.model;
    const e = deps.models.entry(name);
    const provider = deps.models.provider(name);

    let built;
    try {
      built = buildContext({ prompts: session.prompts, messages: session.messages, entry: e, tools: deps.tools.defs(), limits });
    } catch (err) {
      if (err instanceof ContextTooLargeError) return fail(err.message);
      throw err;
    }
    logger.info({
      evt: "prompt_size",
      session: sid,
      step,
      estTokens: built.estimatedTokens,
      budget: built.budget,
      contextWindow: e.contextWindow,
      trimmedResults: built.trimmedResults,
      droppedTurns: built.droppedTurns,
    });

    let res: ChatResult;
    try {
      res = await withRetry(() => provider.chat({ system: built.system, messages: built.messages, tools: built.tools, signal: runSignal, entry: e }), {
        signal: runSignal,
        maxRetries: limits.modelRetryMax,
        onRetry: (err, attempt, delayMs) => logger.warn({ evt: "model_retry", session: sid, kind: err.kind, attempt, delayMs, err: err.message }),
      });
    } catch (err) {
      if (runSignal.aborted) return stopped();
      if (err instanceof ModelError) {
        logger.error({ evt: "model_error", session: sid, provider: e.provider, model: e.model, kind: err.kind, status: err.status, err: err.message });
        return fail(`${ERROR_HINT[err.kind]}.\n${err.message}`);
      }
      logger.error({ evt: "model_error", session: sid, err }, "unexpected model error");
      return fail(`Model call failed: ${(err as Error).message}`);
    }

    const used = res.usage.inputTokens + res.usage.outputTokens;
    tokens += used;
    deps.usage.add(name, used);
    logger.info({
      evt: "model_call",
      provider: e.provider,
      model: e.model,
      entry: name,
      session: sid,
      step,
      estPromptTokens: built.estimatedTokens,
      promptTokens: res.usage.inputTokens,
      completionTokens: res.usage.outputTokens,
      cachedTokens: res.usage.cachedInputTokens,
      latencyMs: res.latencyMs,
      stopReason: res.stopReason,
      toolCalls: res.toolCalls.length,
    });

    const text = textParts(res.message.parts);

    if (res.stopReason === "max_tokens") {
      // A tool call cut off mid-arguments must never run; keep only the text.
      if (text) {
        session.messages.push({ role: "assistant", parts: [{ type: "text", text }] });
        emit({ type: "assistant_message", sessionId: sid, runId, text, interim: false });
      }
      const dropped = res.toolCalls.length ? " A tool call in it was cut off and was not executed." : "";
      return fail(`The reply hit the output token limit (maxOutputTokens=${e.maxOutputTokens}).${dropped}`, "limit");
    }

    if (res.toolCalls.length === 0) {
      if (!text) {
        if (!emptyRetried && !res.stopDetail) {
          emptyRetried = true;
          logger.warn({ evt: "empty_reply", session: sid, step }, "empty reply, retrying once");
          continue;
        }
        return fail(res.stopDetail ? `The model stopped without answering (${res.stopDetail}).` : "The model returned an empty reply twice.");
      }
      session.messages.push(res.message);
      emit({ type: "assistant_message", sessionId: sid, runId, text, interim: false });
      if (res.stopReason === "other" && res.stopDetail) emit({ type: "error", sessionId: sid, runId, message: `Model stopped: ${res.stopDetail}` });
      return finish("end");
    }

    session.messages.push(res.message);
    if (text) emit({ type: "assistant_message", sessionId: sid, runId, text, interim: true });

    const results = await runTools(res.toolCalls, runSignal, ctx);
    // Every call gets a result, even when cancelled, so history never holds an orphan call.
    session.messages.push({ role: "tool", parts: results.parts });

    if (runSignal.aborted) return stopped();
    if (results.bad) {
      badStreak++;
      if (badStreak > limits.toolArgRetryMax) {
        return fail(`Stopped: the model made ${badStreak} invalid tool calls in a row (unknown tool or bad arguments).`);
      }
    } else {
      badStreak = 0;
    }
    if (tokens >= limits.runTokenBudget) return fail(`Run stopped: used ${tokens} tokens, over the per-run budget of ${limits.runTokenBudget}.`, "limit");
  }
  return fail(`Run stopped after ${limits.maxSteps} steps (maxSteps).`, "limit");
}

async function runTools(calls: ToolCall[], signal: AbortSignal, { session, runId, deps }: RunCtx): Promise<{ parts: Part[]; bad: boolean }> {
  const parts: Part[] = [];
  let bad = false;
  // Sequential on purpose: tools may depend on each other's side effects.
  for (const call of calls) {
    if (signal.aborted) {
      parts.push({ type: "tool_result", callId: call.id, content: [{ type: "text", text: "Cancelled before running." }], isError: true });
      continue;
    }
    deps.emit({ type: "tool_start", sessionId: session.id, runId, callId: call.id, name: call.name, args: call.args });
    const r = await executeTool(call, {
      registry: deps.tools,
      signal,
      sessionId: session.id,
      timeoutMs: deps.limits.toolTimeoutMs,
      maxOutputChars: deps.limits.toolOutputMaxChars,
    });
    deps.emit({ type: "tool_end", sessionId: session.id, runId, callId: call.id, name: call.name, ok: !r.isError, durationMs: r.durationMs });
    logger.info({ evt: "tool_call", session: session.id, runId, tool: call.name, kind: r.kind, durationMs: r.durationMs });
    if (r.kind === "unknown_tool" || r.kind === "invalid_args") bad = true;
    parts.push({ type: "tool_result", callId: call.id, content: r.content, ...(r.isError ? { isError: true } : {}) });
  }
  return { parts, bad };
}
