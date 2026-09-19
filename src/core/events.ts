export type DoneReason = "end" | "cancelled" | "limit" | "error";

export type AgentEvent =
  | { type: "run_start"; sessionId: string; runId: string; channel: string }
  | { type: "assistant_message"; sessionId: string; runId: string; text: string; interim: boolean }
  | { type: "tool_start"; sessionId: string; runId: string; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; sessionId: string; runId: string; callId: string; name: string; ok: boolean; durationMs: number }
  | { type: "error"; sessionId: string; runId: string; message: string }
  | { type: "done"; sessionId: string; runId: string; reason: DoneReason; steps: number; tokens: number };

export type Listener = (e: AgentEvent) => void;

export class EventBus {
  #listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(e: AgentEvent): void {
    for (const fn of this.#listeners) {
      // A broken subscriber must not break the run.
      try {
        fn(e);
      } catch {}
    }
  }
}
