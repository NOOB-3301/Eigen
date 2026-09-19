import type { Message } from "./types.ts";
import { estimateMessage } from "../util/tokens.ts";

export type TrimResult = {
  messages: Message[];
  historyTokens: number;
  trimmedResults: number;
  droppedTurns: number;
  fits: boolean;
};

export const TRIMMED_NOTE = "[output trimmed to save context]";

// A turn is a user message plus everything up to the next user message, so a tool call
// and its results always live in the same turn.
export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

// Works on a copy; stored history is never modified.
export function trimHistory(messages: Message[], budget: number, imageTokens: number): TrimResult {
  const turns = splitTurns(messages).map((t) => t.slice());
  const cost = (m: Message) => estimateMessage(m, imageTokens);
  let total = messages.reduce((n, m) => n + cost(m), 0);
  let trimmedResults = 0;
  let droppedTurns = 0;
  const latest = turns.length - 1;

  // 1) Blank old tool-result bodies, oldest first, never in the latest turn.
  for (let t = 0; t < latest && total > budget; t++) {
    const turn = turns[t]!;
    for (let i = 0; i < turn.length && total > budget; i++) {
      const m = turn[i]!;
      if (m.role !== "tool") continue;
      const before = cost(m);
      const parts = m.parts.map((p) => (p.type === "tool_result" ? { ...p, content: [{ type: "text" as const, text: TRIMMED_NOTE }] } : p));
      const next = { ...m, parts };
      const after = cost(next);
      if (after >= before) continue;
      turn[i] = next;
      total -= before - after;
      trimmedResults++;
    }
  }

  // 2) Drop whole old turns.
  let start = 0;
  while (total > budget && start < latest) {
    for (const m of turns[start]!) total -= cost(m);
    start++;
    droppedTurns++;
  }

  const kept = turns.slice(start);
  if (trimmedResults || droppedTurns) {
    // Provider blobs (e.g. signed thinking blocks) are bound to the exact earlier
    // transcript. Once we've edited it, replaying them for completed turns can be
    // rejected, so send those turns in plain neutral form.
    for (let t = 0; t < kept.length - 1; t++) kept[t] = kept[t]!.map(({ providerData: _, ...m }) => m);
  }
  return { messages: kept.flat(), historyTokens: total, trimmedResults, droppedTurns, fits: total <= budget };
}
