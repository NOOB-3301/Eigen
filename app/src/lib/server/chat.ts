import { AgentId, type ChatHistoryResponse } from "@eigen/engine/schema";
import { z } from "zod";
import { engineBase } from "./engine";
import { json } from "./http";
import { cleanText } from "./probe";

/** A chat turn is a few KB; the cap only stops a runaway paste from tying up the engine. */
export const CHAT_MAX_BODY = 1_000_000;

const Session = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** Loose on purpose: the engine validates the message itself. This only refuses what is obviously not a chat turn before it costs a hop. */
const Turn = z.object({ session: Session, message: z.object({ id: z.string(), role: z.enum(["user", "assistant"]), parts: z.array(z.unknown()) }) });

/** `code` lets the panel tell "the engine is offline" from "agent is disabled" without parsing prose. */
export type ChatFailure = { ok: false; code: "offline" | "unavailable" | "bad-request" | "too-large" | "failed"; error: string };
const failure = (status: number, code: ChatFailure["code"], error: string) => json({ ok: false, code, error } satisfies ChatFailure, status);

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
};

/** Reads at most `max` bytes, counting while reading (a missing or false Content-Length does not get around it). */
async function readCapped(req: Request, max = CHAT_MAX_BODY): Promise<string | undefined> {
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
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const isRefused = (e: unknown) => e instanceof Error && e.name !== "AbortError" && e.name !== "TimeoutError";

/** No secrets and no filesystem paths reach the browser, whatever the engine put in its message. */
const scrub = (v: unknown) => cleanText(typeof v === "string" ? v.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`:]+){2,}/g, "[path]") : v);

/** Relays an engine refusal with its status, keeping only its (sanitized) message. */
async function refusal(res: Response): Promise<Response> {
  const raw = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const error = scrub(raw?.error) ?? `the engine answered ${res.status}`;
  if (res.status === 404) return failure(404, "unavailable", "this agent is disabled, invalid or unknown");
  if (res.status === 413) return failure(413, "too-large", "message too large");
  if (res.status >= 400 && res.status < 500) return failure(res.status, "bad-request", error);
  return failure(502, "failed", error);
}

/**
 * POST /api/chat/[agentId]: forwards one chat turn to the engine and pipes its UI-message stream back untouched, chunk by chunk.
 * The browser's abort (Stop, closing the panel) aborts the upstream request, which ends the agent's run in the engine.
 */
export async function proxyChat(req: Request, agentId: string): Promise<Response> {
  if (!AgentId.safeParse(agentId).success) return failure(400, "bad-request", "invalid agent id");
  const raw = await readCapped(req);
  if (raw === undefined) return failure(413, "too-large", "message too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure(400, "bad-request", "body must be JSON");
  }
  const turn = Turn.safeParse(body);
  if (!turn.success) return failure(400, "bad-request", turn.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));

  const base = engineBase();
  if (!base) return failure(503, "offline", "the engine is offline");
  let res: Response;
  try {
    res = await fetch(`${base}/eigen/chat/${agentId}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      // Re-serialized from the parsed turn, so only `session` and `message` ever reach the engine.
      body: JSON.stringify(turn.data),
      signal: req.signal,
    });
  } catch (e) {
    return isRefused(e) ? failure(503, "offline", "the engine is offline") : failure(499, "failed", "request cancelled");
  }
  if (!res.ok) return refusal(res);
  if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) return failure(502, "failed", "the engine sent an unexpected answer");
  return new Response(res.body, { headers: STREAM_HEADERS });
}


/** GET /api/chat/[agentId]?session=...: the session's earlier messages, so a reopened panel continues where it left off. */
export async function chatHistory(agentId: string, session: string | null): Promise<Response> {
  if (!AgentId.safeParse(agentId).success) return failure(400, "bad-request", "invalid agent id");
  if (!Session.safeParse(session).success) return failure(400, "bad-request", "invalid session id");
  const base = engineBase();
  if (!base) return failure(503, "offline", "the engine is offline");
  let res: Response;
  try {
    res = await fetch(`${base}/eigen/chat/${agentId}/${session}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return isRefused(e) ? failure(503, "offline", "the engine is offline") : failure(504, "failed", "the engine did not answer in time");
  }
  if (!res.ok) return refusal(res);
  const raw = (await res.json().catch(() => null)) as Partial<ChatHistoryResponse> | null;
  if (!raw || !Array.isArray(raw.messages) || typeof raw.model !== "string") return failure(502, "failed", "the engine sent an unexpected answer");
  const user = raw.memory?.telegramUserId;
  return json({
    messages: raw.messages,
    model: raw.model,
    memory: typeof user === "number" ? { telegramUserId: user } : {},
  } satisfies ChatHistoryResponse);
}
