"use client";
import { useState } from "react";
import { CalendarClock, ChevronRight, CircleCheck, CircleX, GitPullRequest, LoaderCircle, Play, Send } from "lucide-react";
import type { Trigger, TriggerRun, TriggerRuntime, TriggerState } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Button, Skeleton } from "@/components/ui";
import { Callout } from "@/components/settings/controls";
import { absoluteTime, clip, duration, relativeTime } from "./format";

/* The run history as a pure view: the wrapper in trigger-runs.tsx supplies the runs, the agent's triggers and the clock. */

/** The studio caps a reply at 8,000 characters before it gets here; this is only a guard so a huge one could never freeze the page. */
const MAX_SHOWN = 10_000;

export type TriggerRow = { id: string; type: Trigger["type"]; runtime?: TriggerRuntime };

export type TriggerRunsViewProps = {
  /** Newest first, already limited to the trigger in focus. */
  runs: TriggerRun[];
  loading: boolean;
  /** The agent's saved triggers (just the one in focus when there is one). */
  triggers: TriggerRow[];
  /** The trigger the panel is about is not in the saved config yet, so it cannot run and has no history. */
  unsaved: boolean;
  /** The studio cannot reach the engine, which keeps the run log and does the running. */
  engineOffline: boolean;
  /** Ids whose "Run now" is in flight from this panel. */
  running: ReadonlySet<string>;
  onRun: (triggerId: string) => void;
  now: number;
};

const STATE: Record<TriggerState, { label: string; tone: string }> = {
  idle: { label: "Waiting", tone: "text-ink-2" },
  running: { label: "Running", tone: "text-accent" },
  error: { label: "Failing", tone: "text-bad" },
  disabled: { label: "Disabled", tone: "text-ink-3" },
  "missing-token": { label: "Token not set", tone: "text-warn" },
};

const KIND_ICON = { cron: CalendarClock, "github-pr": GitPullRequest } as const;

export function TriggerRunsView({ runs, loading, triggers, unsaved, engineOffline, running, onRun, now }: TriggerRunsViewProps) {
  const busy = running.size > 0 || runs.some((r) => r.status === "running");
  return (
    <div className="space-y-3">
      {engineOffline && <Callout title="The engine is not running">Run history lives in the engine, and it does the running, so there is nothing to list and Run now is off. Start the engine and this fills in.</Callout>}
      {unsaved && <Callout title="Not saved yet">This trigger is not in the agent&apos;s saved config, so it cannot run and has no history. Save the agent first.</Callout>}

      {triggers.length > 0 && (
        <ul className="space-y-2" aria-label="Triggers">
          {triggers.map((t) => (
            <TriggerLine key={t.id} trigger={t} busy={running.has(t.id)} offline={engineOffline} onRun={() => onRun(t.id)} now={now} />
          ))}
        </ul>
      )}
      {busy && (
        <p role="status" className="text-[12px] text-ink-3">
          A run takes as long as the agent does, sometimes minutes. You can keep working; the result appears below.
        </p>
      )}

      {loading && runs.length === 0 && (
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[62px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {!loading && !engineOffline && runs.length === 0 && <EmptyRuns triggers={triggers} />}

      {runs.length > 0 && (
        <ol aria-label="Runs, newest first" className="space-y-2">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} showTrigger={triggers.length !== 1} now={now} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TriggerLine({ trigger, busy, offline, onRun, now }: { trigger: TriggerRow; busy: boolean; offline: boolean; onRun: () => void; now: number }) {
  const Icon = KIND_ICON[trigger.type];
  const rt = trigger.runtime;
  const state = rt ? STATE[rt.state] : undefined;
  // The engine can be mid-run on its own schedule; a second run on top of it would only queue behind it.
  const working = busy || rt?.state === "running";
  return (
    <li className="rounded-xl border border-line bg-panel px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon size={14} className="shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{trigger.id}</span>
        {state && <span className={cn("text-[12px]", state.tone)}>{state.label}</span>}
        {rt?.nextRunAt && rt.state === "idle" && (
          <span className="text-[12px] text-ink-3" title={absoluteTime(rt.nextRunAt)} suppressHydrationWarning>
            next run {relativeTime(rt.nextRunAt, now)}
          </span>
        )}
        <Button variant="ghost" className="ml-auto" disabled={working || offline} aria-busy={working} onClick={onRun} aria-label={`Run ${trigger.id} now`} title={offline ? "The engine is not running" : undefined}>
          {working ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Play size={12} aria-hidden />} {working ? "Running…" : "Run now"}
        </Button>
      </div>
      {rt?.error && (
        <p className="mt-1.5 line-clamp-2 text-[12px] text-bad" title={rt.error}>
          {rt.error}
        </p>
      )}
    </li>
  );
}

function EmptyRuns({ triggers }: { triggers: TriggerRow[] }) {
  const cron = triggers.some((t) => t.type === "cron");
  const github = triggers.some((t) => t.type === "github-pr");
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-4 py-7 text-center">
      <CalendarClock size={20} className="mx-auto text-ink-3" aria-hidden />
      <p className="mt-2 text-[13px] font-medium text-ink">No runs yet</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] text-ink-3">
        {triggers.length === 0 || (cron && github)
          ? "A schedule fires at its next time, and a GitHub trigger fires when it sees a new pull request."
          : cron
            ? "A schedule fires at its next time."
            : "A GitHub trigger fires when it sees a new pull request. The first poll only records the ones already open."}{" "}
        {triggers.length > 0 ? "Each run, with the agent's reply, is listed here. Use Run now to try the prompt right away." : "Each run, with the agent's reply, will be listed here."}
      </p>
    </div>
  );
}

const STATUS = {
  running: { label: "Running", icon: LoaderCircle, tone: "border-accent/50 bg-accent-soft text-accent", spin: true },
  ok: { label: "OK", icon: CircleCheck, tone: "border-ok/40 bg-ok/10 text-ok", spin: false },
  error: { label: "Error", icon: CircleX, tone: "border-bad/40 bg-bad/10 text-bad", spin: false },
} as const;

function deliveryText(run: TriggerRun) {
  if (run.delivered === true) return { text: "Sent to Telegram", tone: "text-ink-3" };
  if (run.delivered === false) return { text: run.deliveryError ? `Not delivered to Telegram: ${run.deliveryError}` : "Not delivered to Telegram", tone: "text-warn" };
  return run.status === "running" ? undefined : { text: "Not sent to Telegram", tone: "text-ink-3" };
}

function RunRow({ run, showTrigger, now }: { run: TriggerRun; showTrigger: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const s = STATUS[run.status];
  const Icon = s.icon;
  const detail = run.reply || run.error;
  const took = duration(run.startedAt, run.finishedAt);
  const delivery = deliveryText(run);
  const reply = clip(run.reply ?? "", MAX_SHOWN);
  const error = clip(run.error ?? "", MAX_SHOWN);
  const head = (
    <>
      <span className="flex items-center gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium", s.tone)}>
          <Icon size={12} className={cn(s.spin && "animate-spin")} aria-hidden />
          {s.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={run.subject}>
          {run.subject}
        </span>
        <time dateTime={run.startedAt} title={absoluteTime(run.startedAt)} className="shrink-0 text-[12px] text-ink-3" suppressHydrationWarning>
          {relativeTime(run.startedAt, now)}
        </time>
        {detail && <ChevronRight size={14} aria-hidden className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-3">
        {showTrigger && <span className="font-mono">{run.triggerId}</span>}
        {took && <span>took {took}</span>}
        {delivery && (
          <span className={cn("inline-flex items-center gap-1", delivery.tone)}>
            <Send size={11} aria-hidden /> {delivery.text}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li className="rounded-xl border border-line bg-panel">
      {detail ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="w-full rounded-xl px-3.5 py-3 text-left transition-colors hover:bg-raised">
          {head}
        </button>
      ) : (
        <div className="px-3.5 py-3">{head}</div>
      )}
      {open && detail && (
        <div className="space-y-3 border-t border-line px-3.5 py-3">
          {run.error && <Block label="Error" tone="bad" text={error.text} hidden={error.hidden} />}
          {run.reply && <Block label="Reply" text={reply.text} hidden={reply.hidden} />}
        </div>
      )}
    </li>
  );
}

function Block({ label, text, hidden, tone }: { label: string; text: string; hidden: number; tone?: "bad" }) {
  return (
    <div>
      <div className={cn("mb-1 text-[11.5px] font-medium", tone === "bad" ? "text-bad" : "text-ink-3")}>{label}</div>
      <pre tabIndex={0} aria-label={label} className={cn("max-h-72 overflow-auto rounded-lg bg-sunken p-3 font-mono text-[12px] leading-[1.55] break-words whitespace-pre-wrap", tone === "bad" ? "text-bad" : "text-ink")}>
        {text}
      </pre>
      {hidden > 0 && <p className="mt-1 text-[11.5px] text-ink-3">{hidden.toLocaleString("en-US")} more characters are not shown.</p>}
    </div>
  );
}
