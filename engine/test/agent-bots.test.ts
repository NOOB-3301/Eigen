import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSecret } from "../src/mastra/lib/envfile.ts";
import { agentPaths, type HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentConfigInput } from "../src/mastra/lib/schema.ts";
import { tmpHome, writeAgent } from "./helpers/home.ts";
import { closeRegistries, registryRig, sleep, telegramEvents, until } from "./helpers/registry.ts";

afterEach(closeRegistries);

const bot = (tokenEnv = "TELEGRAM_BOT_TOKEN"): Partial<AgentConfigInput> => ({ telegram: { enabled: true, tokenEnv, allowedUserIds: [7] } });
const editConfig = (p: HomePaths, id: string, patch: Record<string, unknown>) => {
  const file = agentPaths(p, id).configFile;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};

describe("each agent's own bot", () => {
  it("is built with the token from the agent's own .env, never another agent's or the engine's environment", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha", bot(), { env: { TELEGRAM_BOT_TOKEN: "1:alpha" } });
    writeAgent(p, "beta", bot(), { env: { TELEGRAM_BOT_TOKEN: "2:beta" } });
    writeAgent(p, "gamma", bot());
    process.env.TELEGRAM_BOT_TOKEN = "9:from-the-shell";
    try {
      const { contexts, attach } = registryRig(p);
      await attach();
      expect(contexts.alpha![0]!.telegramToken).toBe("1:alpha");
      expect(contexts.beta![0]!.telegramToken).toBe("2:beta");
      expect(contexts.gamma![0]!.telegramToken).toBeUndefined();
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("says missing-token until the variable is set in the agent's .env, then starts the bot without a restart", async () => {
    const p = tmpHome();
    writeAgent(p, "gamma", bot("TG_GAMMA"));
    const { reg, bots, events, contexts, attach, watch } = registryRig(p);
    await attach();
    await watch();
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "missing-token", error: "TG_GAMMA is not set in this agent's keys" });

    setSecret(agentPaths(p, "gamma").envFile, "TG_GAMMA", "111:token-gamma");
    await until(() => (bots.get("gamma") ?? []).length === 1);
    expect(contexts.gamma!.map((c) => c.telegramToken)).toEqual([undefined, "111:token-gamma"]);
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "starting" });
    bots.get("gamma")![0]!.set({ state: "polling", username: "gamma_bot" });
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "polling", username: "gamma_bot" });
    expect(telegramEvents(events, "gamma").map((t) => t.state)).toEqual(["missing-token", "starting", "polling"]);
    const node = reg.snapshot().topology.nodes.find((n) => n.id === "channel:telegram:gamma");
    expect(node).toMatchObject({ data: { state: "polling", username: "gamma_bot", agentId: "gamma" } });
    expect(JSON.stringify(events)).not.toContain("111:token-gamma");
    expect(JSON.stringify(reg.snapshot())).not.toContain("111:token-gamma");
  });

  it("an agent without Telegram reports off", async () => {
    const p = tmpHome();
    writeAgent(p, "plain");
    const { reg, attach } = registryRig(p);
    await attach();
    expect(reg.detail("plain")!.runtime.telegram).toEqual({ state: "off" });
  });

  it("stops the old bot completely BEFORE the replacement agent is added (one poller per token)", async () => {
    const p = tmpHome();
    writeAgent(p, "gamma", bot(), { env: { TELEGRAM_BOT_TOKEN: "111:token-gamma" } });
    const { reg, order, bots, attach } = registryRig(p);
    await attach();
    order.length = 0;
    editConfig(p, "gamma", { description: "Changed." });
    await reg.reload();
    expect(order).toEqual(["stopped:gamma#1", "remove:gamma", "add:gamma", "disposed:gamma#1"]);
    expect(bots.get("gamma")!.map((b) => b.stopped)).toEqual([true, false]);
  });

  it("a replaced bot can no longer change the agent's reported state", async () => {
    const p = tmpHome();
    writeAgent(p, "gamma", bot(), { env: { TELEGRAM_BOT_TOKEN: "111:token-gamma" } });
    const { reg, bots, attach } = registryRig(p);
    await attach();
    editConfig(p, "gamma", { description: "Changed." });
    await reg.reload();
    const [old, fresh] = bots.get("gamma")!;
    fresh!.set({ state: "polling", username: "gamma_bot" });
    old!.set({ state: "error", error: "late noise from the old bot" });
    expect(reg.detail("gamma")!.runtime.telegram).toEqual({ state: "polling", username: "gamma_bot" });
  });

  it("stops the bot when the agent folder is trashed, disabled, or the registry closes", async () => {
    const p = tmpHome();
    writeAgent(p, "gone", bot(), { env: { TELEGRAM_BOT_TOKEN: "1:a" } });
    writeAgent(p, "off", bot(), { env: { TELEGRAM_BOT_TOKEN: "2:b" } });
    writeAgent(p, "stay", bot(), { env: { TELEGRAM_BOT_TOKEN: "3:c" } });
    const { reg, bots, attach } = registryRig(p);
    await attach();
    mkdirSync(p.trashDir, { recursive: true });
    renameSync(agentPaths(p, "gone").dir, join(p.trashDir, "gone-1"));
    editConfig(p, "off", { enabled: false });
    await reg.reload();
    expect(bots.get("gone")![0]!.stopped).toBe(true);
    expect(bots.get("off")![0]!.stopped).toBe(true);
    expect(bots.get("stay")![0]!.stopped).toBe(false);
    expect(reg.detail("gone")).toBeUndefined();
    await reg.close();
    expect(bots.get("stay")![0]!.stopped).toBe(true);
  });

  it("two agents whose .env hold the same token: the first by id keeps the bot, the second loads without one, then gets it once the first lets go", async () => {
    const p = tmpHome();
    writeAgent(p, "bbb", bot("TG_B"), { env: { TG_B: "9:same" } });
    writeAgent(p, "aaa", bot(), { env: { TELEGRAM_BOT_TOKEN: "9:same" } });
    const { reg, contexts, attach, watch } = registryRig(p);
    await attach();
    await watch();
    expect(contexts.aaa!.map((c) => c.telegramToken)).toEqual(["9:same"]);
    expect(contexts.bbb!.map((c) => c.telegramToken)).toEqual([undefined]);
    expect(reg.detail("bbb")!.runtime).toMatchObject({ status: "loaded", telegram: { state: "error", error: 'this bot token is also used by "aaa"; one token serves one agent' } });

    setSecret(agentPaths(p, "aaa").envFile, "TELEGRAM_BOT_TOKEN", "9:rotated");
    await until(() => contexts.bbb!.length === 2);
    await sleep(100);
    expect(contexts.bbb!.map((c) => c.telegramToken)).toEqual([undefined, "9:same"]);
    expect(contexts.aaa!.map((c) => c.telegramToken)).toEqual(["9:same", "9:rotated"]);
    expect(reg.detail("bbb")!.runtime.telegram).toEqual({ state: "starting" });
  });
});
