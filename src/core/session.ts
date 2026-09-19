import type { PromptSet } from "../prompts/loader.ts";
import type { Message } from "./types.ts";
import { logger } from "../util/logger.ts";

export type RunState = "idle" | "running";

export type Job = { runId: string; run: (signal: AbortSignal) => Promise<void> };

export type Session = {
  id: string;
  messages: Message[];
  model: string;
  verbose: boolean;
  prompts: PromptSet; // frozen for the session's lifetime
  runState: RunState;
  queue: Job[];
  controller?: AbortController;
};

export type SessionInit = Pick<Session, "id" | "model" | "prompts"> & { verbose?: boolean };

// One active run per session; later submissions wait FIFO.
export class SessionStore {
  #sessions = new Map<string, Session>();

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  all(): Session[] {
    return [...this.#sessions.values()];
  }

  create(init: SessionInit): Session {
    const s: Session = { messages: [], runState: "idle", queue: [], verbose: false, ...init };
    this.#sessions.set(s.id, s);
    return s;
  }

  enqueue(s: Session, job: Job): number {
    s.queue.push(job);
    const ahead = s.queue.length - 1 + (s.runState === "running" ? 1 : 0);
    void this.#pump(s);
    return ahead;
  }

  // Aborts the active run (model request and tool included) and drops everything queued.
  cancel(s: Session): { cancelled: boolean; dropped: number } {
    const dropped = s.queue.length;
    s.queue.length = 0;
    const cancelled = !!s.controller && !s.controller.signal.aborted;
    s.controller?.abort(new DOMException("Cancelled by user", "AbortError"));
    return { cancelled, dropped };
  }

  async #pump(s: Session): Promise<void> {
    if (s.runState === "running") return;
    const job = s.queue.shift();
    if (!job) return;
    s.runState = "running";
    const controller = new AbortController();
    s.controller = controller;
    try {
      await job.run(controller.signal);
    } catch (e) {
      logger.error({ evt: "run_crash", session: s.id, runId: job.runId, err: e }, "run crashed");
    } finally {
      s.runState = "idle";
      s.controller = undefined;
      void this.#pump(s);
    }
  }
}
