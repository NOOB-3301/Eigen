import { describe, expect, it } from "vitest";
import { AgentConfigSchema } from "@eigen/engine/schema";
import type { Draft } from "../../lib/client/draft";
import {
  addMcpServer,
  addTrigger,
  connect,
  deriveItems,
  describeChanges,
  disconnect,
  disconnectWarning,
  freeTriggerId,
  isRisky,
  issuesByNode,
  modelUsers,
  parseRef,
  problemsByNode,
  refId,
  removeMcpServer,
  removeModel,
  removeTrigger,
  renameMcpServer,
  renameModel,
  soulStarter,
  storageMoved,
  type Ctx,
  type Ref,
} from "./model";

const skills = [
  { slug: "pdf", name: "pdf", description: "Read and write PDFs" },
  { slug: "web", name: "web", description: "Browse the web" },
  { slug: "sql", name: "sql", description: "Query a database" },
];
const ctx: Ctx = { agentId: "scout", skills };

const draft = (config: Record<string, unknown> = {}, extra: Partial<Draft> = {}): Draft => ({
  config: { id: "scout", name: "Scout", models: { main: { id: "anthropic/claude-sonnet-5-5" } }, model: "main", ...config },
  instructionsText: "You are Scout.\n",
  soulText: "",
  ...extra,
});
const item = (d: Draft, id: string, c: Ctx = ctx) => deriveItems(d, c).find((i) => i.id === id);
const on = (d: Draft, id: string) => item(d, id)?.connected;
const memory = (d: Draft) => d.config.memory as Record<string, { enabled?: boolean }> | undefined;
/** Every draft a cascade produces must be one the engine accepts. */
const valid = (d: Draft) => expect(AgentConfigSchema.safeParse(d.config).success).toBe(true);

describe("refs", () => {
  it("round-trips every kind through its node id", () => {
    const refs: Ref[] = [{ kind: "llm" }, { kind: "storage" }, { kind: "subconscious" }, { kind: "soul" }, { kind: "mcp", name: "github" }, { kind: "skill", slug: "@owner/pdf" }, { kind: "trigger", id: "daily" }, { kind: "telegram" }];
    for (const r of refs) expect(parseRef(refId(r))).toEqual(r);
    expect(parseRef("agent")).toBeNull();
    expect(parseRef("private-mcp:x")).toBeNull();
  });
});

describe("what is connected, from the schema defaults", () => {
  it("a bare config has storage, last messages, working memory and the workspace; nothing else", () => {
    const d = draft();
    expect(["storage", "lastMessages", "workingMemory", "workspace"].map((id) => on(d, id))).toEqual([true, true, true, true]);
    expect(["semanticRecall", "observational", "subconscious", "soul", "schedule", "telegram"].map((id) => on(d, id))).toEqual([false, false, false, false, false, false]);
    expect(item(d, "llm")).toMatchObject({ connected: true, title: "main", targets: ["agent"] });
    expect(item(d, "llm")?.locked).toBeTruthy();
    expect(item(d, "instructions")?.locked).toBeTruthy();
  });

  it("draws the chain: memory blocks to storage, storage to the llm, the subconscious to both recall blocks", () => {
    const d = draft();
    expect(item(d, "storage")?.targets).toEqual(["llm"]);
    for (const b of ["lastMessages", "workingMemory", "semanticRecall", "observational"]) expect(item(d, b)?.targets).toEqual(["storage"]);
    expect(item(d, "subconscious")?.targets).toEqual(["semanticRecall", "observational"]);
    for (const id of ["soul", "workspace", "telegram"]) expect(item(d, id)?.targets).toEqual(["agent"]);
  });

  it("an MCP server is connected while enabled; skills.enabled all lists the whole library", () => {
    const d = draft({ tools: { mcp: { gh: { url: "https://x.dev/mcp" }, off: { command: "x", enabled: false } } } });
    expect([on(d, "mcp:gh"), on(d, "mcp:off")]).toEqual([true, false]);
    expect(skills.every((s) => on(d, `skill:${s.slug}`))).toBe(true);
    expect(on(draft({ skills: { enabled: ["web"] } }), "skill:pdf")).toBe(false);
  });

  it("says when a component is connected but cannot work, and lists skills that are not in the library", () => {
    const hand = draft({ memory: { storage: { enabled: false } } });
    expect(item(hand, "lastMessages")?.inactive).toMatch(/Storage is off/);
    expect(item(hand, "storage")?.note).toMatch(/Stateless/);
    expect(item(draft({ memory: { subconscious: { enabled: true } } }), "subconscious")?.inactive).toMatch(/semantic recall and observational/);
    expect(item(draft({ skills: { enabled: ["ghost"] } }), "skill:ghost")?.inactive).toBeTruthy();
    expect(item(draft({ skills: { enabled: ["ghost"] } }), "skill:ghost", { ...ctx, skillsKnown: false })?.inactive).toBeUndefined();
    const broken: Ctx = { ...ctx, skills: [...skills, { slug: "bad", name: "bad", description: "x", problem: "name does not match the folder" }] };
    expect(item(draft(), "skill:bad", broken)).toMatchObject({ connected: true, inactive: "Won't load: name does not match the folder" });
    expect(item(draft({ skills: { enabled: ["pdf"] } }), "skill:bad", broken)).toMatchObject({ connected: false, blocked: "Won't load: name does not match the folder" });
  });
});

describe("connect and disconnect cascade the way the table says", () => {
  it("storage off takes every memory block with it, and asks first", () => {
    const full = draft({ memory: { semanticRecall: { enabled: true }, observational: { enabled: true }, subconscious: { enabled: true } } });
    const off = disconnect(full, { kind: "storage" }, ctx);
    for (const id of ["storage", "lastMessages", "workingMemory", "semanticRecall", "observational", "subconscious"]) expect(on(off, id)).toBe(false);
    valid(off);
    expect(disconnectWarning(full, { kind: "storage" })).toMatch(/^The agent will keep nothing between messages\./);
    expect(disconnectWarning(full, { kind: "storage" })).toMatch(/last messages/);
    expect(disconnectWarning(full, { kind: "workspace" })).toBeNull();
    // Blocks that were already off are not written.
    expect(memory(disconnect(draft(), { kind: "storage" }, ctx))).toEqual({ storage: { enabled: false }, lastMessages: { enabled: false }, workingMemory: { enabled: false } });
  });

  it("a memory block turns storage on when it connects", () => {
    const stateless = disconnect(draft(), { kind: "storage" }, ctx);
    for (const b of ["lastMessages", "workingMemory", "semanticRecall", "observational"] as const) {
      const d = connect(stateless, { kind: b }, ctx);
      expect([on(d, b), on(d, "storage")]).toEqual([true, true]);
      valid(d);
    }
    expect(memory(connect(draft(), { kind: "semanticRecall" }, ctx))).toEqual({ semanticRecall: { enabled: true } });
  });

  it("the subconscious brings semantic recall, observational memory and storage; losing either recall block drops it", () => {
    const d = connect(disconnect(draft(), { kind: "storage" }, ctx), { kind: "subconscious" }, ctx);
    for (const id of ["subconscious", "semanticRecall", "observational", "storage"]) expect(on(d, id)).toBe(true);
    valid(d);
    for (const b of ["semanticRecall", "observational"] as const) {
      const x = disconnect(d, { kind: b }, ctx);
      expect([on(x, b), on(x, "subconscious")]).toEqual([false, false]);
      valid(x);
    }
    const y = disconnect(d, { kind: "subconscious" }, ctx);
    expect([on(y, "semanticRecall"), on(y, "observational")]).toEqual([true, true]);
  });

  it("last messages and working memory switch only themselves", () => {
    expect(memory(disconnect(draft(), { kind: "lastMessages" }, ctx))).toEqual({ lastMessages: { enabled: false } });
    expect(memory(disconnect(draft(), { kind: "workingMemory" }, ctx))).toEqual({ workingMemory: { enabled: false } });
  });

  it("the llm and the instructions cannot be disconnected", () => {
    const d = draft();
    expect(disconnect(d, { kind: "llm" }, ctx)).toBe(d);
    expect(disconnect(d, { kind: "instructions" }, ctx)).toBe(d);
  });

  it("soul: enabled true seeds a starter once, false keeps the user's words", () => {
    const d = connect(draft(), { kind: "soul" }, ctx);
    expect(d.config.soul).toEqual({ enabled: true });
    expect(d.soulText).toBe(soulStarter("Scout"));
    expect(connect(draft({}, { soulText: "mine" }), { kind: "soul" }, ctx).soulText).toBe("mine");
    expect(disconnect(d, { kind: "soul" }, ctx, draft()).soulText).toBe("");
    const edited = disconnect({ ...d, soulText: "edited" }, { kind: "soul" }, ctx, draft());
    expect([edited.config.soul, edited.soulText]).toEqual([{ enabled: false }, "edited"]);
  });

  it("built-in tools add and remove their own name, from the default list", () => {
    expect(connect(draft(), { kind: "schedule" }, ctx).config.tools).toEqual({ builtin: ["workspace", "schedule"] });
    expect(disconnect(draft(), { kind: "workspace" }, ctx).config.tools).toEqual({ builtin: [] });
    const twice = connect(connect(draft(), { kind: "schedule" }, ctx), { kind: "schedule" }, ctx);
    expect(twice.config.tools).toEqual({ builtin: ["workspace", "schedule"] });
  });

  it("skills: all is expanded to the agent's own library before one is taken out", () => {
    expect(disconnect(draft(), { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ enabled: ["pdf", "sql"] });
    expect(connect(draft({ skills: { enabled: [] } }), { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ enabled: ["web"] });
    expect(disconnect(draft({ skills: { enabled: ["web"] } }), { kind: "skill", slug: "web" }, ctx).config.skills).toEqual({ enabled: [] });
    const all = draft();
    expect(connect(all, { kind: "skill", slug: "web" }, ctx)).toBe(all);
  });

  it("MCP: disconnect writes enabled false, connect removes it, delete removes the key", () => {
    const { draft: d1, ref } = addMcpServer(draft());
    expect(ref).toEqual({ kind: "mcp", name: "server" });
    expect(d1.config.tools).toEqual({ mcp: { server: { command: "", args: [] } } });
    expect(addMcpServer(d1).ref).toEqual({ kind: "mcp", name: "server-2" });
    const off = disconnect(d1, ref, ctx);
    expect(off.config.tools).toEqual({ mcp: { server: { command: "", args: [], enabled: false } } });
    expect(connect(off, ref, ctx).config.tools).toEqual({ mcp: { server: { command: "", args: [] } } });
    expect(removeMcpServer(d1, "server").config.tools).toBeUndefined();
    expect(renameMcpServer(d1, "server", "github").config.tools).toEqual({ mcp: { github: { command: "", args: [] } } });
    expect(renameMcpServer(addMcpServer(d1).draft, "server", "server-2").config).toEqual(addMcpServer(d1).draft.config);
  });

  it("telegram: enabled true / false only", () => {
    const d = connect(draft(), { kind: "telegram" }, ctx);
    expect(d.config.telegram).toEqual({ enabled: true });
    expect(disconnect(d, { kind: "telegram" }, ctx).config.telegram).toEqual({ enabled: false });
  });

  it("triggers: add keeps ids unique, disconnect switches off, delete removes the entry", () => {
    const t = { id: "daily", type: "cron" as const, enabled: false, cron: "0 9 * * *", prompt: "hi" };
    const d1 = addTrigger(draft(), t);
    expect(freeTriggerId(d1, "daily")).toBe("daily-2");
    expect(on(d1, "trigger:daily")).toBe(false);
    const d2 = connect(d1, { kind: "trigger", id: "daily" }, ctx);
    expect(on(d2, "trigger:daily")).toBe(true);
    expect(on(disconnect(d2, { kind: "trigger", id: "daily" }, ctx), "trigger:daily")).toBe(false);
    expect(removeTrigger(d2, "daily").config.triggers).toBeUndefined();
  });
});

describe("models", () => {
  const two = draft({ models: { main: { id: "anthropic/a" }, cheap: { id: "openai/b" } }, memory: { observational: { enabled: true, model: "cheap" } } });

  it("refuses to remove a model that something uses, or the last one", () => {
    expect(modelUsers(two.config, "cheap")).toEqual(["the observer of observational memory"]);
    const r1 = removeModel(two, "cheap");
    expect("error" in r1 && r1.error).toMatch(/cheap is used as the observer/);
    const r2 = removeModel(two, "main");
    expect("error" in r2 && r2.error).toMatch(/the agent's model/);
    const r3 = removeModel(draft({ models: { main: { id: "a/b" }, x: { id: "c/d" } }, memory: { subconscious: { model: "x" } } }), "x");
    expect("error" in r3 && r3.error).toMatch(/subconscious/);
    const free = draft({ models: { main: { id: "a/b" }, spare: { id: "c/d" } } });
    const r4 = removeModel(free, "spare");
    expect("draft" in r4 && r4.draft.config.models).toEqual({ main: { id: "a/b" } });
  });

  it("renames a key and every reference to it", () => {
    const d = renameModel(two, "cheap", "fast");
    expect(Object.keys(d.config.models as object)).toEqual(["main", "fast"]);
    expect((d.config.memory as { observational: { model: string } }).observational.model).toBe("fast");
    expect(renameModel(two, "main", "cheap")).toBe(two); // taken
    expect(renameModel(two, "main", "brain").config.model).toBe("brain");
  });
});

describe("other rules", () => {
  it("is risky with the workspace tool or a trusted, enabled MCP server", () => {
    expect(isRisky(draft().config)).toBe(true);
    expect(isRisky(draft({ tools: { builtin: [] } }).config)).toBe(false);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { x: { command: "x", trusted: true } } } }).config)).toBe(true);
    expect(isRisky(draft({ tools: { builtin: [], mcp: { x: { command: "x", trusted: true, enabled: false } } } }).config)).toBe(false);
  });

  it("notices when a save would move the agent to another database", () => {
    expect(storageMoved(draft(), draft())).toBe(false);
    expect(storageMoved(draft(), draft({ memory: { storage: { url: "libsql://x.turso.io", authTokenEnv: "T" } } }))).toBe(true);
  });
});

describe("the staged changes", () => {
  const base = draft({ triggers: [{ id: "daily", type: "cron", cron: "0 9 * * *", prompt: "hi" }] });
  it("is empty for an identical draft", () => expect(describeChanges(base, { ...base }, ctx)).toEqual([]));

  it("names connections, disconnections and edits, one line each", () => {
    let d = connect(base, { kind: "subconscious" }, ctx);
    d = disconnect(d, { kind: "workspace" }, ctx);
    d = addMcpServer(d).draft;
    d = { ...d, config: { ...d.config, models: { main: { id: "x/y" }, smart: { id: "x/z" } }, model: "smart", name: "Scout 2" }, instructionsText: "changed" };
    d = addTrigger(d, { id: "gh", type: "github-pr", enabled: false, repo: "a/b", tokenEnv: "GITHUB_TOKEN", prompt: "x" });
    d = removeTrigger(d, "daily");
    expect(describeChanges(base, d, ctx).map((c) => c.label).sort()).toEqual(
      [
        "Changed agent settings: name",
        "Changed instructions",
        "Connected Subconscious",
        "Connected Semantic recall",
        "Connected Observational memory",
        "Disconnected Workspace",
        "Model: main to smart",
        'Added MCP server "server"',
        'Added trigger "gh"',
        'Deleted trigger "daily"',
      ].sort(),
    );
  });

  it("counts text-only, settings-only and selection-only edits", () => {
    expect(describeChanges(base, { ...base, soulText: "hello" }, ctx).map((c) => c.label)).toEqual(["Changed soul"]);
    expect(describeChanges(base, draft({ ...base.config, sandbox: { allowNetwork: false } }), ctx).map((c) => c.label)).toEqual(["Changed sandbox"]);
    expect(describeChanges(base, draft({ ...base.config, memory: { lastMessages: { count: 5 } } }), ctx).map((c) => c.label)).toEqual(["Changed last messages"]);
    expect(describeChanges(base, draft({ ...base.config, skills: { enabled: ["pdf", "web", "sql"] } }), ctx).map((c) => c.label)).toEqual(["Changed skill selection"]);
    expect(describeChanges(base, draft({ ...base.config, models: { main: { id: "anthropic/other" } } }), ctx).map((c) => c.label)).toEqual(["Changed models"]);
  });

  it("falls back to one line for hand edits outside the components", () => {
    expect(describeChanges(base, { ...base, config: { ...base.config, extra: 1 } }, ctx).map((c) => c.label)).toEqual(["Other settings"]);
  });
});

describe("problems land on the node they belong to", () => {
  it("routes validation paths to nodes, by trigger index or id", () => {
    const config = { triggers: [{ id: "a" }, { id: "b" }] };
    expect(
      issuesByNode(
        {
          model: "must name an entry in models",
          "models.main.id": 'use "provider/model"',
          "memory.storage.authTokenEnv": "needs a token",
          "memory.subconscious.enabled": "needs both",
          "memory.observational.model": "must name an entry in models",
          "instructions.file": "bad",
          "sandbox.commandTimeoutMs": "too small",
          "tools.mcp.gh.url": "bad url",
          "telegram.allowedUserIds": "add one",
          "triggers.1.cron": "five fields",
          "triggers.a.timezone": "not a zone",
          name: "required",
        },
        config,
      ),
    ).toEqual({
      llm: ["must name an entry in models", 'use "provider/model"'],
      storage: ["needs a token"],
      subconscious: ["needs both"],
      observational: ["must name an entry in models"],
      instructions: ["bad"],
      workspace: ["too small"],
      "mcp:gh": ["bad url"],
      telegram: ["add one"],
      "trigger:b": ["five fields"],
      "trigger:a": ["not a zone"],
      agent: ["required"],
    });
  });

  it("routes the engine's sentences, including a missing key used in two places", () => {
    const by = problemsByNode(
      [
        "ANTHROPIC_API_KEY is not set in this agent's keys (models.main, memory.semanticRecall.embedder)",
        "LIBSQL_AUTH_TOKEN is not set in this agent's keys (memory.storage)",
        "telegram: add at least one allowed user id; without one the bot would answer anyone",
        "memory.storage.url is already used by \"other\"; agents never share storage",
        "something nobody can place",
      ],
      {},
    );
    expect(Object.keys(by).sort()).toEqual(["agent", "llm", "semanticRecall", "storage", "telegram"]);
    expect(by.llm).toEqual(by.semanticRecall);
    expect(by.storage).toHaveLength(2);
  });
});
