"use client";
import { useState } from "react";
import { Callout, KeyValueEditor, Labeled, LineList, SelectInput } from "@/components/builder/panels/controls";
import { SecretInput } from "@/components/secret-input";
import { Button, Segmented, Switch } from "@/components/ui";
import { inputCls } from "@/components/builder/panels/fields";
import { cn } from "@/lib/cn";
import { putSecret, useSecrets } from "@/lib/client/secrets";

/** One MCP server as config.json holds it: stdio { command, args, env } or remote { url, headers, transport }, plus flags. */
export type McpServerValue = Record<string, unknown>;

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_KEY = /token|key|secret|auth|pass|bearer|cred/i;
const strMap = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, string>) : {});
const refName = (v: string) => (v.startsWith("env:") ? v.slice(4) : undefined);

/** NAME for an env: reference that replaces a literal, e.g. github + GITHUB_TOKEN -> GITHUB_TOKEN, github + Authorization -> GITHUB_AUTHORIZATION. */
export function envNameFor(server: string, key: string) {
  const up = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const k = up(key);
  const s = up(server);
  const joined = k.startsWith(s) ? k : `${s}_${k}`;
  const name = /^[A-Z]/.test(joined) ? joined : `MCP_${joined}`;
  return name.slice(0, 64);
}

/**
 * Edits one MCP server of one agent (an entry of its tools.mcp). `onRename` is optional: leave it out when the name is fixed.
 * Values written as `env:NAME` are read from that agent's own .env when the server starts, and get a write-only secret field here.
 */
export function McpServerForm({
  agentId,
  name,
  value,
  onChange,
  onRename,
  onRemove,
}: {
  agentId: string;
  name: string;
  value: McpServerValue;
  onChange: (next: McpServerValue) => void;
  onRename?: (next: string) => void;
  onRemove?: () => void;
}) {
  const remote = "url" in value;
  const env = strMap(value.env);
  const headers = strMap(value.headers);
  const refs = [...Object.values(env), ...Object.values(headers)].map(refName).filter((n): n is string => !!n && ENV.test(n));
  const { isSet } = useSecrets(agentId, refs);
  const [nameDraft, setNameDraft] = useState(name);
  const [prevName, setPrevName] = useState(name);
  if (name !== prevName) {
    setPrevName(name);
    setNameDraft(name);
  }
  const [moveError, setMoveError] = useState<string | null>(null);

  const patch = (field: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[field];
    else next[field] = v;
    onChange(next);
  };
  const flags = { ...(value.enabled === false && { enabled: false }), ...(value.trusted === true && { trusted: true }) };
  const switchKind = (to: "stdio" | "remote") => onChange(to === "remote" ? { url: "https://", ...flags } : { command: "", args: [], ...flags });

  const extras = (field: "env" | "headers", key: string, val: string) => {
    const ref = refName(val);
    if (ref !== undefined)
      return ENV.test(ref) ? (
        <div className="mt-1.5">
          <SecretInput agentId={agentId} name={ref} set={isSet(ref)} label={ref} />
        </div>
      ) : (
        <p className="mt-1 text-[12px] text-warn">After env: use an upper-case name such as {envNameFor(name, key)}.</p>
      );
    if (val && (SECRET_KEY.test(key) || /^(Bearer|Basic)\s/i.test(val))) {
      const target = envNameFor(name, key);
      return (
        <div className="mt-1.5 rounded-lg border border-warn/40 bg-warn/8 px-3 py-2 text-[12px] text-ink">
          This looks like a secret stored in plain text in config.json.{" "}
          <button
            type="button"
            className="font-medium text-accent underline underline-offset-2"
            onClick={async () => {
              setMoveError(null);
              const err = await putSecret(agentId, target, val);
              if (err) return setMoveError(err);
              const cur = strMap(value[field]);
              patch(field, { ...cur, [key]: `env:${target}` });
            }}
          >
            Move it to .env as {target}
          </button>
          {moveError && <span className="block text-bad">{moveError}</span>}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label="Server name" hint={onRename ? "Becomes the prefix of its tools, e.g. github_search." : undefined}>
          {({ id }) =>
            onRename ? (
              <input
                id={id}
                value={nameDraft}
                spellCheck={false}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  const to = nameDraft.trim();
                  if (to && to !== name) onRename(to);
                  setNameDraft(name);
                }}
                className={cn(inputCls(), "w-56 font-mono text-[13px]")}
              />
            ) : (
              <input id={id} value={name} readOnly className={cn(inputCls(), "w-56 bg-sunken font-mono text-[13px] text-ink-3")} />
            )
          }
        </Labeled>
        <Segmented label="Server type" value={remote ? "remote" : "stdio"} options={[{ value: "stdio", label: "Local command" }, { value: "remote", label: "Remote URL" }]} onChange={switchKind} />
      </div>

      {remote ? (
        <>
          <Labeled label="URL" hint="The server's MCP endpoint." error={typeof value.url === "string" && URL.canParse(value.url) ? undefined : "not a valid URL"}>
            {({ id, invalid }) => <input id={id} value={typeof value.url === "string" ? value.url : ""} spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("url", e.target.value)} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
          </Labeled>
          <Labeled label="Transport" hint="Auto tries streamable HTTP first.">
            {({ id }) => (
              <SelectInput id={id} className="max-w-[12rem]" value={typeof value.transport === "string" ? value.transport : ""} onChange={(v) => patch("transport", v || undefined)} options={[{ value: "", label: "Auto" }, { value: "http", label: "Streamable HTTP" }, { value: "sse", label: "SSE" }]} />
            )}
          </Labeled>
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Headers</div>
            <KeyValueEditor value={headers} onChange={(v) => patch("headers", v)} keyPlaceholder="Authorization" valuePlaceholder="env:GITHUB_TOKEN" renderExtra={(k, v) => extras("headers", k, v)} addLabel="Add header" />
          </div>
        </>
      ) : (
        <>
          <Labeled label="Command" hint="The program to run, e.g. npx" error={typeof value.command === "string" && value.command.trim() ? undefined : "command is required"}>
            {({ id, invalid }) => <input id={id} value={typeof value.command === "string" ? value.command : ""} spellCheck={false} aria-invalid={invalid} onChange={(e) => patch("command", e.target.value)} className={cn(inputCls(invalid), "font-mono text-[13px]")} />}
          </Labeled>
          <Labeled label="Arguments" hint="One per line. No quoting needed.">
            {({ id }) => <LineList id={id} rows={3} value={Array.isArray(value.args) ? (value.args as unknown[]).map(String) : []} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} onChange={(a) => onChange({ ...value, args: a })} />}
          </Labeled>
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Environment</div>
            <KeyValueEditor value={env} onChange={(v) => patch("env", v)} keyPlaceholder="GITHUB_TOKEN" valuePlaceholder="env:GITHUB_TOKEN" renderExtra={(k, v) => extras("env", k, v)} addLabel="Add variable" />
          </div>
        </>
      )}

      <div className="space-y-3 border-t border-line pt-3">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">Enabled</div>
            <div className="text-[12px] text-ink-3">Off keeps the entry but does not connect to it.</div>
          </div>
          <Switch label={`${name} enabled`} checked={value.enabled !== false} onChange={(on) => patch("enabled", on ? undefined : false)} />
        </div>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">Trusted</div>
            <div className="text-[12px] text-ink-3">Tool calls run without asking you first.</div>
          </div>
          <Switch label={`${name} trusted`} checked={value.trusted === true} onChange={(on) => patch("trusted", on ? true : undefined)} />
        </div>
        {value.trusted === true && <Callout tone="warn">Only trust a server you run yourself or fully audited. Its tools can act without an Approve / Deny prompt in Telegram.</Callout>}
        {onRemove && (
          <Button variant="quiet" onClick={onRemove} aria-label={`Remove ${name}`}>
            Remove server
          </Button>
        )}
      </div>
    </div>
  );
}
