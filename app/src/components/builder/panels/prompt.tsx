"use client";
import { cn } from "@/lib/cn";
import { Segmented } from "@/components/ui";
import { SoulEditor } from "@/components/editors/soul-editor";
import { BLURB } from "../kinds";
import { eff, type Item } from "../model";
import { Connection, type PanelCtx } from "./connection";
import { Field, Section, getPath, inputCls, useForm } from "./fields";

export function InstructionsBody({ ctx }: { ctx: PanelCtx }) {
  const { config, set } = useForm();
  const inline = getPath(config, "instructions.inline") as string | undefined;
  const file = String(eff(config, "instructions.file"));
  const isInline = inline !== undefined;
  const text = isInline ? inline : ctx.draft.instructionsText;
  const lines = text.split("\n").length;

  return (
    <Section title="Instructions" hint="The role prompt. A change applies from the agent's next message; no reload needed.">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Where the prompt lives"
          value={isInline ? "inline" : "file"}
          onChange={(v) => {
            if (v === "inline") set("instructions.inline", ctx.draft.instructionsText);
            else {
              ctx.setInstructions(inline ?? ctx.draft.instructionsText);
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
      {!isInline && !ctx.hasInstructionsFile && <p className="text-[12.5px] text-warn">{file} does not exist yet. Applying creates it.</p>}
      <Field label="Prompt" path={isInline ? "instructions.inline" : "instructions"}>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={text}
            spellCheck={false}
            onChange={(e) => (isInline ? set("instructions.inline", e.target.value) : ctx.setInstructions(e.target.value))}
            rows={18}
            className={cn(inputCls(invalid), "min-h-[320px] resize-y font-mono text-[12.5px] leading-[1.65]")}
            placeholder="You are…"
          />
        )}
      </Field>
    </Section>
  );
}

export function SoulBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const { config } = useForm();
  const file = String(eff(config, "soul.file"));
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.soul}. It is read before the instructions on every message. Disconnecting keeps ${file} on disk.`} />
      <Section title={`Soul (${file})`} hint="Lives in this agent's folder and belongs only to it. It saves with Apply and applies from the agent's next message.">
        <SoulEditor value={ctx.draft.soulText} onChange={ctx.setSoul} label={`Soul of ${ctx.agentName}`} readOnly={!item.connected && ctx.draft.soulText.trim() === ""} />
        {!item.connected && <p className="text-[12.5px] text-ink-3">Not connected: the agent does not read it.</p>}
      </Section>
    </>
  );
}
