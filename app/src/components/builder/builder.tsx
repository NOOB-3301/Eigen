"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MessageSquare, Plug, Plus, Trash2, X } from "lucide-react";
import { MEMORY_BLOCKS, type TriggerInput } from "@eigen/engine/schema";
import type { FleetResponse } from "@/lib/types";
import { useSkills } from "@/lib/client/library";
import { cn } from "@/lib/cn";
import { Button, Modal, Monogram, Skeleton, StatusBadge, StatusDot, spring } from "@/components/ui";
import { ChatPanel } from "@/components/chat/chat-panel";
import { newTrigger } from "@/components/editors/trigger-form";
import { TrashDialog } from "./agent-dialogs";
import { ApplyBar } from "./apply-bar";
import { BuilderCanvas, type BuilderCanvasApi } from "./canvas";
import { BuilderProvider, type BuilderApi } from "./context";
import { BLURB, kindIcon } from "./kinds";
import { layoutBuilder, type Adder } from "./layout";
import { liveOf } from "./live";
import {
  AGENT_NODE,
  addMcpServer,
  addTrigger,
  connect as connectRef,
  deriveItems,
  describeChanges,
  disconnect as disconnectRef,
  disconnectWarning,
  freeTriggerId,
  issuesByNode,
  needsSetup,
  parseRef,
  problemsByNode,
  readAgent,
  removeMcpServer,
  removeTrigger,
  renameMcpServer,
  type Ctx,
  type Item,
  type Ref,
  refId,
} from "./model";
import { NodePanel, type PanelCtx } from "./node-panel";
import { AddPalette, type PaletteEntry, type PaletteSection } from "./palette";
import { useAgentDraft } from "./use-agent-draft";

type Props = {
  agentId: string;
  fleet: FleetResponse;
  engineOnline: boolean;
  phone: boolean;
  wide: boolean;
  /** How many changes are staged (0 when clean), so the studio can ask before the user leaves. */
  onDirtyChange: (staged: number) => void;
  /** The agent is gone (trashed): go back to the fleet. */
  onGone: () => void;
};

type Confirm = { title: string; body: string; label: string; run: () => void };

/** The palette section an unconnected component is offered in (null: not offered there). */
function sectionOf(i: Item): PaletteSection | null {
  switch (i.ref.kind) {
    case "storage":
    case "lastMessages":
    case "workingMemory":
    case "semanticRecall":
    case "observational":
    case "subconscious":
      return "memory";
    case "soul":
      return "think";
    case "workspace":
    case "schedule":
      return "builtin";
    case "mcp":
      return "mcp";
    case "skill":
      return "skills";
    case "telegram":
      return "reach";
    default:
      return null;
  }
}

export function Builder({ agentId, fleet, engineOnline, phone, wide, onDirtyChange, onGone }: Props) {
  const d = useAgentDraft({ id: agentId, engineOnline, quiet: true });
  const { skills, isLoading: skillsLoading } = useSkills(agentId);
  const reduce = useReducedMotion();
  const canvas = useRef<BuilderCanvasApi>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [palette, setPalette] = useState<{ open: boolean; section: PaletteSection | null }>({ open: false, section: null });
  const [chat, setChat] = useState(false);
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [trash, setTrash] = useState(false);

  const { draft, base } = d;
  const mctx = useMemo<Ctx>(() => ({ agentId, skills, skillsKnown: !skillsLoading }), [agentId, skills, skillsLoading]);
  const items = useMemo(() => (draft ? deriveItems(draft, mctx) : []), [draft, mctx]);
  const layout = useMemo(() => (items.length ? layoutBuilder(items, phone ? "stack" : "wide") : { nodes: [], edges: [] }), [items, phone]);
  const changes = useMemo(() => (base && draft ? describeChanges(base, draft, mctx) : []), [base, draft, mctx]);
  const summary = fleet.agents.find((a) => a.id === agentId);
  const runtime = d.data?.runtime ?? summary?.runtime;
  const live = useMemo(() => liveOf(runtime, d.data?.resolved, engineOnline), [runtime, d.data?.resolved, engineOnline]);
  // Validation issues where they belong, plus the engine's problems on the node they name. The agent node counts the engine's itself.
  const nodeIssues = useMemo(() => {
    if (!draft) return {};
    const out = issuesByNode(d.errors, draft.config);
    for (const [node, list] of Object.entries(problemsByNode(live.problems, draft.config))) if (node !== AGENT_NODE) out[node] = [...(out[node] ?? []), ...list.filter((p) => !out[node]?.includes(p))];
    return out;
  }, [d.errors, draft, live.problems]);
  const read = draft ? readAgent(draft.config) : null;
  const name = (typeof draft?.config.name === "string" && draft.config.name) || summary?.name || agentId;
  const panelWidth = phone ? 0 : wide ? 480 : 420;

  // The studio asks before leaving with staged changes.
  const staged = d.dirty ? Math.max(1, changes.length) : 0;
  useEffect(() => {
    onDirtyChange(staged);
  }, [staged, onDirtyChange]);
  useEffect(() => () => onDirtyChange(0), [onDirtyChange]);

  const open = useCallback((nodeId: string) => {
    setSelected(nodeId);
    setChat(false);
  }, []);
  // A side sheet covers the right of the canvas: slide the view so the composition sits in what is left, and back when it closes.
  const sheetOpen = !phone && !!draft && ((selected !== null && !chat) || chat);
  const sheetWidth = !sheetOpen ? 0 : chat ? (wide ? 520 : 440) : panelWidth;
  useEffect(() => {
    canvas.current?.setCover(sheetWidth);
    if (!selected || chat) return;
    const t = setTimeout(() => canvas.current?.reveal(selected), 380);
    return () => clearTimeout(t);
  }, [sheetWidth, selected, chat]);
  const closePanel = useCallback(() => {
    const id = selected;
    setSelected(null);
    // Back to the node the panel was opened from, so keyboard users keep their place.
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus(), 60);
  }, [selected]);

  const selectedValid = selected !== null && (selected === AGENT_NODE || selected === "library" || layout.nodes.some((n) => n.id === selected) || items.some((i) => i.id === selected));
  // The node under the open panel is gone (a trigger was deleted): close the panel instead of leaving it dangling.
  if (selected !== null && !selectedValid && draft) setSelected(null);

  /* ---- connect, disconnect, add ---- */

  const connect = useCallback(
    (ref: Ref) => {
      d.update((cur) => connectRef(cur, ref, mctx));
      if (needsSetup(ref)) open(refId(ref));
    },
    [d, mctx, open],
  );

  const disconnect = useCallback(
    (ref: Ref) => {
      const run = () => d.update((cur) => disconnectRef(cur, ref, mctx, base ?? undefined));
      const warning = draft ? disconnectWarning(draft, ref) : null;
      if (!warning) return run();
      setConfirm({ title: `Disconnect the storage of ${name}?`, body: `${warning} Nothing is written until you apply, and Discard brings it back.`, label: "Disconnect storage", run });
    },
    [d, mctx, base, draft, name],
  );

  const removeMcp = useCallback(
    (server: string) =>
      setConfirm({
        title: `Delete the MCP server ${server}?`,
        body: `This removes its command, arguments and settings from ${name}'s config. To keep it but stop using it, switch it off instead. Nothing is written until you apply.`,
        label: "Delete server",
        run: () => d.update((cur) => removeMcpServer(cur, server)),
      }),
    [d, name],
  );

  const deleteTrigger = useCallback(
    (id: string) =>
      setConfirm({
        title: `Delete the trigger ${id}?`,
        body: `This removes it and its prompt from ${name}'s config. To keep it but stop it firing, switch it off instead. Nothing is written until you apply.`,
        label: "Delete trigger",
        run: () => d.update((cur) => removeTrigger(cur, id)),
      }),
    [d, name],
  );

  const addMcp = useCallback(() => {
    if (!draft) return;
    const { draft: next, ref } = addMcpServer(draft);
    d.update(() => next);
    open(refId(ref));
  }, [d, draft, open]);

  const addNewTrigger = useCallback(
    (type: TriggerInput["type"]) => {
      if (!draft) return;
      const id = freeTriggerId(draft, type === "cron" ? "schedule" : "pull-requests");
      d.update((cur) => addTrigger(cur, newTrigger(type, id)));
      open(`trigger:${id}`);
    },
    [d, draft, open],
  );

  const adder = useCallback(
    (kind: Adder) => {
      if (kind === "mcp") addMcp();
      else if (kind === "skills") open("library");
      else setPalette({ open: true, section: "reach" });
    },
    [addMcp, open],
  );

  const onActivate = useCallback((id: string) => (id.startsWith("adder:") ? adder(id.slice("adder:".length) as Adder) : open(id)), [adder, open]);

  const connectGhost = useCallback(
    (id: string) => {
      const ref = parseRef(id);
      if (ref) connect(ref);
    },
    [connect],
  );

  const deleteNode = useCallback(
    (id: string) => {
      // Delete only counts when the keyboard is on the canvas, not on a button inside a panel.
      const at = document.activeElement;
      if (at && at !== document.body && !at.closest(".builder-flow")) return;
      const ref = parseRef(id);
      const item = items.find((i) => i.id === id);
      // Only something that is connected can be disconnected: Delete on a ghost does nothing.
      if (ref && item?.connected && !item.locked) disconnect(ref);
    },
    [disconnect, items],
  );

  /* ---- keyboard ---- */

  const { save } = d;
  const canApply = d.dirty && !!d.validation?.ok && d.phase.k !== "saving" && d.phase.k !== "conflict";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canApply) void save();
      } else if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
        if (chat) setChat(false);
        else if (selected) closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canApply, save, chat, selected, closePanel]);

  /* ---- what the canvas and the panels are given ---- */

  const modelKey = read?.modelKey ?? "";
  const modelId = typeof read?.models[modelKey]?.id === "string" ? (read.models[modelKey].id as string) : "";
  const memoryOn = read ? MEMORY_BLOCKS.filter((b) => read.blocks[b]).length : 0;
  const api = useMemo<BuilderApi>(
    () => ({
      live,
      changed: new Set(changes.map((c) => c.id)),
      issues: nodeIssues,
      selectedId: selected,
      hovered,
      pending: changes.length,
      open,
      connect,
      disconnect,
      adder,
      agent: {
        id: agentId,
        name,
        role: (typeof draft?.config.role === "string" && draft.config.role) || "",
        description: (typeof draft?.config.description === "string" && draft.config.description) || "",
        enabled: draft?.config.enabled !== false,
        modelKey,
        modelId,
        memory: read?.storage ? memoryOn : 0,
      },
      itemsById: new Map(items.map((i) => [i.id, i])),
    }),
    [live, changes, nodeIssues, selected, hovered, open, connect, disconnect, adder, agentId, name, draft, modelKey, modelId, read?.storage, memoryOn, items],
  );

  const panelCtx: PanelCtx | null = draft
    ? {
        agentId,
        agentName: name,
        draft,
        base,
        errors: d.errors,
        hasInstructionsFile: d.data?.instructionsText !== null,
        runtime,
        live,
        engineOnline,
        items,
        issues: nodeIssues,
        set: d.set,
        update: d.update,
        setInstructions: d.setInstructions,
        setSoul: d.setSoul,
        connect,
        disconnect,
        removeTrigger: deleteTrigger,
        removeMcp,
        renameMcp: (from, to) => {
          if (!draft || renameMcpServer(draft, from, to) === draft) return;
          d.update((cur) => renameMcpServer(cur, from, to));
          setSelected(`mcp:${to}`);
        },
        open,
        trash: () => setTrash(true),
      }
    : null;

  const entries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = [];
    for (const i of items) {
      const s = i.connected ? null : sectionOf(i);
      if (!s) continue;
      out.push({
        key: i.id,
        section: s,
        type: i.type,
        icon: kindIcon(i.ref.kind),
        title: i.title,
        detail: i.ref.kind === "skill" ? i.detail || "A skill from this agent's library" : i.ref.kind === "mcp" ? `Switched off · ${i.detail ?? ""}` : (BLURB[i.ref.kind] ?? i.detail ?? ""),
        blocked: i.blocked,
        run: () => connect(i.ref),
      });
    }
    out.push({ key: "new-mcp", section: "mcp", type: "MCP server", icon: Plug, title: "New MCP server", detail: "A tool server for this agent: a local command or a remote URL", run: addMcp });
    out.push({ key: "library", section: "skills", type: "Skill", icon: kindIcon("skill"), title: "Skill library", detail: "Browse, write and edit this agent's skills", action: true, run: () => open("library") });
    out.push({ key: "trigger-cron", section: "reach", type: "Trigger", icon: kindIcon("trigger", "cron"), title: "Schedule trigger", detail: "Wake it on a cron schedule", run: () => addNewTrigger("cron") });
    out.push({ key: "trigger-github", section: "reach", type: "Trigger", icon: kindIcon("trigger", "github-pr"), title: "GitHub pull request trigger", detail: "Wake it when a pull request opens or updates", run: () => addNewTrigger("github-pr") });
    return out;
  }, [items, connect, addMcp, addNewTrigger, open]);

  /* ---- render ---- */

  if (d.notFound)
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">This agent no longer exists</h2>
          <p className="mt-1.5 text-[13px] text-ink-2">It may have been moved to the trash.</p>
          <Button variant="primary" className="mt-4" onClick={onGone}>
            Back to the agents
          </Button>
        </div>
      </div>
    );

  const isOpen = selectedValid && selected !== null && !chat;

  return (
    <BuilderProvider value={api}>
      <div className="absolute inset-0">
        {draft ? (
          <BuilderCanvas
            key={agentId}
            layout={layout}
            selectedId={selectedValid ? selected : null}
            phone={phone}
            onActivate={onActivate}
            onPaneClick={() => selected && closePanel()}
            onConnectGhost={connectGhost}
            onDelete={deleteNode}
            onHover={setHovered}
            apiRef={canvas}
          />
        ) : (
          <div className="grid h-full place-items-center" aria-busy="true" aria-label="Loading the agent">
            {d.error ? <p className="text-[13px] text-bad">Could not load this agent: {(d.error as Error).message}</p> : <Skeleton className="h-40 w-72" />}
          </div>
        )}
      </div>

      {/* Who is being built, and what can be done to the agent as a whole. */}
      <div className="pointer-events-none absolute top-[68px] left-3 z-20 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-2 sm:top-[76px] sm:left-4">
        <div className="pointer-events-auto flex h-11 min-w-0 items-center gap-2.5 rounded-xl border border-line bg-panel/90 pr-3 pl-2 shadow-float backdrop-blur-md">
          <Monogram id={agentId} name={name} size={30} />
          <h2 className="max-w-[16ch] truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink sm:max-w-[24ch]">{name}</h2>
          <span className="hidden font-mono text-[12px] text-ink-3 sm:inline">@{agentId}</span>
          {runtime && (
            <>
              <span className="sm:hidden" title={runtime.status}>
                <StatusDot status={runtime.status} />
                <span className="sr-only">{runtime.status}</span>
              </span>
              <span className="hidden sm:inline">
                <StatusBadge status={runtime.status} />
              </span>
            </>
          )}
        </div>
        <div className="pointer-events-auto flex h-11 items-center gap-1 rounded-xl border border-line bg-panel/90 px-1.5 shadow-float backdrop-blur-md">
          <Button variant="primary" className="h-8" onClick={() => setPalette({ open: true, section: null })} disabled={!draft}>
            <Plus size={14} strokeWidth={2.4} /> Add <span className="hidden sm:inline">component</span>
          </Button>
          <Button variant="quiet" className="h-8" onClick={() => (setSelected(null), setChat((c) => !c))} aria-pressed={chat} disabled={!draft}>
            <MessageSquare size={14} /> <span className="hidden sm:inline">Chat</span>
          </Button>
          {draft && (
            <Button variant="quiet" className="h-8 px-2 hover:text-bad" onClick={() => setTrash(true)} aria-label="Move to trash" title="Move to trash">
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      </div>

      {panelCtx && (
        <ApplyBar
          phase={d.phase}
          dirty={d.dirty}
          changes={changes}
          issues={d.validation?.issues ?? []}
          engineOnline={engineOnline}
          base={base}
          draft={draft}
          agentId={agentId}
          reviewOpen={review}
          setReviewOpen={setReview}
          onApply={() => void d.save()}
          onDiscard={d.discard}
          onKeepEditing={() => d.setPhase({ k: "idle" })}
          onReloadTheirs={() => void d.reloadTheirs()}
          onOverwrite={(etag) => void d.save(etag)}
          inset={sheetWidth + (sheetWidth ? 16 : 0)}
        />
      )}

      <AnimatePresence>
        {panelCtx && isOpen && selected && (
          <NodePanel
            key="panel"
            nodeId={selected}
            ctx={panelCtx}
            onClose={closePanel}
            phone={phone}
            className={cn("absolute z-30", phone ? "inset-x-0 bottom-0 h-[74dvh] rounded-t-2xl border-t" : "top-[76px] right-4 bottom-4 rounded-2xl border")}
            style={phone ? undefined : { width: panelWidth }}
          />
        )}
        {chat && (
          <motion.aside
            key={`chat-${agentId}`}
            role="dialog"
            aria-modal="false"
            aria-label={`Chat with ${name}`}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setChat(false);
              }
            }}
            initial={reduce ? { opacity: 0 } : phone ? { y: "104%" } : { x: "104%" }}
            animate={reduce ? { opacity: 1 } : { x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : phone ? { y: "104%" } : { x: "104%" }}
            transition={spring}
            className={cn("absolute z-30 flex flex-col overflow-hidden border-line bg-panel shadow-float", phone ? "inset-0" : "top-[76px] right-4 bottom-4 rounded-2xl border")}
            style={phone ? undefined : { width: wide ? 520 : 440 }}
          >
            {d.dirty && (
              <p role="status" className="border-b border-line bg-raised/60 px-5 py-2 text-[12.5px] text-ink-2">
                You have changes that are not applied. The chat uses the applied version.
              </p>
            )}
            {/* The chat has its own header and close button; it is only given a box of a definite height. */}
            <div className="min-h-0 flex-1">
              {runtime && (runtime.status === "loaded" || runtime.status === "stale") ? (
                <ChatPanel agentId={agentId} onClose={() => setChat(false)} />
              ) : (
                <div className="flex items-start gap-3 p-5">
                  <p className="min-w-0 flex-1 text-[13px] text-ink-2">
                    {runtime?.status === "disabled"
                      ? `${name} is disabled. Enable it and apply to chat with it.`
                      : runtime?.status === "invalid"
                        ? `${name} has not loaded because its config has problems. Fix them and apply.`
                        : "The engine is not running, so there is nothing to chat with yet."}
                  </p>
                  <button type="button" onClick={() => setChat(false)} aria-label="Close chat" className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
                    <X size={16} />
                  </button>
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <AddPalette open={palette.open} onClose={() => setPalette((p) => ({ ...p, open: false }))} entries={entries} initialSection={palette.section} agentName={name} />

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title ?? ""}>
        <div className="p-5">
          <h3 className="text-[15px] font-semibold text-ink">{confirm?.title}</h3>
          <p className="mt-2 text-[13px] text-ink-2">{confirm?.body}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              {confirm?.label}
            </Button>
          </div>
        </div>
      </Modal>
      <TrashDialog open={trash} onClose={() => setTrash(false)} id={agentId} name={name} onDone={onGone} />
    </BuilderProvider>
  );
}
