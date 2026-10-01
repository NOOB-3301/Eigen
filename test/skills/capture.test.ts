import { describe, expect, it, vi } from "vitest";
import { clampToTokens, parseDraft, SkillCapture, transcriptOf } from "../../src/skills/capture.ts";
import { SkillStore } from "../../src/skills/store.ts";
import type { Message } from "../../src/core/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, testConfig } from "../helpers/fake-provider.ts";

const base = testConfig();
const entry = base.models.fake!;

const RUN: Message[] = [
  { role: "user", parts: [{ type: "text", text: "list the directus collections" }] },
  { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "http_fetch", args: { url: "https://api/collections" } }] },
  { role: "tool", parts: [{ type: "tool_result", callId: "c1", content: [{ type: "text", text: "200 OK: users, posts" }] }] },
  { role: "assistant", parts: [{ type: "text", text: "Collections: users, posts" }] },
];

const GOOD_BODY = [
  "## Preconditions",
  "- DIRECTUS_URL and DIRECTUS_TOKEN are set in the environment",
  "",
  "## Steps",
  "1. GET $DIRECTUS_URL/collections with header Authorization: Bearer $DIRECTUS_TOKEN",
  "2. Read the `data` array; each entry has a `collection` field with the name",
  "3. For a custom collection, fetch items at $DIRECTUS_URL/items/<collection>",
  "",
  "## Notes",
  "- System users live at /users, not /items/users — that returns 403",
  "- A 403 usually means the wrong collection name rather than a bad token",
].join("\n");
const DRAFT_TEXT = `---\nname: directus collections\ndescription: List collections from a Directus instance over HTTP\nwhen: asked what is in a Directus database\n---\n\n${GOOD_BODY}`;
const PASS_JUDGE = JSON.stringify({ worthCapturing: 3, taskSucceeded: 0.95, alreadyCovered: 0.05, reusable: 3, specific: 0.9, preconditions: 0.9, redundant: 0.1, verdict: "keep" });

const captureOn = { ...base.skills, capture: { ...base.skills.capture, enabled: true } };

function setup(scripts: Array<{ text?: string; error?: Error; delayMs?: number }>, cfgPatch: Partial<typeof base.skills> = {}) {
  const store = new SkillStore(mkdtempSync(join(tmpdir(), "eigen-capture-")), base.skills);
  store.load();
  const provider = new FakeProvider(scripts);
  const saved: string[] = [];
  const usage: number[] = [];
  const capture = new SkillCapture({
    store,
    cfg: { ...captureOn, ...cfgPatch },
    entryFor: () => entry,
    providerFor: () => provider,
    isBusy: () => false,
    overCap: () => false,
    onSaved: (_s, skill) => saved.push(skill.slug),
    onUsage: (_e, t) => usage.push(t),
  });
  return { store, provider, capture, saved, usage };
}

const job = { sessionId: "s", runId: "r", messages: RUN, entryName: "fake" };

describe("transcript handling", () => {
  it("renders roles, tool calls and results", () => {
    expect(transcriptOf(RUN)).toBe(
      ["user: list the directus collections", 'assistant calls http_fetch({"url":"https://api/collections"})', "tool result: 200 OK: users, posts", "assistant: Collections: users, posts"].join("\n"),
    );
  });

  it("keeps the tail when over the state cap", () => {
    const long = `START${"x".repeat(5000)}END`;
    const clamped = clampToTokens(long, 100);
    expect(clamped).toContain("END");
    expect(clamped).not.toContain("START");
    expect(clamped).toContain("earlier turns omitted");
    expect(clampToTokens("short", 100)).toBe("short");
  });

  it("parses a draft, tolerating a code fence", () => {
    expect(parseDraft("```markdown\n" + DRAFT_TEXT + "\n```")).toMatchObject({ name: "directus collections", when: "asked what is in a Directus database" });
    expect(parseDraft("no frontmatter")).toBeUndefined();
    expect(parseDraft("---\nname: x\n---\n\nbody")).toBeUndefined(); // description required
  });
});

describe("SkillCapture", () => {
  it("triages, drafts, evaluates and saves", async () => {
    const { capture, store, saved, provider, usage } = setup([{ text: PASS_JUDGE }, { text: DRAFT_TEXT }, { text: PASS_JUDGE }]);
    capture.schedule(job);
    await capture.idle();
    expect(store.slugs()).toEqual(["directus-collections"]);
    expect(saved).toEqual(["directus-collections"]);
    expect(provider.requests).toHaveLength(3); // triage, draft, eval
    expect(usage.reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // tokens accounted
  });

  it("stops after triage when the run is not worth capturing (no draft call)", async () => {
    const { capture, store, provider, saved } = setup([{ text: JSON.stringify({ worthCapturing: 0, taskSucceeded: 0.9, alreadyCovered: 0.1 }) }]);
    capture.schedule(job);
    await capture.idle();
    expect(store.slugs()).toEqual([]);
    expect(saved).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("stops when the task did not actually succeed", async () => {
    const { capture, store, provider } = setup([{ text: JSON.stringify({ worthCapturing: 3, taskSucceeded: 0.1, alreadyCovered: 0.1 }) }]);
    capture.schedule(job);
    await capture.idle();
    expect(store.slugs()).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("stops when an existing skill already covers it", async () => {
    const { capture, store, provider } = setup([{ text: JSON.stringify({ worthCapturing: 3, taskSucceeded: 0.9, alreadyCovered: 0.95 }) }]);
    capture.schedule(job);
    await capture.idle();
    expect(store.slugs()).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("discards a draft the eval rejects, writing nothing", async () => {
    const withSecret = DRAFT_TEXT.replace("## Notes", "export TOKEN=sk-abcdefghijklmnop123\n\n## Notes");
    const { capture, store, saved } = setup([{ text: PASS_JUDGE }, { text: withSecret }]);
    capture.schedule(job);
    await capture.idle();
    expect(store.slugs()).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("skips when the daily cap is hit", async () => {
    const store = new SkillStore(mkdtempSync(join(tmpdir(), "eigen-capture-")), base.skills);
    store.load();
    const provider = new FakeProvider([{ text: PASS_JUDGE }]);
    const capture = new SkillCapture({
      store, cfg: captureOn, entryFor: () => entry, providerFor: () => provider,
      isBusy: () => false, overCap: () => true,
    });
    capture.schedule(job);
    await capture.idle();
    expect(provider.requests).toHaveLength(0);
  });

  it("is disabled by config", async () => {
    const { capture, provider } = setup([{ text: PASS_JUDGE }], { enabled: false });
    capture.schedule(job);
    await capture.idle();
    expect(provider.requests).toHaveLength(0);
  });

  it("swallows failures instead of throwing into the chat", async () => {
    const { capture, store } = setup([{ error: new Error("provider exploded") }]);
    capture.schedule(job);
    await expect(capture.idle()).resolves.toBeUndefined();
    expect(store.slugs()).toEqual([]);
  });

  it("defers while the session is busy, then runs", async () => {
    const store = new SkillStore(mkdtempSync(join(tmpdir(), "eigen-capture-")), base.skills);
    store.load();
    const provider = new FakeProvider([{ text: PASS_JUDGE }, { text: DRAFT_TEXT }, { text: PASS_JUDGE }]);
    let busy = true;
    const capture = new SkillCapture({
      store, cfg: captureOn, entryFor: () => entry, providerFor: () => provider,
      isBusy: () => busy, overCap: () => false,
    });
    capture.schedule(job);
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.requests).toHaveLength(0); // waited for the session
    busy = false;
    await capture.idle();
    expect(store.slugs()).toEqual(["directus-collections"]);
  });

  it("stop() drains the queue", async () => {
    const { capture, provider } = setup([{ text: PASS_JUDGE, delayMs: 50 }]);
    capture.schedule(job);
    capture.stop();
    await capture.idle();
    expect(provider.requests.length).toBeLessThanOrEqual(1);
  });
});
