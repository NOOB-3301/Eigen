import { afterEach, describe, expect, it } from "vitest";
import type { TelegramRuntime } from "../src/mastra/lib/schema.ts";
import { createBot, telegramChannels, type TelegramBot } from "../src/mastra/lib/telegram.ts";
import { fakeTelegram } from "./helpers/fake-telegram.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("timed out");
}

/** The slice of the Chat SDK the adapter touches while polling with nothing to deliver. */
const fakeChat = () => ({
  getUserName: () => undefined,
  getState: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined, setIfNotExists: async () => true }),
});

let tg: Awaited<ReturnType<typeof fakeTelegram>>;
let bots: TelegramBot[] = [];
afterEach(async () => {
  await Promise.all(bots.splice(0).map((b) => b.stop()));
  await tg?.close();
});

async function start(token: string) {
  const bot = createBot({ token, allowedUserIds: [7], apiBaseUrl: tg.url });
  const seen: TelegramRuntime[] = [bot.state()];
  bot.subscribe((t) => seen.push(t));
  bots.push(bot);
  // Mastra runs initialize() fire-and-forget and only logs a rejection, so a bad token must show up in the bot's state, not here.
  await bot.adapter.initialize(fakeChat() as never).catch(() => undefined);
  return { bot, seen };
}

describe("createBot", () => {
  it("goes starting -> polling and learns the @username from getMe", async () => {
    tg = await fakeTelegram();
    const { bot, seen } = await start("55:good");
    await until(() => bot.state().state === "polling");
    expect(seen.map((s) => s.state)).toEqual(["starting", "polling"]);
    expect(bot.state().username).toBe("bot_55_good");
    expect(tg.pollers("55:good")).toBe(1);
  });

  it("reports a token Telegram rejects as an error, without ever repeating the token", async () => {
    tg = await fakeTelegram();
    tg.reject("66:revoked", 401, "Unauthorized");
    const { bot } = await start("66:revoked");
    await until(() => bot.state().state === "error");
    expect(bot.state().error).toMatch(/unauthorized/i);
    expect(JSON.stringify(bot.state())).not.toContain("66:revoked");
  });

  it("reports a second poller on the same token as a conflict instead of pretending to be live", async () => {
    tg = await fakeTelegram();
    const a = await start("77:shared");
    await until(() => a.bot.state().state === "polling");
    const b = await start("77:shared");
    await until(() => tg.conflicts("77:shared") > 0);
    await until(() => [a.bot, b.bot].some((x) => x.state().state === "error"));
    const failed = [a.bot, b.bot].find((x) => x.state().state === "error")!;
    expect(failed.state().error).toMatch(/terminated by other getUpdates request/);
  });

  it("stop() ends the poll in flight, and nothing polls afterwards", async () => {
    tg = await fakeTelegram();
    const { bot } = await start("88:stopme");
    await until(() => tg.pollers("88:stopme") === 1);
    await bot.stop();
    await until(() => tg.pollers("88:stopme") === 0, 500); // the fake notices the closed socket a few ms after the client aborted
    const before = tg.callsFor("88:stopme", "getUpdates").length;
    await sleep(1500);
    expect(tg.callsFor("88:stopme", "getUpdates").length).toBe(before);
    await bot.stop(); // idempotent
  });

  it("a stop() that lands before initialize() finishes is not undone by the late startPolling()", async () => {
    tg = await fakeTelegram();
    const bot = createBot({ token: "99:early", allowedUserIds: [7], apiBaseUrl: tg.url });
    bots.push(bot);
    await bot.stop();
    await bot.adapter.initialize(fakeChat() as never);
    await sleep(1200);
    expect(tg.callsFor("99:early", "getUpdates")).toHaveLength(0);
    expect(bot.adapter.isPolling).toBe(false);
  });

  it("never builds a bot without an allow-list (the adapter would answer anyone)", async () => {
    tg = await fakeTelegram();
    expect(() => createBot({ token: "11:x", allowedUserIds: [], apiBaseUrl: tg.url })).toThrow(/no allowed user ids/);
  });
});

describe("whose memory a bot's chats belong to", () => {
  const owner = (isolatedAs?: string) => {
    const ch = telegramChannels({ adapter: {} as never }, { queue: {} as never, slash: (async () => undefined) as never, verbose: () => false, isolatedAs });
    return ch.resolveResourceId?.({ defaultResourceId: "telegram:7" } as never);
  };

  it("keeps Mastra's per-user owner for the primary and shared agents, and gives an isolated agent its own", async () => {
    expect(await owner()).toBeUndefined(); // no hook: Mastra's default telegram:<userId>
    expect(await owner("researcher")).toBe("researcher:telegram:7");
  });
});
