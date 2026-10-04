"use client";
import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Bot, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { spring } from "@/components/ui";
import { kindIcon, TINT } from "./kinds";
import { parseRef } from "./model";
import { AgentBody } from "./panels/agent";
import type { PanelCtx } from "./panels/connection";
import { Form, type FormCtx } from "./panels/fields";
import { LlmBody } from "./panels/llm";
import { LastMessagesBody, ObservationalBody, SemanticRecallBody, StorageBody, SubconsciousBody, WorkingMemoryBody } from "./panels/memory";
import { InstructionsBody, SoulBody } from "./panels/prompt";
import { TelegramBody, TriggerBody } from "./panels/reach";
import { LibraryBody, McpBody, OverflowBody, ScheduleBody, SkillBody, WorkspaceBody } from "./panels/tools";

export type { PanelCtx } from "./panels/connection";

type Title = { title: string; subtitle: string; icon: ReturnType<typeof kindIcon>; tint: string };

function describe(nodeId: string, ctx: PanelCtx): Title {
  if (nodeId === "agent") return { title: ctx.agentName, subtitle: "The agent: identity, time zone, limits", icon: Bot, tint: "bg-accent-soft text-accent" };
  if (nodeId === "library") return { title: "Skill library", subtitle: `${ctx.agentName}'s own skills`, icon: kindIcon("skill"), tint: TINT.tools.tile };
  if (nodeId.startsWith("overflow:")) return { title: nodeId === "overflow:mcp" ? "All MCP servers" : "More skills", subtitle: "Not drawn one by one", icon: kindIcon(nodeId === "overflow:mcp" ? "mcp" : "skill"), tint: TINT.tools.tile };
  const item = ctx.items.find((i) => i.id === nodeId);
  if (!item) return { title: "Component", subtitle: "", icon: kindIcon("llm"), tint: TINT.think.tile };
  return { title: item.ref.kind === "llm" ? "LLM" : item.title, subtitle: item.ref.kind === "llm" ? `Thinks with ${item.title}` : item.type, icon: kindIcon(item.ref.kind, item.type === "GitHub trigger" ? "github-pr" : "cron"), tint: TINT[item.group].tile };
}

export function NodePanel({ nodeId, ctx, onClose, phone, className, style }: { nodeId: string; ctx: PanelCtx; onClose: () => void; phone: boolean; className?: string; style?: React.CSSProperties }) {
  const reduce = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const t = describe(nodeId, ctx);
  const Icon = t.icon;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [nodeId]);

  const form: FormCtx = { config: ctx.draft.config, set: ctx.set, errors: ctx.errors };
  // The agent panel lists the engine's problems itself.
  const problems = nodeId === "agent" ? [] : (ctx.issues[nodeId] ?? []);
  const enter = phone ? { y: "104%" } : { x: "104%" };

  return (
    <motion.aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="builder-panel-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      initial={reduce ? { opacity: 0 } : enter}
      animate={reduce ? { opacity: 1 } : { x: 0, y: 0 }}
      exit={reduce ? { opacity: 0 } : enter}
      transition={spring}
      className={cn("flex flex-col overflow-hidden border-line bg-panel shadow-float", className)}
      style={style}
    >
      <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", t.tint)}>
          <Icon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="builder-panel-title" ref={headingRef} tabIndex={-1} className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink focus:outline-none">
            {t.title}
          </h2>
          <p className="truncate text-[12.5px] text-ink-3">{t.subtitle}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" className="grid size-9 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-24 sm:pb-0">
        {problems.length > 0 && (
          <div role="alert" className="flex gap-2.5 border-b border-bad/30 bg-bad/8 px-5 py-3 text-[12.5px] text-ink">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" aria-hidden />
            <ul className="min-w-0 space-y-0.5 break-words">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <Form.Provider value={form}>
          <Body nodeId={nodeId} ctx={ctx} />
        </Form.Provider>
      </div>
    </motion.aside>
  );
}

function Body({ nodeId, ctx }: { nodeId: string; ctx: PanelCtx }) {
  if (nodeId === "agent") return <AgentBody ctx={ctx} />;
  if (nodeId === "library") return <LibraryBody ctx={ctx} />;
  if (nodeId === "overflow:mcp" || nodeId === "overflow:skill") return <OverflowBody kind={nodeId === "overflow:mcp" ? "mcp" : "skill"} ctx={ctx} />;
  const ref = parseRef(nodeId);
  const item = ctx.items.find((i) => i.id === nodeId);
  if (!ref || !item) return <p className="p-5 text-[13px] text-ink-3">This component is no longer on the agent.</p>;
  switch (ref.kind) {
    case "llm":
      return <LlmBody ctx={ctx} />;
    case "storage":
      return <StorageBody item={item} ctx={ctx} />;
    case "lastMessages":
      return <LastMessagesBody item={item} ctx={ctx} />;
    case "workingMemory":
      return <WorkingMemoryBody item={item} ctx={ctx} />;
    case "semanticRecall":
      return <SemanticRecallBody item={item} ctx={ctx} />;
    case "observational":
      return <ObservationalBody item={item} ctx={ctx} />;
    case "subconscious":
      return <SubconsciousBody item={item} ctx={ctx} />;
    case "instructions":
      return <InstructionsBody ctx={ctx} />;
    case "soul":
      return <SoulBody item={item} ctx={ctx} />;
    case "workspace":
      return <WorkspaceBody item={item} ctx={ctx} />;
    case "schedule":
      return <ScheduleBody item={item} ctx={ctx} />;
    case "mcp":
      return <McpBody item={item} name={ref.name} ctx={ctx} />;
    case "skill":
      return <SkillBody item={item} slug={ref.slug} ctx={ctx} />;
    case "telegram":
      return <TelegramBody item={item} ctx={ctx} />;
    case "trigger":
      return <TriggerBody item={item} id={ref.id} ctx={ctx} />;
  }
}
