"use client";
import { useState } from "react";
import { Loader2, Settings as SettingsIcon } from "lucide-react";
import { ENV_NAME, type AgentRuntime, type ResolvedAgent, type TelegramCheckResponse } from "@eigen/engine/schema";
import type { RootInfo } from "@/lib/types";
import { cn } from "@/lib/cn";
import { checkTelegram } from "@/lib/client/probes";
import { useSecrets } from "@/lib/client/secrets";
import { Button, Switch } from "@/components/ui";
import { SecretInput } from "@/components/secret-input";
import type { SettingsSection } from "@/components/settings/settings-dialog";
import { suggestTokenEnv, telegramView, TelegramStateChip } from "@/components/canvas/telegram-state";
import { Field, Provenance, Section, SwitchRow, getPath, inputCls, useForm } from "./fields";

type Props = {
  id: string;
  runtime?: AgentRuntime;
  /** What the engine last resolved for this agent (null while the file is invalid). Supplies the root allow-list an agent inherits. */
  resolved?: ResolvedAgent | null;
  root?: RootInfo;
  engineOnline: boolean;
  openSettings: (section: SettingsSection) => void;
};

const tokens = (text: string) => text.split(/[\s,]+/).filter(Boolean);
/** Digits become user ids; anything else stays text so the schema flags it and Save is blocked, instead of silently dropping it. */
const parseIds = (text: string): Array<number | string> => tokens(text).map((t) => (/^\d+$/.test(t) ? Number(t) : t));

export function TelegramSection(props: Props) {
  const { config } = useForm();
  const primary = getPath(config, "primary") === true;
  return primary ? <PrimaryBot {...props} /> : <OwnBot {...props} />;
}

/* ---------------------------------------------------------------------------------------------- */

function PrimaryBot({ runtime, engineOnline, openSettings }: Props) {
  const { config, set } = useForm();
  const view = telegramView(runtime?.telegram, { enabled: true, engineOffline: !engineOnline });
  const own = ["telegram.enabled", "telegram.tokenEnv", "telegram.allowedUserIds"].filter((p) => getPath(config, p) !== undefined);
  return (
    <Section title="Telegram" hint="The primary answers on the root bot, so you talk to the whole team in one chat.">
      <div className="flex flex-wrap items-center gap-2">
        <TelegramStateChip view={view} />
        <Button onClick={() => openSettings("telegram")} className="ml-auto">
          <SettingsIcon size={13} /> Telegram settings
        </Button>
      </div>
      <p className="text-[12.5px] text-ink-3">It uses the root bot. Its token and the allowed users are edited in Settings, for every agent at once.</p>
      {runtime?.telegram?.restartRequired && (
        <p role="status" className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
          The token or allowed users of the root bot changed. Restart the engine to apply them; the primary connects its bot once, at start.
        </p>
      )}
      {own.length > 0 && (
        <div className="rounded-lg border border-dashed border-line-strong px-3 py-2 text-[12.5px] text-ink-2">
          This file sets Telegram options of its own ({own.map((p) => p.replace("telegram.", "")).join(", ")}). They are ignored for the primary.
          <button type="button" className="ml-2 font-medium text-accent hover:underline" onClick={() => own.forEach((p) => set(p, undefined))}>
            Remove them
          </button>
        </div>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function OwnBot({ id, runtime, resolved, root, engineOnline }: Props) {
  const { config, set } = useForm();
  const enabled = getPath(config, "telegram.enabled") === true;
  const tokenEnv = (getPath(config, "telegram.tokenEnv") as string | undefined) ?? "";
  const valid = ENV_NAME.test(tokenEnv);
  const { isSet } = useSecrets(valid ? [tokenEnv] : []);
  // Turned on in the draft but not in the saved file: the engine cannot know about it yet.
  const unsaved = enabled && resolved?.telegram.enabled !== true;
  const view = unsaved ? { tone: "off" as const, label: "Not started", detail: "Save to start this bot." } : telegramView(runtime?.telegram, { enabled, engineOffline: !engineOnline });

  return (
    <Section title="Telegram" hint="Chat with this agent in its own Telegram chat. One bot token serves one agent.">
      <SwitchRow label="Give it its own bot" hint="Create the bot with @BotFather, then paste its token below.">
        <Switch
          label="Own Telegram bot"
          checked={enabled}
          onChange={(v) => {
            set("telegram.enabled", v ? true : undefined);
            if (v && !tokenEnv) set("telegram.tokenEnv", suggestTokenEnv(id));
          }}
        />
      </SwitchRow>
      {enabled && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <TelegramStateChip view={view} />
            {unsaved && <span className="text-[12px] text-ink-3">Save to start this bot.</span>}
          </div>
          {runtime?.telegram?.state === "error" && runtime.telegram.error && (
            <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
              {runtime.telegram.error}
            </p>
          )}
          <Field label="Token variable" path="telegram.tokenEnv" hint="The name of the line in ~/.eigen/.env that holds this bot's token. The token itself never goes in the config.">
            {({ id: fid, describedBy, invalid }) => (
              <input
                id={fid}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={tokenEnv}
                spellCheck={false}
                autoCapitalize="characters"
                placeholder={suggestTokenEnv(id)}
                onChange={(e) => set("telegram.tokenEnv", e.target.value.toUpperCase().replace(/\s+/g, "") || undefined)}
                className={cn(inputCls(invalid), "font-mono text-[13px]")}
              />
            )}
          </Field>
          {valid && <SecretInput name={tokenEnv} set={isSet(tokenEnv)} label="Bot token" />}
          <CheckToken tokenEnv={valid ? tokenEnv : ""} />
          <AllowedUsers root={root} resolved={resolved} />
        </>
      )}
    </Section>
  );
}

function CheckToken({ tokenEnv }: { tokenEnv: string }) {
  const [state, setState] = useState<{ busy: boolean; env?: string; res?: TelegramCheckResponse }>({ busy: false });
  const shown = state.env === tokenEnv ? state.res : undefined;
  const run = async () => {
    setState({ busy: true, env: tokenEnv });
    const res = await checkTelegram(tokenEnv);
    setState({ busy: false, env: tokenEnv, res });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => void run()} disabled={!tokenEnv || state.busy}>
        {state.busy && <Loader2 size={13} className="animate-spin" />} Check token
      </Button>
      <span role="status" className={cn("min-w-0 text-[12.5px]", shown?.ok ? "text-ok" : shown ? "text-bad" : "text-ink-3")}>
        {state.busy ? "Asking Telegram…" : shown ? (shown.ok ? `It works: @${shown.username ?? "bot"}` : (shown.error ?? "Telegram did not accept it.")) : "Checks the token saved in .env, not unsaved edits."}
      </span>
    </div>
  );
}

function AllowedUsers({ root, resolved }: { root?: RootInfo; resolved?: ResolvedAgent | null }) {
  const { config, set } = useForm();
  const users = getPath(config, "telegram.allowedUserIds") as Array<number | string> | undefined;
  // What the agent inherits: the server's root info when it reports it, else what the engine resolved while the file did not override it.
  const inherited = root?.telegram?.allowedUserIds ?? (resolved && resolved.provenance["telegram.allowedUserIds"] === "root" ? resolved.telegram.allowedUserIds : undefined);

  const joined = (users ?? []).join(", ");
  const [text, setText] = useState(joined);
  // Re-sync when the draft changes from elsewhere (JSON tab, discard), without clobbering what is being typed.
  const [prevJoined, setPrevJoined] = useState(joined);
  if (joined !== prevJoined) {
    setPrevJoined(joined);
    if (parseIds(text).join(", ") !== joined) setText(joined);
  }

  return (
    <Field
      label="Who may talk to this bot"
      path="telegram.allowedUserIds"
      hint="Telegram user ids (numbers). Get yours from @userinfobot."
      aside={
        <Provenance
          overridden={users !== undefined}
          inheritedLabel={inherited?.length ? inherited.join(", ") : "the root list"}
          onOverride={() => set("telegram.allowedUserIds", inherited ?? [])}
          onReset={() => set("telegram.allowedUserIds", undefined)}
        />
      }
    >
      {({ id: fid, describedBy, invalid }) =>
        users === undefined ? (
          <div id={fid} className="font-mono text-[13px] text-ink-3 tabular-nums">
            {inherited === undefined ? "The allow-list in root config.json" : inherited.length ? inherited.join(", ") : "Nobody yet: add ids in Settings, or override here"}
          </div>
        ) : (
          <input
            id={fid}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            inputMode="numeric"
            value={text}
            spellCheck={false}
            placeholder="123456789, 987654321"
            onChange={(e) => {
              setText(e.target.value);
              set("telegram.allowedUserIds", parseIds(e.target.value));
            }}
            className={cn(inputCls(invalid), "font-mono text-[13px] tabular-nums")}
          />
        )
      }
    </Field>
  );
}
