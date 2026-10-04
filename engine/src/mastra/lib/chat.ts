/**
 * Chat with an agent from the studio, as the AI SDK UI-message stream that `useChat` reads (Mastra's handleChatStream, the handler
 * behind chatRoute). The studio's Next server is the only caller: it proxies the browser's request here.
 *
 * Memory: the primary and "shared" agents use the resource Mastra's Telegram channel gives the user (`telegram:<userId>`), so working
 * memory and recall carry over between the studio and Telegram; an "isolated" agent gets a resource of its own. The thread is always a
 * separate studio thread per session, so the two conversations never interleave.
 *
 * The body is rebuilt here instead of being spread into agent.stream() the way chatRoute does it: a caller that could set `memory`,
 * `instructions` or `tools` could read any thread or rewrite the agent.
 *
 * Tool approval: Mastra suspends the run and streams a `tool-approval-request`; the panel answers with useChat's addToolApprovalResponse
 * and sends the assistant message back, and handleChatStream resumes the suspended run from it.
 */
import { handleChatStream, withSseHeartbeat } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { Mastra } from "@mastra/core/mastra";
import { createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { truncate } from "lodash-es";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import { AgentId, type GetAgentRuntimeResponse, type ResolvedAgent } from "./schema.ts";
import { redact, redactDeep } from "./secrets.ts";
import { activeModel, readState } from "./state.ts";

export const CHAT_MAX_BODY = 1_000_000;
const HISTORY_LIMIT = 100;
/**
 * SSE comment while the model is quiet (a slow first token, a long tool call). The studio's Next server only notices that the
 * browser went away when it writes, so without these a Stop during a silent stretch would leave the run going until it finished.
 */
const HEARTBEAT_MS = 1000;

/** Chosen by the studio per agent; "New chat" picks a new one. Never a Telegram thread id (those are not in this alphabet's prefix). */
export const ChatSession = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "session must be 8-64 letters, digits, _ or -");

const TextPart = z.object({ type: z.literal("text"), text: z.string().min(1).max(200_000) });
const UserMessage = z.object({ id: z.string().min(1).max(128), role: z.literal("user"), parts: z.array(TextPart).min(1).max(20) });

/** The approval id Mastra puts on a tool-approval-request is `<runId>::<toolCallId>`; handleChatStream resumes exactly that run and call. */
const isAnswer = (p: Record<string, unknown>) => {
  const a = p.approval as { id?: unknown; approved?: unknown } | undefined;
  return (
    p.state === "approval-responded" &&
    typeof p.toolCallId === "string" &&
    typeof a?.id === "string" &&
    typeof a.approved === "boolean" &&
    a.id.endsWith(`::${p.toolCallId}`) &&
    a.id.length > p.toolCallId.length + 2
  );
};
/** An assistant message is accepted only to carry Approve/Deny answers back; anything else would plant fake turns in memory. */
const ApprovalMessage = z
  .object({ id: z.string().min(1).max(128), role: z.literal("assistant"), parts: z.array(z.record(z.string(), z.unknown())).min(1).max(500) })
  .refine((m) => m.parts.some(isAnswer), "an assistant message must answer a tool approval");

export const ChatRequest = z.object({ session: ChatSession, message: z.union([UserMessage, ApprovalMessage]) });
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Body of GET /eigen/chat/:id/:session. */
export type ChatHistoryResponse = {
  messages: UIMessage[];
  /** Config key of the model that answers (the primary follows /model). */
  model: string;
  memory: { scope: "shared" | "isolated"; telegramUserId?: number };
};

/** Same resource as the user's Telegram chat for the primary and shared agents; a studio thread of its own per agent and session. */
export function chatMemory(r: Pick<ResolvedAgent, "id" | "primary" | "memory">, root: Pick<Config, "telegram">, session: string) {
  const user = root.telegram.allowedUserIds[0];
  const telegram = user === undefined ? "studio" : `telegram:${user}`;
  const shared = r.primary || r.memory.scope === "shared";
  return { resource: shared ? telegram : `${r.id}:${telegram}`, thread: `studio:${r.id}:${session}`, scope: shared ? ("shared" as const) : ("isolated" as const), user };
}

/** Errors go to a browser: no secrets, no filesystem paths, nothing long. */
export const cleanError = (e: unknown) =>
  truncate(redact(String((e as Error)?.message ?? e)).replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`:]+){2,}/g, "[path]"), { length: 300 });

/** Reads at most `max` bytes; undefined when the body is bigger (checked while reading, so a lying Content-Length does not help). */
export async function readCapped(req: Request, max = CHAT_MAX_BODY): Promise<string | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** Tool output can quote a secret (an `env` dump); each chunk is redacted before it leaves the engine, like history and Telegram logs. */
const redactChunks = () => new TransformStream<UIMessageChunk, UIMessageChunk>({ transform: (chunk, c) => c.enqueue(redactDeep(chunk)) });

export type ChatDeps = {
  paths: HomePaths;
  root: () => Config;
  resolved: (id: string) => ResolvedAgent | undefined;
  detail: (id: string) => GetAgentRuntimeResponse | undefined;
};

/** The process-wide instance for server.ts. fleet.ts is imported lazily, so tests use makeChat without booting the real registry. */
export async function studioChat() {
  const [{ paths, registry }, { getConfig }] = await Promise.all([import("./fleet.ts"), import("./config.ts")]);
  return makeChat({ paths, root: getConfig, resolved: registry.resolved, detail: (id) => registry.detail(id) });
}

export function makeChat({ paths, root, resolved, detail }: ChatDeps) {
  /** Only a loaded agent (or a stale one, which keeps answering with its last good version) can be chatted with. */
  const target = (id: string) => {
    if (!AgentId.safeParse(id).success) return undefined;
    const status = detail(id)?.runtime.status;
    return status === "loaded" || status === "stale" ? resolved(id) : undefined;
  };
  const modelOf = (r: ResolvedAgent) => (r.primary ? activeModel(root(), readState(paths), r.modelKey) : r.modelKey);
  const agentOf = (mastra: Mastra, id: string) => {
    try {
      return mastra.getAgentById(id);
    } catch {
      return undefined;
    }
  };
  const notFound = () => fail(404, "no such agent, or it is disabled or invalid");

  return {
    async stream(mastra: Mastra, req: Request, id: string): Promise<Response> {
      const r = target(id);
      if (!r || !agentOf(mastra, id)) return notFound();
      const raw = await readCapped(req);
      if (raw === undefined) return fail(413, "message too large");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return fail(400, "body must be JSON");
      }
      const body = ChatRequest.safeParse(json);
      if (!body.success) return fail(400, body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));

      const { resource, thread } = chatMemory(r, root(), body.data.session);
      const model = modelOf(r);
      try {
        const stream = await handleChatStream({
          mastra,
          agentId: id,
          version: "v7",
          params: {
            messages: [body.data.message as UIMessage],
            memory: { thread: { id: thread, title: `Studio chat with ${r.name}`, metadata: { eigen_source: "studio" } }, resource },
            // Closing the tab (the studio aborts its upstream fetch) stops the model call instead of finishing a reply nobody reads.
            abortSignal: req.signal,
          },
          sendReasoning: true,
          onError: cleanError,
          messageMetadata: ({ part }) => (part.type === "start" ? { model } : undefined),
        });
        return withSseHeartbeat(createUIMessageStreamResponse({ stream: stream.pipeThrough(redactChunks()), headers: { "cache-control": "no-store" } }), HEARTBEAT_MS);
      } catch (e) {
        return fail(500, cleanError(e));
      }
    },

    /** The session's earlier messages (newest HISTORY_LIMIT), so a reopened panel continues where it left off. */
    async history(mastra: Mastra, id: string, session: string): Promise<Response> {
      const r = target(id);
      const agent = r && agentOf(mastra, id);
      if (!r || !agent) return notFound();
      if (!ChatSession.safeParse(session).success) return fail(400, "bad session id");
      const { resource, thread, scope, user } = chatMemory(r, root(), session);
      let messages: UIMessage[] = [];
      try {
        const memory = await agent.getMemory();
        if (memory && (await memory.getThreadById({ threadId: thread }))) {
          const res = await memory.recall({ threadId: thread, resourceId: resource, perPage: HISTORY_LIMIT });
          messages = redactDeep(toAISdkMessages(res.messages, { version: "v7" }) as UIMessage[]);
        }
      } catch {
        // A thread from before a Telegram user change belongs to another resource: start fresh rather than fail the panel.
      }
      const body: ChatHistoryResponse = { messages, model: modelOf(r), memory: { scope, ...(user !== undefined && { telegramUserId: user }) } };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    },
  };
}
