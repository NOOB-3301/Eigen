"use client";
import { Unplug } from "lucide-react";
import { DEFAULT_DENY_READ } from "@eigen/engine/schema";
import { Button } from "@/components/ui";
import { McpServerForm } from "@/components/mcp-form";
import { SkillEditor, SkillLibrary } from "@/components/editors/skill-editor";
import { BLURB } from "../kinds";
import { readAgent, updateMcpServer, type Item } from "../model";
import { BoolField, Callout, ChoiceField, LineList, ListField, NumField } from "./controls";
import { Connection, type PanelCtx } from "./connection";
import { Field, Section, getPath, useForm } from "./fields";

export function WorkspaceBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const skills = ctx.items.filter((i) => i.ref.kind === "skill" && i.connected).length;
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.workspace}. Its shell can write only in this agent's sandbox/ folder and read its skills/; the rest of ~/.eigen, its own .env and memory included, is always hidden.`} />
      {!item.connected && skills > 0 && (
        <div className="border-b border-line px-5 py-4">
          <Callout tone="warn">
            {skills} connected {skills === 1 ? "skill needs" : "skills need"} this tool: the agent cannot load {skills === 1 ? "it" : "them"} without it.
          </Callout>
        </div>
      )}
      <SandboxPolicy />
    </>
  );
}

/** The sandbox policy of this agent (sandbox.*), with the schema defaults as placeholders. */
function SandboxPolicy() {
  const { config, set } = useForm();
  const isolation = String(getPath(config, "sandbox.isolation") ?? "auto");
  const writable = (getPath(config, "sandbox.readWritePaths") as string[] | undefined) ?? [];
  const deny = getPath(config, "sandbox.denyReadPaths") as string[] | undefined;
  const removed = deny ? DEFAULT_DENY_READ.filter((p) => !deny.includes(p)) : [];
  return (
    <>
      <Section title="Sandbox" hint="Every command the agent runs goes through this.">
        <ChoiceField
          label="Isolation"
          path="sandbox.isolation"
          options={[
            { value: "auto", label: "Auto" },
            { value: "seatbelt", label: "Seatbelt (macOS)" },
            { value: "bwrap", label: "Bubblewrap (Linux)" },
            { value: "none", label: "None" },
          ]}
          hint="Auto picks the OS sandbox that is available."
        />
        {isolation === "none" && (
          <Callout tone="bad" title="Isolation is off">
            This agent&apos;s commands run directly on your machine with your permissions. They can read your keys and change any file you can.
          </Callout>
        )}
        <BoolField label="Allow network" path="sandbox.allowNetwork" hint="Lets commands reach the internet (package installs, web requests)." />
      </Section>
      <Section title="Paths" hint="One path per line. A leading ~/ means your home folder.">
        <ListField label="Also writable" path="sandbox.readWritePaths" placeholder="~/Projects/notes" hint="Folders this agent's commands may write to, beyond its sandbox." />
        {writable.length > 0 && (
          <Callout tone="warn" title="This agent can change these folders">
            {writable.join(", ")}. Anything it runs, or is tricked into running, can modify them.
          </Callout>
        )}
        <ListField label="Also readable" path="sandbox.readOnlyPaths" hint="Folders its commands may read but not change." />
        {deny ? (
          <Field label="Never readable" path="sandbox.denyReadPaths" hint="Your own list replaces the built-in one.">
            {({ id, invalid }) => (
              <>
                <LineList id={id} invalid={invalid} rows={6} value={deny} onChange={(lines) => set("sandbox.denyReadPaths", lines)} />
                <Button variant="ghost" className="mt-2" onClick={() => set("sandbox.denyReadPaths", undefined)}>
                  Go back to the built-in list
                </Button>
              </>
            )}
          </Field>
        ) : (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Never readable</div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-3">{DEFAULT_DENY_READ.join("\n")}</pre>
            <p className="mt-1.5 text-[12px] text-ink-3">The built-in list ({DEFAULT_DENY_READ.length} paths: keys, shell history, Documents, ...) is hidden from commands on macOS.</p>
            <Button variant="ghost" className="mt-2" onClick={() => set("sandbox.denyReadPaths", [...DEFAULT_DENY_READ])}>
              Customize the list
            </Button>
          </div>
        )}
        {removed.length > 0 && (
          <Callout tone="warn" title={`${removed.length} protected ${removed.length === 1 ? "path is" : "paths are"} no longer hidden`}>
            {removed.join(", ")}
          </Callout>
        )}
      </Section>
      <Section title="Time limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Default command timeout (ms)" path="sandbox.commandTimeoutMs" width="w-40" />
          <NumField label="Longest allowed timeout (s)" path="sandbox.maxTimeoutSec" width="w-40" />
        </div>
      </Section>
    </>
  );
}

export function ScheduleBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  return <Connection item={item} ctx={ctx} blurb={`${BLURB.schedule}, from the chat. To wake the agent on a fixed schedule without asking it, add a trigger instead.`} />;
}

export function McpBody({ item, name, ctx }: { item: Item; name: string; ctx: PanelCtx }) {
  const value = readAgent(ctx.draft.config).mcp[name];
  if (!value) return <p className="p-5 text-[13px] text-ink-3">This server is no longer on the agent.</p>;
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`A tool server only ${ctx.agentName} uses. Its tools are named ${name}_<tool>. Switching it off keeps its settings; Delete removes them.`} />
      <Section title="Server">
        <McpServerForm agentId={ctx.agentId} name={name} value={value} onChange={(next) => ctx.update((d) => updateMcpServer(d, name, next))} onRename={(to) => ctx.renameMcp(name, to)} onRemove={() => ctx.removeMcp(name)} />
      </Section>
      <Section title="Startup">
        <NumField label="Startup timeout (ms)" path="tools.mcpStartupTimeoutMs" width="w-40" hint="How long to wait for each of this agent's servers to connect. Default 20,000." />
      </Section>
    </>
  );
}

export function SkillBody({ item, slug, ctx }: { item: Item; slug: string; ctx: PanelCtx }) {
  const workspace = ctx.items.find((i) => i.ref.kind === "workspace")?.connected ?? false;
  const inLibrary = !item.inactive?.includes("has no skill with this name");
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`A skill is a folder of instructions in this agent's library, loaded only when its description matches the job. ${item.detail ?? ""}`} />
      {!workspace && (
        <div className="px-5 pt-4">
          <Callout tone="warn" title="Needs the Workspace tool">
            The agent loads skills through its workspace. Connect Workspace for this skill to do anything.
          </Callout>
        </div>
      )}
      <div className="px-5 pt-4">
        <Callout>The SKILL.md is in this agent&apos;s own skills folder. It saves on its own, not with Apply.</Callout>
      </div>
      {inLibrary && (
        <div className="px-5 py-4">
          <SkillEditor agentId={ctx.agentId} slug={slug} onDeleted={() => ctx.open("library")} />
        </div>
      )}
    </>
  );
}

export function LibraryBody({ ctx }: { ctx: PanelCtx }) {
  return (
    <div className="px-5 py-4">
      <SkillLibrary agentId={ctx.agentId} onPick={(slug) => ctx.open(`skill:${slug}`)} />
    </div>
  );
}

export function OverflowBody({ kind, ctx }: { kind: "mcp" | "skill"; ctx: PanelCtx }) {
  const listed = ctx.items.filter((i) => i.ref.kind === kind && (kind === "mcp" || i.connected));
  const all = kind === "skill" && readAgent(ctx.draft.config).skills === "all";
  return (
    <section className="px-5 py-4">
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        {all ? "This agent loads every skill in its library (skills.enabled is all). Disconnecting one switches to an explicit list of the others." : `${listed.length} in all. Only the first few get a node of their own.`}
      </p>
      <ul className="mt-3 grid gap-1.5">
        {listed.map((i) => (
          <li key={i.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
            <button type="button" onClick={() => ctx.open(i.id)} className="min-w-0 flex-1 text-left">
              <span className="block truncate font-mono text-[12.5px] text-ink">{i.title}</span>
              <span className="block truncate text-[11.5px] text-ink-3">{i.connected ? (i.inactive ?? i.detail) : "off"}</span>
            </button>
            {i.connected && (
              <Button variant="quiet" aria-label={`${kind === "mcp" ? "Switch off" : "Disconnect"} ${i.title}`} onClick={() => ctx.disconnect(i.ref)} className="h-7 px-2">
                <Unplug size={13} />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
