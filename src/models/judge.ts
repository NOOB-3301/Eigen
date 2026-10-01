import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { ModelEntry, SkillsConfig } from "../config/schema.ts";
import type { ModelProvider } from "./provider.ts";
import { logger } from "../util/logger.ts";

// The only module that touches the SDK's evaluation API. Everything else asks for
// typed answers and gets them, whichever backend produced them.

export type Question =
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "boolean"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type Answer = { type: "score"; score: number } | { type: "boolean"; probability: number } | { type: "choice"; choice: string };

export type JudgeResult = {
  backend: "typesafe" | "entry" | "local";
  answers: Record<string, Answer>;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type JudgeDeps = {
  cfg: SkillsConfig["eval"];
  entry: ModelEntry;
  entryName: string;
  provider: ModelProvider;
  signal?: AbortSignal;
};

function backendOrder(provider: SkillsConfig["eval"]["provider"]): Array<JudgeResult["backend"]> {
  if (provider === "auto") return ["typesafe", "entry", "local"];
  return provider === "local" ? ["local"] : [provider, "local"];
}

function typeSafeModel(cfg: SkillsConfig["eval"]): Experimental_EvaluationModel | undefined {
  const apiKey = process.env[cfg.apiKeyEnv];
  return apiKey ? createTypeSafeAi({ apiKey }).evaluationModel(cfg.model) : undefined;
}

function normalize(answers: Record<string, unknown>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, a] of Object.entries(answers)) {
    const x = a as { type: string; score?: number; probability?: number; choice?: string };
    if (x.type === "score") out[id] = { type: "score", score: x.score ?? 0 };
    else if (x.type === "boolean") out[id] = { type: "boolean", probability: x.probability ?? 0 };
    else out[id] = { type: "choice", choice: String(x.choice ?? "") };
  }
  return out;
}

// A judge failure must never block the pipeline that called it, so every backend
// degrades to the next one and the last one runs on the session's own model.
export async function judge(state: unknown, questions: Record<string, Question>, deps: JudgeDeps): Promise<JudgeResult> {
  const errors: string[] = [];
  // Judge calls sit outside the agent loop, so they carry their own deadline.
  const timeout = AbortSignal.timeout(deps.cfg.timeoutMs);
  deps = { ...deps, signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout };
  for (const backend of backendOrder(deps.cfg.provider)) {
    try {
      if (backend === "typesafe") {
        const model = typeSafeModel(deps.cfg);
        if (!model) continue;
        const r = await experimental_evaluate({ model, state: state as never, questions: questions as never, abortSignal: deps.signal });
        logger.debug({ evt: "judge", backend, confidence: (r.providerMetadata as { typesafe?: unknown } | undefined)?.typesafe });
        return { backend, answers: normalize(r.answers as Record<string, unknown>), usage: r.usage };
      }
      if (backend === "entry") {
        if (!deps.provider.evaluate) continue;
        const r = await deps.provider.evaluate({ state, questions, entry: deps.entry, signal: deps.signal });
        return { backend, answers: normalize(r.answers), usage: r.usage };
      }
      return await localJudge(state, questions, deps);
    } catch (e) {
      if (deps.signal?.aborted) throw e;
      errors.push(`${backend}: ${(e as Error).message}`);
      logger.warn({ evt: "judge_fallback", backend, err: (e as Error).message });
    }
  }
  throw new Error(`no judge backend succeeded (${errors.join("; ")})`);
}

// Offline fallback: ask the session's own model for strict JSON and parse tolerantly.
async function localJudge(state: unknown, questions: Record<string, Question>, deps: JudgeDeps): Promise<JudgeResult> {
  const spec = Object.entries(questions).map(([id, q]) =>
    q.type === "score"
      ? `"${id}": a number 0-${q.criteria.length - 1} (${q.criteria.map((c, i) => `${i}=${c}`).join(", ")}) — ${q.instructions}`
      : q.type === "boolean"
        ? `"${id}": a probability 0-1 that this is true — ${q.instructions}`
        : `"${id}": one of ${Object.keys(q.criteria).map((k) => `"${k}"`).join(" | ")} — ${q.instructions}`,
  );
  const prompt = [
    "Evaluate the material below. Reply immediately with ONE JSON object and nothing else — no explanation, no reasoning.",
    "Keys and value types:",
    ...spec.map((s) => `  ${s}`),
    "",
    "MATERIAL:",
    typeof state === "string" ? state : JSON.stringify(state).slice(0, 20_000),
  ].join("\n");

  // Thinking models spend budget before answering, so a truncated first try gets more room.
  for (let attempt = 0; attempt < 2; attempt++) {
    // First try is capped (a rubric answer is tiny); a thinking model that spends the
    // whole budget reasoning gets the entry's full budget on the retry.
    const budget = attempt === 0 ? Math.min(deps.entry.maxOutputTokens, deps.cfg.maxOutputTokens) : deps.entry.maxOutputTokens;
    const res = await deps.provider.chat({
      system: "You are a strict evaluator. Output only JSON.",
      messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
      tools: [],
      signal: deps.signal ?? new AbortController().signal,
      // A rubric answer is tiny; without this cap a thinking model runs for minutes.
      entry: { ...deps.entry, maxOutputTokens: budget },
    });
    const text = res.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const raw = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!raw) {
      logger.debug({ evt: "judge_unparseable", attempt, stopReason: res.stopReason, budget, reply: text.slice(-400) });
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const v = parsed[id];
        if (q.type === "score") answers[id] = { type: "score", score: clamp(Number(v), 0, q.criteria.length - 1) };
        else if (q.type === "boolean") answers[id] = { type: "boolean", probability: clamp(typeof v === "boolean" ? (v ? 1 : 0) : Number(v), 0, 1) };
        else answers[id] = { type: "choice", choice: Object.keys(q.criteria).includes(String(v)) ? String(v) : Object.keys(q.criteria)[0]! };
      }
      return { backend: "local", answers, usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } };
    } catch {}
  }
  throw new Error("local judge returned no parseable JSON");
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

export const scoreOf = (a: Answer | undefined) => (a?.type === "score" ? a.score : 0);
export const probOf = (a: Answer | undefined) => (a?.type === "boolean" ? a.probability : 0);
export const choiceOf = (a: Answer | undefined) => (a?.type === "choice" ? a.choice : "");
