"use client";
import { Trash2 } from "lucide-react";
import { Button, STATUS, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { Callout, NumField, StrField } from "./controls";
import type { PanelCtx } from "./connection";
import { Section, SwitchRow, TextField, useForm } from "./fields";

const machineZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "the machine's";
  }
};

/** The agent itself: who it is, whether it runs, its limits, and what the engine says about it. */
export function AgentBody({ ctx }: { ctx: PanelCtx }) {
  const { config, set } = useForm();
  const enabled = config.enabled !== false;
  const { status, problems } = ctx.live;
  const loadedHash = ctx.runtime?.loadedHash;
  const loadedAt = ctx.runtime?.loadedAt;
  return (
    <>
      {problems.length > 0 && (
        <div className="border-b border-line px-5 py-4">
          <Callout tone={status === "stale" ? "warn" : "bad"} title={status === "stale" ? "The files have problems. The engine keeps running the last good version." : status === "invalid" ? "This agent is not loaded. Fix these problems and apply." : "These problems keep the engine from loading this agent."}>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 break-words">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
      <Section title="Identity">
        <TextField label="Name" path="name" />
        <TextField label="Role" path="role" hint="A short label shown on the canvas, like researcher or planner." />
        <TextField label="Description" path="description" multiline rows={4} hint="What this agent is for, shown in the studio." />
      </Section>
      <Section title="Running">
        <SwitchRow label={enabled ? "Enabled" : "Disabled"} hint="A disabled agent is not loaded and its bot and triggers stop; its folder stays as it is.">
          <Switch label="Enabled" checked={enabled} onChange={(v) => set("enabled", v ? undefined : false)} />
        </SwitchRow>
        <StrField label="Time zone" path="timezone" mono placeholder={machineZone()} hint={`For its triggers, its schedules and the date in its prompt. Empty: this machine's (${machineZone()}).`} />
        <NumField label="Max tool steps per message" path="limits.maxSteps" hint="How many tool calls it may make before it must answer. Default 25, at most 200." />
      </Section>
      <Section title="Engine">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-[13px]">
          <dt className="text-ink-3">Status</dt>
          <dd className={cn("text-ink", status === "invalid" && "text-bad", status === "stale" && "text-warn")}>{enabled ? STATUS[status].label : "Disabled"}</dd>
          <dt className="text-ink-3">Loaded version</dt>
          <dd className="truncate font-mono text-[12px] text-ink-2" title={loadedHash}>
            {loadedHash ? loadedHash.slice(0, 12) : "none"}
            {loadedAt && <span className="ml-2 font-sans text-ink-3">{new Date(loadedAt).toLocaleString()}</span>}
          </dd>
        </dl>
      </Section>
      <Section title="Remove">
        <p className="text-[12.5px] text-ink-3">Moves the whole agent folder (config, keys, memory, skills, sandbox) to the trash. Nothing is erased.</p>
        <div>
          <Button variant="danger" onClick={ctx.trash}>
            <Trash2 size={13} aria-hidden /> Move to trash
          </Button>
        </div>
      </Section>
    </>
  );
}
