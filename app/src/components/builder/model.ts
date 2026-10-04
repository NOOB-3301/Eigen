/**
 * The builder's model: how ONE agent's config.json reads as COMPONENTS, and what connecting or disconnecting one writes.
 * Pure (no React, no `@/` imports) so it is tested directly; the canvas and the panels only call into it.
 * Every agent is standalone: nothing here is inherited from anywhere, an absent key means the schema default (DEFAULTS below).
 *
 * The canvas is a chain: memory blocks -> storage -> LLM -> agent, with everything else plugged into the agent.
 *
 * | kind           | connected when                           | connect / disconnect writes                                                     | panel edits |
 * |----------------|------------------------------------------|---------------------------------------------------------------------------------|-------------|
 * | llm            | always, edge to agent                    | cannot disconnect                                                               | `models` catalog (key, id, url, apiKeyEnv, contextWindow, replyReserve), `model`, key status + write-only key, Test (saved config). Removing a model something uses is refused |
 * | storage        | memory.storage.enabled, edge to llm      | true / false. Disconnecting turns every memory block off too (asked first)      | local memory.db or remote url + authTokenEnv + write-only token; changing it warns |
 * | lastMessages   | memory.lastMessages.enabled, to storage  | true / false; connecting turns storage on                                       | count |
 * | workingMemory  | memory.workingMemory.enabled, to storage | same                                                                            | scope, template |
 * | semanticRecall | memory.semanticRecall.enabled, to storage| same; disconnecting also disconnects subconscious                               | topK, messageRange, scope, embedder |
 * | observational  | memory.observational.enabled, to storage | same; disconnecting also disconnects subconscious                               | model, messageTokens, reflectionTokens, activateAfterIdle, retrieval |
 * | subconscious   | memory.subconscious.enabled, edges to semanticRecall AND observational | connecting turns on semantic recall, observational and storage | model, pins, tools, maxPins, maxCharacters |
 * | instructions   | always                                   | -                                                                               | instructionsText |
 * | soul           | soul.enabled                             | true / false (the soul file stays on disk)                                      | soulText |
 * | workspace      | tools.builtin has it                     | add / remove                                                                    | the sandbox policy (sandbox.*) |
 * | schedule       | tools.builtin has it                     | add / remove                                                                    | - |
 * | mcp:<name>     | key in tools.mcp and enabled             | add entry / enabled: false; "delete" removes the key (asked first)              | mcp-form |
 * | skill:<slug>   | skills.enabled is "all" or lists it      | an explicit list ("all" is expanded to the agent's own library first)           | the agent's own skill library |
 * | telegram       | telegram.enabled                         | true / false (allowedUserIds is required to enable; validation says so)         | allowedUserIds, tokenEnv, write-only token, Check |
 * | trigger:<id>   | each entry of triggers (and enabled)     | add (enabled false) / enabled false; "delete" removes the entry                 | trigger form, GitHub check, write-only token |
 * | agent          | -                                        | -                                                                               | name, role, description, timezone, limits.maxSteps, enabled |
 */
import { AgentConfigSchema, MEMORY_BLOCKS, newAgentConfig, type MemoryBlock, type SkillSummary, type TriggerInput } from "@eigen/engine/schema";
import { getPath, setPath, stable, type Draft, type Obj } from "../../lib/client/draft";

export type Group = "think" | "memory" | "tools" | "reach";

type Simple = "llm" | "storage" | MemoryBlock | "instructions" | "soul" | "workspace" | "schedule" | "telegram";
export type Ref = { kind: Simple } | { kind: "mcp"; name: string } | { kind: "skill"; slug: string } | { kind: "trigger"; id: string };
export type Kind = Ref["kind"];

export const AGENT_NODE = "agent";
const SIMPLE: Simple[] = ["llm", "storage", ...MEMORY_BLOCKS, "instructions", "soul", "workspace", "schedule", "telegram"];

/** What the schema fills in for an absent key: a config with nothing but the required fields, parsed. */
export const DEFAULTS = AgentConfigSchema.parse(newAgentConfig({ id: "defaults", name: "defaults", model: { id: "provider/model" } })) as unknown as Obj;

/** The value at `path`, or the schema default when the draft does not set it. */
export const eff = (config: Obj, path: string): unknown => getPath(config, path) ?? getPath(DEFAULTS, path);

/** Node id of a component: "llm", "mcp:github", "skill:@owner/pdf". The first ":" splits kind from key. */
export function refId(ref: Ref): string {
  if (ref.kind === "mcp") return `mcp:${ref.name}`;
  if (ref.kind === "skill") return `skill:${ref.slug}`;
  if (ref.kind === "trigger") return `trigger:${ref.id}`;
  return ref.kind;
}

export function parseRef(id: string): Ref | null {
  const i = id.indexOf(":");
  if (i < 0) return (SIMPLE as string[]).includes(id) ? ({ kind: id } as Ref) : null;
  const kind = id.slice(0, i);
  const key = id.slice(i + 1);
  if (kind === "mcp") return { kind, name: key };
  if (kind === "skill") return { kind, slug: key };
  if (kind === "trigger") return { kind, id: key };
  return null;
}

export const KIND_GROUP: Record<Kind, Group> = {
  llm: "think",
  instructions: "think",
  soul: "think",
  storage: "memory",
  lastMessages: "memory",
  workingMemory: "memory",
  semanticRecall: "memory",
  observational: "memory",
  subconscious: "memory",
  workspace: "tools",
  schedule: "tools",
  mcp: "tools",
  skill: "tools",
  telegram: "reach",
  trigger: "reach",
};

export const MEMORY_TITLE: Record<MemoryBlock, string> = {
  lastMessages: "Last messages",
  workingMemory: "Working memory",
  semanticRecall: "Semantic recall",
  observational: "Observational memory",
  subconscious: "Subconscious",
};

/** What the agent's library tells us about a skill; the builder never needs more. */
export type LibrarySkill = Pick<SkillSummary, "slug" | "name" | "description" | "problem">;

export type Ctx = {
  agentId: string;
  /** This agent's own skill library. */
  skills: LibrarySkill[];
  /** False until the library has loaded: a slug that is not in `skills` yet is not "missing". */
  skillsKnown?: boolean;
};

export type Item = {
  ref: Ref;
  id: string;
  group: Group;
  connected: boolean;
  /** The noun for what it is ("MCP server", "Memory"), shown small on the node. */
  type: string;
  title: string;
  detail?: string;
  /** The nodes its edge runs to while it is connected: "agent", "llm", "storage", or both recall blocks for the subconscious. */
  targets: string[];
  /** Why it cannot be disconnected (llm, instructions). */
  locked?: string;
  /** Why it cannot be connected from here (a skill that will not load). */
  blocked?: string;
  /** Something worth saying about a component that is NOT connected, shown where "Not connected" would be. */
  note?: string;
  /** Connected, but it will not do anything (it names something that does not exist, or what it needs is off). */
  inactive?: string;
};

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const oneLine = (s: string, max = 70) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The agent as the draft says it is, with the schema's defaults filled in. */
export function readAgent(config: Obj) {
  const skills = getPath(config, "skills.enabled");
  const builtin = getPath(config, "tools.builtin");
  const mcp = getPath(config, "tools.mcp");
  return {
    modelKey: typeof config.model === "string" ? config.model : "",
    models: (isObj(config.models) ? config.models : {}) as Record<string, Obj>,
    storage: eff(config, "memory.storage.enabled") === true,
    blocks: Object.fromEntries(MEMORY_BLOCKS.map((b) => [b, eff(config, `memory.${b}.enabled`) === true])) as Record<MemoryBlock, boolean>,
    soul: eff(config, "soul.enabled") === true,
    builtin: strings(Array.isArray(builtin) ? builtin : getPath(DEFAULTS, "tools.builtin")),
    mcp: (isObj(mcp) ? mcp : {}) as Record<string, Obj>,
    skills: (Array.isArray(skills) ? strings(skills) : "all") as "all" | string[],
    telegram: eff(config, "telegram.enabled") === true,
    triggers: (Array.isArray(config.triggers) ? (config.triggers as unknown[]).filter(isObj) : []) as Obj[],
  };
}
export type AgentRead = ReturnType<typeof readAgent>;

/** Library skills this config loads; "all" expands to the whole library. Listed slugs that are not in the library are kept (removable entries). */
function connectedSkills(a: AgentRead, ctx: Ctx): string[] {
  return a.skills === "all" ? ctx.skills.map((s) => s.slug) : a.skills;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Every component the agent has or could have, connected or not. The canvas decides how many to draw. */
export function deriveItems(draft: Draft, ctx: Ctx): Item[] {
  const { config } = draft;
  const a = readAgent(config);
  const items: Item[] = [];
  const add = (ref: Ref, o: Omit<Item, "ref" | "id" | "group">) => items.push({ ref, id: refId(ref), group: KIND_GROUP[ref.kind], ...o });

  const entry = a.models[a.modelKey];
  const count = Object.keys(a.models).length;
  add({ kind: "llm" }, {
    connected: true,
    type: "LLM",
    title: a.modelKey || "no model",
    detail: `${typeof entry?.id === "string" ? entry.id : "not in the models"}${count > 1 ? ` · ${count} models` : ""}`,
    targets: [AGENT_NODE],
    locked: "Every agent thinks with one of its models. Pick another one to swap it.",
  });

  const url = getPath(config, "memory.storage.url");
  add({ kind: "storage" }, {
    connected: a.storage,
    type: "Storage",
    title: "Storage",
    detail: typeof url === "string" && url ? `remote · ${hostOf(url)}` : "memory.db in the agent folder",
    targets: ["llm"],
    ...(a.storage ? {} : { note: "Stateless: the agent keeps nothing between messages." }),
  });

  const scope = (b: MemoryBlock) => (eff(config, `memory.${b}.scope`) === "thread" ? "per chat" : "per person");
  const obsModel = getPath(config, "memory.observational.model");
  const subModel = getPath(config, "memory.subconscious.model");
  const details: Record<MemoryBlock, string> = {
    lastMessages: `last ${String(eff(config, "memory.lastMessages.count"))}`,
    workingMemory: `notes about the person · ${scope("workingMemory")}`,
    semanticRecall: `top ${String(eff(config, "memory.semanticRecall.topK"))} · ${String(eff(config, "memory.semanticRecall.embedder.id"))}`,
    observational: `observer: ${typeof obsModel === "string" ? obsModel : "the agent's model"}`,
    subconscious: `curator: ${typeof subModel === "string" ? subModel : "the observer's model"}`,
  };
  for (const b of MEMORY_BLOCKS) {
    const on = a.blocks[b];
    const missing = b === "subconscious" && on && (!a.blocks.semanticRecall || !a.blocks.observational);
    add({ kind: b }, {
      connected: on,
      type: "Memory",
      title: MEMORY_TITLE[b],
      detail: on ? details[b] : "off",
      targets: b === "subconscious" ? ["semanticRecall", "observational"] : ["storage"],
      ...(on && !a.storage ? { inactive: "Storage is off, so this has nowhere to keep anything." } : missing ? { inactive: "Needs semantic recall and observational memory." } : {}),
    });
  }

  const inline = getPath(config, "instructions.inline");
  const file = (getPath(config, "instructions.file") as string | undefined) ?? "instructions.md";
  const text = typeof inline === "string" ? inline : draft.instructionsText;
  const lines = text ? text.split("\n").length : 0;
  add({ kind: "instructions" }, {
    connected: true,
    type: "Instructions",
    title: "Instructions",
    detail: `${typeof inline === "string" ? "inline in config" : file} · ${lines} ${lines === 1 ? "line" : "lines"}`,
    targets: [AGENT_NODE],
    locked: "Every agent has instructions. Edit them in the panel.",
  });
  add({ kind: "soul" }, { connected: a.soul, type: "Persona", title: "Soul", detail: a.soul ? String(eff(config, "soul.file")) : "no persona", targets: [AGENT_NODE] });

  add({ kind: "workspace" }, { connected: a.builtin.includes("workspace"), type: "Built-in tool", title: "Workspace", detail: `bash, files, skills · sandbox ${String(eff(config, "sandbox.isolation"))}`, targets: [AGENT_NODE] });
  add({ kind: "schedule" }, { connected: a.builtin.includes("schedule"), type: "Built-in tool", title: "Schedule", detail: "reminders, recurring jobs", targets: [AGENT_NODE] });

  for (const [name, srv] of Object.entries(a.mcp).sort(([x], [y]) => x.localeCompare(y)))
    add({ kind: "mcp", name }, { connected: srv.enabled !== false, type: "MCP server", title: name, detail: `${"url" in srv ? "remote" : "local"}${srv.trusted === true ? " · trusted" : ""}`, targets: [AGENT_NODE] });

  const skillSet = new Set(connectedSkills(a, ctx));
  for (const s of ctx.skills) {
    const on = skillSet.has(s.slug);
    // The engine skips a skill whose frontmatter is invalid or whose name is not its folder name, so it would do nothing.
    const wontLoad = s.problem ? `Won't load: ${s.problem}` : undefined;
    add({ kind: "skill", slug: s.slug }, { connected: on, type: "Skill", title: s.slug, detail: oneLine(s.description), targets: [AGENT_NODE], ...(wontLoad ? (on ? { inactive: wontLoad } : { blocked: wontLoad }) : {}) });
  }
  for (const slug of a.skills === "all" ? [] : a.skills)
    if (!ctx.skills.some((s) => s.slug === slug))
      add({ kind: "skill", slug }, {
        connected: true,
        type: "Skill",
        title: slug,
        targets: [AGENT_NODE],
        ...(ctx.skillsKnown === false ? { detail: "loading the library" } : { detail: "not in the library", inactive: "This agent's skill library has no skill with this name." }),
      });

  add({ kind: "telegram" }, { connected: a.telegram, type: "Channel", title: "Telegram bot", detail: String(eff(config, "telegram.tokenEnv")), targets: [AGENT_NODE] });
  for (const t of a.triggers) {
    const id = typeof t.id === "string" ? t.id : "";
    add({ kind: "trigger", id }, {
      connected: t.enabled !== false,
      type: t.type === "github-pr" ? "GitHub trigger" : "Schedule trigger",
      title: id || "unnamed trigger",
      detail: t.type === "github-pr" ? `pull requests · ${String(t.repo ?? "")}` : `cron ${String(t.cron ?? "")}`,
      targets: [AGENT_NODE],
    });
  }
  return items;
}

/* ---------------------------------------------------------------------------------------------- */
/* Connect and disconnect                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const setIn = (d: Draft, path: string, value: unknown): Draft => ({ ...d, config: setPath(d.config, path, value) });
/** Writes `enabled` only where it changes what the agent does, so turning off what is already off leaves no noise in the file. */
const setOn = (d: Draft, path: string, on: boolean): Draft => (eff(d.config, `${path}.enabled`) === on ? d : setIn(d, `${path}.enabled`, on));

/** A short starter so a new soul is not an empty file; the user rewrites it. */
export const soulStarter = (name: string) => `# ${name}\n\nWho ${name} is: how it speaks, what it cares about, what it never does. This is read before the instructions on every message.\n`;

export const setSkills = (d: Draft, slugs: string[]): Draft => setIn(d, "skills.enabled", slugs);

const triggerList = (d: Draft) => (Array.isArray(d.config.triggers) ? (d.config.triggers as Obj[]) : []);
const agentName = (d: Draft, ctx: Ctx) => (typeof d.config.name === "string" && d.config.name ? d.config.name : ctx.agentId);

/** Connects a component that exists as an option (a new MCP server or trigger has its own function). */
export function connect(d: Draft, ref: Ref, ctx: Ctx): Draft {
  const a = readAgent(d.config);
  switch (ref.kind) {
    case "llm":
    case "instructions":
      return d;
    case "storage":
      return setOn(d, "memory.storage", true);
    case "lastMessages":
    case "workingMemory":
    case "semanticRecall":
    case "observational":
      return setOn(setOn(d, "memory.storage", true), `memory.${ref.kind}`, true);
    case "subconscious": {
      // It curates from both recall blocks, so it brings them (and the storage under them) along.
      let next = setOn(d, "memory.storage", true);
      for (const b of ["semanticRecall", "observational", "subconscious"] as const) next = setOn(next, `memory.${b}`, true);
      return next;
    }
    case "soul": {
      const next = setOn(d, "soul", true);
      // Seed an empty soul so the editor is not blank; an existing soul text is never replaced.
      return next.soulText.trim() === "" ? { ...next, soulText: soulStarter(agentName(d, ctx)) } : next;
    }
    case "workspace":
    case "schedule":
      return a.builtin.includes(ref.kind) ? d : setIn(d, "tools.builtin", [...a.builtin, ref.kind]);
    case "mcp":
      // enabled defaults to true, so switching a server back on removes the key.
      return a.mcp[ref.name] ? setIn(d, `tools.mcp.${ref.name}.enabled`, undefined) : d;
    case "skill":
      return a.skills === "all" ? d : setSkills(d, uniq([...a.skills, ref.slug]));
    case "telegram":
      return setOn(d, "telegram", true);
    case "trigger":
      return setIn(d, "triggers", triggerList(d).map((t) => (t.id === ref.id ? { ...t, enabled: true } : t)));
  }
}

export function disconnect(d: Draft, ref: Ref, ctx: Ctx, base?: Draft): Draft {
  const a = readAgent(d.config);
  switch (ref.kind) {
    case "llm":
    case "instructions":
      return d;
    case "storage": {
      // The schema refuses memory blocks without storage, so they all go with it.
      let next = setOn(d, "memory.storage", false);
      for (const b of MEMORY_BLOCKS) next = setOn(next, `memory.${b}`, false);
      return next;
    }
    case "semanticRecall":
    case "observational":
      return setOn(setOn(d, `memory.${ref.kind}`, false), "memory.subconscious", false);
    case "lastMessages":
    case "workingMemory":
    case "subconscious":
      return setOn(d, `memory.${ref.kind}`, false);
    case "soul": {
      const next = setOn(d, "soul", false);
      // A starter the user never touched goes away with the connection; their own words stay (and so does the file on disk).
      return base && d.soulText === soulStarter(agentName(d, ctx)) ? { ...next, soulText: base.soulText } : next;
    }
    case "workspace":
    case "schedule":
      return setIn(d, "tools.builtin", a.builtin.filter((b) => b !== ref.kind));
    case "mcp":
      return a.mcp[ref.name] ? setIn(d, `tools.mcp.${ref.name}.enabled`, false) : d;
    case "skill":
      return setSkills(d, connectedSkills(a, ctx).filter((s) => s !== ref.slug));
    case "telegram":
      return setOn(d, "telegram", false);
    case "trigger":
      return setIn(d, "triggers", triggerList(d).map((t) => (t.id === ref.id ? { ...t, enabled: false } : t)));
  }
}

/** Connecting it opens its panel, because it needs something filled in to work (a persona, allowed users, a trigger's prompt). */
export const needsSetup = (ref: Ref) => ref.kind === "soul" || ref.kind === "telegram" || ref.kind === "trigger";

/** Disconnecting it asks first, with this sentence: it takes more with it than the one node. Null: just do it. */
export function disconnectWarning(d: Draft, ref: Ref): string | null {
  if (ref.kind !== "storage") return null;
  const a = readAgent(d.config);
  const on = MEMORY_BLOCKS.filter((b) => a.blocks[b]).map((b) => MEMORY_TITLE[b].toLowerCase());
  return `The agent will keep nothing between messages.${on.length ? ` This also turns off ${on.join(", ")}.` : ""} What is already stored stays where it is.`;
}

/* ---- MCP servers ---- */

export function freeMcpName(d: Draft): string {
  const taken = new Set(Object.keys(readAgent(d.config).mcp));
  for (let i = 1; ; i++) {
    const n = i === 1 ? "server" : `server-${i}`;
    if (!taken.has(n)) return n;
  }
}

/** An empty local server. Validation asks for the command until it is filled in. */
export function addMcpServer(d: Draft): { draft: Draft; ref: Ref } {
  const name = freeMcpName(d);
  return { draft: setIn(d, "tools.mcp", { ...readAgent(d.config).mcp, [name]: { command: "", args: [] } }), ref: { kind: "mcp", name } };
}

export const updateMcpServer = (d: Draft, name: string, value: Obj): Draft => setIn(d, "tools.mcp", { ...readAgent(d.config).mcp, [name]: value });

/** Renames in place (same order). Refused (unchanged draft) for an empty or taken name. */
export function renameMcpServer(d: Draft, from: string, to: string): Draft {
  const own = readAgent(d.config).mcp;
  if (!to || to === from || to in own) return d;
  return setIn(d, "tools.mcp", Object.fromEntries(Object.entries(own).map(([n, v]) => [n === from ? to : n, v])));
}

export function removeMcpServer(d: Draft, name: string): Draft {
  const rest = Object.entries(readAgent(d.config).mcp).filter(([n]) => n !== name);
  return setIn(d, "tools.mcp", rest.length ? Object.fromEntries(rest) : undefined);
}

/* ---- triggers ---- */

export function freeTriggerId(d: Draft, base: string): string {
  const taken = new Set(readAgent(d.config).triggers.map((t) => t.id));
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

export const addTrigger = (d: Draft, trigger: TriggerInput): Draft => setIn(d, "triggers", [...triggerList(d), trigger]);

export const updateTrigger = (d: Draft, id: string, next: TriggerInput): Draft => setIn(d, "triggers", triggerList(d).map((t) => (t.id === id ? next : t)));

export function removeTrigger(d: Draft, id: string): Draft {
  const next = triggerList(d).filter((t) => t.id !== id);
  return setIn(d, "triggers", next.length ? next : undefined);
}

/* ---- models (the LLM node) ---- */

/** Who uses a model key, in words: what removing it would break. */
export function modelUsers(config: Obj, key: string): string[] {
  return [
    config.model === key && "the agent's model",
    getPath(config, "memory.observational.model") === key && "the observer of observational memory",
    getPath(config, "memory.subconscious.model") === key && "the subconscious",
  ].filter((x): x is string => !!x);
}

export function freeModelKey(d: Draft, base: string): string {
  const taken = readAgent(d.config).models;
  if (!(base in taken)) return base;
  for (let i = 2; ; i++) if (!(`${base}-${i}` in taken)) return `${base}-${i}`;
}

export const setModel = (d: Draft, key: string, entry: Obj): Draft => setIn(d, "models", { ...readAgent(d.config).models, [key]: entry });

/** Removes a model, or says why it cannot: something still uses it, or it is the last one. */
export function removeModel(d: Draft, key: string): { draft: Draft } | { error: string } {
  const users = modelUsers(d.config, key);
  if (users.length) return { error: `${key} is used as ${users.join(" and ")}. Pick another model there first.` };
  const rest = Object.entries(readAgent(d.config).models).filter(([k]) => k !== key);
  if (!rest.length) return { error: "An agent needs at least one model." };
  return { draft: setIn(d, "models", Object.fromEntries(rest)) };
}

/** Renames a model key and every reference to it. Refused (unchanged draft) for an empty or taken key. */
export function renameModel(d: Draft, from: string, to: string): Draft {
  const models = readAgent(d.config).models;
  if (!to || to === from || to in models || !(from in models)) return d;
  let next = setIn(d, "models", Object.fromEntries(Object.entries(models).map(([k, v]) => [k === from ? to : k, v])));
  if (next.config.model === from) next = setIn(next, "model", to);
  for (const p of ["memory.observational.model", "memory.subconscious.model"]) if (getPath(next.config, p) === from) next = setIn(next, p, to);
  return next;
}

/** True when a save would point the agent at a different database: it starts with an empty memory, and the old one stays where it was. */
export function storageMoved(base: Draft, draft: Draft): boolean {
  const where = (d: Draft) => (getPath(d.config, "memory.storage.url") as string | undefined) ?? "";
  return where(base) !== where(draft);
}

/** A trigger's prompt may be steered by someone else's text, so it is risky when the agent can run commands or call a trusted server. */
export function isRisky(config: Obj): boolean {
  const a = readAgent(config);
  return a.builtin.includes("workspace") || Object.values(a.mcp).some((s) => s.trusted === true && s.enabled !== false);
}

/* ---------------------------------------------------------------------------------------------- */
/* What changed                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export type Change = { id: string; label: string };

/** Everything about one component that a save would write, as comparable text. */
function slice(d: Draft, ref: Ref): string {
  const c = d.config;
  switch (ref.kind) {
    case "llm":
      return stable([c.model ?? null, c.models ?? null]);
    case "instructions":
      return stable([c.instructions ?? null, d.instructionsText]);
    case "soul":
      return stable([c.soul ?? null, d.soulText]);
    case "storage":
    case "lastMessages":
    case "workingMemory":
    case "semanticRecall":
    case "observational":
    case "subconscious":
      return stable(getPath(c, `memory.${ref.kind}`) ?? null);
    case "workspace":
      return stable(c.sandbox ?? null);
    case "mcp":
      return stable(getPath(c, `tools.mcp.${ref.name}`) ?? null);
    case "telegram":
      return stable(c.telegram ?? null);
    case "trigger":
      return stable(triggerList(d).find((t) => t.id === ref.id) ?? null);
    default:
      return "";
  }
}

const AGENT_KEYS = ["name", "role", "description", "enabled", "timezone", "limits"] as const;
const MODELLED = new Set<string>([...AGENT_KEYS, "model", "models", "instructions", "soul", "memory", "tools", "skills", "sandbox", "telegram", "triggers"]);

/**
 * The staged changes, one line each. The count is what the Apply bar shows.
 * Anything the components do not cover is one "Other settings" line, so the count is never zero for a dirty draft.
 */
export function describeChanges(base: Draft, draft: Draft, ctx: Ctx): Change[] {
  const before = new Map(deriveItems(base, ctx).map((i) => [i.id, i]));
  const after = new Map(deriveItems(draft, ctx).map((i) => [i.id, i]));
  const out: Change[] = [];
  const push = (id: string, label: string) => out.push({ id, label });
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id);
    const x = after.get(id);
    const { ref, title } = (x ?? b)!;
    if (ref.kind === "trigger" || ref.kind === "mcp") {
      const noun = ref.kind === "trigger" ? "trigger" : "MCP server";
      if (!b) push(id, `Added ${noun} "${title}"`);
      else if (!x) push(id, `Deleted ${noun} "${title}"`);
      else if (b.connected !== x.connected) push(id, `${x.connected ? "Switched on" : "Switched off"} ${noun} "${title}"`);
      else if (slice(base, ref) !== slice(draft, ref)) push(id, `Edited ${noun} "${title}"`);
      continue;
    }
    if (ref.kind === "llm") {
      if (b?.title !== x?.title) push(id, `Model: ${b?.title} to ${x?.title}`);
      else if (slice(base, ref) !== slice(draft, ref)) push(id, "Changed models");
      continue;
    }
    const was = !!b?.connected;
    const now = !!x?.connected;
    if (was !== now) push(id, `${now ? "Connected" : "Disconnected"} ${title}`);
    else if (slice(base, ref) !== slice(draft, ref)) push(id, `Changed ${ref.kind === "workspace" ? "sandbox" : title.toLowerCase()}`);
  }
  // "all" written out as the same list changes the file but no node.
  if (stable(base.config.skills ?? null) !== stable(draft.config.skills ?? null) && !out.some((c) => c.id.startsWith("skill:"))) push("skills", "Changed skill selection");
  const touched: string[] = AGENT_KEYS.filter((k) => stable(base.config[k] ?? null) !== stable(draft.config[k] ?? null));
  if (stable(getPath(base.config, "tools.mcpStartupTimeoutMs") ?? null) !== stable(getPath(draft.config, "tools.mcpStartupTimeoutMs") ?? null)) touched.push("MCP startup timeout");
  if (touched.length) push(AGENT_NODE, `Changed agent settings: ${touched.join(", ")}`);
  const rest = (c: Obj) => stable(Object.fromEntries(Object.entries(c).filter(([k]) => !MODELLED.has(k))));
  if (rest(base.config) !== rest(draft.config)) push("other", "Other settings");
  if (!out.length && stable(base.config) !== stable(draft.config)) push("other", "Other settings");
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Which problem belongs to which node                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** The node a dotted config path belongs to. `triggers.<n>` may be an index (zod) or an id (agentProblems). */
export function nodeOfPath(path: string, config: Obj): string {
  const [head, second, third] = path.split(".");
  if (head === "model" || head === "models") return "llm";
  if (head === "memory") return second && (MEMORY_BLOCKS as readonly string[]).includes(second) ? second : "storage";
  if (head === "instructions") return "instructions";
  if (head === "soul") return "soul";
  if (head === "sandbox") return "workspace";
  if (head === "tools" && second === "mcp" && third) return `mcp:${third}`;
  if (head === "telegram") return "telegram";
  if (head === "triggers" && second !== undefined) {
    const list = Array.isArray(config.triggers) ? (config.triggers as Obj[]) : [];
    const id = /^\d+$/.test(second) ? list[Number(second)]?.id : second;
    return typeof id === "string" && list.some((t) => t.id === id) ? `trigger:${id}` : AGENT_NODE;
  }
  return AGENT_NODE;
}

/** Spreads validation messages (keyed by config path) over the nodes they belong to, so the node that is wrong says so. */
export function issuesByNode(errors: Record<string, string>, config: Obj): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, msg] of Object.entries(errors)) (out[nodeOfPath(path, config)] ??= []).push(msg);
  return out;
}

/**
 * The engine's problems (runtime.problems) by node. They are sentences: "<path>: message", "<path> is already used by ...", or a missing key
 * naming where it is used in brackets ("ANTHROPIC_API_KEY is not set in this agent's keys (models.main, memory.semanticRecall.embedder)").
 * A problem nobody can place stays on the agent.
 */
export function problemsByNode(problems: string[], config: Obj): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const put = (node: string, msg: string) => {
    const list = (out[node] ??= []);
    if (!list.includes(msg)) list.push(msg);
  };
  for (const p of problems) {
    const where = /\(([\w.@/-]+(?:, [\w.@/-]+)*)\)$/.exec(p)?.[1];
    if (where) {
      for (const w of where.split(", ")) put(nodeOfPath(w, config), p);
      continue;
    }
    const path = /^([A-Za-z][\w-]*(?:\.[\w@/-]+)*):\s/.exec(p)?.[1] ?? /^([a-z][\w-]*(?:\.[\w@/-]+)+)\s/.exec(p)?.[1];
    put(path ? nodeOfPath(path, config) : AGENT_NODE, p);
  }
  return out;
}
