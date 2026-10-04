import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readyHome, type HomePaths } from "../src/mastra/lib/home.ts";
import type { AgentConfigInput, ListAgentsResponse } from "../src/mastra/lib/schema.ts";
import { fakeLlm, type Turn } from "../test/helpers/fake-llm.ts";
import { fakeTelegram } from "../test/helpers/fake-telegram.ts";
import { writeAgent } from "../test/helpers/home.ts";

const ROOT = resolve(import.meta.dirname, "..");
/** The mastra CLI, wherever npm put it (hoisted to the workspace root or local to engine/): same lookup as scripts/service.ts. */
const pkg = createRequire(import.meta.url).resolve("mastra/package.json");
export const MASTRA_CLI = join(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.mastra);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for condition");
}

/** waitFor for checks that need a request. */
export async function eventually(check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for condition");
}

/**
 * One agent folder for the test home. By default it has a Telegram bot whose token is in its own .env, one allowed user (7), and a model
 * served by a fake LLM of its own, so a test can tell which agent a request reached.
 */
export type AgentSpec = { id: string; config?: Partial<AgentConfigInput>; env?: Record<string, string>; instructions?: string; turns?: Turn[]; telegram?: boolean };

/** The bot token the harness puts in an agent's .env. */
export const tokenOf = (id: string) => `${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 900_000, 7) + 100_000}:tok-${id}`;

/**
 * The built server (.mastra/output) with a temp home of v2 agent folders, a fake Telegram (TELEGRAM_API_BASE_URL) and one fake model per agent.
 * Nothing secret is put in the engine's environment: each agent's token is only in its own .env.
 */
export async function startEigen(agents: AgentSpec[], { port = 4190, prepare }: { port?: number; prepare?: (p: HomePaths) => void } = {}) {
  const tg = await fakeTelegram();
  const llms = Object.fromEntries(await Promise.all(agents.map(async (a) => [a.id, await fakeLlm(a.turns ?? [{ text: `hi from ${a.id}` }])] as const)));
  const p = readyHome(mkdtempSync(join(tmpdir(), "eigen-e2e-")));
  for (const a of agents) {
    const telegram = a.telegram ?? true;
    writeAgent(
      p,
      a.id,
      {
        models: { main: { id: "fake/model", url: llms[a.id]!.url } },
        sandbox: { isolation: "none" },
        telegram: { enabled: telegram, allowedUserIds: [7] },
        ...a.config,
      },
      { instructions: a.instructions, env: { ...(telegram && { TELEGRAM_BOT_TOKEN: tokenOf(a.id) }), ...a.env } },
    );
  }
  prepare?.(p);

  const env = { ...process.env, EIGEN_HOME: p.home, EIGEN_PORT: String(port), TELEGRAM_API_BASE_URL: tg.url };
  const proc = spawn(process.execPath, [join(ROOT, ".mastra/output/index.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const get = async <T,>(path: string) => {
    const r = await fetch(`${url}${path}`);
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = async <T,>(path: string, body: unknown) => {
    const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  const stop = async () => {
    proc.kill("SIGKILL");
    await Promise.all([tg.close(), ...Object.values(llms).map((l) => l.close())]);
  };

  // Up = every agent is loaded and every bot is polling.
  const bots = agents.filter((a) => a.telegram ?? true).map((a) => tokenOf(a.id));
  let seen = "no answer from /eigen/agents";
  try {
    await eventually(async () => {
      const { body } = await get<ListAgentsResponse>("/eigen/agents").catch((e) => {
        seen = `GET /eigen/agents failed: ${(e as Error).message} ${((e as Error).cause as Error | undefined)?.message ?? ""}`;
        throw e;
      });
      const polling = bots.map((t) => tg.callsFor(t, "getUpdates").length);
      seen = `agents ${body.agents.map((a) => `${a.id}:${a.runtime.status}`).join(",") || "none"}; getUpdates per bot ${polling.join(",") || "-"}`;
      return body.agents.length === agents.length && body.agents.every((a) => a.runtime.status === "loaded") && polling.every((n) => n > 0);
    }, 90_000);
  } catch {
    await stop();
    throw new Error(`the engine never came up (last seen: ${seen}):\n${log.slice(-3000)}`);
  }
  return { p, tg, llms, url, get, post, log: () => log, stop };
}

export type Eigen = Awaited<ReturnType<typeof startEigen>>;
