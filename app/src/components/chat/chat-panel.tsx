"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowUp, Brain, ChevronRight, CloudOff, Loader2, MessageSquarePlus, Square, TriangleAlert, X } from "lucide-react";
import type { AgentStatus, ChatHistoryResponse } from "@eigen/engine/schema";
import type { ChatFailure } from "@/lib/server/chat";
import { useFleet } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { Button, Kbd, Monogram, Skeleton, StatusBadge, spring } from "@/components/ui";
import { CopyButton, Markdown } from "./markdown";
import { isFreshSession, useChatSession } from "./session";
import { ToolCard } from "./tool-card";

type Meta = { model?: string };
type Msg = UIMessage<Meta>;

/** Why this agent cannot chat right now, if it cannot. */
type Block = { kind: "offline" } | { kind: "unavailable"; status?: AgentStatus };

const BLOCK_TEXT = {
  offline: { title: "The engine is offline", body: "Start the engine (npm run dev) and the chat picks up again." },
  unavailable: { title: "This agent cannot chat", body: "It is disabled or its config is invalid. Fix it in the builder; chat works once it loads." },
} as const;

/** Chat with one agent from the studio (Mastra chatRoute + AI SDK useChat). Shares the agent's memory with its Telegram chat. */
export function ChatPanel({ agentId, onClose }: { agentId: string; onClose?: () => void }) {
  const { data: fleet } = useFleet();
  const [session, renew] = useChatSession(agentId);
  const summary = fleet?.agents.find((a) => a.id === agentId);
  const name = summary?.name ?? agentId;
  const status = fleet?.engine === "offline" ? "offline" : summary?.runtime.status;
  const block: Block | undefined =
    fleet?.engine === "offline" ? { kind: "offline" } : summary && status !== "loaded" && status !== "stale" ? { kind: "unavailable", status } : undefined;

  const [history, setHistory] = useState<{ session: string; data?: ChatHistoryResponse; failed?: boolean }>();
  useEffect(() => {
    // Also for a session made on this page: the answer says which memory the agent shares, for the header.
    if (!session) return;
    let live = true;
    fetch(`/api/chat/${agentId}?session=${encodeURIComponent(session)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as ChatHistoryResponse) : Promise.reject(r.status)))
      .then((data) => live && setHistory({ session, data }))
      .catch(() => live && setHistory({ session, failed: true }));
    return () => {
      live = false;
    };
  }, [agentId, session]);

  // A session made on this page has no history to wait for.
  const loaded = session && history?.session === session ? history : undefined;
  const ready = session && (isFreshSession(session) || loaded);

  return (
    <section aria-label={`Chat with ${name}`} className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Monogram id={agentId} name={name} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{name}</h2>
            {status && <StatusBadge status={status} />}
          </div>
          <MemoryNote memory={loaded?.data?.memory} />
        </div>
        <Button variant="quiet" onClick={renew} disabled={!session} className="h-8 shrink-0 px-2" title="Start a new conversation (a new thread; memory carries over)">
          <MessageSquarePlus size={15} />
          <span className="max-[480px]:sr-only">New chat</span>
        </Button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close chat" className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        )}
      </header>
      {ready ? (
        <Conversation
          key={session}
          agentId={agentId}
          name={name}
          session={session}
          initial={(loaded?.data?.messages as Msg[] | undefined) ?? []}
          historyFailed={!!loaded?.failed}
          model={loaded?.data?.model ?? summary?.modelKey}
          block={block}
        />
      ) : (
        <div className="flex-1 space-y-3 p-4" aria-busy="true" aria-label="Loading the conversation">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      )}
    </section>
  );
}

/** The studio chat is the agent's memory of its first allowed Telegram user when it has one, else a studio-only memory. */
function MemoryNote({ memory }: { memory?: ChatHistoryResponse["memory"] }) {
  if (!memory) return <p className="mt-0.5 h-4 text-[12px] text-ink-3" />;
  const shared = memory.telegramUserId !== undefined;
  const text = shared ? "Shares memory with your Telegram chat" : "Studio memory, apart from Telegram";
  const detail = shared
    ? `Working memory and recall are the same person as Telegram user ${memory.telegramUserId}.`
    : "This agent has no Telegram user to share with, so the studio keeps a memory of its own.";
  return (
    <p className="mt-0.5 truncate text-[12px] text-ink-3" title={`${detail} This studio conversation is a thread of its own, so it never mixes into the Telegram one.`}>
      {text}
    </p>
  );
}

/** What went wrong, from the proxy's { code, error } body or an error the engine streamed. */
function describe(error: Error): Block | { kind: "error"; text: string } {
  const e = error as Error & { statusCode?: number; responseBody?: string };
  let body: Partial<ChatFailure> = {};
  try {
    body = JSON.parse(e.responseBody ?? e.message);
  } catch {
    /* an error streamed by the engine is plain text */
  }
  if (body.code === "offline" || e.statusCode === 503) return { kind: "offline" };
  if (body.code === "unavailable" || e.statusCode === 404) return { kind: "unavailable" };
  if (e.statusCode && e.statusCode >= 400 && !body.error) return { kind: "error", text: `The request failed (${e.statusCode}).` };
  return { kind: "error", text: body.error ?? e.message ?? "Something went wrong." };
}

type ConversationProps = { agentId: string; name: string; session: string; initial: Msg[]; historyFailed: boolean; model?: string; block?: Block };

function Conversation({ agentId, name, session, initial, historyFailed, model, block }: ConversationProps) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<Msg>({
        api: `/api/chat/${agentId}`,
        // Only the newest message goes up: the engine's memory holds the conversation, and a resent history would be stored twice.
        prepareSendMessagesRequest: ({ messages }) => ({ body: { session, message: messages.at(-1) } }),
      }),
    [agentId, session],
  );
  const { messages, sendMessage, status, error, stop, clearError, regenerate, addToolApprovalResponse } = useChat<Msg>({
    id: `${agentId}:${session}`,
    messages: initial,
    transport,
    throttle: 40,
    // An Approve/Deny answer goes straight back, and the engine resumes the suspended run.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // Closing the panel (or switching agents) cancels a reply in flight; the proxy passes the abort on to the engine.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => () => void stopRef.current(), []);

  const busy = status === "submitted" || status === "streaming";
  const last = messages.at(-1);
  const awaitingApproval = !busy && last?.role === "assistant" && last.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested");
  const problem = error ? describe(error) : undefined;
  const blocked = block ?? (problem && problem.kind !== "error" ? problem : undefined);
  const answeredBy = [...messages].reverse().find((m) => m.role === "assistant" && m.metadata?.model)?.metadata?.model ?? model;

  const send = (text: string) => {
    if (error) clearError();
    void sendMessage({ text });
  };

  return (
    <>
      <MessageList messages={messages} busy={busy} name={name} agentId={agentId} historyFailed={historyFailed && !blocked} blocked={!!blocked} onAnswer={(id, approved) => void addToolApprovalResponse({ id, approved })} canAnswer={!busy && !blocked} />
      <AnimatePresence initial={false}>
        {blocked ? (
          <Notice key="blocked" tone={blocked.kind === "offline" ? "off" : "warn"} icon={blocked.kind === "offline" ? <CloudOff size={15} /> : <TriangleAlert size={15} />} title={BLOCK_TEXT[blocked.kind].title} body={BLOCK_TEXT[blocked.kind].body} />
        ) : problem?.kind === "error" ? (
          <Notice
            key="error"
            tone="bad"
            icon={<TriangleAlert size={15} />}
            title="The reply failed"
            body={problem.text}
            action={
              <Button variant="ghost" className="h-7 px-2.5 text-[12.5px]" onClick={() => void regenerate()}>
                Try again
              </Button>
            }
          />
        ) : null}
      </AnimatePresence>
      <Composer
        name={name}
        busy={busy}
        disabled={!!blocked || awaitingApproval}
        hint={awaitingApproval ? "Approve or deny the tool call above to continue." : undefined}
        model={answeredBy}
        onSend={send}
        onStop={() => void stop()}
      />
    </>
  );
}

function Notice({ tone, icon, title, body, action }: { tone: "off" | "warn" | "bad"; icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      role={tone === "bad" ? "alert" : "status"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={spring}
      className={cn(
        "mx-3 mb-2 flex items-start gap-2.5 rounded-xl border px-3 py-2.5",
        tone === "bad" ? "border-bad/40 bg-bad/8" : tone === "warn" ? "border-warn/40 bg-warn/8" : "border-line bg-raised",
      )}
    >
      <span className={cn("mt-px shrink-0", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink-3")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[12.5px] break-words text-ink-2">{body}</p>
      </div>
      {action}
    </motion.div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/** Within this distance of the bottom the list follows new content; scrolled further up, it stays where the user put it. */
const STICK_PX = 72;

function MessageList({
  messages,
  busy,
  name,
  agentId,
  historyFailed,
  blocked,
  onAnswer,
  canAnswer,
}: {
  messages: Msg[];
  busy: boolean;
  name: string;
  agentId: string;
  historyFailed: boolean;
  /** The notice below explains why; an invitation to talk would contradict it. */
  blocked: boolean;
  onAnswer: (id: string, approved: boolean) => void;
  canAnswer: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    setAway(!stick.current);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const waiting = busy && messages.at(-1)?.role === "user";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-relevant="additions">
        {historyFailed && <p className="mb-3 text-center text-[12px] text-ink-3">Earlier messages could not be loaded; new ones still go to the same thread.</p>}
        {messages.length === 0 ? (
          !blocked && <Empty name={name} agentId={agentId} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <Message key={m.id} message={m} onAnswer={onAnswer} canAnswer={canAnswer} />
            ))}
            {waiting && (
              <div className="flex items-center gap-2 text-[13px] text-ink-3" aria-label={`${name} is thinking`}>
                <Loader2 size={14} className="animate-spin" /> Thinking
              </div>
            )}
          </div>
        )}
      </div>
      <AnimatePresence>
        {away && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={spring}
            onClick={toBottom}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-ink-2 shadow-float hover:text-ink"
          >
            <ArrowDown size={13} /> Latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function Empty({ name, agentId }: { name: string; agentId: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-xs text-center">
        <Monogram id={agentId} name={name} size={44} className="mx-auto" />
        <p className="mt-3 text-[14px] font-medium text-ink">Talk to {name}</p>
        <p className="mt-1 text-[12.5px] text-ink-3">Same agent, tools and memory as on Telegram. Changes you make in the studio apply to the next message.</p>
      </div>
    </div>
  );
}

function Message({ message, onAnswer, canAnswer }: { message: Msg; onAnswer: (id: string, approved: boolean) => void; canAnswer: boolean }) {
  if (message.role === "user") {
    const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">{text}</p>
      </div>
    );
  }
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  return (
    <div className="group/msg min-w-0">
      {message.parts.map((p, i) => {
        if (p.type === "text") return p.text ? <Markdown key={i} text={p.text} /> : null;
        if (p.type === "reasoning") return p.text.trim() ? <Reasoning key={i} text={p.text} streaming={p.state === "streaming"} /> : null;
        if (isToolUIPart(p)) return <ToolCard key={p.toolCallId} part={p} onAnswer={onAnswer} answerable={canAnswer} />;
        return null;
      })}
      {text && (
        <div className="mt-1 flex h-7 items-center opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 max-[640px]:opacity-100">
          <CopyButton text={text} label="Copy reply" />
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] text-ink-3 hover:text-ink-2">
        <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
        <Brain size={13} />
        {streaming ? "Thinking" : "Reasoning"}
      </button>
      {open && <p className="mt-1 border-l-2 border-line pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{text}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const MAX_ROWS_PX = 200;

function Composer({
  name,
  busy,
  disabled,
  hint,
  model,
  onSend,
  onStop,
}: {
  name: string;
  busy: boolean;
  disabled: boolean;
  hint?: string;
  model?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const canSend = !busy && !disabled && text.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="border-t border-line px-3 pt-2.5 pb-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={cn(
          "flex items-end gap-2 rounded-xl border bg-raised px-2.5 py-2 transition-colors focus-within:border-line-strong",
          disabled ? "border-line opacity-70" : "border-line",
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline; never while an IME is composing a word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          aria-label={`Message ${name}`}
          placeholder={hint ?? `Message ${name}`}
          className="max-h-[200px] min-h-[22px] flex-1 resize-none bg-transparent py-0.5 text-[14px] leading-[22px] text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
        {busy ? (
          <Button variant="ghost" onClick={onStop} aria-label="Stop the reply" className="size-8 shrink-0 px-0">
            <Square size={13} className="fill-current" />
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!canSend} aria-label="Send" className="size-8 shrink-0 px-0">
            <ArrowUp size={16} />
          </Button>
        )}
      </form>
      <div className="mt-1.5 flex items-center gap-2 px-1 text-[11.5px] text-ink-3">
        {model && (
          <span className="truncate" title="The model that answers this agent">
            Model <span className="font-mono text-ink-2">{model}</span>
          </span>
        )}
        <span className="ml-auto shrink-0 max-[480px]:hidden">
          <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline
        </span>
      </div>
    </div>
  );
}
