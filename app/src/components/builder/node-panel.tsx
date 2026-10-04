"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Bot, ExternalLink, Loader2, Plus, Unplug, X, Zap } from "lucide-react";
import type { AgentRuntime, AgentSummary, ResolvedAgent, TriggerInput } from "@eigen/engine/schema";
import type { RootInfo } from "@/lib/types";
import type { Draft } from "@/lib/client/draft";
import { getPath } from "@/lib/client/draft";
import { testModel } from "@/lib/client/probes";
import type { ModelTestResponse } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Button, Segmented, Switch, spring } from "@/components/ui";
import { Callout } from "@/components/settings/controls";
import type { SettingsSection } from "@/components/settings/settings-dialog";
import { McpServerForm, type McpServerValue } from "@/components/mcp-form";
import { SkillEditor, SkillLibrary } from "@/components/editors/skill-editor";
import { SharedSoulEditor, SoulEditor } from "@/components/editors/soul-editor";
import { TriggerForm } from "@/components/editors/trigger-form";
import { TriggerRuns } from "@/components/editors/trigger-runs";
import { Form, Section, SwitchRow, type FormCtx } from "@/components/inspector/fields";
import { DelegationSection, IdentitySection, InstructionsSection, MaxStepsField, MemoryFilesField, MemoryScopeSection, ModelField, ObservationalField, RecentMessagesField, SandboxField, SemanticRecallField } from "@/components/inspector/panels";
import { TelegramSection } from "@/components/inspector/telegram-section";
import { TelegramStateChip, telegramView } from "@/components/canvas/telegram-state";
import { kindIcon, TINT } from "./kinds";
import { liveError, liveLine, type Live } from "./live";
import { hasBot, isRisky, parseRef, readAgent, type Item, type Ref } from "./model";

/** Everything a panel needs; the Builder builds one of these and the panels never touch the draft hook directly. */
export type PanelCtx = {
  agentId: string;
  agentName: string;
  root?: RootInfo;
  agents: AgentSummary[];
  draft: Draft;
  errors: Record<string, string>;
  hasInstructionsFile: boolean;
  runtime?: AgentRuntime;
  resolved?: ResolvedAgent | null;
  live: Live;
  engineOnline: boolean;
  items: Item[];
  issues: Record<string, string[]>;
  set: (path: string, value: unknown) => void;
  setInstructions: (text: string) => void;
  setSoul: (text: string) => void;
  setSoulSource: (source: "shared" | "own" | "none") => void;
  updateTrigger: (id: string, next: TriggerInput) => void;
  updatePrivateServer: (name: string, next: McpServerValue) => void;
  renamePrivateServer: (from: string, to: string) => void;
  connect: (ref: Ref) => void;
  disconnect: (ref: Ref) => void;
  /** Delete a trigger entry (asks first). */
  removeTrigger: (id: string) => void;
  open: (nodeId: string) => void;
  openSettings: (section: SettingsSection) => void;
};

type Title = { title: string; subtitle: string; icon: ReturnType<typeof kindIcon>; tint: string };

function describe(nodeId: string, ctx: PanelCtx): Title {
  if (nodeId === "agent") return { title: ctx.agentName, subtitle: "The agent: identity, limits, delegation", icon: Bot, tint: "bg-accent-soft text-accent" };
  if (nodeId === "library") return { title: "Skill library", subtitle: "Every skill, shared by all agents", icon: kindIcon("skill"), tint: TINT.tools.tile };
  if (nodeId.startsWith("overflow:")) return { title: nodeId === "overflow:mcp" ? "More MCP servers" : "More skills", subtitle: "Connected, not drawn one by one", icon: kindIcon(nodeId === "overflow:mcp" ? "mcp" : "skill"), tint: TINT.tools.tile };
  const item = ctx.items.find((i) => i.id === nodeId);
  if (!item) return { title: "Component", subtitle: "", icon: kindIcon("model"), tint: TINT.think.tile };
  return { title: item.title, subtitle: item.type, icon: kindIcon(item.ref.kind, item.type === "GitHub trigger" ? "github-pr" : "cron"), tint: TINT[item.group].tile };
}

export function NodePanel({ nodeId, ctx, onClose, phone, className, style }: { nodeId: string; ctx: PanelCtx; onClose: () => void; phone: boolean; className?: string; style?: React.CSSProperties }) {
  const reduce = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const t = describe(nodeId, ctx);
  const Icon = t.icon;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [nodeId]);

  const form: FormCtx = { config: ctx.draft.config, set: ctx.set, errors: ctx.errors };
  const problems = ctx.issues[nodeId] ?? [];
  const enter = phone ? { y: "104%" } : { x: "104%" };

  return (
    <motion.aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="builder-panel-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      initial={reduce ? { opacity: 0 } : enter}
      animate={reduce ? { opacity: 1 } : { x: 0, y: 0 }}
      exit={reduce ? { opacity: 0 } : enter}
      transition={spring}
      className={cn("flex flex-col overflow-hidden border-line bg-panel shadow-float", className)}
      style={style}
    >
      <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", t.tint)}>
          <Icon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="builder-panel-title" ref={headingRef} tabIndex={-1} className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink focus:outline-none">
            {t.title}
          </h2>
          <p className="truncate text-[12.5px] text-ink-3">{t.subtitle}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" className="grid size-9 place-items-center rounded-lg text-ink-3 hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24 sm:pb-0">
        {problems.length > 0 && (
          <div role="alert" className="flex gap-2.5 border-b border-bad/30 bg-bad/8 px-5 py-3 text-[12.5px] text-ink">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" aria-hidden />
            <ul className="min-w-0 space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <Form.Provider value={form}>
          <Body nodeId={nodeId} ctx={ctx} />
        </Form.Provider>
      </div>
    </motion.aside>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Body({ nodeId, ctx }: { nodeId: string; ctx: PanelCtx }) {
  if (nodeId === "agent") return <AgentBody ctx={ctx} />;
  if (nodeId === "library") return <SkillLibrary onPick={(slug) => ctx.open(`skill:${slug}`)} />;
  if (nodeId === "overflow:mcp" || nodeId === "overflow:skill") return <OverflowBody kind={nodeId === "overflow:mcp" ? "mcp" : "skill"} ctx={ctx} />;
  const ref = parseRef(nodeId);
  const item = ctx.items.find((i) => i.id === nodeId);
  if (!ref || !item) return <p className="p-5 text-[13px] text-ink-3">This component is no longer on the agent.</p>;
  switch (ref.kind) {
    case "model":
      return <ModelBody ctx={ctx} />;
    case "instructions":
      return <InstructionsBody ctx={ctx} />;
    case "soul":
      return <SoulBody ctx={ctx} />;
    case "recent":
      return (
        <>
          <Connection item={item} ctx={ctx} blurb="Keeps the last messages of the conversation in front of the model. Disconnecting sets it to 0: the agent then sees only the current message, plus whatever recall and observation give it." />
          <Section title="Settings">
            <RecentMessagesField root={ctx.root} />
          </Section>
        </>
      );
    case "semantic":
      return (
        <>
          <Connection item={item} ctx={ctx} blurb="Finds older messages that mean the same thing as the current one, even from past conversations, and puts them in front of the model. Needs the embedder from Settings." />
          <Section title="Settings">
            <SemanticRecallField root={ctx.root} />
          </Section>
        </>
      );
    case "observational":
      return (
        <>
          <Connection item={item} ctx={ctx} blurb="Background agents compress old turns into short observations, so a long conversation does not fall out of the context window." />
          <Section title="Settings">
            <ObservationalField root={ctx.root} />
          </Section>
        </>
      );
    case "workspace":
      return <WorkspaceBody item={item} ctx={ctx} />;
    case "schedule":
      return <ScheduleBody item={item} ctx={ctx} />;
    case "mcp":
      return <RootMcpBody item={item} name={ref.name} ctx={ctx} />;
    case "private-mcp":
      return <PrivateMcpBody name={ref.name} ctx={ctx} />;
    case "skill":
      return <SkillBody item={item} slug={ref.slug} ctx={ctx} />;
    case "telegram":
      return <TelegramBody item={item} ctx={ctx} />;
    case "trigger":
      return <TriggerBody item={item} id={ref.id} ctx={ctx} />;
  }
}

/* ---------------------------------------------------------------------------------------------- */

/** The connect / disconnect row every component panel starts with, and the one honest sentence about what the component does. */
function Connection({ item, ctx, blurb, verbs }: { item: Item; ctx: PanelCtx; blurb: string; verbs?: { on: string; off: string } }) {
  // The Telegram section below shows its own error, with the state chip.
  const err = item.ref.kind === "telegram" ? undefined : liveError(item, ctx.live);
  return (
    <section className="border-b border-line px-5 py-4">
      <div className="flex items-center gap-3">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]", item.connected ? "border-ok/40 text-ok" : "border-line text-ink-3")}>
          <span className={cn("size-1.5 rounded-full", item.connected ? "bg-ok" : "bg-off")} aria-hidden />
          {item.connected ? (verbs?.on ?? "Connected") : (verbs?.off ?? "Not connected")}
        </span>
        <div className="ml-auto">
          {item.locked ? null : item.connected ? (
            <Button onClick={() => ctx.disconnect(item.ref)}>
              <Unplug size={13} /> {item.unavailable ? "Remove" : item.ref.kind === "trigger" ? "Switch off" : "Disconnect"}
            </Button>
          ) : (
            <Button variant="primary" disabled={!!item.blocked} onClick={() => ctx.connect(item.ref)}>
              <Plus size={13} /> Connect
            </Button>
          )}
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{blurb}</p>
      {item.locked && <p className="mt-2 text-[12.5px] text-ink-3">{item.locked}</p>}
      {item.note && !item.connected && <p className="mt-2 text-[12.5px] text-warn">{item.note}</p>}
      {item.blocked && <p className="mt-2 text-[12.5px] text-warn">{item.blocked}</p>}
      {item.inactive && item.connected && <p className="mt-2 text-[12.5px] text-warn">{item.inactive}</p>}
      {err && (
        <p role="alert" className="mt-2 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] break-words text-bad">
          {err}
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function AgentBody({ ctx }: { ctx: PanelCtx }) {
  const primary = ctx.draft.config.primary === true;
  const enabled = ctx.draft.config.enabled !== false;
  const { status, problems } = ctx.live;
  return (
    <>
      {problems.length > 0 && (
        <div className="border-b border-line px-5 py-4">
          <Callout tone={status === "stale" ? "warn" : "bad"} title={status === "stale" ? "The file has problems. The engine keeps running the last good version." : status === "invalid" ? "This agent is not loaded. Fix these problems and apply." : "These problems will stop the engine from loading this agent."}>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
      <IdentitySection />
      <Section title="Status">
        <SwitchRow label={enabled ? "Enabled" : "Disabled"} hint={primary ? "The primary cannot be disabled. Make another agent primary first." : "A disabled agent is not loaded; its files stay as they are."}>
          <Switch label="Enabled" checked={enabled} disabled={primary} onChange={(v) => ctx.set("enabled", v ? undefined : false)} />
        </SwitchRow>
      </Section>
      <Section title="Limits and sandbox">
        <MaxStepsField root={ctx.root} />
        <SandboxField />
      </Section>
      <MemoryScopeSection />
      <DelegationSection id={ctx.agentId} agents={ctx.agents} />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function ModelBody({ ctx }: { ctx: PanelCtx }) {
  const key = readAgent(ctx.draft.config, ctx.root).modelKey;
  const [state, setState] = useState<{ busy: boolean; key?: string; res?: ModelTestResponse }>({ busy: false });
  const shown = state.key === key ? state.res : undefined;
  const run = async () => {
    setState({ busy: true, key });
    setState({ busy: false, key, res: await testModel(key) });
  };
  return (
    <>
      <Section title="Model" hint="The model this agent answers with. Swapping it applies on the next message after you apply.">
        <ModelField root={ctx.root} />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void run()} disabled={!key || state.busy}>
            {state.busy ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Test {key || "model"}
          </Button>
          <span role="status" className={cn("min-w-0 text-[12.5px]", shown?.ok ? "text-ok" : shown ? "text-bad" : "text-ink-3")}>
            {state.busy ? "Sending a tiny prompt…" : shown ? (shown.ok ? `It answered in ${shown.ms} ms` : (shown.error ?? "The model did not answer.")) : "Sends one tiny prompt with the key saved in .env."}
          </span>
        </div>
        <Button variant="quiet" onClick={() => ctx.openSettings("models")} className="-ml-2">
          <ExternalLink size={13} /> Edit models in Settings
        </Button>
      </Section>
    </>
  );
}

function InstructionsBody({ ctx }: { ctx: PanelCtx }) {
  return (
    <>
      <InstructionsSection instructionsText={ctx.draft.instructionsText} setInstructions={ctx.setInstructions} hasInstructionsFile={ctx.hasInstructionsFile} />
      <Section title="Context" hint="The persona comes from the Soul component.">
        <MemoryFilesField />
      </Section>
    </>
  );
}

function SoulBody({ ctx }: { ctx: PanelCtx }) {
  const source = readAgent(ctx.draft.config, ctx.root).soul;
  const file = (getPath(ctx.draft.config, "soul.file") as string | undefined) ?? "soul.md";
  return (
    <>
      <Section title="Persona" hint="The soul is the persona block of the prompt: how the agent sounds and what it will not do. It is read before the instructions on every message.">
        <Segmented
          label="Soul"
          value={source}
          onChange={ctx.setSoulSource}
          options={[
            { value: "none", label: "None" },
            { value: "shared", label: "Shared" },
            { value: "own", label: "Own" },
          ]}
        />
        {source === "none" && (
          <p className="text-[12.5px] text-ink-3">No persona is added to the prompt.{ctx.draft.soulText.trim() ? ` Your own ${file} stays on disk and comes back if you pick Own again.` : ""}</p>
        )}
      </Section>
      {source === "shared" && (
        <Section title="Shared soul">
          <Callout tone="warn" title="Every agent on Shared reads this one file">
            Editing it here changes how all of them sound, not just {ctx.agentName}. It saves on its own, not with Apply. Pick Own to give this agent a soul that is only its.
          </Callout>
          <SharedSoulEditor />
        </Section>
      )}
      {source === "own" && (
        <Section title={`Own soul (${file})`} hint="Lives in this agent's folder. It saves with Apply, and applies from the agent's next message.">
          <SoulEditor value={ctx.draft.soulText} onChange={ctx.setSoul} label={`Soul of ${ctx.agentName}`} />
        </Section>
      )}
    </>
  );
}

function WorkspaceBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const skills = ctx.items.filter((i) => i.ref.kind === "skill" && i.connected).length;
  return (
    <>
      <Connection
        item={item}
        ctx={ctx}
        blurb="Lets the agent run bash commands, read and write files, and load skills, all inside its sandbox. The sandbox cannot see the rest of your home folder."
      />
      <Section title="Sandbox" hint="Where the workspace lives.">
        <SandboxField />
      </Section>
      {!item.connected && skills > 0 && (
        <div className="px-5 pb-5">
          <Callout tone="warn">
            {skills} connected {skills === 1 ? "skill needs" : "skills need"} this tool: the agent cannot load {skills === 1 ? "it" : "them"} without it.
          </Callout>
        </div>
      )}
    </>
  );
}

function ScheduleBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const primary = ctx.draft.config.primary === true;
  return (
    <>
      <Connection item={item} ctx={ctx} blurb="Lets the agent set reminders and recurring jobs for itself, from the chat." />
      {!primary && (
        <div className="px-5 py-4">
          <Callout tone="warn" title="Only the primary agent can use this tool">
            {ctx.agentName} is not the primary, so the engine never gives it the Schedule tool. To wake {ctx.agentName} up on a schedule, add a trigger.
          </Callout>
        </div>
      )}
    </>
  );
}

function RootMcpBody({ item, name, ctx }: { item: Item; name: string; ctx: PanelCtx }) {
  const server = ctx.root?.mcpServers.find((s) => s.name === name);
  return (
    <>
      <Connection item={item} ctx={ctx} blurb="A tool server from the root config.json. Every agent can connect to it; its settings live in one place." />
      <Section title="Server">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-[13px]">
          <dt className="text-ink-3">Enabled</dt>
          <dd className="text-ink">{server ? (server.enabled ? "Yes" : "No, switched off in Settings") : "Not in the root config"}</dd>
          <dt className="text-ink-3">Trusted</dt>
          <dd className="text-ink">{server?.trusted ? "Yes: its tools run without asking first" : "No: its tools ask before they run"}</dd>
        </dl>
        <Button onClick={() => ctx.openSettings("tools")}>
          <ExternalLink size={13} /> Edit in Settings
        </Button>
      </Section>
    </>
  );
}

function PrivateMcpBody({ name, ctx }: { name: string; ctx: PanelCtx }) {
  const value = readAgent(ctx.draft.config, ctx.root).mcpOwn[name];
  const err = ctx.live.mcpErrors[`private:${name}`];
  if (!value) return <p className="p-5 text-[13px] text-ink-3">This server is no longer on the agent.</p>;
  return (
    <>
      <section className="border-b border-line px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink-2">A tool server that only {ctx.agentName} connects to. Removing it deletes its command and settings from this agent&apos;s config.</p>
        {err && (
          <p role="alert" className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] break-words text-bad">
            {err}
          </p>
        )}
      </section>
      <Section title="Server">
        <McpServerForm
          name={name}
          value={value}
          onChange={(next) => ctx.updatePrivateServer(name, next)}
          onRename={(to) => ctx.renamePrivateServer(name, to)}
          onRemove={() => ctx.disconnect({ kind: "private-mcp", name })}
        />
      </Section>
    </>
  );
}

function SkillBody({ item, slug, ctx }: { item: Item; slug: string; ctx: PanelCtx }) {
  const workspace = ctx.items.find((i) => i.ref.kind === "workspace")?.connected ?? false;
  const inLibrary = !item.inactive?.startsWith("The skill library has no skill");
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`A skill is a folder of instructions the agent loads when it needs them. ${item.detail ?? ""}`} />
      {!workspace && (
        <div className="px-5 pt-4">
          <Callout tone="warn" title="Needs the Workspace tool">
            The agent loads skills through its workspace. Connect Workspace for this skill to do anything.
          </Callout>
        </div>
      )}
      <div className="px-5 pt-4">
        <Callout>The skill file is in the shared library, so editing it changes it for every agent that uses it. It saves on its own, not with Apply.</Callout>
      </div>
      {inLibrary && (
        <div className="py-2">
          <SkillEditor slug={slug} />
        </div>
      )}
    </>
  );
}

function TelegramBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const primary = ctx.draft.config.primary === true;
  const view = telegramView(ctx.live.telegram, { enabled: item.connected, engineOffline: !ctx.engineOnline });
  return (
    <>
      {primary ? (
        <section className="border-b border-line px-5 py-4">
          <div className="flex items-center gap-3">
            <TelegramStateChip view={view} />
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">The primary always answers on the root bot, so you talk to the whole team in one chat.</p>
          {item.locked && <p className="mt-2 text-[12.5px] text-ink-3">{item.locked}</p>}
        </section>
      ) : (
        <Connection item={item} ctx={ctx} blurb="Chat with this agent in its own Telegram chat. Create the bot with @BotFather; one bot token serves exactly one agent." />
      )}
      {(primary || item.connected) && <TelegramSection id={ctx.agentId} runtime={ctx.runtime} resolved={ctx.resolved} root={ctx.root} engineOnline={ctx.engineOnline} openSettings={ctx.openSettings} />}
    </>
  );
}

function TriggerBody({ item, id, ctx }: { item: Item; id: string; ctx: PanelCtx }) {
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
        <TriggerForm agentId={ctx.agentId} value={value} onChange={(next) => ctx.updateTrigger(id, next)} onRemove={() => ctx.removeTrigger(id)} telegramOn={hasBot(ctx.draft.config)} risky={isRisky(ctx.draft.config, ctx.root)} />
      </Section>
      <Section title="Runs">
        <TriggerRuns agentId={ctx.agentId} triggerId={id} />
      </Section>
    </>
  );
}

function OverflowBody({ kind, ctx }: { kind: "mcp" | "skill"; ctx: PanelCtx }) {
  const connected = ctx.items.filter((i) => i.connected && (kind === "mcp" ? i.ref.kind === "mcp" || i.ref.kind === "private-mcp" : i.ref.kind === "skill"));
  const all = kind === "skill" && readAgent(ctx.draft.config, ctx.root).skillsInherit === "all";
  return (
    <section className="px-5 py-4">
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        {all ? "This agent uses every skill in the library (skills.inherit is all). Disconnecting one switches to an explicit list of the others." : `Everything connected, ${connected.length} in all. Only the first few get a node of their own.`}
      </p>
      <ul className="mt-3 grid gap-1.5">
        {connected.map((i) => (
          <li key={i.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
            <button type="button" onClick={() => ctx.open(i.id)} className="min-w-0 flex-1 text-left">
              <span className="block truncate font-mono text-[12.5px] text-ink">{i.title}</span>
              <span className="block truncate text-[11.5px] text-ink-3">{i.inactive ?? i.detail}</span>
            </button>
            <Button variant="quiet" aria-label={`Disconnect ${i.title}`} onClick={() => ctx.disconnect(i.ref)} className="h-7 px-2">
              <Unplug size={13} />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
