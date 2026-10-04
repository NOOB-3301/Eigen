"use client";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, Blocks, ChevronRight, Crown, Plus } from "lucide-react";
import type { FleetResponse } from "@/lib/types";
import { Monogram, STATUS, StatusDot, spring } from "@/components/ui";
import { TelegramStateChip, telegramView } from "@/components/canvas/telegram-state";

/** Phone layout: the canvas is too cramped below 640px, so the team is a list (primary first). */
export function AgentList({ fleet, onOpen, onBuild, onCreate }: { fleet: FleetResponse; onOpen: (id: string) => void; onBuild: (id: string) => void; onCreate: () => void }) {
  const agents = [...fleet.agents].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  return (
    <div className="h-full overflow-y-auto px-4 pt-[76px] pb-8">
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {agents.map((a) => (
            <motion.li key={a.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -24 }} transition={spring} className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => onOpen(a.id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-panel p-3 text-left shadow-float active:scale-[0.99]"
              >
                <Monogram id={a.id} name={a.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14.5px] font-semibold text-ink">{a.name}</span>
                    {a.primary && <Crown size={13} className="text-crown" aria-label="primary" />}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-2">
                    <span className="truncate">{a.role}</span>
                    <span className="font-mono text-[11.5px] text-ink-3">{a.modelKey}</span>
                  </span>
                  {a.telegram.enabled && <TelegramStateChip view={telegramView(a.runtime.telegram, { enabled: true, engineOffline: fleet.engine === "offline" })} className="mt-1" />}
                  {a.runtime.problems.length > 0 && (
                    <span className="mt-1 flex items-center gap-1 text-[12px] text-bad">
                      <AlertTriangle size={11} /> {a.runtime.problems[0]}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2" title={STATUS[a.runtime.status].label}>
                  <StatusDot status={a.runtime.status} />
                  <ChevronRight size={16} className="text-ink-3" />
                </span>
              </button>
              <button
                type="button"
                onClick={() => onBuild(a.id)}
                aria-label={`Open the builder for ${a.name}`}
                className="grid w-12 shrink-0 place-items-center rounded-xl border border-line bg-panel text-ink-2 shadow-float active:scale-[0.97]"
              >
                <Blocks size={17} />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <button type="button" onClick={onCreate} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong p-3 text-[13px] text-ink-2">
        <Plus size={14} /> New agent
      </button>
    </div>
  );
}
