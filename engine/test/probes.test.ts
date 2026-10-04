import { afterEach, describe, expect, it } from "vitest";
import { checkTelegramToken, telegramEnvAllowed, testModel } from "../src/mastra/lib/probes.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { fakeTelegram } from "./helpers/fake-telegram.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe("telegramEnvAllowed", () => {
  it("only TELEGRAM_* names or names some config uses as a bot token", () => {
    expect(telegramEnvAllowed("TELEGRAM_BOT_TOKEN_RESEARCHER", [])).toBe(true);
    expect(telegramEnvAllowed("MY_BOT", ["MY_BOT"])).toBe(true);
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PATH", "HOME", "MY_BOT"]) expect(telegramEnvAllowed(n, ["TELEGRAM_BOT_TOKEN"]), n).toBe(false);
  });
});

describe("checkTelegramToken", () => {
  it("returns the @username for a good token", async () => {
    const tg = await fakeTelegram();
    closers.push(tg.close);
    expect(await checkTelegramToken("42:good", tg.url)).toEqual({ ok: true, username: "bot_42_good" });
  });
  it("says so when the variable is not set", async () => {
    expect(await checkTelegramToken(undefined)).toEqual({ ok: false, error: "that variable is not set in .env" });
  });
  it("turns a rejected token into a readable error that does not contain the token", async () => {
    const tg = await fakeTelegram();
    closers.push(tg.close);
    tg.reject("43:revoked", 401, "Unauthorized");
    const r = await checkTelegramToken("43:revoked", tg.url);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unauthorized/);
    expect(JSON.stringify(r)).not.toContain("43:revoked");
  });
  it("reports an unreachable Telegram without leaking the token", async () => {
    const r = await checkTelegramToken("44:unreachable", "http://127.0.0.1:1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not reach Telegram/);
    expect(JSON.stringify(r)).not.toContain("44:unreachable");
  });
});

describe("testModel", () => {
  const root = (url: string) => ({ models: { fake: { id: "openai/gpt-fake", url, apiKeyEnv: "FAKE_KEY", replyReserve: 4096 } } });

  it("answers ok with the latency and a short reply", async () => {
    const llm = await fakeLlm([{ text: "ok" }]);
    closers.push(llm.close);
    const r = await testModel("fake", root(llm.url), { FAKE_KEY: "sk-test-secret-value-123" });
    expect(r).toMatchObject({ ok: true, reply: "ok" });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("an unknown key is an error, not a crash", async () => {
    expect(await testModel("nope", root("http://127.0.0.1:1"))).toEqual({ ok: false, ms: 0, error: 'no model "nope" in config.json' });
  });

  it("gives up after the timeout and says how long it waited", async () => {
    const llm = await fakeLlm([{ text: "late", delayMs: 3000 }]);
    closers.push(llm.close);
    const r = await testModel("fake", root(llm.url), {}, 400);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no answer after 0\.4s/);
    expect(r.ms).toBeLessThan(2500);
  });

  it("an unreachable model returns an error that never contains the API key", async () => {
    const r = await testModel("fake", root("http://127.0.0.1:1/v1"), { FAKE_KEY: "super-secret-key-value" }, 5000);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("super-secret-key-value");
  });
});
