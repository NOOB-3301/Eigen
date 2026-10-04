"use client";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CalendarClock, CircleCheck, CircleX, GitPullRequest, LoaderCircle, Trash2 } from "lucide-react";
import { ENV_NAME, TRIGGER_PLACEHOLDERS, TriggerSchema, type GithubCheckResponse, type Trigger, type TriggerInput } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Button, Switch } from "@/components/ui";
import { ChipToggle, SwitchRow, inputCls } from "@/components/builder/panels/fields";
import { Callout } from "@/components/builder/panels/controls";
import { SecretInput } from "@/components/secret-input";
import { CRON_PRESETS, checkCron, isTimezone } from "./cron";
import { FormField } from "./form-field";
import { intervalLabel } from "./format";

/* The trigger form as a pure view: the wrapper in trigger-form.tsx supplies the secret status and the GitHub probe. */

type CronValue = Extract<TriggerInput, { type: "cron" }>;
type GithubValue = Extract<TriggerInput, { type: "github-pr" }>;
type PlaceholderName = (typeof TRIGGER_PLACEHOLDERS)[Trigger["type"]][number];

const MAX_PROMPT = 4000;
const INTERVALS = [60, 300, 900, 3600];

const PLACEHOLDER_HELP: Record<PlaceholderName, string> = {
  now: "The current date and time",
  date: "Today's date",
  time: "The current time",
  event: "What happened, such as opened or updated",
  repo: "The repository, owner/name",
  "pr.number": "The pull request number",
  "pr.title": "The title, written by the author",
  "pr.url": "A link to the pull request",
  "pr.author": "The author's GitHub login",
  "pr.base": "The branch it merges into",
  "pr.head": "The branch it comes from",
  "pr.draft": "true or false",
  "pr.body": "The description, written by the author",
};

/** Errors by field, from the same schema the config is validated with; wording tuned where zod's own is unhelpful. */
function schemaErrors(value: TriggerInput | Trigger): Record<string, string> {
  const out: Record<string, string> = {};
  const r = TriggerSchema.safeParse(value);
  if (r.success) return out;
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? "");
    if (out[key]) continue;
    out[key] =
      key === "prompt" ? (issue.code === "too_big" ? `Keep it under ${MAX_PROMPT.toLocaleString("en-US")} characters` : "Write what the agent should do when this fires")
      : key === "intervalSec" ? "Between 60 and 3,600 seconds (1 to 60 minutes)"
      : key === "events" ? "Pick at least one event"
      : issue.message;
  }
  return out;
}

const noSubscribe = () => () => {};
const EMPTY: string[] = [];
let zones: string[] | undefined;
const zoneList = () => (zones ??= typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : EMPTY);
/** Time zone names for the suggestions list; empty on the server so the first client render matches it. */
const useZones = () => useSyncExternalStore(noSubscribe, zoneList, () => EMPTY);

export type TriggerFormViewProps = {
  /** The agent whose config holds the trigger: the GitHub token is written to its .env. */
  agentId: string;
  value: TriggerInput | Trigger;
  onChange: (next: TriggerInput) => void;
  onRemove?: () => void;
  telegramOn: boolean;
  risky: boolean;
  /** github-pr: whether the token's variable has a value in the agent's .env. */
  tokenSet: boolean;
  onCheckGithub: (tokenEnv: string, repo: string) => Promise<GithubCheckResponse>;
};

export function TriggerFormView({ agentId, value, onChange, onRemove, telegramOn, risky, tokenSet, onCheckGithub }: TriggerFormViewProps) {
  const errors = schemaErrors(value);
  const deliver = value.deliverToTelegram ?? true;
  const github = value.type === "github-pr";
  const Icon = github ? GitPullRequest : CalendarClock;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon size={15} className="shrink-0 text-ink-3" aria-hidden />
        <span className="text-[13px] font-semibold text-ink">{github ? "GitHub pull requests" : "Schedule"}</span>
        <span className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2" title="The id ties the run history to this trigger, so it does not change">
          {value.id}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            Enabled
            <Switch label={`Enable trigger ${value.id}`} checked={value.enabled ?? true} onChange={(enabled) => onChange({ ...value, enabled })} />
          </label>
          {onRemove && (
            <Button variant="quiet" onClick={onRemove} aria-label={`Remove trigger ${value.id}`}>
              <Trash2 size={13} aria-hidden /> Remove
            </Button>
          )}
        </div>
      </div>

      {value.type === "github-pr" && risky && (
        <Callout tone="warn" title="Pull request text is written by other people">
          <p>
            This agent can run commands or use trusted tools, and a pull request&apos;s title, description and comments can contain instructions aimed at it. The engine hands that text to the agent marked as untrusted data, which lowers the risk but does not remove it.
          </p>
          <p className="mt-1.5">To be safer, remove the Workspace tool and any trusted MCP servers from this agent, or keep the prompt read-only: review and summarise, never act.</p>
        </Callout>
      )}

      {value.type === "cron" ? (
        <CronFields value={value} errors={errors} patch={(p) => onChange({ ...value, ...p })} />
      ) : (
        <GithubFields agentId={agentId} value={value} errors={errors} patch={(p) => onChange({ ...value, ...p })} tokenSet={tokenSet} onCheck={onCheckGithub} />
      )}

      <PromptField value={value} error={errors.prompt} onChange={(prompt) => onChange({ ...value, prompt })} />

      <div className="space-y-3">
        <SwitchRow label="Send the reply to Telegram" hint="The agent's final reply goes to this agent's Telegram allow-list. The run history keeps every reply either way.">
          <Switch label="Send the reply to Telegram" checked={deliver} onChange={(deliverToTelegram) => onChange({ ...value, deliverToTelegram })} />
        </SwitchRow>
        {deliver && !telegramOn && (
          <Callout tone="warn" title="This agent has no running Telegram bot">
            Replies will not be delivered. Turn on the agent&apos;s Telegram bot and give it a token to deliver them; until then the reply is only in the run history.
          </Callout>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function CronFields({ value, errors, patch }: { value: CronValue; errors: Record<string, string>; patch: (p: Partial<CronValue>) => void }) {
  const zoneNames = useZones();
  const check = checkCron(value.cron);
  const cronError = check.ok ? undefined : check.error;
  const zone = value.timezone ?? "";
  const zoneError = zone.trim() && !isTimezone(zone.trim()) ? `"${zone.trim()}" is not a time zone` : errors.timezone;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FormField label="Schedule" error={cronError ?? errors.cron} aside={<span className="font-mono">minute hour day month weekday</span>}>
          {(a) => (
            <input
              id={a.id}
              aria-describedby={a.describedBy}
              aria-invalid={a.invalid}
              value={value.cron}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => patch({ cron: e.target.value })}
              className={cn(inputCls(a.invalid), "font-mono text-[13px]")}
            />
          )}
        </FormField>
        {check.ok && (
          <p role="status" className="flex items-center gap-1.5 text-[12.5px] text-ink">
            <CalendarClock size={13} className="shrink-0 text-ink-3" aria-hidden />
            {check.description}
          </p>
        )}
        <div role="group" aria-label="Schedule presets" className="flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((p) => (
            <ChipToggle key={p.cron} on={value.cron.trim() === p.cron} onClick={() => patch({ cron: p.cron })} title={p.cron}>
              {p.label}
            </ChipToggle>
          ))}
        </div>
      </div>
      <FormField label="Time zone" error={zoneError} hint="Optional. A name such as Europe/Stockholm. Empty uses the time zone from Settings.">
        {(a) => (
          <>
            <input
              id={a.id}
              aria-describedby={a.describedBy}
              aria-invalid={a.invalid}
              value={zone}
              list={`${a.id}-zones`}
              placeholder="Settings default"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => patch({ timezone: e.target.value.trim() === "" ? undefined : e.target.value })}
              className={cn(inputCls(a.invalid), "max-w-xs font-mono text-[13px]")}
            />
            <datalist id={`${a.id}-zones`}>
              {zoneNames.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </>
        )}
      </FormField>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const EVENT_LABEL = { opened: ["Opened", "A pull request the poller has not seen before."], updated: ["Updated", "A pull request already seen whose head commit changed."] } as const;

function GithubFields({
  agentId,
  value,
  errors,
  patch,
  tokenSet,
  onCheck,
}: {
  agentId: string;
  value: GithubValue;
  errors: Record<string, string>;
  patch: (p: Partial<GithubValue>) => void;
  tokenSet: boolean;
  onCheck: TriggerFormViewProps["onCheckGithub"];
}) {
  const events = value.events ?? ["opened"];
  const interval = value.intervalSec ?? 300;
  const tokenValid = ENV_NAME.test(value.tokenEnv);
  const placeholderRepo = value.repo === "owner/name";
  return (
    <div className="space-y-4">
      <FormField label="Repository" error={errors.repo ? "Write it as owner/name, for example acme/api" : undefined} hint={placeholderRepo ? "Replace owner/name with the repository to watch." : "The repository whose pull requests are watched."}>
        {(a) => <input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid} value={value.repo} placeholder="owner/name" spellCheck={false} autoCapitalize="off" onChange={(e) => patch({ repo: e.target.value.trim() })} className={cn(inputCls(a.invalid), "font-mono text-[13px]")} />}
      </FormField>

      <div className="space-y-2">
        <FormField label="Token variable" error={errors.tokenEnv ? "Upper-case name such as GITHUB_TOKEN" : undefined} hint="The name of the line in this agent's .env that holds a GitHub token. It needs read access to the repository's pull requests.">
          {(a) => <input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid} value={value.tokenEnv} placeholder="GITHUB_TOKEN" spellCheck={false} autoCapitalize="characters" onChange={(e) => patch({ tokenEnv: e.target.value.toUpperCase().replace(/\s+/g, "") })} className={cn(inputCls(a.invalid), "max-w-xs font-mono text-[13px]")} />}
        </FormField>
        {tokenValid && <SecretInput agentId={agentId} name={value.tokenEnv} set={tokenSet} label="GitHub token" />}
        <GithubCheck key={`${value.tokenEnv}|${value.repo}`} ready={tokenValid && !errors.repo && tokenSet} reason={!tokenValid ? "Name the token variable first." : errors.repo ? "Enter a valid repository first." : "Set the token first."} onCheck={() => onCheck(value.tokenEnv, value.repo)} />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-[12.5px] font-medium text-ink-2">Fire on</legend>
        <div className="space-y-2">
          {(["opened", "updated"] as const).map((ev) => {
            const on = events.includes(ev);
            return (
              <label key={ev} className="flex items-start gap-2.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={on}
                  // At least one event must stay on, or the trigger could never fire.
                  disabled={on && events.length === 1}
                  onChange={() => patch({ events: on ? events.filter((e) => e !== ev) : [...events, ev] })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                />
                <span>
                  {EVENT_LABEL[ev][0]}
                  <span className="block text-[12px] text-ink-3">{EVENT_LABEL[ev][1]}</span>
                </span>
              </label>
            );
          })}
        </div>
        {errors.events ? (
          <p role="alert" className="mt-1.5 text-[12px] text-bad">
            {errors.events}
          </p>
        ) : (
          <p className="mt-1.5 text-[12px] text-ink-3">At least one event stays on.</p>
        )}
      </fieldset>

      <FormField label="Poll every" error={errors.intervalSec} hint="One request to GitHub per poll. The first poll only records the pull requests that are already open.">
        {(a) => (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <IntervalInput id={a.id} describedBy={a.describedBy} invalid={a.invalid} value={interval} onChange={(intervalSec) => patch({ intervalSec })} />
              <span className="text-[12.5px] text-ink-3">seconds{!a.invalid && ` = ${intervalLabel(interval)}`}</span>
            </div>
            <div role="group" aria-label="Poll interval presets" className="flex flex-wrap gap-1.5">
              {INTERVALS.map((s) => (
                <ChipToggle key={s} on={interval === s} onClick={() => patch({ intervalSec: s })}>
                  {intervalLabel(s)}
                </ChipToggle>
              ))}
            </div>
          </div>
        )}
      </FormField>

      <SwitchRow label="Include draft pull requests" hint="Off: a draft is ignored until it is marked ready.">
        <Switch label="Include draft pull requests" checked={value.includeDrafts ?? false} onChange={(includeDrafts) => patch({ includeDrafts })} />
      </SwitchRow>
    </div>
  );
}

/** Keeps what is typed (including an empty box) and only reports whole numbers, so clearing the field does not snap to a value. */
function IntervalInput({ id, describedBy, invalid, value, onChange }: { id: string; describedBy?: string; invalid: boolean; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={60}
      max={3600}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (/^\d+$/.test(e.target.value)) onChange(Number(e.target.value));
      }}
      onBlur={() => setText(String(value))}
      className={cn(inputCls(invalid), "w-28 font-mono tabular-nums")}
    />
  );
}

/** "Check access": asks the engine whether the token can read the repository's pull requests. Remounts (and so forgets the answer) when either input changes. */
function GithubCheck({ ready, reason, onCheck }: { ready: boolean; reason: string; onCheck: () => Promise<GithubCheckResponse> }) {
  const [state, setState] = useState<{ busy: boolean; result?: GithubCheckResponse }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    const result = await onCheck().catch((e: unknown): GithubCheckResponse => ({ ok: false, error: e instanceof Error ? e.message : "the request failed" }));
    setState({ busy: false, result });
  };
  const r = state.result;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Button variant="ghost" disabled={!ready || state.busy} onClick={() => void run()} title={ready ? undefined : reason}>
        {state.busy && <LoaderCircle size={13} className="animate-spin" aria-hidden />} Check access
      </Button>
      {!ready && <span className="text-[12px] text-ink-3">{reason}</span>}
      <p role="status" className="min-w-0 basis-full text-[12.5px] empty:hidden sm:basis-0 sm:flex-1">
        {r?.ok && (
          <span className="flex items-start gap-1.5 text-ok">
            <CircleCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {r.login ? `Signed in as ${r.login}. ` : ""}
              {r.openPulls === undefined ? "The repository is readable." : `${r.openPulls} open pull request${r.openPulls === 1 ? "" : "s"} right now.`}
            </span>
          </span>
        )}
        {r && !r.ok && (
          <span className="flex items-start gap-1.5 text-bad">
            <CircleX size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>{r.error ?? "GitHub did not accept this token for that repository."}</span>
          </span>
        )}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

function PromptField({ value, error, onChange }: { value: TriggerInput | Trigger; error?: string; onChange: (prompt: string) => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const names: readonly string[] = TRIGGER_PLACEHOLDERS[value.type];
  const unknown = [...new Set([...value.prompt.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !names.includes(n)))];

  // Put the caret after the inserted placeholder once the new text is in the box.
  useLayoutEffect(() => {
    if (caret.current === null || !ta.current) return;
    ta.current.focus();
    ta.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const insert = (name: string) => {
    const el = ta.current;
    const from = el?.selectionStart ?? value.prompt.length;
    const to = el?.selectionEnd ?? value.prompt.length;
    const token = `{{${name}}}`;
    caret.current = from + token.length;
    onChange(value.prompt.slice(0, from) + token + value.prompt.slice(to));
  };

  return (
    <FormField
      label="Prompt"
      error={error}
      aside={<span className={cn("tabular-nums", value.prompt.length > MAX_PROMPT && "text-bad")}>{value.prompt.length.toLocaleString("en-US")} / {MAX_PROMPT.toLocaleString("en-US")}</span>}
      hint={value.type === "github-pr" ? "Written as an instruction to the agent. Placeholders are filled in from the pull request, which reaches the agent as untrusted data." : "Written as an instruction to the agent. Placeholders are filled in when it fires."}
    >
      {(a) => (
        <div className="space-y-2">
          <textarea
            ref={ta}
            id={a.id}
            aria-describedby={a.describedBy}
            aria-invalid={a.invalid}
            rows={5}
            value={value.prompt}
            onChange={(e) => onChange(e.target.value)}
            className={cn(inputCls(a.invalid), "resize-y leading-relaxed")}
          />
          <div role="group" aria-label="Insert a placeholder at the cursor" className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-ink-3">Insert</span>
            {TRIGGER_PLACEHOLDERS[value.type].map((n) => (
              <PlaceholderChip key={n} name={n} onClick={() => insert(n)} />
            ))}
          </div>
          {unknown.length > 0 && (
            <p className="text-[12px] text-warn">
              {unknown.map((n) => `{{${n}}}`).join(", ")} {unknown.length === 1 ? "is" : "are"} not {unknown.length === 1 ? "a placeholder" : "placeholders"} for this kind of trigger.
            </p>
          )}
        </div>
      )}
    </FormField>
  );
}

function PlaceholderChip({ name, onClick }: { name: PlaceholderName; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={PLACEHOLDER_HELP[name]} className="inline-flex h-7 items-center rounded-full border border-line px-2.5 font-mono text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:bg-raised hover:text-ink">
      {`{{${name}}}`}
    </button>
  );
}
