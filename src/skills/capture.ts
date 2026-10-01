import type { ModelEntry, SkillsConfig } from "../config/schema.ts";
import type { Message } from "../core/types.ts";
import type { ModelProvider } from "../models/provider.ts";
import { judge, probOf, scoreOf } from "../models/judge.ts";
import type { Question } from "../models/judge.ts";
import { evaluateDraft } from "./eval.ts";
import { parseFrontmatter } from "./store.ts";
import type { Skill, SkillDraft, SkillStore } from "./store.ts";
import { estimateText } from "../util/tokens.ts";
import { logger } from "../util/logger.ts";

const DEFER_POLL_MS = 200;

export type CaptureJob = { sessionId: string; runId: string; messages: Message[]; entryName: string };

export type CaptureDeps = {
  store: SkillStore;
  cfg: SkillsConfig;
  entryFor: (name: string) => ModelEntry;
  providerFor: (name: string) => ModelProvider;
  isBusy: (sessionId: string) => boolean;
  overCap: (entryName: string) => boolean;
  onSaved?: (sessionId: string, skill: Skill) => void;
  onUsage?: (entryName: string, tokens: number) => void;
};

const TRIAGE_QUESTIONS: Record<string, Question> = {
  worthCapturing: {
    type: "score",
    instructions: "Would a written procedure from this conversation help with future tasks?",
    criteria: ["one-off, never again", "narrow, rarely", "occasionally useful", "often useful"],
  },
  taskSucceeded: { type: "boolean", instructions: "Did the assistant actually accomplish what the user asked?" },
  alreadyCovered: { type: "boolean", instructions: "Is this already covered by one of the existing skills listed in the material?" },
};

export function transcriptOf(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") lines.push(`${m.role}: ${p.text}`);
      else if (p.type === "tool_call") lines.push(`assistant calls ${p.name}(${JSON.stringify(p.args)})`);
      else if (p.type === "tool_result") lines.push(`tool result${p.isError ? " (error)" : ""}: ${p.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ")}`);
    }
  }
  return lines.join("\n");
}

// Keep the tail: the end of a run holds the working procedure, the start holds the flailing.
export function clampToTokens(text: string, maxTokens: number): string {
  if (estimateText(text) <= maxTokens) return text;
  return `[earlier turns omitted]\n${text.slice(-maxTokens * 4)}`;
}

const DRAFT_INSTRUCTIONS = `Write a reusable skill from the conversation above, as one markdown document:

---
name: <2-4 words>
description: <one line under 120 chars: what it does and for what>
when: <when a future task should use this>
---
## Preconditions
- <env vars, access, tools needed>

## Steps
1. <concrete step with real commands, paths, endpoints>

## Notes
- <pitfalls discovered, including what did NOT work>

Rules: no secrets or tokens (name the env var instead); no one-off values from this conversation unless they are stable; only steps that actually worked. Output the document and nothing else.`;

// Runs after a run has finished and its reply is already on the way to the user.
// Never touches the session, never throws into the chat.
export class SkillCapture {
  #deps: CaptureDeps;
  #queue: CaptureJob[] = [];
  #running = false;
  #controller = new AbortController();

  constructor(deps: CaptureDeps) {
    this.#deps = deps;
  }

  schedule(job: CaptureJob): void {
    if (!this.#deps.cfg.enabled || !this.#deps.cfg.capture.enabled) return;
    this.#queue.push(job);
    void this.#pump();
  }

  async idle(): Promise<void> {
    while (this.#running || this.#queue.length) await new Promise((r) => setTimeout(r, 5));
  }

  stop(): void {
    this.#queue.length = 0;
    this.#controller.abort();
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      // `done` is emitted while the session is still marked running (the session queue
      // flips it to idle just after runLoop returns), so let that settle first.
      await new Promise((r) => setImmediate(r));
      while (this.#queue.length && !this.#controller.signal.aborted) {
        const job = this.#queue.shift()!;
        if (this.#deps.cfg.capture.deferWhileBusy && this.#deps.isBusy(job.sessionId)) {
          // The user is mid-conversation: come back after that run finishes.
          this.#queue.push(job);
          if (this.#queue.length === 1) await new Promise((r) => setTimeout(r, DEFER_POLL_MS));
          continue;
        }
        try {
          await this.#capture(job);
        } catch (e) {
          logger.error({ evt: "skill_capture", decision: "failed", session: job.sessionId, err: (e as Error).message });
        }
      }
    } finally {
      this.#running = false;
    }
  }

  // Gates 2-5 (gate 1 is the caller: only clean runs are scheduled).
  async #capture(job: CaptureJob): Promise<void> {
    const { store, cfg } = this.#deps;
    if (this.#deps.overCap(job.entryName)) return logger.info({ evt: "skill_capture", decision: "skip", reason: "daily token cap" });

    const entryName = cfg.capture.model ?? job.entryName;
    const deps = {
      entry: this.#deps.entryFor(entryName),
      entryName,
      provider: this.#deps.providerFor(entryName),
      signal: this.#controller.signal,
    };
    const transcript = clampToTokens(transcriptOf(job.messages), cfg.capture.maxStateTokens);
    const th = cfg.capture.thresholds;

    const triage = await judge({ transcript, existingSkills: store.indexText() || "(none)" }, TRIAGE_QUESTIONS, { ...deps, cfg: cfg.eval });
    this.#usage(entryName, triage.usage);
    const a = triage.answers;
    if (scoreOf(a.worthCapturing) < (th.worthCapturing ?? 2) || probOf(a.taskSucceeded) < (th.taskSucceeded ?? 0.7) || probOf(a.alreadyCovered) > (th.alreadyCovered ?? 0.5)) {
      return logger.info({ evt: "skill_capture", decision: "skip", backend: triage.backend, session: job.sessionId, answers: a });
    }

    const draft = await this.draft(transcript, { ...deps, timeoutMs: cfg.capture.timeoutMs });
    if (!draft) return logger.info({ evt: "skill_capture", decision: "skip", reason: "draft unusable" });

    const verdict = await evaluateDraft(draft, store, cfg, deps);
    if (!verdict.ok) return logger.info({ evt: "skill_capture", decision: "rejected", session: job.sessionId, reasons: verdict.reasons });

    const skill = store.write(draft, "agent-created", verdict.score);
    logger.info({ evt: "skill_capture", decision: "saved", slug: skill.slug, score: verdict.score });
    if (cfg.notify) this.#deps.onSaved?.(job.sessionId, skill);
  }

  // One model call: transcript -> SKILL.md draft.
  async draft(transcript: string, deps: { entry: ModelEntry; entryName: string; provider: ModelProvider; signal?: AbortSignal; timeoutMs?: number }): Promise<SkillDraft | undefined> {
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? 300_000);
    const res = await deps.provider.chat({
      system: "You write concise, reusable operating procedures. Output only the markdown document.",
      messages: [{ role: "user", parts: [{ type: "text", text: `CONVERSATION:\n${transcript}\n\n${DRAFT_INSTRUCTIONS}` }] }],
      tools: [],
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
      entry: deps.entry,
    });
    this.#usage(deps.entryName, { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    const text = res.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
    return parseDraft(text);
  }

  #usage(entryName: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
    this.#deps.onUsage?.(entryName, (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
  }
}

export function parseDraft(text: string): SkillDraft | undefined {
  const cleaned = text.replace(/^```(?:markdown|md)?\n?/, "").replace(/```$/, "").trim();
  try {
    const { data, body } = parseFrontmatter(cleaned);
    const name = String(data.name ?? "").trim();
    const description = String(data.description ?? "").trim();
    if (!name || !description || !body) return undefined;
    return { name, description, when: data.when ? String(data.when) : undefined, body };
  } catch {
    return undefined;
  }
}
