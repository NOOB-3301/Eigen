import type { SkillsConfig } from "../config/schema.ts";
import { choiceOf, judge, probOf, scoreOf } from "../models/judge.ts";
import type { JudgeDeps, Question } from "../models/judge.ts";
import { slugify, similarity } from "./store.ts";
import type { SkillDraft, SkillStore } from "./store.ts";
import { logger } from "../util/logger.ts";

export type Verdict = { ok: boolean; score?: number; reasons: string[]; revise?: boolean };

const SECRET_RE = /(TOKEN|SECRET|API_?KEY|PASSWORD)\s*[:=]\s*\S|sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}/i;
const FORBIDDEN_PATH_RE = /\.eigen\/\.env|~\/\.ssh|\/\.aws\/|\/etc\/(passwd|shadow)/;

export const MIN_BODY = 200;
export const MAX_BODY = 8192;

// Stage 1: deterministic. Runs first so a junk draft never costs a judge call.
export function validateDraft(draft: SkillDraft, store: SkillStore): string[] {
  const reasons: string[] = [];
  if (!draft.name?.trim()) reasons.push("missing name");
  if (!slugify(draft.name ?? "")) reasons.push("name produces an empty slug");
  if (!draft.description?.trim()) reasons.push("missing description");
  else if (draft.description.length > 120) reasons.push(`description is ${draft.description.length} chars; keep it under 120 for the index`);
  const body = draft.body ?? "";
  if (body.length < MIN_BODY) reasons.push(`body is too thin (${body.length} chars) to be a procedure`);
  if (body.length > MAX_BODY) reasons.push(`body is too large (${body.length} chars)`);
  const haystack = [body, ...(draft.scripts ?? []).map((s) => s.content)].join("\n");
  if (SECRET_RE.test(haystack)) reasons.push("contains something that looks like a secret; reference an env var name instead");
  if (FORBIDDEN_PATH_RE.test(haystack)) reasons.push("references a credential path (.env, ~/.ssh, ~/.aws)");
  for (const s of draft.scripts ?? []) if (s.path.includes("..") || s.path.startsWith("/")) reasons.push(`script path must stay inside the skill: ${s.path}`);
  const dup = draft.description ? store.similarTo(draft.description, 0.8) : undefined;
  if (dup) reasons.push(`duplicates existing skill "${dup.slug}" (${Math.round(similarity(dup.description, draft.description) * 100)}% similar); use skill_update instead`);
  return reasons;
}

export const DRAFT_QUESTIONS: Record<string, Question> = {
  reusable: {
    type: "score",
    instructions: "Will this procedure help with future tasks, beyond the single instance it came from?",
    criteria: ["one-off, never again", "narrow, rarely", "occasionally useful", "often useful"],
  },
  specific: { type: "boolean", instructions: "Are the steps concrete — real tool names, paths, commands, flags — rather than generic advice?" },
  preconditions: { type: "boolean", instructions: "Does it state when to use it and what it assumes (env vars, access, files)?" },
  redundant: { type: "boolean", instructions: "Is this already covered by an obvious single tool call, making the skill pointless?" },
  verdict: {
    type: "choice",
    instructions: "Should this be kept as a reusable skill?",
    criteria: { keep: "Useful and well-formed", revise: "Useful but the steps need work", discard: "Not worth keeping" },
  },
};

// Stage 2: judged critique. Thresholds live in config because probabilities are not
// calibrated across providers.
export async function evaluateDraft(draft: SkillDraft, store: SkillStore, cfg: SkillsConfig, deps: Omit<JudgeDeps, "cfg">): Promise<Verdict> {
  const reasons = validateDraft(draft, store);
  if (reasons.length) {
    logger.info({ evt: "skill_eval", stage: "validation", ok: false, reasons });
    return { ok: false, reasons };
  }

  const th = cfg.eval.thresholds;
  console.log(`Evaluating skill draft "${draft.name}" with thresholds:`, JSON.stringify(th, null, 2));
  const r = await judge({ name: draft.name, description: draft.description, when: draft.when, body: draft.body }, DRAFT_QUESTIONS, { ...deps, cfg: cfg.eval });
  console.log(`Judge returned:`, JSON.stringify(r, null, 2));
  const a = r.answers;
  const failures: string[] = [];
  if (scoreOf(a.reusable) < (th.reusable ?? 2)) failures.push(`judged not reusable enough (${scoreOf(a.reusable).toFixed(1)} < ${th.reusable})`);
  if (probOf(a.specific) < (th.specific ?? 0.7)) failures.push("steps are too generic");
  if (probOf(a.preconditions) < (th.preconditions ?? 0.6)) failures.push("missing preconditions or a clear trigger");
  if (probOf(a.redundant) > (th.redundant ?? 0.5)) failures.push("already covered by a single built-in tool call");
  const verdict = choiceOf(a.verdict);
  if (verdict === "discard") failures.push("judge verdict: discard");

  logger.info({ evt: "skill_eval", stage: "critique", backend: r.backend, ok: !failures.length, answers: a });
  return failures.length ? { ok: false, reasons: failures, revise: verdict === "revise" } : { ok: true, score: scoreOf(a.reusable), reasons: [] };
}
