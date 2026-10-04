import type { MastraCompositeStore } from "@mastra/core/storage";
import { compact, sortBy, truncate } from "lodash-es";
import { dayjs } from "./time.ts";

export type Row = { at: Date; role: string; text: string };

type Msg = { role: string; createdAt: Date; content: { parts: Array<{ type: string; text?: string; toolInvocation?: { toolName?: string } }> } };

const textOf = (m: Msg) =>
  compact(m.content.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-invocation" ? `[used ${p.toolInvocation?.toolName}]` : undefined))).join(" ").trim();

/** User and assistant messages stored after `since`, oldest first, across every thread. */
export async function messagesSince(storage: MastraCompositeStore, since: Date): Promise<Row[]> {
  const mem = await storage.getStore("memory");
  if (!mem) return [];
  const { threads } = await mem.listThreads({ perPage: false });
  const perThread = await Promise.all(
    threads.map(async (t) => {
      const { messages } = await mem.listMessages({
        threadId: t.id,
        perPage: false,
        filter: { dateRange: { start: since, startExclusive: true } },
        orderBy: { field: "createdAt", direction: "ASC" },
      });
      return (messages as unknown as Msg[]).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ at: new Date(m.createdAt), role: m.role, text: textOf(m) }));
    }),
  );
  return sortBy(perThread.flat().filter((r) => r.text), "at");
}

/** Splits rows into transcripts of at most `maxChars`; `until` is the last message each one covers. */
export function transcripts(rows: Row[], zone: string, maxChars = 40_000) {
  const out: Array<{ text: string; until: Date }> = [];
  let text = "";
  let until = rows[0]?.at ?? new Date(0);
  for (const r of rows) {
    const line = `[${dayjs(r.at).tz(zone).format("YYYY-MM-DD HH:mm")}] ${r.role}: ${truncate(r.text, { length: 2000 })}\n`;
    if (text && text.length + line.length > maxChars) {
      out.push({ text, until });
      text = "";
    }
    text += line;
    until = r.at;
  }
  return text ? [...out, { text, until }] : out;
}
