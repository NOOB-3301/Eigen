"use client";
import { useState } from "react";
import { CalendarClock, FolderCog, Lock, Plug, ShieldCheck, Sparkles } from "lucide-react";
import type { AgentSummary } from "@eigen/engine/schema";
import type { RootInfo } from "@/lib/types";
import { cn } from "@/lib/cn";
import { Segmented, Switch } from "@/components/ui";
import { ChipToggle, Field, NumberInput, Provenance, Section, SwitchRow, TextField, getPath, inputCls, useForm } from "./fields";

export type PanelProps = {
  id: string;
  root?: RootInfo;
  agents: AgentSummary[];
  instructionsText: string;
  setInstructions: (t: string) => void;
  hasInstructionsFile: boolean;
};

/* ---------------------------------------------------------------------------------------------- */

export function OverviewPanel({ id, root, agents }: PanelProps) {
  const { config, set } = useForm();
  const model = getPath(config, "model") as string | undefined;
  const primary = getPath(config, "primary") === true;
  const acceptsFrom = (getPath(config, "delegation.acceptsFrom") as string | undefined) ?? "primary";
  const canDelegateTo = (getPath(config, "delegation.canDelegateTo") as string[] | undefined) ?? [];
  const others = agents.filter((a) => a.id !== id);
  const defaultModel = root?.models.find((m) => m.key === root.defaultModel);

  return (
    <>
      <Section title="Identity">
        <TextField label="Name" path="name" />
        <TextField label="Role" path="role" hint="A short label shown on the canvas, like researcher or planner." />
        <TextField label="Description" path="description" multiline rows={4} hint="The primary reads this to decide when to delegate, so write it for a model." />
      </Section>

      <Section title="Model">
        <Field
          label="Model"
          path="model"
          aside={
            <Provenance
              overridden={model !== undefined}
              inheritedLabel={root?.defaultModel ?? "default"}
              onOverride={() => set("model", root?.defaultModel ?? "")}
              onReset={() => set("model", undefined)}
            />
          }
        >
          {({ id: fid, describedBy, invalid }) => (
            <select
              id={fid}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={model ?? ""}
              onChange={(e) => set("model", e.target.value || undefined)}
              className={cn(inputCls(invalid), "appearance-none font-mono text-[13px]")}
            >
              <option value="">
                Root default: {root?.defaultModel ?? "…"}
                {defaultModel ? ` (${defaultModel.id})` : ""}
              </option>
              {root?.models.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.key} ({m.id})
                </option>
              ))}
              {model && root && !root.models.some((m) => m.key === model) && <option value={model}>{model} (missing)</option>}
            </select>
          )}
        </Field>
      </Section>

      <Section title="Delegation" hint="Who can hand work to this agent, and who it can hand work to.">
        <Field label="Accepts work from" path="delegation.acceptsFrom">
          {() => (
            <Segmented
              label="Accepts work from"
              value={acceptsFrom}
              onChange={(v) => set("delegation.acceptsFrom", v)}
              options={[
                ...(primary ? [] : [{ value: "primary", label: "The primary" }]),
                { value: "any", label: "Any agent" },
                { value: "none", label: "Nobody" },
              ]}
            />
          )}
        </Field>
        <Field label="Can delegate to" path="delegation.canDelegateTo" hint={primary ? "The primary can already reach every agent that accepts work from it." : undefined}>
          {() => (
            <div className="flex flex-wrap gap-1.5">
              {others.length === 0 && <span className="text-[12.5px] text-ink-3">No other agents yet.</span>}
              {others.map((a) => {
                const on = canDelegateTo.includes(a.id);
                return (
                  <ChipToggle key={a.id} on={on} onClick={() => set("delegation.canDelegateTo", on ? canDelegateTo.filter((x) => x !== a.id) : [...canDelegateTo, a.id])}>
                    {a.name}
                  </ChipToggle>
                );
              })}
            </div>
          )}
        </Field>
      </Section>

    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */

export function PromptPanel({ instructionsText, setInstructions, hasInstructionsFile }: PanelProps) {
  const { config, set } = useForm();
  const inline = getPath(config, "instructions.inline") as string | undefined;
  const file = (getPath(config, "instructions.file") as string | undefined) ?? "instructions.md";
  const includeSoul = (getPath(config, "instructions.includeSoul") as boolean | undefined) ?? true;
  const mem = getPath(config, "instructions.includeMemoryFiles") as boolean | undefined;
  const primary = getPath(config, "primary") === true;
  const isInline = inline !== undefined;
  const text = isInline ? inline : instructionsText;
  const lines = text.split("\n").length;

  return (
    <>
      <Section title="Instructions" hint="The role prompt. Edits to the file apply on the agent's next message; no reload needed.">
        <div className="flex items-center gap-3">
          <Segmented
            label="Where the prompt lives"
            value={isInline ? "inline" : "file"}
            onChange={(v) => {
              if (v === "inline") set("instructions.inline", instructionsText);
              else {
                setInstructions(inline ?? instructionsText);
                set("instructions.inline", undefined);
              }
            }}
            options={[
              { value: "file", label: file },
              { value: "inline", label: "Inline in config" },
            ]}
          />
          <span className="ml-auto font-mono text-[11.5px] text-ink-3 tabular-nums">
            {lines} {lines === 1 ? "line" : "lines"}
          </span>
        </div>
        {!isInline && !hasInstructionsFile && <p className="text-[12.5px] text-warn">{file} does not exist yet. Saving creates it.</p>}
        <Field label="Prompt" path={isInline ? "instructions.inline" : "instructions"}>
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={text}
              spellCheck={false}
              onChange={(e) => (isInline ? set("instructions.inline", e.target.value) : setInstructions(e.target.value))}
              rows={18}
              className={cn(inputCls(invalid), "min-h-[320px] resize-y font-mono text-[12.5px] leading-[1.65]")}
              placeholder="You are…"
            />
          )}
        </Field>
      </Section>
      <Section title="Context">
        <SwitchRow label="Prepend the shared persona" hint="Adds ~/.eigen/SOUL.md before the prompt.">
          <Switch label="Prepend the shared persona" checked={includeSoul} onChange={(v) => set("instructions.includeSoul", v ? undefined : false)} />
        </SwitchRow>
        <Field label="Curated memory files" path="instructions.includeMemoryFiles" hint={`Appends ~/.eigen/memory/*.md. Default is ${primary ? "on (primary)" : "off"}.`}>
          {() => (
            <Segmented
              label="Curated memory files"
              value={mem === undefined ? "default" : mem ? "on" : "off"}
              onChange={(v) => set("instructions.includeMemoryFiles", v === "default" ? undefined : v === "on")}
              options={[
                { value: "default", label: `Default (${primary ? "on" : "off"})` },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          )}
        </Field>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const BUILTINS = [
  { key: "workspace", label: "Workspace", hint: "Files and shell commands inside the sandbox.", Icon: FolderCog },
  { key: "schedule", label: "Schedule", hint: "Reminders and recurring jobs.", Icon: CalendarClock },
  { key: "skills", label: "Skills", hint: "Load and run skills from the skills folder.", Icon: Sparkles },
] as const;

export function ToolsPanel({ root }: PanelProps) {
  const { config, set } = useForm();
  const builtin = (getPath(config, "tools.builtin") as string[] | undefined) ?? ["workspace"];
  const inherit = (getPath(config, "tools.mcp.inherit") as "all" | "none" | string[] | undefined) ?? "none";
  const own = (getPath(config, "tools.mcp.servers") as Record<string, { trusted?: boolean; enabled?: boolean; url?: string; command?: string }> | undefined) ?? {};
  const mode = Array.isArray(inherit) ? "pick" : inherit;
  const picked = Array.isArray(inherit) ? inherit : [];

  return (
    <>
      <Section title="Built-in tools">
        <div className="grid gap-2">
          {BUILTINS.map(({ key, label, hint, Icon }) => {
            const on = builtin.includes(key);
            return (
              <label key={key} className={cn("flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors", on ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong")}>
                <span className={cn("grid size-8 place-items-center rounded-lg", on ? "bg-panel text-accent" : "bg-raised text-ink-3")}>
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{label}</span>
                  <span className="block text-[12px] text-ink-3">{hint}</span>
                </span>
                <Switch label={label} checked={on} onChange={(v) => set("tools.builtin", v ? [...builtin, key] : builtin.filter((b) => b !== key))} />
              </label>
            );
          })}
        </div>
      </Section>
      <Section title="Shared tool servers" hint="MCP servers defined in the root config.json.">
        <Field label="Connect to" path="tools.mcp.inherit">
          {() => (
            <Segmented
              label="Shared tool servers"
              value={mode}
              onChange={(v) => set("tools.mcp.inherit", v === "pick" ? picked : v)}
              options={[
                { value: "none", label: "None" },
                { value: "all", label: "All" },
                { value: "pick", label: "Pick" },
              ]}
            />
          )}
        </Field>
        {root && root.mcpServers.length === 0 && <p className="text-[12.5px] text-ink-3">The root config has no MCP servers.</p>}
        {mode !== "none" && root && root.mcpServers.length > 0 && (
          <ul className="grid gap-1.5">
            {root.mcpServers.map((s) => {
              const on = mode === "all" || picked.includes(s.name);
              return (
                <li key={s.name}>
                  <label className={cn("flex items-center gap-2.5 rounded-lg border px-3 py-2", on ? "border-line-strong" : "border-line", mode === "all" && "opacity-80")}>
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--accent)]"
                      checked={on}
                      disabled={mode === "all"}
                      onChange={(e) => set("tools.mcp.inherit", e.target.checked ? [...picked, s.name] : picked.filter((p) => p !== s.name))}
                    />
                    <Plug size={13} className="text-ink-3" />
                    <span className="font-mono text-[12.5px] text-ink">{s.name}</span>
                    {s.trusted && <ShieldCheck size={12} className="text-ok" aria-label="trusted" />}
                    {!s.enabled && <span className="ml-auto text-[11.5px] text-ink-3">disabled in root</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Private tool servers" hint="Servers only this agent connects to. Edit them in Advanced.">
        {Object.keys(own).length === 0 ? (
          <p className="text-[12.5px] text-ink-3">None.</p>
        ) : (
          <ul className="grid gap-1.5">
            {Object.entries(own).map(([name, s]) => (
              <li key={name} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                <Lock size={12} className="text-ink-3" />
                <span className="font-mono text-[12.5px] text-ink">{name}</span>
                <span className="truncate text-[11.5px] text-ink-3">{s.url ? "remote" : "local process"}</span>
                {s.trusted && <ShieldCheck size={12} className="ml-auto text-ok" aria-label="trusted" />}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */

export function MemoryPanel({ root }: PanelProps) {
  const { config, set } = useForm();
  const scope = (getPath(config, "memory.scope") as string | undefined) ?? "isolated";
  const last = getPath(config, "memory.lastMessages") as number | undefined;
  const sr = getPath(config, "memory.semanticRecall") as { enabled?: boolean; topK?: number; messageRange?: number } | undefined;
  const obs = getPath(config, "memory.observational") as { enabled?: boolean } | undefined;
  const d = root?.defaults;

  return (
    <>
      <Section title="Scope">
        <Segmented
          label="Memory scope"
          value={scope}
          onChange={(v) => set("memory.scope", v)}
          options={[
            { value: "isolated", label: "Isolated" },
            { value: "shared", label: "Shared with primary" },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">
          {scope === "shared" ? "Uses the same memory as the primary, including what it knows about you." : "Keeps its own threads and working memory."}
        </p>
      </Section>
      <Section title="Recall">
        <Field
          label="Recent messages kept in context"
          path="memory.lastMessages"
          aside={<Provenance overridden={last !== undefined} inheritedLabel={String(d?.lastMessages ?? "")} onOverride={() => set("memory.lastMessages", d?.lastMessages ?? 20)} onReset={() => set("memory.lastMessages", undefined)} />}
        >
          {({ id, describedBy, invalid }) =>
            last === undefined ? (
              <div className="font-mono text-[13px] text-ink-3 tabular-nums">{d?.lastMessages ?? "…"}</div>
            ) : (
              <NumberInput id={id} describedBy={describedBy} invalid={invalid} value={last} onChange={(v) => set("memory.lastMessages", v ?? 1)} />
            )
          }
        </Field>
        <Field
          label="Semantic recall"
          path="memory.semanticRecall"
          aside={
            <Provenance
              overridden={sr !== undefined}
              inheritedLabel={d ? (d.semanticRecall.enabled ? `on, top ${d.semanticRecall.topK}` : "off") : ""}
              onOverride={() => set("memory.semanticRecall", { ...d?.semanticRecall })}
              onReset={() => set("memory.semanticRecall", undefined)}
            />
          }
        >
          {() =>
            sr === undefined ? (
              <div className="text-[13px] text-ink-3">{d ? (d.semanticRecall.enabled ? `On: top ${d.semanticRecall.topK} matches, ${d.semanticRecall.messageRange} messages around each` : "Off") : "…"}</div>
            ) : (
              <div className="space-y-3 rounded-xl border border-line p-3">
                <SwitchRow label="Search past conversations">
                  <Switch label="Semantic recall" checked={sr.enabled ?? d?.semanticRecall.enabled ?? true} onChange={(v) => set("memory.semanticRecall.enabled", v)} />
                </SwitchRow>
                <div className="flex gap-4">
                  <label className="text-[12px] text-ink-2">
                    <span className="mb-1 block">Matches</span>
                    <NumberInput value={sr.topK} onChange={(v) => set("memory.semanticRecall.topK", v)} />
                  </label>
                  <label className="text-[12px] text-ink-2">
                    <span className="mb-1 block">Messages around each</span>
                    <NumberInput value={sr.messageRange} onChange={(v) => set("memory.semanticRecall.messageRange", v)} />
                  </label>
                </div>
              </div>
            )
          }
        </Field>
        <Field
          label="Observational memory"
          path="memory.observational"
          hint="Background agents compress old turns into observations."
          aside={
            <Provenance
              overridden={obs !== undefined}
              inheritedLabel={d?.observational.enabled ? "on" : "off"}
              onOverride={() => set("memory.observational", { enabled: d?.observational.enabled ?? false })}
              onReset={() => set("memory.observational", undefined)}
            />
          }
        >
          {() =>
            obs === undefined ? (
              <div className="text-[13px] text-ink-3">{d?.observational.enabled ? "On" : "Off"}</div>
            ) : (
              <Switch label="Observational memory" checked={obs.enabled ?? false} onChange={(v) => set("memory.observational.enabled", v)} />
            )
          }
        </Field>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */

export function AdvancedPanel({ root, onJson }: PanelProps & { onJson: (config: Record<string, unknown>) => void }) {
  const { config, set } = useForm();
  const maxSteps = getPath(config, "limits.maxSteps") as number | undefined;
  const sandbox = (getPath(config, "sandbox.mode") as string | undefined) ?? "shared";
  const pretty = JSON.stringify(config, null, 2);
  // While focused the textarea owns its text (it may be mid-edit, invalid JSON); otherwise it mirrors the draft.
  const [text, setText] = useState(pretty);
  const [focused, setFocused] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <>
      <Section title="Limits and sandbox">
        <Field
          label="Max tool steps per message"
          path="limits.maxSteps"
          aside={<Provenance overridden={maxSteps !== undefined} inheritedLabel={String(root?.defaults.maxSteps ?? "")} onOverride={() => set("limits.maxSteps", root?.defaults.maxSteps ?? 25)} onReset={() => set("limits.maxSteps", undefined)} />}
        >
          {({ id, describedBy, invalid }) =>
            maxSteps === undefined ? (
              <div className="font-mono text-[13px] text-ink-3 tabular-nums">{root?.defaults.maxSteps ?? "…"}</div>
            ) : (
              <NumberInput id={id} describedBy={describedBy} invalid={invalid} value={maxSteps} onChange={(v) => set("limits.maxSteps", v ?? 1)} />
            )
          }
        </Field>
        <Field label="Sandbox" path="sandbox.mode" hint={sandbox === "own" ? "A private sandbox folder inside this agent's folder." : "The shared ~/.eigen/sandbox."}>
          {() => (
            <Segmented
              label="Sandbox"
              value={sandbox}
              onChange={(v) => set("sandbox.mode", v)}
              options={[
                { value: "shared", label: "Shared" },
                { value: "own", label: "Own" },
              ]}
            />
          )}
        </Field>
      </Section>
      <Section title="config.json" hint="The raw file. Everything above edits this; edits here flow back into the forms.">
        <textarea
          aria-label="config.json"
          aria-invalid={!!parseError}
          spellCheck={false}
          value={focused ? text : pretty}
          onFocus={() => {
            setText(pretty);
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
            setParseError(null);
          }}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const v = JSON.parse(e.target.value);
              if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("must be a JSON object");
              setParseError(null);
              onJson(v);
            } catch (err) {
              setParseError((err as Error).message);
            }
          }}
          rows={22}
          className={cn(inputCls(!!parseError), "min-h-[360px] resize-y font-mono text-[12px] leading-[1.6]")}
        />
        {parseError && (
          <p role="alert" className="text-[12px] text-bad">
            Not valid JSON yet: {parseError}
          </p>
        )}
      </Section>
    </>
  );
}
