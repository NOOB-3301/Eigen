"use client";
import { ENV_NAME } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { useSecrets } from "@/lib/client/secrets";
import { SecretInput } from "@/components/secret-input";
import { Callout } from "./controls";
import { envInput } from "./connection";
import { Field, getPath, inputCls, useForm } from "./fields";

/**
 * A key the agent needs, in two parts: the NAME of the variable (in config.json, at `path`) and its value (write-only, in this agent's .env).
 * `effective` is the name the engine will read: the typed one, or the default it falls back to (shown as the placeholder); undefined means
 * no key is needed (a local model server).
 */
export function KeyField({ agentId, path, label, effective, hint, secretLabel }: { agentId: string; path: string; label: string; effective: string | undefined; hint?: string; secretLabel?: string }) {
  const { config, set } = useForm();
  const raw = getPath(config, path);
  const valid = !!effective && ENV_NAME.test(effective);
  const { isSet } = useSecrets(agentId, valid ? [effective] : []);
  return (
    <div className="space-y-2">
      <Field label={label} path={path} hint={hint ?? "The name of the line in this agent's .env that holds it. The value itself never goes in the config."}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typeof raw === "string" ? raw : ""}
            placeholder={effective ?? "no key needed"}
            spellCheck={false}
            autoCapitalize="characters"
            onChange={(e) => set(path, envInput(e.target.value))}
            className={cn(inputCls(invalid), "max-w-sm font-mono text-[13px]")}
          />
        )}
      </Field>
      {valid ? <SecretInput agentId={agentId} name={effective} set={isSet(effective)} label={secretLabel ?? effective} /> : effective ? <Callout tone="warn">Use an upper-case name such as OPENAI_API_KEY to set the value from here.</Callout> : null}
    </div>
  );
}
