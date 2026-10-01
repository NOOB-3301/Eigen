import type { Agent } from "../../core/agent.ts";
import type { AgentEvent } from "../../core/events.ts";
import type { Outbox } from "./outbox.ts";

export const sessionFor = (chatId: number) => `tg:${chatId}`;
const chatFor = (sessionId: string) => (sessionId.startsWith("tg:") ? Number(sessionId.slice(3)) : undefined);

function brief(args: Record<string, unknown>): string {
  const s = Object.values(args)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

// Chat <-> session mapping and agent events -> outbound messages.
export function createDispatcher(agent: Agent, outbox: Outbox) {
  const off = agent.on((e: AgentEvent) => {
    const chat = chatFor(e.sessionId);
    if (chat === undefined) return;
    const verbose = agent.getVerbose(e.sessionId);
    switch (e.type) {
      case "run_start":
        outbox.startTyping(chat);
        break;
      case "assistant_message":
        if (!e.interim || verbose) outbox.send(chat, e.text);
        break;
      case "tool_start":
        if (verbose) outbox.send(chat, `⚙ ${e.name} ${brief(e.args)}`.trim());
        break;
      case "tool_end":
        if (verbose && !e.ok) outbox.send(chat, `✗ ${e.name} failed (${e.durationMs} ms)`);
        break;
      case "notice":
        outbox.send(chat, e.text);
        break;
      case "error":
        outbox.send(chat, `⚠ ${e.message}`);
        break;
      case "done":
        outbox.stopTyping(chat);
        if (e.reason === "cancelled") outbox.send(chat, "Stopped.");
        break;
    }
  });

  return {
    onText(chatId: number, text: string): void {
      const { ahead } = agent.submit({ sessionId: sessionFor(chatId), text, channel: "telegram" });
      if (ahead > 0) outbox.send(chatId, `Queued (${ahead} ahead).`);
    },
    dispose: off,
  };
}
