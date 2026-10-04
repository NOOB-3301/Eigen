import { describe, expect, it } from "vitest";
import type { RootInfo } from "../../lib/types";
import type { Draft } from "../../lib/client/draft";
import {
  addPrivateServer,
  addTrigger,
  connect,
  deriveItems,
  describeChanges,
  disconnect,
  freeTriggerId,
  isRisky,
  issuesByNode,
  parseRef,
  refId,
  removeTrigger,
  renamePrivateServer,
  setSoulSource,
  soulStarter,
  type Ctx,
  type Ref,
} from "./model";

const root: RootInfo = {
  defaultModel: "fast",
  models: [
    { key: "fast", id: "provider/fast" },
    { key: "smart", id: "provider/smart" },
  ],
  mcpServers: [
    { name: "github", enabled: true, trusted: false },
    { name: "files", enabled: true, trusted: true },
    { name: "old", enabled: false, trusted: false },
  ],
  defaults: { maxSteps: 25, lastMessages: 20, semanticRecall: { enabled: false, topK: 4, messageRange: 2 }, observational: { enabled: false } },
};
const skills = [
  { slug: "pdf", name: "pdf", description: "Read and write PDFs" },
  { slug: "web", name: "web", description: "Browse the web" },
  { slug: "sql", name: "sql", description: "Query a database" },
];
const ctx: Ctx = { agentId: "scout", root, skills };

const draft = (config: Record<string, unknown> = {}, extra: Partial<Draft> = {}): Draft => ({
  config: { id: "scout", name: "Scout", role: "researcher", description: "Finds things.", ...config },
  instructionsText: "You are Scout.\n",
  soulText: "",
  ...extra,
});
const on = (d: Draft, kind: Ref["kind"], key?: string) => {
  const ref = (key === undefined ? { kind } : kind === "skill" ? { kind, slug: key } : kind === "trigger" ? { kind, id: key } : { kind, name: key }) as Ref;
  return deriveItems(d, ctx).find((i) => i.id === refId(ref))?.connected;
};

describe("refs", () => {
  it("round-trips every kind through its node id", () => {
    const refs: Ref[] = [{ kind: "model" }, { kind: "soul" }, { kind: "mcp", name: "github" }, { kind: "private-mcp", name: "mine" }, { kind: "skill", slug: "@owner/pdf" }, { kind: "trigger", id: "daily" }, { kind: "telegram" }];
    for (const r of refs) expect(parseRef(refId(r))).toEqual(r);
    expect(parseRef("agent")).toBeNull();
  });
});

describe("what is connected", () => {
  it("fills in the root defaults the way the engine does", () => {
    const d = draft();
    expect(on(d, "recent")).toBe(true); // root lastMessages 20
    expect(on(d, "semantic")).toBe(false);
    expect(on(d, "observational")).toBe(false);
    expect(on(d, "workspace")).toBe(true); // schema default builtin ["workspace"]
    expect(on(d, "schedule")).toBe(false);
    expect(on(d, "soul")).toBe(true); // includeSoul defaults to true -> shared
    expect(on(draft({ instructions: { includeSoul: false } }), "soul")).toBe(false);
    expect(on(draft({ soul: { source: "none" }, instructions: { includeSoul: true } }), "soul")).toBe(false);
    expect(on(draft({ memory: { lastMessages: 0 } }), "recent")).toBe(false);
  });

  it("treats inherit all as the enabled root servers only, and lists every library skill as connected", () => {
    const d = draft({ tools: { mcp: { inherit: "all" } } });
    expect([on(d, "mcp", "github"), on(d, "mcp", "files"), on(d, "mcp", "old")]).toEqual([true, true, false]);
    expect(deriveItems(d, ctx).find((i) => i.id === "mcp:old")?.blocked).toMatch(/Settings/);
    expect(deriveItems(draft({ tools: { mcp: { inherit: ["github"] } } }), ctx).find((i) => i.id === "mcp:old")?.blocked).toMatch(/Settings/);
    expect(on(d, "skill", "pdf")).toBe(true); // skills.inherit defaults to all
    expect(on(draft({ skills: { inherit: "none" } }), "skill", "pdf")).toBe(false);
  });

  it("shows entries that name something that no longer exists, so they can be removed", () => {
    const d = draft({ tools: { mcp: { inherit: ["github", "gone"] } }, skills: { inherit: ["ghost-skill"] } });
    const gone = deriveItems(d, ctx).find((i) => i.id === "mcp:gone");
    expect(gone).toMatchObject({ connected: true });
    expect(gone?.inactive).toBeTruthy();
    expect(deriveItems(d, ctx).find((i) => i.id === "skill:ghost-skill")?.inactive).toBeTruthy();
  });

  it("makes the primary's Telegram bot permanent and a specialist's depend on telegram.enabled", () => {
    const primary = deriveItems(draft({ primary: true }), ctx).find((i) => i.id === "telegram")!;
    expect(primary).toMatchObject({ connected: true });
    expect(primary.locked).toBeTruthy();
    expect(on(draft(), "telegram")).toBe(false);
    expect(on(draft({ telegram: { enabled: true } }), "telegram")).toBe(true);
  });

  it("makes one node per trigger, connected while it is enabled", () => {
    const d = draft({ triggers: [{ id: "daily", type: "cron", cron: "0 9 * * *", prompt: "hi" }, { id: "off", type: "cron", enabled: false, cron: "0 9 * * *", prompt: "hi" }] });
    expect([on(d, "trigger", "daily"), on(d, "trigger", "off")]).toEqual([true, false]);
  });
});

describe("what the engine does with a component, said on the component", () => {
  const item = (d: Draft, id: string, c: Ctx = ctx) => deriveItems(d, c).find((i) => i.id === id)!;

  it("recent messages off means stateless: it says so, and recall and observation say they have nothing to work with", () => {
    const d = draft({ memory: { lastMessages: 0, semanticRecall: { enabled: true }, observational: { enabled: true } } });
    expect(item(d, "recent")).toMatchObject({ connected: false, note: "Stateless: this agent keeps nothing from the conversation." });
    expect(item(d, "semantic").inactive).toMatch(/Nothing to work with/);
    expect(item(d, "observational").inactive).toMatch(/Nothing to work with/);
    const on = draft({ memory: { semanticRecall: { enabled: true } } });
    expect(item(on, "recent").note).toBeUndefined();
    expect(item(on, "semantic").inactive).toBeUndefined();
    // a recall that is off has nothing to warn about
    expect(item(draft({ memory: { lastMessages: 0 } }), "semantic").inactive).toBeUndefined();
  });

  it("the schedule tool is not offered to a specialist, and a listed one is flagged as having no effect and removable", () => {
    const none = item(draft(), "schedule");
    expect(none).toMatchObject({ connected: false });
    expect(none.unavailable).toBeTruthy();
    expect(connect(draft(), { kind: "schedule" }, ctx).config.tools).toBeUndefined(); // nothing is written for a tool that would be ignored
    const listed = draft({ tools: { builtin: ["workspace", "schedule"] } });
    expect(item(listed, "schedule")).toMatchObject({ connected: true, inactive: "No effect: only the primary agent can use this tool." });
    expect(disconnect(listed, { kind: "schedule" }, ctx).config.tools).toEqual({ builtin: ["workspace"] });
    const primary = draft({ primary: true });
    expect(item(primary, "schedule").unavailable).toBeUndefined();
    expect(connect(primary, { kind: "schedule" }, ctx).config.tools).toEqual({ builtin: ["workspace", "schedule"] });
    expect(item(draft({ primary: true, tools: { builtin: ["schedule"] } }), "schedule").inactive).toBeUndefined();
  });

  it("a skill that will not load says why: flagged when connected, not connectable when not", () => {
    const broken: Ctx = { ...ctx, skills: [...skills, { slug: "bad", name: "bad", description: "x", problem: "name does not match the folder" }] };
    expect(item(draft(), "skill:bad", broken)).toMatchObject({ connected: true, inactive: "Won't load: name does not match the folder" });
    expect(item(draft({ skills: { inherit: ["pdf"] } }), "skill:bad", broken)).toMatchObject({ connected: false, blocked: "Won't load: name does not match the folder" });
    expect(item(draft(), "skill:pdf", broken).inactive).toBeUndefined();
  });
});

describe("connect and disconnect write exactly what the table says", () => {
  it("memory kinds", () => {
    expect(disconnect(draft(), { kind: "recent" }, ctx).config.memory).toEqual({ lastMessages: 0 });
    expect((connect(draft({ memory: { lastMessages: 0 } }), { kind: "recent" }, ctx).config.memory as { lastMessages: number }).lastMessages).toBe(20);
    expect((connect(draft({ memory: { lastMessages: 0 } }), { kind: "recent" }, { ...ctx, root: { ...root, defaults: { ...root.defaults, lastMessages: 0 } } }).config.memory as { lastMessages: number }).lastMessages).toBe(20);
    expect(connect(draft(), { kind: "semantic" }, ctx).config.memory).toEqual({ semanticRecall: { enabled: true } });
    expect(connect(draft(), { kind: "observational" }, ctx).config.memory).toEqual({ observational: { enabled: true } });
    expect(disconnect(connect(draft(), { kind: "semantic" }, ctx), { kind: "semantic" }, ctx).config.memory).toEqual({ semanticRecall: { enabled: false } });
  });

  it("built-in tools add and remove only their own name and never touch the unused \"skills\" entry", () => {
    const d = draft({ primary: true, tools: { builtin: ["workspace", "skills"] } });
    expect(connect(d, { kind: "schedule" }, ctx).config.tools).toEqual({ builtin: ["workspace", "skills", "schedule"] });
    expect(disconnect(d, { kind: "workspace" }, ctx).config.tools).toEqual({ builtin: ["skills"] });
    expect(connect(connect(d, { kind: "schedule" }, ctx), { kind: "schedule" }, ctx).config.tools).toEqual({ builtin: ["workspace", "skills", "schedule"] });
    expect(deriveItems(d, ctx).some((i) => i.title.toLowerCase() === "skills" && i.group === "tools" && i.ref.kind !== "skill")).toBe(false);
  });

  it("root MCP servers: expands all, edits the list, and an empty list becomes none", () => {
    const all = draft({ tools: { mcp: { inherit: "all" } } });
    expect(disconnect(all, { kind: "mcp", name: "github" }, ctx).config.tools).toEqual({ mcp: { inherit: ["files"] } });
    const none = draft();
    expect(connect(none, { kind: "mcp", name: "github" }, ctx).config.tools).toEqual({ mcp: { inherit: ["github"] } });
    const one = draft({ tools: { mcp: { inherit: ["github"] } } });
    expect(connect(one, { kind: "mcp", name: "files" }, ctx).config.tools).toEqual({ mcp: { inherit: ["github", "files"] } });
    expect(disconnect(one, { kind: "mcp", name: "github" }, ctx).config.tools).toEqual({ mcp: { inherit: "none" } });
    expect(connect(all, { kind: "mcp", name: "old" }, ctx)).toBe(all); // blocked: it is switched off in Settings
  });

  it("skills: same pattern, expanding all into the library", () => {
    const all = draft();
    expect(disconnect(all, { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ inherit: ["pdf", "sql"] });
    expect(connect(draft({ skills: { inherit: "none" } }), { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ inherit: ["web"] });
    expect(disconnect(draft({ skills: { inherit: ["web"] } }), { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ inherit: "none" });
  });

  it("soul: shared, own (seeds a starter once), none (the file stays)", () => {
    const none = draft({ soul: { source: "none" } });
    expect(connect(none, { kind: "soul" }, ctx).config.soul).toEqual({ source: "shared" });
    const own = setSoulSource(none, "own", "Scout");
    expect(own.config.soul).toEqual({ source: "own" });
    expect(own.soulText).toBe(soulStarter("Scout"));
    expect(setSoulSource({ ...none, soulText: "my words" }, "own", "Scout").soulText).toBe("my words");
    const off = disconnect({ ...own, soulText: "edited" }, { kind: "soul" }, ctx, none);
    expect(off.config.soul).toEqual({ source: "none" });
    expect(off.soulText).toBe("edited");
    // an untouched starter leaves with the connection, so a file the user never asked for is not written
    expect(disconnect(own, { kind: "soul" }, ctx, none).soulText).toBe("");
  });

  it("telegram: a specialist gets the conventional token variable; the primary is left alone", () => {
    const d = connect(draft(), { kind: "telegram" }, ctx);
    expect(d.config.telegram).toEqual({ enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_SCOUT" });
    expect(connect(draft({ telegram: { tokenEnv: "MINE" } }), { kind: "telegram" }, ctx).config.telegram).toEqual({ tokenEnv: "MINE", enabled: true });
    expect(disconnect(d, { kind: "telegram" }, ctx).config.telegram).toEqual({ enabled: false, tokenEnv: "TELEGRAM_BOT_TOKEN_SCOUT" });
    const primary = draft({ primary: true });
    expect(disconnect(primary, { kind: "telegram" }, ctx)).toBe(primary);
  });

  it("private MCP servers: add makes a free name, disconnect deletes the key, the last one removes the map", () => {
    const { draft: d1, ref } = addPrivateServer(draft(), ctx);
    expect(ref).toEqual({ kind: "private-mcp", name: "server" });
    expect(d1.config.tools).toEqual({ mcp: { servers: { server: { command: "", args: [], enabled: true, trusted: false } } } });
    expect(addPrivateServer(d1, ctx).ref).toEqual({ kind: "private-mcp", name: "server-2" });
    expect(addPrivateServer(draft({}), { ...ctx, root: { ...root, mcpServers: [{ name: "server", enabled: true, trusted: false }] } }).ref).toEqual({ kind: "private-mcp", name: "server-2" });
    expect(disconnect(d1, ref, ctx).config.tools).toBeUndefined();
    expect(renamePrivateServer(d1, "server", "mine", ctx).config.tools).toEqual({ mcp: { servers: { mine: { command: "", args: [], enabled: true, trusted: false } } } });
    expect(renamePrivateServer(d1, "server", "github", ctx)).not.toBe(d1); // a root name is allowed here; validation flags the clash
  });

  it("triggers: add keeps ids unique, disconnect switches off, delete removes the entry", () => {
    const t = { id: "daily", type: "cron" as const, enabled: false, cron: "0 9 * * *", prompt: "hi" };
    const d1 = addTrigger(draft(), t);
    expect(freeTriggerId(d1, "daily")).toBe("daily-2");
    expect(on(d1, "trigger", "daily")).toBe(false);
    const d2 = connect(d1, { kind: "trigger", id: "daily" }, ctx);
    expect((d2.config.triggers as Array<{ enabled: boolean }>)[0]!.enabled).toBe(true);
    expect((disconnect(d2, { kind: "trigger", id: "daily" }, ctx).config.triggers as Array<{ enabled: boolean }>)[0]!.enabled).toBe(false);
    expect(removeTrigger(d2, "daily").config.triggers).toBeUndefined();
  });
});

describe("risk", () => {
  it("is risky with the workspace tool or a trusted server, and not otherwise", () => {
    expect(isRisky(draft().config, root)).toBe(true);
    const quiet = { tools: { builtin: [], mcp: { inherit: ["github"] } } };
    expect(isRisky(draft(quiet).config, root)).toBe(false);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { inherit: ["files"] } } }).config, root)).toBe(true);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { inherit: "all" } } }).config, root)).toBe(true);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { servers: { x: { command: "x", trusted: true } } } } }).config, root)).toBe(true);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { servers: { x: { command: "x", trusted: true, enabled: false } } } } }).config, root)).toBe(false);
  });
});

describe("the staged changes", () => {
  const base = draft({ triggers: [{ id: "daily", type: "cron", cron: "0 9 * * *", prompt: "hi" }] });
  it("is empty for an identical draft", () => expect(describeChanges(base, { ...base }, ctx)).toEqual([]));

  it("names connections, disconnections and edits, one line each", () => {
    let d = connect(base, { kind: "semantic" }, ctx);
    d = disconnect(d, { kind: "recent" }, ctx);
    d = disconnect(d, { kind: "workspace" }, ctx);
    d = connect(d, { kind: "mcp", name: "github" }, ctx);
    d = { ...d, config: { ...d.config, model: "smart", name: "Scout 2" }, instructionsText: "changed" };
    d = addTrigger(d, { id: "gh", type: "github-pr", enabled: false, repo: "a/b", tokenEnv: "GITHUB_TOKEN", prompt: "x" });
    d = removeTrigger(d, "daily");
    expect(describeChanges(base, d, ctx).map((c) => c.label).sort()).toEqual(
      [
        "Changed agent settings: name",
        "Changed instructions",
        "Connected github",
        "Connected Semantic recall",
        "Disconnected Recent messages",
        "Disconnected Workspace",
        "Model: fast to smart",
        'Added trigger "gh"',
        'Deleted trigger "daily"',
      ].sort(),
    );
  });

  it("counts a text-only edit and an own-soul edit", () => {
    expect(describeChanges(base, { ...base, soulText: "hello" }, ctx).map((c) => c.label)).toEqual(["Changed soul"]);
    const d = addPrivateServer(base, ctx).draft;
    expect(describeChanges(base, d, ctx).map((c) => c.label)).toEqual(['Added MCP server "server"']);
  });

  it("falls back to one line for hand edits outside the components", () => {
    expect(describeChanges(base, { ...base, config: { ...base.config, extra: 1 } }, ctx).map((c) => c.label)).toEqual(["Other settings"]);
  });
});

describe("problems land on the node they belong to", () => {
  it("routes validation paths to nodes", () => {
    const config = { triggers: [{ id: "a" }, { id: "b" }] };
    const by = issuesByNode(
      {
        model: '"x" is not a root model',
        "instructions.file": "must be a .md file",
        "memory.lastMessages": "too small",
        "tools.mcp.inherit": '"gone" is not a root MCP server',
        "tools.mcp.servers.mine.command": "command is required",
        "telegram.tokenEnv": "name the variable",
        "triggers.1.cron": "five fields",
        name: "required",
        "delegation.acceptsFrom": "bad",
      },
      config,
    );
    expect(by).toEqual({
      model: ['"x" is not a root model'],
      instructions: ["must be a .md file"],
      recent: ["too small"],
      "mcp:gone": ['"gone" is not a root MCP server'],
      "private-mcp:mine": ["command is required"],
      telegram: ["name the variable"],
      "trigger:b": ["five fields"],
      agent: ["required", "bad"],
    });
  });
});
