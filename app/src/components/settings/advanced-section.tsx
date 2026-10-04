"use client";
import { useState } from "react";
import { Section, getPath, inputCls, Field, useForm } from "@/components/inspector/fields";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { BoolField, Callout, NumField, useRoot, type Obj } from "./controls";

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
};

export function AdvancedSection({ etag, onReplace }: { etag: string; onReplace: (next: Obj) => void }) {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const tz = getPath(config, "timezone");
  const pretty = JSON.stringify(config, null, 2);
  const [text, setText] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const apply = () => {
    try {
      const v = JSON.parse(text ?? "");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the top level must be an object");
      onReplace(v as Obj);
      setText(null);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  return (
    <>
      <Section title="General">
        <Field label="Time zone" path="timezone" hint={`Used for schedules and "today". Default ${defaults.timezone} (this machine).`}>
          {({ id, describedBy, invalid }) => (
            <>
              <input id={id} list="eigen-timezones" aria-describedby={describedBy} aria-invalid={invalid} spellCheck={false} placeholder={defaults.timezone} value={typeof tz === "string" ? tz : ""} onChange={(e) => set("timezone", e.target.value.trim() || undefined)} className={cn(inputCls(invalid), "max-w-xs font-mono text-[13px]")} />
              <datalist id="eigen-timezones">
                {zones().map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <NumField label="Max steps per turn" path="limits.maxSteps" hint="How many tool-use steps an agent may take before it must answer. An agent can set its own. Default 25." />
      </Section>

      <Section title="MCP connections">
        <BoolField label="Connect to MCP servers" path="mcp.enabled" hint="Master switch for every server in the Tools tab." />
        <NumField label="Startup timeout (ms)" path="mcp.startupTimeoutMs" width="w-40" hint="How long to wait for a server to connect. Default 20,000." />
      </Section>

      <Section title="config.json" hint={`The whole file as the engine reads it (version ${etag}). Edit here, then Apply; the forms above update.`}>
        <textarea
          aria-label="config.json"
          spellCheck={false}
          rows={14}
          value={text ?? pretty}
          onChange={(e) => {
            setText(e.target.value);
            setParseError(null);
          }}
          className={cn(inputCls(!!parseError), "resize-y font-mono text-[12px] leading-relaxed")}
        />
        {parseError && <p role="alert" className="text-[12.5px] text-bad">That is not valid JSON: {parseError}</p>}
        {text !== null && text !== pretty && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={apply}>
              Apply JSON
            </Button>
            <Button variant="quiet" onClick={() => { setText(null); setParseError(null); }}>
              Discard
            </Button>
          </div>
        )}
        <Callout>Keys and tokens belong in ~/.eigen/.env and are referenced by name (env:NAME). The studio never shows their values.</Callout>
      </Section>
    </>
  );
}
