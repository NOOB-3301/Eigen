"use client";
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Crown, FolderCog, CalendarClock, Plug, Send, ShieldCheck, Sparkles } from "lucide-react";
import type { AgentSummary, TelegramState } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Monogram, STATUS, StatusDot, spring } from "@/components/ui";
import { TelegramDot, telegramView } from "./telegram-state";

type Common = { leaving?: boolean; enterDelay?: number; dimmed?: boolean };
export type AgentNodeData = AgentSummary & { builtinTools: string[]; overrides: string[]; selected?: boolean } & Common;
/** One Telegram bot, wired to the agent it answers as. `offline`: the engine is not running, so `state` is only what the config implies. */
export type ChannelNodeData = { channel: "telegram"; routesTo: string; tokenEnv?: string; state: TelegramState; username?: string; offline?: boolean } & Common;
export type McpNodeData = { name: string; owner: string; trusted: boolean; error?: string } & Common;

export type AgentNode = Node<AgentNodeData, "agent">;
export type ChannelNode = Node<ChannelNodeData, "channel">;
export type McpNode = Node<McpNodeData, "mcp">;
export type StudioNode = AgentNode | ChannelNode | McpNode;

const TOOL_ICON: Record<string, typeof FolderCog> = { workspace: FolderCog, schedule: CalendarClock, skills: Sparkles };

/** Enter/leave choreography shared by every node. Leaving nodes are kept briefly by the canvas so they can animate out. */
function Shell({ data, children, className }: { data: Common; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 8 }}
      animate={data.leaving ? { opacity: 0, scale: 0.88, y: -6 } : { opacity: data.dimmed ? 0.45 : 1, scale: 1, y: 0 }}
      transition={{ ...spring, delay: data.leaving ? 0 : (data.enterDelay ?? 0) }}
      className={cn("relative", className)}
    >
      {children}
    </motion.div>
  );
}

const handle = "!border-line-strong !bg-panel";

export const AgentNodeView = memo(function AgentNodeView({ data, selected }: NodeProps<AgentNode>) {
  const status = data.runtime.status;
  const problems = data.runtime.problems.length;
  const modelInherited = !data.overrides.includes("model");
  const otherOverrides = data.overrides.filter((o) => o !== "model").length;
  return (
    <Shell data={data}>
      {selected && (
        <motion.span
          layoutId="selection-ring"
          transition={spring}
          className="pointer-events-none absolute -inset-[5px] rounded-[18px] border-2 border-accent"
          aria-hidden
        />
      )}
      <div
        className={cn(
          "w-[264px] rounded-[var(--radius-module)] border bg-panel shadow-float transition-colors",
          data.primary ? "border-crown/50" : "border-line",
          !data.enabled && "opacity-60 saturate-50",
        )}
      >
        <Handle type="target" position={Position.Left} className={handle} />
        <div className="flex items-start gap-3 p-3 pb-2.5">
          <Monogram id={data.id} name={data.name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink">{data.name}</span>
              {data.primary && (
                <span title="Primary: owns Telegram and supervises the team" className="text-crown">
                  <Crown size={13} strokeWidth={2.2} aria-label="primary" />
                </span>
              )}
              <span className="ml-auto flex items-center gap-1" title={`${STATUS[status].label}: ${STATUS[status].hint}`}>
                <StatusDot status={status} pulse />
                <span className="sr-only">{STATUS[status].label}</span>
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <span className="truncate">{data.role || "no role"}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-2">
          <span
            className={cn(
              "inline-flex h-5 max-w-[130px] items-center gap-1 rounded-md px-1.5 font-mono text-[11px]",
              modelInherited ? "border border-dashed border-line-strong text-ink-3" : "bg-accent-soft text-accent",
            )}
            title={modelInherited ? "Model inherited from the root default" : "Model set on this agent"}
          >
            <span className="truncate">{data.modelKey}</span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            {data.builtinTools.map((t) => {
              const Icon = TOOL_ICON[t] ?? Sparkles;
              return (
                <span key={t} title={`Built-in tool: ${t}`} className="grid size-5 place-items-center rounded-md bg-raised text-ink-2">
                  <Icon size={11.5} strokeWidth={2} aria-label={t} />
                </span>
              );
            })}
          </span>
        </div>
        {(problems > 0 || otherOverrides > 0 || !data.enabled) && (
          <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11.5px]">
            {problems > 0 && (
              <span className={cn("inline-flex items-center gap-1", status === "stale" ? "text-warn" : "text-bad")}>
                <AlertTriangle size={12} strokeWidth={2.2} />
                {problems} {problems === 1 ? "problem" : "problems"}
              </span>
            )}
            {!data.enabled && <span className="text-ink-3">Disabled</span>}
            {otherOverrides > 0 && (
              <span className="ml-auto text-ink-3" title={data.overrides.join(", ")}>
                {otherOverrides} {otherOverrides === 1 ? "override" : "overrides"}
              </span>
            )}
          </div>
        )}
        <Handle type="source" position={Position.Right} className={handle} />
      </div>
    </Shell>
  );
});

export const ChannelNodeView = memo(function ChannelNodeView({ data }: NodeProps<ChannelNode>) {
  const view = telegramView({ state: data.state, username: data.username }, { enabled: true, engineOffline: data.offline });
  const title = view.tone === "polling" && data.username ? `@${data.username}` : "Telegram bot";
  // The handle is already the title when live, so the state line says "Live" instead of repeating it.
  const stateText = view.tone === "polling" ? "Live" : view.label;
  return (
    <Shell data={data}>
      <div
        className={cn(
          "flex w-[224px] items-center gap-3 rounded-[var(--radius-module)] border bg-panel p-3 shadow-float",
          view.tone === "error" ? "border-tg-error/50" : view.tone === "missing" ? "border-tg-missing/50" : "border-routes/40",
        )}
        title={view.detail}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-routes/15 text-routes">
          <Send size={16} strokeWidth={2} className="-translate-x-px translate-y-px" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-ink">{title}</span>
            <span className="ml-auto">
              <TelegramDot tone={view.tone} />
            </span>
          </div>
          <div className={cn("truncate text-[12px]", view.tone === "error" ? "text-bad" : view.tone === "missing" ? "text-warn" : "text-ink-2")}>{stateText}</div>
          <div className="truncate font-mono text-[11px] text-ink-3">{data.tokenEnv ?? "no token variable"}</div>
        </div>
        <Handle type="source" position={Position.Right} className="!border-routes !bg-panel" />
      </div>
    </Shell>
  );
});

export const McpNodeView = memo(function McpNodeView({ data }: NodeProps<McpNode>) {
  return (
    <Shell data={data}>
      <div
        className={cn(
          "flex w-[200px] items-center gap-2.5 rounded-xl border bg-panel px-3 py-2.5 shadow-float",
          data.error ? "border-bad/50" : "border-line",
        )}
        title={data.error ? `Error: ${data.error}` : undefined}
      >
        <Handle type="target" position={Position.Left} className={handle} />
        <span className={cn("grid size-7 place-items-center rounded-lg", data.error ? "bg-bad/12 text-bad" : "bg-uses/15 text-ink-2")}>
          <Plug size={14} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate font-mono text-[12.5px] text-ink">{data.name}</span>
            {data.trusted && (
              <span title="Trusted: tools run without asking" className="text-ok">
                <ShieldCheck size={12} strokeWidth={2.2} aria-label="trusted" />
              </span>
            )}
          </div>
          <div className="truncate text-[11.5px] text-ink-3">{data.error ? "Failed to connect" : data.owner === "root" ? "Shared server" : `Private to ${data.owner}`}</div>
        </div>
      </div>
    </Shell>
  );
});

export const nodeTypes = { agent: AgentNodeView, channel: ChannelNodeView, mcp: McpNodeView };
