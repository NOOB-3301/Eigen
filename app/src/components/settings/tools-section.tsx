"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Plus } from "lucide-react";
import { McpServerForm, type McpServerValue } from "@/components/mcp-form";
import { Section, errorAt, useForm } from "@/components/inspector/fields";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { Callout, useRoot, type Obj } from "./controls";

const hostOf = (v: McpServerValue) => {
  if (typeof v.url === "string") return v.url.replace(/^https?:\/\//, "");
  return [v.command, ...(Array.isArray(v.args) ? v.args : [])].filter((x) => typeof x === "string").join(" ");
};

function freshName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export function ToolsSection() {
  const { config, set, errors } = useForm();
  const { base } = useRoot();
  const servers = (config.mcpServers ?? {}) as Record<string, McpServerValue>;
  const names = Object.keys(servers);
  const saved = Object.keys((base.mcpServers ?? {}) as Obj);
  const [added, setAdded] = useState<string | null>(null);
  const put = (next: Record<string, McpServerValue>) => set("mcpServers", Object.keys(next).length ? next : undefined);

  const add = (kind: "stdio" | "remote") => {
    const name = freshName(kind === "stdio" ? "local-server" : "remote-server", names);
    put({ ...servers, [name]: kind === "stdio" ? { command: "npx", args: ["-y"] } : { url: "https://" } });
    setAdded(name);
  };

  return (
    <Section title="MCP servers" hint="Tool servers every agent can be given. Each agent chooses which of these it uses. Secrets stay in ~/.eigen/.env: write env:NAME as a value.">
      {names.length === 0 && <p className="text-[13px] text-ink-3">No servers yet.</p>}
      <ul className="space-y-2.5">
        <AnimatePresence initial={false}>
          {names.map((n) => (
            <motion.li key={n} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
              <ServerCard
                name={n}
                value={servers[n]!}
                saved={saved.includes(n)}
                initiallyOpen={n === added}
                problem={errorAt(errors, `mcpServers.${n}`)}
                onChange={(v) => put({ ...servers, [n]: v })}
                onRename={
                  saved.includes(n)
                    ? undefined
                    : (to) => {
                        if (!to || Object.hasOwn(servers, to)) return;
                        put(Object.fromEntries(Object.entries(servers).map(([k, v]) => [k === n ? to : k, v])));
                        setAdded(to);
                      }
                }
                onRemove={() => {
                  const rest = { ...servers };
                  delete rest[n];
                  put(rest);
                }}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {saved.length > 0 && <Callout>A saved server cannot be renamed, because agents refer to it by name. Add a new one and remove the old one instead.</Callout>}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => add("stdio")}>
          <Plus size={13} /> Local command
        </Button>
        <Button variant="ghost" onClick={() => add("remote")}>
          <Plus size={13} /> Remote URL
        </Button>
      </div>
    </Section>
  );
}

function ServerCard({ name, value, saved, initiallyOpen, problem, onChange, onRename, onRemove }: { name: string; value: McpServerValue; saved: boolean; initiallyOpen: boolean; problem?: string; onChange: (v: McpServerValue) => void; onRename?: (to: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(initiallyOpen || !!problem);
  const [confirm, setConfirm] = useState(false);
  return (
    <div data-problem={!!problem} className={cn("rounded-xl border bg-panel", problem ? "border-bad/60" : "border-line")}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-accent">
        <ChevronDown size={15} className={cn("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-ink">{name}</span>
            {!saved && <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-3">unsaved</span>}
            {value.enabled === false && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-3">off</span>}
            {value.trusted === true && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">trusted</span>}
          </span>
          <span className="block truncate font-mono text-[12px] text-ink-3">{hostOf(value) || "not configured"}</span>
        </span>
      </button>
      {problem && <p role="alert" className="px-3 pb-2 text-[12px] text-bad">{problem}</p>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="border-t border-line px-4 py-4">
              <McpServerForm name={name} value={value} onChange={onChange} onRename={onRename} onRemove={confirm ? undefined : () => setConfirm(true)} />
              {confirm && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] text-ink-2">Remove {name}?</span>
                  <Button variant="danger" onClick={onRemove}>
                    Remove
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
