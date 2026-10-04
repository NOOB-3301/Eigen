import { describe, expect, it } from "vitest";
import { issuesByPath, validateDraft, warnings } from "./validate";

const base = { id: "scout", name: "Scout", models: { main: { id: "anthropic/claude-sonnet-5-5" } }, model: "main" };

describe("validateDraft", () => {
  it("accepts a minimal agent", () => {
    expect(validateDraft("scout", base)).toEqual({ ok: true, issues: [], byPath: {} });
  });

  it("says required instead of zod's wording, and keys messages by path", () => {
    const v = validateDraft("scout", { ...base, name: "" });
    expect(v.ok).toBe(false);
    expect(v.byPath.name).toBe("required");
    expect(v.issues).toContain("name: required");
  });

  it("refuses a model key that is not in models, and an empty catalog", () => {
    expect(validateDraft("scout", { ...base, model: "gone" }).byPath.model).toBe("must name an entry in models");
    expect(validateDraft("scout", { ...base, models: {}, model: "main" }).byPath.models).toBe("add at least one model");
    expect(validateDraft("scout", { ...base, memory: { observational: { enabled: true, model: "gone" } } }).byPath["memory.observational.model"]).toBe("must name an entry in models");
  });

  it("refuses memory blocks without storage, and a subconscious without both recall blocks", () => {
    expect(validateDraft("scout", { ...base, memory: { storage: { enabled: false } } }).byPath["memory.storage.enabled"]).toMatch(/every memory block needs the storage/);
    expect(validateDraft("scout", { ...base, memory: { subconscious: { enabled: true } } }).byPath["memory.subconscious.enabled"]).toMatch(/needs semantic recall and observational/);
    expect(validateDraft("scout", { ...base, memory: { storage: { url: "libsql://x.turso.io" } } }).byPath["memory.storage.authTokenEnv"]).toMatch(/auth token/);
  });

  it("puts agentProblems on the field: the bot's allow-list, a trigger's time zone by index", () => {
    const v = validateDraft("scout", {
      ...base,
      timezone: "Mars/Olympus",
      telegram: { enabled: true },
      triggers: [
        { id: "a", type: "cron", cron: "0 9 * * *", prompt: "x" },
        { id: "b", type: "cron", cron: "0 9 * * *", prompt: "x", timezone: "Nowhere/Land" },
      ],
    });
    expect(v.byPath.timezone).toMatch(/is not a time zone/);
    expect(v.byPath["telegram.allowedUserIds"]).toMatch(/add at least one allowed user id/);
    expect(v.byPath["triggers.1.timezone"]).toMatch(/is not a time zone/);
    expect(validateDraft("scout", { ...base, telegram: { enabled: true, allowedUserIds: [42] } }).ok).toBe(true);
  });

  it("insists the id is the folder name", () => {
    expect(validateDraft("other", base).byPath.id).toMatch(/folder name "other"/);
  });
});

describe("warnings", () => {
  it("flags skills without the workspace tool and delivery without a bot, and never a valid quiet agent", () => {
    expect(warnings(base)).toEqual([]);
    expect(warnings({ ...base, tools: { builtin: [] } })[0]).toMatch(/^skills\.enabled:/);
    expect(warnings({ ...base, tools: { builtin: [] }, skills: { enabled: [] } })).toEqual([]);
    const w = warnings({ ...base, triggers: [{ id: "a", type: "cron", cron: "0 9 * * *", prompt: "hi {{pr.title}}" }] });
    expect(w).toHaveLength(2);
    expect(issuesByPath(w)).toHaveProperty("triggers.0.deliverToTelegram");
  });
});
