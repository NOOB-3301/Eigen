"use client";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, Blocks, KeyRound, Loader2, MessageSquare, Trash2, X } from "lucide-react";
import type { AgentSummary } from "@eigen/engine/schema";
import { keys, trashAgent, useAgent } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { Button, Modal, Monogram, StatusBadge, spring } from "@/components/ui";
import { TelegramStateChip, telegramView } from "@/components/canvas/telegram-state";
import { ChatPanel } from "@/components/chat/chat-panel";
import { chatAvailability, headline, splitProblems } from "./summary";

type Props = {
  agent: AgentSummary;
  engine: "online" | "offline";
  phone: boolean;
  /** Card width on larger screens (the canvas keeps the selected node clear of it). */
  width: number;
  onClose: () => void;
  onOpenBuilder: (id: string) => void;
};

/**
 * The compact card for the agent selected on the fleet view: what it is, whether it runs, its bot, what it needs, and the three things
 * to do next (build, chat, trash). Everything else is edited in the builder.
 */
export function SummaryCard({ agent: a, engine, phone, width, onClose, onOpenBuilder }: Props) {
  const reduce = useReducedMotion();
  const { mutate } = useSWRConfig();
  const { data: detail } = useAgent(a.id);
  const [chat, setChat] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { keys: missing, other } = splitProblems(a.runtime.problems);
  const canChat = chatAvailability(a, engine);
  const models = (detail?.config as { models?: Record<string, { id?: string }> } | undefined)?.models;
  const modelId = detail?.resolved?.model.id ?? models?.[a.modelKey]?.id;

  const trash = async () => {
    setBusy(true);
    const r = await trashAgent(a.id).catch(() => ({ status: 0, body: { ok: false, issues: ["the studio did not answer"] } }));
    setBusy(false);
    setConfirm(false);
    if (!r.body.ok) {
      toast.error(`Could not trash ${a.name}`, { description: r.body.issues?.[0] });
      return;
    }
    toast.success(`${a.name} moved to the trash`, { description: "Its folder is in ~/.eigen/agents/.trash; nothing was erased." });
    onClose();
    await mutate(keys.fleet);
  };

  return (
    <motion.aside
      aria-label={`${a.name} summary`}
      initial={reduce ? { opacity: 0 } : phone ? { y: "104%" } : { opacity: 0, x: 24 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0, y: 0 }}
      exit={reduce ? { opacity: 0 } : phone ? { y: "104%" } : { opacity: 0, x: 24 }}
      transition={spring}
      className={cn(
        "absolute z-30 flex flex-col overflow-hidden border-line bg-panel shadow-float",
        phone ? "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t" : "top-[76px] right-4 rounded-2xl border",
        chat && (phone ? "top-0 max-h-none rounded-none" : "bottom-4"),
      )}
      style={phone ? undefined : { width }}
    >
      <header className="flex items-start gap-3 border-b border-line p-4">
        <Monogram id={a.id} name={a.name} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{a.name}</h2>
          <p className="truncate text-[12.5px] text-ink-2">{headline(a, engine)}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
      </header>

      {chat ? (
        <div className="min-h-0 flex-1">
          {canChat.ok ? (
            <ChatPanel agentId={a.id} onClose={() => setChat(false)} />
          ) : (
            <div className="flex items-start gap-3 p-5">
              <p className="min-w-0 flex-1 text-[13px] text-ink-2">{canChat.reason}</p>
              <Button variant="quiet" onClick={() => setChat(false)}>
                Back
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto">
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2.5 px-4 py-3.5 text-[12.5px]">
            <dt className="text-ink-3">Status</dt>
            <dd>
              <StatusBadge status={a.runtime.status} />
            </dd>
            <dt className="text-ink-3">Model</dt>
            <dd className="min-w-0 truncate font-mono text-[12px] text-ink" title={modelId}>
              {a.modelKey || "none"}
              {modelId && <span className="text-ink-3"> · {modelId}</span>}
            </dd>
            <dt className="text-ink-3">Telegram</dt>
            <dd className="min-w-0">
              <TelegramStateChip view={telegramView(a.runtime.telegram, { enabled: a.telegram.enabled, engineOffline: engine === "offline" })} />
            </dd>
            {a.description && (
              <>
                <dt className="text-ink-3">About</dt>
                <dd className="line-clamp-3 text-ink-2">{a.description}</dd>
              </>
            )}
          </dl>

          {missing.length > 0 && (
            <div className="mx-4 mb-3 rounded-xl border border-warn/40 bg-warn/8 px-3 py-2.5 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <KeyRound size={13} className="text-warn" /> {missing.length === 1 ? "A key to set" : "Keys to set"}
              </div>
              <p className="mt-1 text-ink-2">
                Set <span className="font-mono text-ink">{missing.join(", ")}</span> in this agent&apos;s keys (the LLM node in its builder). Until then it cannot think.
              </p>
            </div>
          )}
          {other.length > 0 && (
            <ul role="alert" className="mx-4 mb-3 space-y-1 rounded-xl bg-bad/8 px-3 py-2.5 text-[12.5px] text-ink">
              {other.slice(0, 4).map((p) => (
                <li key={p} className="flex gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-bad" />
                  <span className="min-w-0 break-words">{p}</span>
                </li>
              ))}
              {other.length > 4 && <li className="text-ink-3">and {other.length - 4} more, shown in the builder</li>}
            </ul>
          )}
        </div>
      )}

      {!chat && (
        <footer className="flex items-center gap-2 border-t border-line p-3">
          <Button variant="primary" onClick={() => onOpenBuilder(a.id)}>
            <Blocks size={14} /> Open builder
          </Button>
          <Button onClick={() => setChat(true)} title={canChat.reason}>
            <MessageSquare size={14} /> Chat
          </Button>
          <Button variant="quiet" className="ml-auto text-bad" onClick={() => setConfirm(true)} aria-label={`Trash ${a.name}`}>
            <Trash2 size={14} />
          </Button>
        </footer>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Trash ${a.name}`}>
        <div className="p-5">
          <h3 className="text-[15px] font-semibold text-ink">Move {a.name} to the trash?</h3>
          <p className="mt-2 text-[13px] text-ink-2">
            The engine stops it, its bot goes quiet and its triggers stop. The whole folder (config, keys, memory, skills, workspace) moves to ~/.eigen/agents/.trash, where you can
            get it back by moving it out again.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={trash} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />} Move to trash
            </Button>
          </div>
        </div>
      </Modal>
    </motion.aside>
  );
}
