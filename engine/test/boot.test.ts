import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, telegramTokenOk } from "../src/mastra/lib/boot.ts";
import { reloadConfig } from "../src/mastra/lib/config.ts";
import { tmpHome } from "./helpers/home.ts";

const reply = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
const offline = vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
const env = { TELEGRAM_BOT_TOKEN: "123:abc" };

function useHome(allowedUserIds: number[]) {
  process.env.EIGEN_HOME = tmpHome({ telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds } }).home;
  reloadConfig();
}

afterEach(() => {
  delete process.env.EIGEN_HOME;
});

describe("telegramTokenOk", () => {
  it("is false only when Telegram rejects the token", async () => {
    expect(await telegramTokenOk("t", reply(200))).toBe(true);
    expect(await telegramTokenOk("t", reply(401))).toBe(false);
    expect(await telegramTokenOk("t", reply(404))).toBe(false);
    expect(await telegramTokenOk("t", offline)).toBe(true);
  });
});

describe("boot", () => {
  it("refuses an empty allowlist", async () => {
    useHome([]);
    await expect(boot(env, reply(200))).rejects.toThrow(/allowedUserIds is empty/);
  });

  it("refuses a rejected token", async () => {
    useHome([1]);
    await expect(boot(env, reply(401))).rejects.toThrow(/rejected by Telegram/);
  });

  it("starts when everything is in place", async () => {
    useHome([1]);
    expect((await boot(env, reply(200))).telegram.allowedUserIds).toEqual([1]);
  });
});
