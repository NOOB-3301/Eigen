"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ENV_NAME, type TelegramCheckResponse, type TriggerInput } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { checkTelegram } from "@/lib/client/probes";
import { Button } from "@/components/ui";
import { TelegramStateChip, telegramView } from "@/components/canvas/telegram-state";
import { TriggerForm } from "@/components/editors/trigger-form";
import { TriggerRuns } from "@/components/editors/trigger-runs";
import { BLURB } from "../kinds";
import { liveLine } from "../live";
import { eff, isRisky, readAgent, updateTrigger, type Item } from "../model";
import { Connection, type PanelCtx } from "./connection";
import { Field, Section, getPath, inputCls, useForm } from "./fields";
import { KeyField } from "./key-field";

const tokens = (text: string) => text.split(/[\s,]+/).filter(Boolean);
/** Digits become user ids; anything else stays text so the schema flags it and Apply is blocked, instead of silently dropping it. */
const parseIds = (text: string): Array<number | string> => tokens(text).map((t) => (/^\d+$/.test(t) ? Number(t) : t));

export function TelegramBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const { config } = useForm();
  const tokenEnv = String(eff(config, "telegram.tokenEnv"));
  // Turned on in the draft but not in what the engine runs: it cannot know about it yet.
  const unapplied = item.connected && !ctx.live.appliedTelegram;
  const view = unapplied ? { tone: "off" as const, label: "Not started", detail: "Apply to start this bot." } : telegramView(ctx.live.telegram, { enabled: item.connected, engineOffline: !ctx.engineOnline });
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.telegram}. Create the bot with @BotFather; one bot token serves exactly one agent.`} />
      <Section title="Bot" hint="Only the people listed below can talk to it. The token is kept in this agent's .env.">
        <div className="flex flex-wrap items-center gap-2">
          <TelegramStateChip view={view} />
          {unapplied && <span className="text-[12px] text-ink-3">Apply to start this bot.</span>}
        </div>
        {ctx.live.telegram?.state === "error" && ctx.live.telegram.error && (
          <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] break-words text-bad">
            {ctx.live.telegram.error}
          </p>
        )}
        <AllowedUsers />
        <KeyField agentId={ctx.agentId} path="telegram.tokenEnv" label="Token variable" effective={tokenEnv} secretLabel="Bot token" hint="The name of the line in this agent's .env that holds the bot token. Default TELEGRAM_BOT_TOKEN." />
        <CheckToken agentId={ctx.agentId} tokenEnv={ENV_NAME.test(tokenEnv) ? tokenEnv : ""} />
      </Section>
    </>
  );
}

function CheckToken({ agentId, tokenEnv }: { agentId: string; tokenEnv: string }) {
  const [state, setState] = useState<{ busy: boolean; env?: string; res?: TelegramCheckResponse }>({ busy: false });
  const shown = state.env === tokenEnv ? state.res : undefined;
  const run = async () => {
    setState({ busy: true, env: tokenEnv });
    setState({ busy: false, env: tokenEnv, res: await checkTelegram(agentId, tokenEnv) });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => void run()} disabled={!tokenEnv || state.busy}>
        {state.busy && <Loader2 size={13} className="animate-spin" />} Check token
      </Button>
      <span role="status" className={cn("min-w-0 text-[12.5px] break-words", shown?.ok ? "text-ok" : shown ? "text-bad" : "text-ink-3")}>
        {state.busy ? "Asking Telegram…" : shown ? (shown.ok ? `It works: @${shown.username ?? "bot"}` : (shown.error ?? "Telegram did not accept it.")) : "Asks Telegram with the token saved in this agent's .env."}
      </span>
    </div>
  );
}

function AllowedUsers() {
  const { config, set } = useForm();
  const users = (getPath(config, "telegram.allowedUserIds") as Array<number | string> | undefined) ?? [];
  const joined = users.join(", ");
  const [text, setText] = useState(joined);
  // Re-sync when the draft changes from elsewhere (discard, a reload), without clobbering what is being typed.
  const [prevJoined, setPrevJoined] = useState(joined);
  if (joined !== prevJoined) {
    setPrevJoined(joined);
    if (parseIds(text).join(", ") !== joined) setText(joined);
  }
  return (
    <Field label="Who may talk to this bot" path="telegram.allowedUserIds" hint="Telegram user ids (numbers), required: without one the bot would answer anyone. Get yours from @userinfobot. The studio chat shares memory with the first one.">
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          inputMode="numeric"
          value={text}
          spellCheck={false}
          placeholder="123456789, 987654321"
          onChange={(e) => {
            setText(e.target.value);
            const ids = parseIds(e.target.value);
            set("telegram.allowedUserIds", ids.length ? ids : undefined);
          }}
          className={cn(inputCls(invalid), "font-mono text-[13px] tabular-nums")}
        />
      )}
    </Field>
  );
}

export function TriggerBody({ item, id, ctx }: { item: Item; id: string; ctx: PanelCtx }) {
  const value = (Array.isArray(ctx.draft.config.triggers) ? (ctx.draft.config.triggers as TriggerInput[]) : []).find((t) => t.id === id);
  const line = liveLine(item, ctx.live);
  if (!value) return <p className="p-5 text-[13px] text-ink-3">This trigger is no longer on the agent.</p>;
  return (
    <>
      <section className="border-b border-line px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink-2">A trigger wakes {ctx.agentName} on its own and hands it the prompt below. Switching it off keeps it here; deleting removes it.</p>
        {line && <p className={cn("mt-2 text-[12.5px]", line.tone === "bad" ? "text-bad" : line.tone === "warn" ? "text-warn" : "text-ink-3")}>{line.text}</p>}
      </section>
      <Section title="Trigger">
        <TriggerForm agentId={ctx.agentId} value={value} onChange={(next) => ctx.update((d) => updateTrigger(d, id, next))} onRemove={() => ctx.removeTrigger(id)} telegramOn={readAgent(ctx.draft.config).telegram} risky={isRisky(ctx.draft.config)} />
      </Section>
      <Section title="Runs">
        <TriggerRuns agentId={ctx.agentId} triggerId={id} />
      </Section>
    </>
  );
}
