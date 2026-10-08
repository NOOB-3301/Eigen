import { readFileSync } from "node:fs";
import type { MastraDBMessage } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/mastra/lib/config.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import { clipStrings, dropScheduledTurns, makeMemory, observationalOptions, observerHooks } from "../src/mastra/lib/memory.ts";
import { hasSecret, redact, redactDeep } from "../src/mastra/lib/secrets.ts";
import { DEFAULTS, tmpHome } from "./helpers/home.ts";

const example = JSON.parse(readFileSync(`${DEFAULTS}/config.example.json`, "utf8"));
const cfgWith = (memory: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Config =>
  parseConfig({
    ...example,
    models: { local: { id: "ollama/x", url: "http://localhost:11434/v1" }, cloud: { id: "anthropic/claude-sonnet-5-5" }, small: { id: "ollama-cloud/gpt-oss:20b" } },
    defaultModel: "local",
    ...rest,
    memory: { ...example.memory, ...memory },
  });

const msg = (role: string, text: string, type?: string): MastraDBMessage =>
  ({ id: `${role}-${text}`, role, type, createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text }] } }) as unknown as MastraDBMessage;
const texts = (ms: MastraDBMessage[]) => ms.map((m) => (m.content.parts[0] as { text: string }).text);

describe("memory config", () => {
  it("leaves observational memory and knowledge off by default", () => {
    const c = parseConfig({ ...example, memory: undefined });
    expect(c.memory.observational).toMatchObject({ enabled: false, messageTokens: 8000, reflectionTokens: 20000, retrieval: true });
    expect(c.memory.knowledge).toMatchObject({ enabled: false, pins: true, maxPins: 20, maxCharacters: 2000 });
    expect(observationalOptions(() => c)).toBeUndefined();
  });

  it("rejects an unknown observer model and knowledge without observational", () => {
    expect(() => cfgWith({ observational: { enabled: true, model: "nope" } })).toThrow(/must name an entry in models/);
    expect(() => cfgWith({ knowledge: { enabled: true } })).toThrow(/needs memory.observational.enabled/);
  });
});

describe("observationalOptions", () => {
  it("uses thread scope, the configured thresholds and the recall tool with semantic search", () => {
    const o = observationalOptions(() => cfgWith({ observational: { enabled: true, messageTokens: 3000, reflectionTokens: 9000, activateAfterIdle: "10m" } }))!;
    expect(o).toMatchObject({ scope: "thread", observation: { messageTokens: 3000, failurePolicy: "continue" }, reflection: { observationTokens: 9000, failurePolicy: "continue" }, activateAfterIdle: "10m", retrieval: { vector: true } });
    expect(o).not.toHaveProperty("experimental_subconscious");
  });

  it("browses only when semantic recall is off, and drops retrieval when asked", () => {
    expect(observationalOptions(() => cfgWith({ semanticRecall: { enabled: false }, observational: { enabled: true } }))!.retrieval).toBe(true);
    expect(observationalOptions(() => cfgWith({ observational: { enabled: true, retrieval: false } }))!.retrieval).toBe(false);
  });

  it("picks the observer model from observational.model, then defaultModel, and follows /reload", () => {
    const pick = (memory: Record<string, unknown>, rest: Record<string, unknown> = {}) => (observationalOptions(() => cfgWith(memory, rest))!.model as () => unknown)();
    expect(pick({ observational: { enabled: true, model: "small" } })).toBe("ollama-cloud/gpt-oss:20b");
    expect(pick({ observational: { enabled: true } })).toMatchObject({ id: "ollama/x" });

    let live = cfgWith({ observational: { enabled: true, model: "small" } });
    const o = observationalOptions(() => live)!;
    live = cfgWith({ observational: { enabled: true, model: "cloud" } });
    expect((o.model as () => unknown)()).toBe("anthropic/claude-sonnet-5-5");
  });

  it("lets the knowledge agents use their own model", () => {
    const o = observationalOptions(() => cfgWith({ observational: { enabled: true, model: "small" }, knowledge: { enabled: true, model: "cloud" } }))!;
    const sub = (o as { experimental_subconscious?: { resolved: { observation: Array<{ model?: unknown }> } } }).experimental_subconscious!;
    expect((sub.resolved.observation[0]!.model as () => unknown)()).toBe("anthropic/claude-sonnet-5-5");
    expect((o.model as () => unknown)()).toBe("ollama-cloud/gpt-oss:20b");
  });

  it("adds the Subconscious only when knowledge is enabled", () => {
    const o = observationalOptions(() => cfgWith({ observational: { enabled: true }, knowledge: { enabled: true, maxPins: 5, maxCharacters: 900 } }))!;
    const sub = (o as { experimental_subconscious?: { resolved: { observation: Array<{ name: string }>; pins: unknown; tools: boolean } } }).experimental_subconscious!;
    expect(sub.resolved.observation.map((a) => a.name).sort()).toEqual(["curate", "remind"]);
    expect(sub.resolved.pins).toEqual({ maxPins: 5, maxCharacters: 900 });
  });

  it("builds a real Memory with everything enabled", () => {
    const p = tmpHome();
    const c = cfgWith({ observational: { enabled: true }, knowledge: { enabled: true }, embedder: { id: "ollama/nomic-embed-text", url: "http://localhost:11434/v1" } });
    expect(() => makeMemory(p, c)).not.toThrow();
  });
});

describe("what the Observer is allowed to see", () => {
  it("drops scheduled turns and their replies but keeps the user's own turns", () => {
    const kept = dropScheduledTurns([
      msg("signal", "hi", "user"),
      msg("assistant", "hello"),
      msg("signal", "Run the heartbeat", "schedule"),
      msg("assistant", "replied to stashcubby"),
      msg("assistant", "marked read"),
      msg("signal", "what is on my plate", "user"),
      msg("assistant", "this"),
    ]);
    expect(texts(kept)).toEqual(["hi", "hello", "what is on my plate", "this"]);
  });

  it("redacts keys from messages before the Observer and from observations after it", async () => {
    const hooks = observerHooks();
    const out = await hooks.beforeObservation({
      messages: [msg("signal", "my key is moltbook_sk_abcdefghijklmnopqrstuvwx and FIRECRAWL_API_KEY=fc-0123456789abcdef01234567", "user")],
    } as never);
    const [text] = texts(out.messages);
    expect(hasSecret(text!)).toBe(false);
    expect(text).toContain("my key is");
    expect(hooks.afterObservation({ observations: "uses Bearer abcdefghijklmnopqrstuvwxyz0123" }).observations).not.toMatch(/abcdefghij/);
  });

  it("clips huge tool output so the Observer prompt stays inside its model", async () => {
    const big = "x".repeat(50_000);
    const out = await observerHooks().beforeObservation({ messages: [msg("assistant", big)] } as never);
    const [text] = texts(out.messages);
    expect(text!.length).toBeLessThan(2100);
    expect(text).toContain("[clipped 48000 chars]");
    expect(clipStrings({ a: ["short", big], n: 1 })).toEqual({ a: ["short", `${"x".repeat(2000)}…[clipped 48000 chars]`], n: 1 });
  });

  it("returns no messages (so the Observer is skipped) when everything was scheduled", async () => {
    const out = await observerHooks().beforeObservation({ messages: [msg("signal", "Run it", "schedule"), msg("assistant", "done")] } as never);
    expect(out.messages).toEqual([]);
  });
});

describe("secret patterns", () => {
  it.each(["moltbook_sk_abcdefghijklmnopqrstuvwx", "fc-0123456789abcdef01234567", "AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-abc", "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4"])("flags %s", (s) => {
    expect(hasSecret(`token here: ${s}`)).toBe(true);
    expect(redact(`x ${s} y`)).not.toContain(s);
  });

  it("redactDeep cleans nested strings and leaves the shape and other values alone", () => {
    const input = { a: ["API_KEY=hunter2abc", { b: "fine", n: 3, ok: true }], d: new Date(0) };
    const out = redactDeep(input);
    expect(JSON.stringify(out)).not.toContain("hunter2abc");
    expect(out.a[1]).toEqual({ b: "fine", n: 3, ok: true });
    expect(out.d).toBe(input.d);
  });
});

describe("instructions", () => {
  it("tell the agent to edit working memory instead of rebuilding it", () => {
    const text = buildInstructions(tmpHome(), "Asia/Kolkata", new Date("2026-10-03T00:00:00Z"));
    expect(text).toMatch(/<memory_rules>[\s\S]*change only what changed[\s\S]*<\/memory_rules>/);
    expect(text.indexOf("<memory_rules>")).toBeLessThan(text.indexOf("Current time:"));
  });
});
