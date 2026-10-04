"use client";
import { useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { Field, Section, getPath, inputCls, useForm } from "@/components/inspector/fields";
import { SecretInput } from "@/components/secret-input";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { checkTelegram } from "@/lib/client/probes";
import { useSecrets } from "@/lib/client/secrets";
import { Callout, ListField, useRoot } from "./controls";

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;

export function TelegramSection() {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const raw = getPath(config, "telegram.tokenEnv");
  const tokenEnv = typeof raw === "string" && raw ? raw : defaults.telegram.tokenEnv;
  const valid = ENV.test(tokenEnv);
  const { isSet } = useSecrets(valid ? [tokenEnv] : []);
  const [check, setCheck] = useState<{ state: "idle" | "running" | "ok" | "fail"; text?: string }>({ state: "idle" });
  const ids = getPath(config, "telegram.allowedUserIds");
  const noUsers = !Array.isArray(ids) || ids.length === 0;

  const run = async () => {
    setCheck({ state: "running" });
    const r = await checkTelegram(tokenEnv);
    setCheck(r.ok ? { state: "ok", text: r.username ? `@${r.username}` : "token accepted" } : { state: "fail", text: r.error ?? "failed" });
  };

  return (
    <>
      <Section title="Root bot" hint="The bot the primary agent answers on. Create one with @BotFather on Telegram and paste its token below. Agents can also have bots of their own (set in each agent).">
        <Field label="Token variable" path="telegram.tokenEnv" hint={`The .env variable that holds the token. Default ${defaults.telegram.tokenEnv}.`}>
          {({ id, describedBy, invalid }) => (
            <input id={id} aria-describedby={describedBy} aria-invalid={invalid} spellCheck={false} placeholder={defaults.telegram.tokenEnv} value={typeof raw === "string" ? raw : ""} onChange={(e) => set("telegram.tokenEnv", e.target.value.trim() || undefined)} className={cn(inputCls(invalid), "max-w-sm font-mono text-[13px]")} />
          )}
        </Field>
        {valid ? <SecretInput name={tokenEnv} set={isSet(tokenEnv)} label={tokenEnv} /> : <Callout tone="warn">Use an upper-case name such as TELEGRAM_BOT_TOKEN to set the token from here.</Callout>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={run} disabled={!valid || check.state === "running"}>
            {check.state === "running" ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />} Check token
          </Button>
          {check.state === "ok" && (
            <span role="status" className="text-[13px] text-ok">
              Works: <span className="font-mono">{check.text}</span>
            </span>
          )}
          {check.state === "fail" && (
            <span role="alert" className="text-[13px] text-bad">
              {check.text}
            </span>
          )}
        </div>
        <Callout>The root bot reads its token and allow-list once, when the engine starts. After changing them here, restart the engine.</Callout>
      </Section>
      <Section title="Who may talk to it" hint="Message @userinfobot on Telegram to get your numeric id.">
        <ListField label="Allowed Telegram user ids" path="telegram.allowedUserIds" int placeholder={"123456789"} hint="One id per line. Agents with their own bot inherit this list unless they set one." />
        {noUsers && <Callout tone="warn" title="The list is empty">Eigen refuses to start without at least one allowed user, because the bot would answer anyone who finds it.</Callout>}
      </Section>
    </>
  );
}
