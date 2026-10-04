/**
 * The builder's model: how an agent's config.json reads as COMPONENTS, and what connecting or disconnecting one writes.
 * Pure (no React, no `@/` imports) so it is tested directly; the canvas and the panels only call into it.
 *
 * The table it implements (config.json = AgentConfigInput, see engine schema.ts):
 *   model          always connected      | pick: `model: <root key>` (the root default removes the key)
 *   instructions   always connected      | text edited as instructionsText
 *   soul           soul.source != none   | connect: soul.source "shared" | "own"      disconnect: soul.source "none" (soul.md stays on disk)
 *   recent         lastMessages > 0      | connect: memory.lastMessages n              disconnect: 0
 *   semantic       semanticRecall on     | memory.semanticRecall.enabled true / false
 *   observational  observational on      | memory.observational.enabled true / false
 *   workspace      tools.builtin has it  | add / remove "workspace"
 *   schedule       tools.builtin has it  | add / remove "schedule"
 *   mcp (root)     inherit all or listed | write an explicit list ("all" is expanded first); an empty list is "none"
 *   mcp (private)  key in servers        | add an entry / delete the key
 *   skill          inherit all or listed | like mcp
 *   telegram       telegram.enabled      | telegram.enabled true / false (the primary always uses the root bot)
 *   trigger        each entry of triggers| add an entry (enabled false) / enabled false; "delete" removes the entry
 * `tools.builtin` also holds "skills", which nothing in the engine reads: it is never shown and never removed.
 */
import type { SkillSummary, TriggerInput } from "@eigen/engine/schema";
import type { RootInfo } from "../../lib/types";
import { getPath, setPath, stable, type Draft, type Obj } from "../../lib/client/draft";
import { suggestTokenEnv } from "../../lib/client/telegram";

export type Group = "think" | "tools" | "reach";

export type Ref =
  | { kind: "model" | "instructions" | "soul" | "recent" | "semantic" | "observational" | "workspace" | "schedule" | "telegram" }
  | { kind: "mcp" | "private-mcp"; name: string }
  | { kind: "skill"; slug: string }
  | { kind: "trigger"; id: string };

export type Kind = Ref["kind"];

export const AGENT_NODE = "agent";

/** Node id of a component: "model", "mcp:github", "skill:pdf". The slug and names never contain a newline, so the first ":" splits cleanly. */
export function refId(ref: Ref): string {
  if (ref.kind === "mcp" || ref.kind === "private-mcp") return `${ref.kind}:${ref.name}`;
  if (ref.kind === "skill") return `skill:${ref.slug}`;
  if (ref.kind === "trigger") return `trigger:${ref.id}`;
  return ref.kind;
}

export function parseRef(id: string): Ref | null {
  const i = id.indexOf(":");
  if (i < 0) return ["model", "instructions", "soul", "recent", "semantic", "observational", "workspace", "schedule", "telegram"].includes(id) ? ({ kind: id } as Ref) : null;
  const kind = id.slice(0, i);
  const key = id.slice(i + 1);
  if (kind === "mcp" || kind === "private-mcp") return { kind, name: key };
  if (kind === "skill") return { kind, slug: key };
  if (kind === "trigger") return { kind, id: key };
  return null;
}

export const GROUPS: Record<Group, { title: string; hint: string }> = {
  think: { title: "Thinks with", hint: "What the agent reasons with on every message" },
  tools: { title: "Can use", hint: "What the agent can act with" },
  reach: { title: "Reaches it, wakes it", hint: "How you talk to the agent, and what starts it on its own" },
};

export const KIND_GROUP: Record<Kind, Group> = {
  model: "think",
  instructions: "think",
  soul: "think",
  recent: "think",
  semantic: "think",
  observational: "think",
  workspace: "tools",
  schedule: "tools",
  mcp: "tools",
  "private-mcp": "tools",
  skill: "tools",
  telegram: "reach",
  trigger: "reach",
};

/** What the library tells us about a skill; the builder never needs more. */
export type LibrarySkill = Pick<SkillSummary, "slug" | "name" | "description" | "problem">;

export type Ctx = {
  agentId: string;
  root?: RootInfo;
  skills: LibrarySkill[];
  /** False until the skill library has loaded: a name that is not in `skills` yet is not "missing". */
  skillsKnown?: boolean;
};

export type Item = {
  ref: Ref;
  id: string;
  group: Group;
  connected: boolean;
  /** The noun for what it is ("MCP server", "Skill"), shown small on the node. */
  type: string;
  title: string;
  detail?: string;
  /** Why it cannot be disconnected (model, instructions, the primary's bot). */
  locked?: string;
  /** Why it cannot be connected from here (a root server that is switched off in Settings, a skill that will not load). */
  blocked?: string;
  /** Not offered at all for this agent (the Schedule tool on a specialist). Still shown when the file already lists it, as a no-op that can be removed. */
  unavailable?: string;
  /** Something worth saying about a component that is NOT connected, shown where "Not connected" would be. */
  note?: string;
  /** Connected, but it will not do anything yet (the entry names something that does not exist, or is switched off). */
  inactive?: string;
};

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** The agent as the draft says it is, with the root's defaults filled in the way the engine's resolveAgent does. */
export function readAgent(config: Obj, root?: RootInfo) {
  const primary = config.primary === true;
  const soulSource = getPath(config, "soul.source");
  const includeSoul = getPath(config, "instructions.includeSoul");
  const last = getPath(config, "memory.lastMessages");
  const srEnabled = getPath(config, "memory.semanticRecall.enabled");
  const obsEnabled = getPath(config, "memory.observational.enabled");
  const builtin = getPath(config, "tools.builtin");
  const mcp = getPath(config, "tools.mcp.inherit");
  const skills = getPath(config, "skills.inherit");
  const own = getPath(config, "tools.mcp.servers");
  const triggers = Array.isArray(config.triggers) ? (config.triggers as unknown[]).filter(isObj) : [];
  return {
    primary,
    modelKey: typeof config.model === "string" ? config.model : (root?.defaultModel ?? ""),
    modelInherited: typeof config.model !== "string",
    soul: (soulSource === "shared" || soulSource === "own" || soulSource === "none" ? soulSource : includeSoul === false ? "none" : "shared") as "shared" | "own" | "none",
    lastMessages: typeof last === "number" ? last : (root?.defaults.lastMessages ?? 0),
    semantic: typeof srEnabled === "boolean" ? srEnabled : (root?.defaults.semanticRecall.enabled ?? false),
    observational: typeof obsEnabled === "boolean" ? obsEnabled : (root?.defaults.observational.enabled ?? false),
    builtin: Array.isArray(builtin) ? strings(builtin) : ["workspace"],
    mcpInherit: (mcp === "all" || mcp === "none" || Array.isArray(mcp) ? (Array.isArray(mcp) ? strings(mcp) : mcp) : "none") as "all" | "none" | string[],
    mcpOwn: isObj(own) ? (own as Record<string, Obj>) : {},
    skillsInherit: (skills === "none" || Array.isArray(skills) ? (Array.isArray(skills) ? strings(skills) : skills) : "all") as "all" | "none" | string[],
    telegramEnabled: primary ? true : getPath(config, "telegram.enabled") === true,
    triggers: triggers as Obj[],
  };
}
export type AgentRead = ReturnType<typeof readAgent>;

const rootEnabled = (root?: RootInfo) => (root?.mcpServers ?? []).filter((s) => s.enabled).map((s) => s.name);

/** Root servers this config connects to, with "all" expanded to the enabled ones (what the engine does). */
function connectedRootServers(a: AgentRead, root?: RootInfo): string[] {
  return a.mcpInherit === "all" ? rootEnabled(root) : a.mcpInherit === "none" ? [] : a.mcpInherit;
}

/** Library skills this config connects to; "all" expands to the whole library. Slugs that are not in the library are kept: they are entries the user can remove. */
function connectedSkills(a: AgentRead, ctx: Ctx): string[] {
  return a.skillsInherit === "all" ? ctx.skills.map((s) => s.slug) : a.skillsInherit === "none" ? [] : a.skillsInherit;
}

const oneLine = (s: string, max = 70) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Every component the agent has or could have, connected or not. Cheap even with a big skill library; the canvas decides how many to draw. */
export function deriveItems(draft: Draft, ctx: Ctx): Item[] {
  const { config } = draft;
  const a = readAgent(config, ctx.root);
  const items: Item[] = [];
  const add = (ref: Ref, o: Omit<Item, "ref" | "id" | "group">) => items.push({ ref, id: refId(ref), group: KIND_GROUP[ref.kind], ...o });

  const rootModel = ctx.root?.models.find((m) => m.key === a.modelKey);
  add({ kind: "model" }, {
    connected: true,
    type: "Model",
    title: a.modelKey || "no model",
    detail: `${rootModel ? rootModel.id : "not in the root models"}${a.modelInherited ? " · root default" : ""}`,
    locked: "Every agent has exactly one model. Pick another to swap it.",
  });
  const inline = getPath(config, "instructions.inline");
  const file = (getPath(config, "instructions.file") as string | undefined) ?? "instructions.md";
  const text = typeof inline === "string" ? inline : draft.instructionsText;
  const lines = text ? text.split("\n").length : 0;
  add({ kind: "instructions" }, {
    connected: true,
    type: "Instructions",
    title: "Instructions",
    detail: `${typeof inline === "string" ? "inline in config" : file} · ${lines} ${lines === 1 ? "line" : "lines"}`,
    locked: "Every agent has instructions. Edit them in the panel.",
  });
  add({ kind: "soul" }, { connected: a.soul !== "none", type: "Persona", title: "Soul", detail: a.soul === "none" ? "no persona" : a.soul === "shared" ? "shared · SOUL.md" : `own · ${(getPath(config, "soul.file") as string | undefined) ?? "soul.md"}` });
  // With no recent messages Mastra saves none at all: the thread is not stored, so recall and observation have nothing to work with.
  const stateless = a.lastMessages <= 0;
  const nothingToWorkWith = "Nothing to work with: recent messages are off, so no messages are stored.";
  add({ kind: "recent" }, {
    connected: !stateless,
    type: "Memory",
    title: "Recent messages",
    detail: stateless ? "history off" : `last ${a.lastMessages}`,
    ...(stateless ? { note: "Stateless: this agent keeps nothing from the conversation." } : {}),
  });
  const topK = getPath(config, "memory.semanticRecall.topK") ?? ctx.root?.defaults.semanticRecall.topK;
  add({ kind: "semantic" }, { connected: a.semantic, type: "Memory", title: "Semantic recall", detail: a.semantic ? `top ${String(topK ?? "?")} matches` : "off", ...(a.semantic && stateless ? { inactive: nothingToWorkWith } : {}) });
  add({ kind: "observational" }, { connected: a.observational, type: "Memory", title: "Observational memory", detail: a.observational ? "compresses old turns" : "off", ...(a.observational && stateless ? { inactive: nothingToWorkWith } : {}) });

  add({ kind: "workspace" }, { connected: a.builtin.includes("workspace"), type: "Built-in tool", title: "Workspace", detail: "bash, files, skills" });
  // Only the primary is given the schedule tool (the agent factory never wires it for a specialist); a trigger is how a specialist works on a schedule.
  const scheduled = a.builtin.includes("schedule");
  add({ kind: "schedule" }, {
    connected: scheduled,
    type: "Built-in tool",
    title: "Schedule",
    detail: "reminders, recurring jobs",
    ...(a.primary ? {} : { unavailable: "Only the primary agent can use this tool. To run work on a schedule, give this agent a trigger." }),
    ...(scheduled && !a.primary ? { inactive: "No effect: only the primary agent can use this tool." } : {}),
  });

  const listed = new Set(connectedRootServers(a, ctx.root));
  const catalog = ctx.root?.mcpServers ?? [];
  for (const s of catalog) {
    const on = listed.has(s.name);
    add({ kind: "mcp", name: s.name }, {
      connected: on,
      type: "MCP server",
      title: s.name,
      detail: `shared${s.trusted ? " · trusted" : ""}`,
      ...(on && !s.enabled ? { inactive: "Switched off in Settings, so it is not connected." } : {}),
      // Listing a server that is switched off connects nothing, so it is not offered either; it has to be switched on in Settings first.
      ...(!on && !s.enabled ? { blocked: "Switched off in Settings > Tools. Switch it on there." } : {}),
    });
  }
  // Names the file lists that the root no longer has: shown so they can be disconnected.
  for (const name of Array.isArray(a.mcpInherit) ? a.mcpInherit : [])
    if (!catalog.some((s) => s.name === name)) add({ kind: "mcp", name }, { connected: true, type: "MCP server", title: name, detail: "not in the root catalog", inactive: "The root config has no server with this name." });
  for (const [name, srv] of Object.entries(a.mcpOwn).sort(([x], [y]) => x.localeCompare(y)))
    add({ kind: "private-mcp", name }, {
      connected: true,
      type: "MCP server",
      title: name,
      detail: `private · ${"url" in srv ? "remote" : "local"}${srv.trusted === true ? " · trusted" : ""}`,
      ...(srv.enabled === false ? { inactive: "Switched off in its own settings." } : {}),
    });

  const skillSet = new Set(connectedSkills(a, ctx));
  for (const s of ctx.skills) {
    const on = skillSet.has(s.slug);
    // The engine skips a skill whose frontmatter is invalid or whose name is not its folder name, so it would do nothing.
    const wontLoad = s.problem ? `Won't load: ${s.problem}` : undefined;
    add({ kind: "skill", slug: s.slug }, { connected: on, type: "Skill", title: s.slug, detail: oneLine(s.description), ...(wontLoad ? (on ? { inactive: wontLoad } : { blocked: wontLoad }) : {}) });
  }
  for (const slug of Array.isArray(a.skillsInherit) ? a.skillsInherit : [])
    if (!ctx.skills.some((s) => s.slug === slug))
      add({ kind: "skill", slug }, { connected: true, type: "Skill", title: slug, ...(ctx.skillsKnown === false ? { detail: "loading the library" } : { detail: "not in the library", inactive: "The skill library has no skill with this name." }) });

  add({ kind: "telegram" }, {
    connected: a.telegramEnabled,
    type: "Channel",
    title: "Telegram bot",
    detail: a.primary ? "the root bot" : ((getPath(config, "telegram.tokenEnv") as string | undefined) ?? "no token variable yet"),
    ...(a.primary ? { locked: "The primary always answers on the root bot. Change or remove its token in Settings." } : {}),
  });
  a.triggers.forEach((t) => {
    const id = typeof t.id === "string" ? t.id : "";
    add({ kind: "trigger", id }, {
      connected: t.enabled !== false,
      type: t.type === "github-pr" ? "GitHub trigger" : "Schedule trigger",
      title: id || "unnamed trigger",
      detail: t.type === "github-pr" ? `pull requests · ${String(t.repo ?? "")}` : `cron ${String(t.cron ?? "")}`,
    });
  });
  return items;
}

/* ---------------------------------------------------------------------------------------------- */
/* Connect and disconnect                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const withConfig = (d: Draft, config: Obj): Draft => ({ ...d, config });
const setIn = (d: Draft, path: string, value: unknown) => withConfig(d, setPath(d.config, path, value));

function builtinList(config: Obj): string[] {
  const b = getPath(config, "tools.builtin");
  return Array.isArray(b) ? strings(b) : ["workspace"];
}

/** A short starter so a new own soul is not an empty file; the user rewrites it. */
export const soulStarter = (name: string) => `# ${name}\n\nWho ${name} is: how it speaks, what it cares about, what it never does. This is read before the instructions on every message.\n`;

export function setSoulSource(d: Draft, source: "shared" | "own" | "none", name: string): Draft {
  const next = setIn(d, "soul.source", source);
  // Seed an empty own soul so the editor is not blank; an existing soul.md text is never replaced.
  return source === "own" && next.soulText.trim() === "" ? { ...next, soulText: soulStarter(name) } : next;
}

export function setRootServers(d: Draft, names: string[]): Draft {
  return setIn(d, "tools.mcp.inherit", names.length ? names : "none");
}

export function setSkills(d: Draft, slugs: string[]): Draft {
  return setIn(d, "skills.inherit", slugs.length ? slugs : "none");
}

const lastOrDefault = (config: Obj, ctx: Ctx) => {
  const own = getPath(config, "memory.lastMessages");
  const root = ctx.root?.defaults.lastMessages ?? 0;
  return typeof own === "number" && own > 0 ? own : root > 0 ? root : 20;
};

/** Connects a component that already exists as an option (everything but a new private server or a new trigger, which have their own functions). */
export function connect(d: Draft, ref: Ref, ctx: Ctx): Draft {
  const a = readAgent(d.config, ctx.root);
  const name = typeof d.config.name === "string" && d.config.name ? d.config.name : ctx.agentId;
  switch (ref.kind) {
    case "model":
    case "instructions":
      return d;
    case "soul":
      // The soul text a previous "own" left in the draft or on disk is kept: connecting never wipes it.
      return setSoulSource(d, "shared", name);
    case "recent":
      return setIn(d, "memory.lastMessages", lastOrDefault(d.config, ctx));
    case "semantic":
      return setIn(d, "memory.semanticRecall.enabled", true);
    case "observational":
      return setIn(d, "memory.observational.enabled", true);
    case "workspace":
    case "schedule":
      if (ref.kind === "schedule" && !a.primary) return d; // it would be saved and ignored
      return builtinList(d.config).includes(ref.kind) ? d : setIn(d, "tools.builtin", [...builtinList(d.config), ref.kind]);
    case "mcp":
      return a.mcpInherit === "all" ? d : setRootServers(d, uniq([...connectedRootServers(a, ctx.root), ref.name]));
    case "private-mcp":
      return d;
    case "skill":
      return a.skillsInherit === "all" ? d : setSkills(d, uniq([...connectedSkills(a, ctx), ref.slug]));
    case "telegram": {
      if (a.primary) return d;
      const withToken = getPath(d.config, "telegram.tokenEnv") ? d : setIn(d, "telegram.tokenEnv", suggestTokenEnv(ctx.agentId));
      return setIn(withToken, "telegram.enabled", true);
    }
    case "trigger": {
      const list = Array.isArray(d.config.triggers) ? (d.config.triggers as Obj[]) : [];
      return setIn(d, "triggers", list.map((t) => (t.id === ref.id ? { ...t, enabled: true } : t)));
    }
  }
}

export function disconnect(d: Draft, ref: Ref, ctx: Ctx, base?: Draft): Draft {
  const a = readAgent(d.config, ctx.root);
  switch (ref.kind) {
    case "model":
    case "instructions":
      return d;
    case "soul": {
      const next = setIn(d, "soul.source", "none");
      // A starter the user never touched goes away with the connection; their own words stay (and so does soul.md on disk).
      return base && d.soulText === soulStarter(typeof d.config.name === "string" ? d.config.name : ctx.agentId) ? { ...next, soulText: base.soulText } : next;
    }
    case "recent":
      return setIn(d, "memory.lastMessages", 0);
    case "semantic":
      return setIn(d, "memory.semanticRecall.enabled", false);
    case "observational":
      return setIn(d, "memory.observational.enabled", false);
    case "workspace":
    case "schedule":
      return setIn(d, "tools.builtin", builtinList(d.config).filter((b) => b !== ref.kind));
    case "mcp":
      return setRootServers(d, connectedRootServers(a, ctx.root).filter((n) => n !== ref.name));
    case "private-mcp": {
      const rest = Object.entries(a.mcpOwn).filter(([n]) => n !== ref.name);
      return setIn(d, "tools.mcp.servers", rest.length ? Object.fromEntries(rest) : undefined);
    }
    case "skill":
      return setSkills(d, connectedSkills(a, ctx).filter((s) => s !== ref.slug));
    case "telegram":
      return a.primary ? d : setIn(d, "telegram.enabled", false);
    case "trigger": {
      const list = Array.isArray(d.config.triggers) ? (d.config.triggers as Obj[]) : [];
      return setIn(d, "triggers", list.map((t) => (t.id === ref.id ? { ...t, enabled: false } : t)));
    }
  }
}

/** Connecting this component writes nothing to the file until its panel is filled in (and opens the panel so it can be). */
export const needsSetup = (ref: Ref) => ref.kind === "soul" || ref.kind === "telegram" || ref.kind === "private-mcp" || ref.kind === "trigger";

/** Removing it deletes configuration the user typed (not just a link), so it asks first. */
export const isDestructive = (ref: Ref) => ref.kind === "private-mcp";

/** A private server name that is free in this agent and in the root catalog. */
export function freeServerName(d: Draft, ctx: Ctx): string {
  const taken = new Set([...Object.keys(readAgent(d.config, ctx.root).mcpOwn), ...(ctx.root?.mcpServers ?? []).map((s) => s.name)]);
  for (let i = 1; ; i++) {
    const n = i === 1 ? "server" : `server-${i}`;
    if (!taken.has(n)) return n;
  }
}

/** An empty private server, the way the Inspector's "Add tool server" makes one. Validation asks for the command until it is filled in. */
export function addPrivateServer(d: Draft, ctx: Ctx): { draft: Draft; ref: Ref } {
  const name = freeServerName(d, ctx);
  const own = readAgent(d.config, ctx.root).mcpOwn;
  return { draft: setIn(d, "tools.mcp.servers", { ...own, [name]: { command: "", args: [], enabled: true, trusted: false } }), ref: { kind: "private-mcp", name } };
}

export function freeTriggerId(d: Draft, base: string): string {
  const taken = new Set(readAgent(d.config).triggers.map((t) => t.id));
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

export function addTrigger(d: Draft, trigger: TriggerInput): Draft {
  const list = Array.isArray(d.config.triggers) ? (d.config.triggers as unknown[]) : [];
  return setIn(d, "triggers", [...list, trigger]);
}

export function updateTrigger(d: Draft, id: string, next: TriggerInput): Draft {
  const list = Array.isArray(d.config.triggers) ? (d.config.triggers as Obj[]) : [];
  return setIn(d, "triggers", list.map((t) => (t.id === id ? next : t)));
}

export function removeTrigger(d: Draft, id: string): Draft {
  const list = Array.isArray(d.config.triggers) ? (d.config.triggers as Obj[]) : [];
  const next = list.filter((t) => t.id !== id);
  return setIn(d, "triggers", next.length ? next : undefined);
}

export function renamePrivateServer(d: Draft, from: string, to: string, ctx: Ctx): Draft {
  const own = readAgent(d.config, ctx.root).mcpOwn;
  if (!to || to === from || to in own) return d;
  return setIn(d, "tools.mcp.servers", Object.fromEntries(Object.entries(own).map(([n, v]) => [n === from ? to : n, v])));
}

export function updatePrivateServer(d: Draft, name: string, value: Obj, ctx: Ctx): Draft {
  const own = readAgent(d.config, ctx.root).mcpOwn;
  return setIn(d, "tools.mcp.servers", { ...own, [name]: value });
}

/** Does the agent have a way to be talked to or to deliver to Telegram: its own bot, or (primary) the root bot. */
export const hasBot = (config: Obj) => readAgent(config).telegramEnabled;

/** A trigger's prompt may be steered by someone else's text, so it is risky when the agent can run commands or call a server that is trusted. */
export function isRisky(config: Obj, root?: RootInfo): boolean {
  const a = readAgent(config, root);
  if (a.builtin.includes("workspace")) return true;
  const trusted = new Set((root?.mcpServers ?? []).filter((s) => s.trusted && s.enabled).map((s) => s.name));
  if (connectedRootServers(a, root).some((n) => trusted.has(n))) return true;
  return Object.values(a.mcpOwn).some((s) => s.trusted === true && s.enabled !== false);
}

/* ---------------------------------------------------------------------------------------------- */
/* What changed                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export type Change = { id: string; label: string };

/** Everything about one component that a save would write, as comparable text. */
function slice(d: Draft, ref: Ref): string {
  const c = d.config;
  switch (ref.kind) {
    case "model":
      return stable(c.model ?? null);
    case "instructions":
      return stable([c.instructions ?? null, d.instructionsText]);
    case "soul":
      return stable([c.soul ?? null, d.soulText]);
    case "recent":
      return stable(getPath(c, "memory.lastMessages") ?? null);
    case "semantic":
      return stable(getPath(c, "memory.semanticRecall") ?? null);
    case "observational":
      return stable(getPath(c, "memory.observational") ?? null);
    case "private-mcp":
      return stable(getPath(c, `tools.mcp.servers.${ref.name}`) ?? null);
    case "telegram":
      return stable(c.telegram ?? null);
    case "trigger":
      return stable((Array.isArray(c.triggers) ? (c.triggers as Obj[]) : []).find((t) => t.id === ref.id) ?? null);
    default:
      return "";
  }
}

const AGENT_KEYS = ["name", "role", "description", "enabled", "primary", "limits", "sandbox", "delegation"] as const;
const MODELLED = new Set<string>([...AGENT_KEYS, "model", "instructions", "soul", "memory", "tools", "skills", "telegram", "triggers"]);

/**
 * The staged changes, one line each: what was connected, disconnected or edited. The count is what the Apply bar shows.
 * Anything the components do not cover (hand edits to unknown keys) is one "Other settings" line, so the count is never zero for a dirty draft.
 */
export function describeChanges(base: Draft, draft: Draft, ctx: Ctx): Change[] {
  const before = new Map(deriveItems(base, ctx).map((i) => [i.id, i]));
  const after = new Map(deriveItems(draft, ctx).map((i) => [i.id, i]));
  const out: Change[] = [];
  const push = (id: string, label: string) => out.push({ id, label });
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id);
    const x = after.get(id);
    const ref = (x ?? b)!.ref;
    const title = (x ?? b)!.title;
    if (ref.kind === "trigger") {
      if (!b) push(id, `Added trigger "${title}"`);
      else if (!x) push(id, `Deleted trigger "${title}"`);
      else if (b.connected !== x.connected) push(id, `${x.connected ? "Switched on" : "Switched off"} trigger "${title}"`);
      else if (slice(base, ref) !== slice(draft, ref)) push(id, `Edited trigger "${title}"`);
      continue;
    }
    if (ref.kind === "private-mcp") {
      if (!b?.connected && x?.connected) push(id, `Added MCP server "${title}"`);
      else if (b?.connected && !x?.connected) push(id, `Removed MCP server "${title}"`);
      else if (slice(base, ref) !== slice(draft, ref)) push(id, `Edited MCP server "${title}"`);
      continue;
    }
    const was = !!b?.connected;
    const now = !!x?.connected;
    if (ref.kind === "model") {
      if (slice(base, ref) !== slice(draft, ref)) push(id, `Model: ${b?.title} to ${x?.title}`);
    } else if (was !== now) push(id, `${now ? "Connected" : "Disconnected"} ${title}`);
    else if (slice(base, ref) !== slice(draft, ref)) push(id, `Changed ${title.toLowerCase()}`);
  }
  const touched: string[] = AGENT_KEYS.filter((k) => stable(base.config[k] ?? null) !== stable(draft.config[k] ?? null));
  if (stable(getPath(base.config, "memory.scope") ?? null) !== stable(getPath(draft.config, "memory.scope") ?? null)) touched.push("memory scope");
  if (touched.length) push("agent", `Changed agent settings: ${touched.join(", ")}`);
  const rest = (c: Obj) => stable(Object.fromEntries(Object.entries(c).filter(([k]) => !MODELLED.has(k))));
  if (rest(base.config) !== rest(draft.config)) push("other", "Other settings");
  if (!out.length && stable(base.config) !== stable(draft.config)) push("other", "Other settings");
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Which problem belongs to which node                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** Spreads validation messages (keyed by config path) over the nodes they belong to, so the node that is wrong says so. */
export function issuesByNode(errors: Record<string, string>, config: Obj): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const triggers = Array.isArray(config.triggers) ? (config.triggers as Obj[]) : [];
  const put = (node: string, msg: string) => (out[node] ??= []).push(msg);
  for (const [path, msg] of Object.entries(errors)) {
    const quoted = /"([^"]+)"/.exec(msg)?.[1];
    if (path === "model") put("model", msg);
    else if (path.startsWith("instructions")) put("instructions", msg);
    else if (path.startsWith("soul")) put("soul", msg);
    else if (path === "memory.lastMessages") put("recent", msg);
    else if (path.startsWith("memory.semanticRecall")) put("semantic", msg);
    else if (path.startsWith("memory.observational")) put("observational", msg);
    else if (path.startsWith("telegram")) put("telegram", msg);
    else if (path === "tools.mcp.inherit" && quoted) put(`mcp:${quoted}`, msg);
    else if (path.startsWith("tools.mcp.servers.")) put(`private-mcp:${path.slice("tools.mcp.servers.".length).split(".")[0]}`, msg);
    else if (path === "skills.inherit" && quoted) put(`skill:${quoted}`, msg);
    else if (/^triggers\.\d+/.test(path)) {
      const id = triggers[Number(path.split(".")[1])]?.id;
      put(typeof id === "string" ? `trigger:${id}` : AGENT_NODE, msg);
    } else put(AGENT_NODE, msg);
  }
  return out;
}
