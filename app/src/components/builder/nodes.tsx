"use client";
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Crown, Link2, Plus, Unplug } from "lucide-react";
import { cn } from "@/lib/cn";
import { Monogram, STATUS, StatusDot, spring } from "@/components/ui";
import { TelegramDot } from "@/components/canvas/telegram-state";
import { useBuilder } from "./context";
import { KindIcon, TINT } from "./kinds";
import { liveError, liveLine, type Tone } from "./live";
import type { Adder, Side, VNode } from "./layout";
import type { Item } from "./model";

export type BuilderNodeData = { v: VNode };
export type BuilderNode = Node<BuilderNodeData>;

const handlePos: Record<Side, Position> = { left: Position.Right, right: Position.Left, top: Position.Bottom, stack: Position.Left };
const TONE: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-ink-3" };

/** Nodes fade and scale in when they appear (a ghost becoming a component, a new trigger), and only fade when motion is reduced. */
function Shell({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={spring} className={cn("relative", className)}>
      {children}
    </motion.div>
  );
}

const ItemIcon = ({ item, size = 16 }: { item: Item; size?: number }) => <KindIcon kind={item.ref.kind} github={item.type === "GitHub trigger"} size={size} strokeWidth={2} aria-hidden />;

const cardBase = "group/card relative flex h-[58px] w-[280px] items-center gap-2.5 rounded-xl border px-3 text-left transition-[border-color,box-shadow,opacity]";

function StagedDot({ id }: { id: string }) {
  const { changed } = useBuilder();
  if (!changed.has(id)) return null;
  return <span title="Changed, not applied yet" className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-panel bg-accent" role="img" aria-label="changed, not applied yet" />;
}

const ItemNode = memo(function ItemNode({ data, selected }: NodeProps<BuilderNode>) {
  const v = data.v as Extract<VNode, { type: "item" }>;
  const { item } = v;
  const api = useBuilder();
  const line = liveLine(item, api.live);
  const problems = api.issues[item.id] ?? [];
  const off = !item.connected; // a trigger that is switched off keeps its node
  const warn = !!item.inactive || line?.tone === "warn";
  const bad = problems.length > 0 || line?.tone === "bad";
  const title = problems[0] ?? liveError(item, api.live) ?? item.inactive;
  const action = off ? { label: `Switch on ${item.title}`, Icon: Link2 } : item.locked ? null : { label: `${item.unavailable ? "Remove" : item.ref.kind === "trigger" ? "Switch off" : "Disconnect"} ${item.title}`, Icon: Unplug };
  return (
    <Shell>
      <div
        title={title}
        className={cn(
          cardBase,
          "bg-panel shadow-float",
          bad ? "border-bad/60" : warn ? "border-warn/50" : "border-line",
          off && "border-dashed opacity-80",
          selected && "ring-2 ring-accent ring-offset-2 ring-offset-canvas",
        )}
      >
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", off ? "bg-raised text-ink-3" : TINT[item.group].tile)}>
          <ItemIcon item={item} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-[13.5px] font-medium text-ink", /^(mcp|private-mcp|skill|trigger)$/.test(item.ref.kind) && "font-mono text-[12.5px]")}>{item.title}</span>
            {item.ref.kind === "telegram" && line?.tg && <TelegramDot tone={line.tg.tone} className="size-2" />}
          </span>
          <span className={cn("block truncate text-[11.5px]", line ? TONE[line.tone] : bad ? "text-bad" : warn ? "text-warn" : "text-ink-3")}>{problems[0] ?? line?.text ?? item.inactive ?? item.detail}</span>
        </span>
        {(bad || warn) && !action && <AlertTriangle size={14} className={bad ? "text-bad" : "text-warn"} aria-hidden />}
        {action && (
          <button
            type="button"
            aria-label={action.label}
            title={action.label}
            onClick={(e) => {
              e.stopPropagation();
              if (off) api.connect(item.ref);
              else api.disconnect(item.ref);
            }}
            className={cn(
              "nodrag nopan grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100",
              off ? "" : "opacity-0 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            <action.Icon size={14} aria-hidden />
          </button>
        )}
        <StagedDot id={item.id} />
        <Handle id="out" type="source" position={handlePos[v.side]} isConnectable={false} />
      </div>
    </Shell>
  );
});

const GhostNode = memo(function GhostNode({ data, selected }: NodeProps<BuilderNode>) {
  const v = data.v as Extract<VNode, { type: "ghost" }>;
  const { item } = v;
  const api = useBuilder();
  return (
    <Shell>
      <div title={item.note ?? item.blocked} className={cn(cardBase, "border-dashed border-line-strong bg-panel/55 hover:border-accent/60 hover:bg-panel", selected && "ring-2 ring-accent ring-offset-2 ring-offset-canvas")}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-ink-3">
          <ItemIcon item={item} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink-2">{item.title}</span>
          <span className={cn("block truncate text-[11.5px]", item.blocked ? "text-warn" : "text-ink-3")}>{item.blocked ?? item.note ?? "Not connected"}</span>
        </span>
        <button
          type="button"
          aria-label={`Connect ${item.title}`}
          disabled={!!item.blocked}
          onClick={(e) => {
            e.stopPropagation();
            api.connect(item.ref);
          }}
          className="nodrag nopan inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-line bg-panel px-1.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={12} aria-hidden /> Connect
        </button>
        <StagedDot id={item.id} />
        <Handle id="out" type="source" position={handlePos[v.side]} isConnectable={!item.blocked} />
      </div>
    </Shell>
  );
});

const OverflowNode = memo(function OverflowNode({ data, selected }: NodeProps<BuilderNode>) {
  const v = data.v as Extract<VNode, { type: "overflow" }>;
  const noun = v.kind === "mcp" ? "MCP servers" : "skills";
  return (
    <Shell>
      <div className={cn(cardBase, "border-line bg-panel shadow-float", selected && "ring-2 ring-accent ring-offset-2 ring-offset-canvas")}>
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", TINT.tools.tile)}>
          <KindIcon kind={v.kind === "mcp" ? "mcp" : "skill"} size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink">
            +{v.items.length} more {noun}
          </span>
          <span className="block truncate text-[11.5px] text-ink-3">Connected. Open to manage them.</span>
        </span>
        <Handle id="out" type="source" position={handlePos[v.side]} isConnectable={false} />
      </div>
    </Shell>
  );
});

const ADDER: Record<Adder, (count: number) => { title: string; detail: string }> = {
  "private-mcp": () => ({ title: "Add an MCP server", detail: "A tool server only this agent uses" }),
  trigger: () => ({ title: "Add a trigger", detail: "Wake it on a schedule or a pull request" }),
  "mcp-more": (n) => ({ title: `${n} more shared ${n === 1 ? "server" : "servers"}`, detail: "Not connected. Open the list." }),
  skills: (n) => (n > 0 ? { title: `${n} ${n === 1 ? "skill" : "skills"} in the library`, detail: "Not connected. Open the list." } : { title: "Skill library", detail: "No skills yet. Write the first one." }),
};

const AdderNode = memo(function AdderNode({ data }: NodeProps<BuilderNode>) {
  const v = data.v as Extract<VNode, { type: "adder" }>;
  const a = ADDER[v.adder](v.count);
  return (
    <Shell>
      <div className={cn(cardBase, "border-dashed border-line-strong bg-transparent text-ink-3 hover:border-accent/60 hover:bg-panel/60 hover:text-ink-2")}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong">
          <Plus size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink-2">{a.title}</span>
          <span className="block truncate text-[11.5px]">{a.detail}</span>
        </span>
      </div>
    </Shell>
  );
});

const LabelNode = memo(function LabelNode({ data }: NodeProps<BuilderNode>) {
  const v = data.v as Extract<VNode, { type: "label" }>;
  return (
    <div className={cn("pointer-events-none flex h-5 items-center gap-2 text-[11.5px] font-semibold tracking-[0.04em] uppercase", TINT[v.group].text)}>
      <span>{v.text}</span>
      <span className="h-px flex-1 bg-current opacity-25" />
    </div>
  );
});

const AgentNode = memo(function AgentNode({ selected }: NodeProps<BuilderNode>) {
  const api = useBuilder();
  const a = api.agent;
  const status = api.live.status;
  const problems = api.live.problems.length + (api.issues.agent?.length ?? 0);
  return (
    <Shell>
      <div
        className={cn(
          "group/agent relative h-[176px] w-[300px] rounded-[var(--radius-module)] border bg-panel shadow-float transition-[border-color,box-shadow]",
          a.primary ? "border-crown/50" : "border-line",
          !a.enabled && "opacity-70 saturate-50",
          selected && "ring-2 ring-accent ring-offset-2 ring-offset-canvas",
        )}
      >
        <div className="flex items-start gap-3 p-3.5 pb-2">
          <Monogram id={a.id} name={a.name} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink">{a.name}</span>
              {a.primary && <Crown size={14} className="shrink-0 text-crown" aria-label="primary" />}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-2">
              <span className="truncate">{a.role || "no role"}</span>
            </div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2" title={`${STATUS[status].label}: ${STATUS[status].hint}`}>
              <StatusDot status={status} className="size-2" pulse />
              {a.enabled ? STATUS[status].label : "Disabled"}
            </div>
          </div>
        </div>
        <p className="line-clamp-2 px-3.5 text-[12px] leading-snug text-ink-3">{a.description}</p>
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 border-t border-line px-3.5 py-2 text-[11px]">
          <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-accent">{a.memoryScope === "shared" ? "shared memory" : "own memory"}</span>
          <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-ink-2">{a.sandbox === "own" ? "own sandbox" : "shared sandbox"}</span>
          {problems > 0 && (
            <span className="ml-auto inline-flex items-center gap-1 text-bad">
              <AlertTriangle size={11} aria-hidden /> {problems}
            </span>
          )}
        </div>
        <StagedDot id="agent" />
        {/* Cables arrive on the side the component sits on. Generous handles, so a dragged cable is easy to drop. */}
        <Handle id="left" type="target" position={Position.Left} className="!size-3.5" />
        <Handle id="right" type="target" position={Position.Right} className="!size-3.5" />
        <Handle id="top" type="target" position={Position.Top} className="!size-3.5" />
      </div>
    </Shell>
  );
});

export const builderNodeTypes = { agent: AgentNode, item: ItemNode, ghost: GhostNode, overflow: OverflowNode, adder: AdderNode, label: LabelNode };
