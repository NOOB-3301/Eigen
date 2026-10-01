import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homePaths, seedHome } from "../src/mastra/lib/home.ts";
import { fakeLlm, type Turn } from "../test/helpers/fake-llm.ts";
import { fakeTelegram } from "../test/helpers/fake-telegram.ts";

const ROOT = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for condition");
}

/** The built server (.mastra/output) wired to a fake Telegram and a scripted fake model. */
export async function startEigen(turns: Turn[], config: Record<string, unknown> = {}, port = 4199) {
  const tg = await fakeTelegram();
  const llm = await fakeLlm(turns);
  const p = homePaths(mkdtempSync(join(tmpdir(), "eigen-e2e-")));
  seedHome(p, join(ROOT, "defaults"));
  const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
  Object.assign(cfg, { telegram: { ...cfg.telegram, allowedUserIds: [7] }, sandbox: { ...cfg.sandbox, isolation: "none" }, ...config });
  for (const m of Object.values<any>(cfg.models)) m.url = llm.url;
  cfg.memory.embedder.url = llm.url;
  cfg.curatorModel = "local";
  writeFileSync(p.configFile, JSON.stringify(cfg));

  const proc = spawn("node", [join(ROOT, ".mastra/output/index.mjs")], {
    env: { ...process.env, EIGEN_HOME: p.home, EIGEN_PORT: String(port), TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_API_BASE_URL: tg.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  await waitFor(() => tg.calls.some((c) => c.method === "getUpdates"), 60_000).catch(() => {
    throw new Error(`server never started polling:\n${log.slice(-1500)}`);
  });

  return {
    p,
    tg,
    llm,
    api: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/api${path}`, init).then((r) => r.json()) as Promise<any>,
    log: () => log,
    stop: async () => {
      proc.kill("SIGKILL");
      await Promise.all([tg.close(), llm.close()]);
    },
  };
}
