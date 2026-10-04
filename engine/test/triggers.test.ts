import { existsSync, readFileSync } from "node:fs";
import type { Agent } from "@mastra/core/agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { AgentConfigSchema, resolveAgent, type Trigger, type TriggerInput, type TriggerRuntime } from "../src/mastra/lib/schema.ts";
import type { TelegramBot } from "../src/mastra/lib/telegram.ts";
import { chunkText, createTriggerManager, triggerResource, type UnattendedRun } from "../src/mastra/lib/triggers.ts";
import { runsFile, seenFile } from "../src/mastra/lib/trigger-runs.ts";
import { fakeClock } from "./helpers/fake-clock.ts";
import { fakeGithub, pull, type FakePull } from "./helpers/fake-github.ts";
import { tmpHome } from "./helpers/home.ts";

const TOKEN = "gho_Tok3nThatMustNeverLeak0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const ghTrigger = (o: Record<string, unknown> = {}): TriggerInput => ({ id: "prs", type: "github-pr", repo: "acme/app", tokenEnv: "GITHUB_TOKEN", prompt: "Review {{pr.title}}", intervalSec: 60, ...o }) as TriggerInput;
const cronTrigger = (o: Record<string, unknown> = {}): TriggerInput => ({ id: "daily", type: "cron", cron: "0 9 * * *", timezone: "Asia/Kolkata", prompt: "Summary for {{date}} at {{time}}", ...o }) as TriggerInput;

function fakeBot(initial: "polling" | "starting" | "error" = "polling") {
  const sent: Array<{ chat: string; text: string }> = [];
  const failFor = new Set<string>();
  let state: string = initial;
  const bot = {
    state: () => ({ state }),
    adapter: {
      openDM: async (id: string) => `telegram:${id}`,
      postMessage: async (chat: string, text: string) => {
        if (failFor.has(chat)) throw new Error(`chat ${chat} not found`);
        sent.push({ chat, text });
      },
    },
  } as unknown as Pick<TelegramBot, "adapter" | "state">;
  return { bot, sent, failFor, setState: (s: string) => (state = s) };
}

type Options = { start?: string; env?: NodeJS.ProcessEnv; runAgent?: (r: UnattendedRun) => Promise<{ text: string; declined: string[] }>; bot?: ReturnType<typeof fakeBot> | null; secrets?: string[]; timezone?: string; runTimeoutMs?: number };

async function rig(o: Options = {}) {
  const p = tmpHome();
  const root = loadConfig(p.configFile);
  const gh = await fakeGithub();
  closers.push(gh.close);
  const fc = fakeClock(o.start ?? "2026-10-04T08:59:00Z");
  const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: TOKEN, GITHUB_API_BASE_URL: gh.url, ...o.env };
  const runs: UnattendedRun[] = [];
  const runAgent = o.runAgent ?? (async (r: UnattendedRun) => (runs.push(r), { text: `Reviewed (${runs.length})`, declined: [] }));
  const logs: string[] = [];
  const events: Array<{ id: string; trigger: TriggerRuntime }> = [];
  const telegram = o.bot === undefined ? fakeBot() : o.bot;
  /** The root time zone, which a test can change like an edit to config.json. */
  const zone = { current: o.timezone ?? "Asia/Kolkata" };
  const make = () => {
    const mgr = createTriggerManager({
      paths: p,
      env,
      clock: fc.clock,
      log: (m) => logs.push(m),
      emit: (id, trigger) => events.push({ id, trigger }),
      timezone: () => zone.current,
      agentOf: () => ({}) as Agent,
      botOf: () => telegram?.bot,
      secretsOf: () => o.secrets ?? [],
      runAgent,
      runTimeoutMs: o.runTimeoutMs,
    });
    closers.push(() => mgr.close());
    return mgr;
  };
  const resolved = (triggers: TriggerInput[], extra: Record<string, unknown> = {}) =>
    resolveAgent(AgentConfigSchema.parse({ id: "reviewer", name: "Reviewer", role: "reviewer", description: "Reviews.", telegram: { allowedUserIds: [7, 8] }, triggers, ...extra }), root);
  const mgr = make();
  const rt = (i = 0) => mgr.runtimes("reviewer")![i]!;
  /** Fires what is due and waits until the trigger is idle again with its next time set (poll and every run it started are over). */
  const settle = async (ms = 0) => {
    fc.advance(ms);
    await until(() => rt().nextRunAt !== undefined && rt().state !== "running");
  };
  const allText = () => JSON.stringify({ logs, events, runtimes: mgr.runtimes("reviewer"), runs: mgr.runs("reviewer"), file: existsSync(runsFile(p, "reviewer")) ? readFileSync(runsFile(p, "reviewer"), "utf8") : "" });
  return { p, gh, fc, env, zone, runs, logs, events, telegram, mgr, make, resolved, rt, settle, allText };
}

const pr = (n: number, o: Parameters<typeof pull>[1] = {}): FakePull => pull(n, o);

describe("github-pr polling", () => {
  it("only records the pull requests that are already open on the first poll; it never fires for them", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1), pr(2)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    expect(r.gh.pollsOf()).toHaveLength(1);
    expect(r.runs).toEqual([]);
    expect(r.rt()).toMatchObject({ id: "prs", type: "github-pr", state: "idle", nextRunAt: new Date(r.fc.now() + 60_000).toISOString() });
    expect(JSON.parse(readFileSync(seenFile(r.p, "reviewer", "prs"), "utf8"))).toEqual({ repo: "acme/app", prs: { 1: "sha-1-a", 2: "sha-2-a" } });
  });

  it("fires once for a pull request that appears, with the placeholders filled and the event as data", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2, { title: "Add retries", author: "hubot" }));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ threadId: "trigger-reviewer-prs", resourceId: expect.any(String), maxSteps: expect.any(Number) });
    expect(r.runs[0]!.prompt.split("\n\n")[0]).toBe("Review Add retries");
    expect(r.runs[0]!.prompt).toContain('"author":"hubot"');
    expect(r.rt().lastRun).toMatchObject({ status: "ok", subject: "acme/app#2 opened", reply: "Reviewed (1)", delivered: true, agentId: "reviewer", triggerId: "prs", type: "github-pr" });
    // two more polls with nothing new: still one run
    await r.settle(60_000);
    await r.settle(60_000);
    expect(r.gh.pollsOf()).toHaveLength(4);
    expect(r.runs).toHaveLength(1);
  });

  it("fires 'updated' when a seen pull request gets a new head commit, and only if the trigger asks for it", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger({ events: ["opened", "updated"] })]));
    await r.settle();
    r.gh.addPull("acme/app", pr(1, { sha: "sha-1-b" }));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    expect(r.rt().lastRun?.subject).toBe("acme/app#1 updated");
    expect(r.runs[0]!.prompt).toContain('"headSha":"sha-1-b"');
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1); // the new sha is remembered

    const only = await rig();
    only.gh.setPulls("acme/app", [pr(1)]);
    only.mgr.sync("reviewer", only.resolved([ghTrigger()])); // events: ["opened"]
    await only.settle();
    only.gh.addPull("acme/app", pr(1, { sha: "sha-1-b" }));
    await only.settle(60_000);
    expect(only.runs).toEqual([]);
    only.gh.addPull("acme/app", pr(1, { sha: "sha-1-c" }));
    await only.settle(60_000);
    expect(only.runs).toEqual([]);
  });

  it("does not fire again after a restart or a hot reload, but does fire for what appeared while it was down", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    await r.mgr.close();

    // a new engine process on the same home: the seen-list is on disk
    const again = r.make();
    r.gh.addPull("acme/app", pr(3));
    again.sync("reviewer", r.resolved([ghTrigger()]));
    r.fc.advance(0);
    await until(() => r.runs.length === 2 && again.runtimes("reviewer")![0]!.state === "idle");
    expect(r.runs.map((x) => x.prompt.match(/"number":(\d+)/)![1])).toEqual(["2", "3"]);
    expect(again.runs("reviewer").map((x) => x.subject)).toEqual(["acme/app#3 opened", "acme/app#2 opened"]);
  });

  it("skips drafts unless includeDrafts, and a draft marked ready then counts as opened", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2, { draft: true }));
    await r.settle(60_000);
    expect(r.runs).toEqual([]);
    r.gh.addPull("acme/app", pr(2, { draft: false, sha: "sha-2-b" }));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    expect(r.rt().lastRun?.subject).toBe("acme/app#2 opened");

    const withDrafts = await rig();
    withDrafts.gh.setPulls("acme/app", [pr(1)]);
    withDrafts.mgr.sync("reviewer", withDrafts.resolved([ghTrigger({ includeDrafts: true })]));
    await withDrafts.settle();
    withDrafts.gh.addPull("acme/app", pr(2, { draft: true }));
    await withDrafts.settle(60_000);
    expect(withDrafts.runs).toHaveLength(1);
    expect(withDrafts.runs[0]!.prompt).toContain('"draft":true');
  });

  it("runs at most 5 per poll, newest first, remembers all of them, and logs how many it skipped", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    for (let n = 2; n <= 9; n++) r.gh.addPull("acme/app", pr(n));
    await r.settle(60_000);
    expect(r.runs.map((x) => x.prompt.match(/"number":(\d+)/)![1])).toEqual(["9", "8", "7", "6", "5"]);
    expect(r.logs.some((l) => l.includes("running the newest 5 and skipping 3"))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(seenFile(r.p, "reviewer", "prs"), "utf8")).prs)).toHaveLength(9);
    await r.settle(60_000);
    expect(r.runs).toHaveLength(5); // 2, 3 and 4 are not picked up later
  });

  it("sends If-None-Match after the first poll and treats a 304 as nothing new", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    expect(r.gh.pollsOf()[0]!.headers["if-none-match"]).toBeUndefined();
    await r.settle(60_000);
    expect(r.gh.pollsOf()[1]!.headers["if-none-match"]).toMatch(/^"[0-9a-f]{40}"$/);
    expect(r.rt()).toMatchObject({ state: "idle" });
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1); // the changed list is not served from the 304 path
  });

  it("backs off until a rate limit lifts and then keeps polling", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    const resetAt = r.fc.now() + 10 * 60_000;
    r.gh.rateLimit(403, { resetEpochSec: resetAt / 1000 });
    await r.settle(60_000);
    expect(r.rt()).toMatchObject({ state: "error", error: expect.stringContaining("rate limit"), nextRunAt: new Date(resetAt).toISOString() });
    const polls = r.gh.pollsOf().length;
    await r.settle(0);
    r.fc.advance(8 * 60_000); // nothing is due before the reset
    await sleep(60);
    expect(r.gh.pollsOf()).toHaveLength(polls);

    r.gh.clearRateLimit();
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000); // past the reset
    expect(r.gh.pollsOf()).toHaveLength(polls + 1);
    expect(r.runs).toHaveLength(1);
    expect(r.rt()).toMatchObject({ state: "idle" });
    expect(r.rt().error).toBeUndefined();
  });

  it("honours Retry-After on a 429, never waiting less than the poll interval", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.rateLimit(429, { retryAfterSec: 5 });
    await r.settle(60_000);
    expect(r.rt()).toMatchObject({ state: "error", nextRunAt: new Date(r.fc.now() + 60_000).toISOString() });
    r.gh.clearRateLimit();
    r.gh.rateLimit(429, { retryAfterSec: 900 });
    await r.settle(60_000);
    expect(r.rt().nextRunAt).toBe(new Date(r.fc.now() + 900_000).toISOString());
  });

  it("shows missing-token without calling GitHub, and starts as soon as the token appears (the agent reloads when .env changes)", async () => {
    const r = await rig({ env: { GITHUB_TOKEN: undefined } });
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    expect(r.rt()).toMatchObject({ state: "missing-token", error: "GITHUB_TOKEN is not set in .env" });
    await r.settle(60_000);
    expect(r.gh.requests).toEqual([]);

    r.env.GITHUB_TOKEN = TOKEN;
    r.mgr.sync("reviewer", r.resolved([ghTrigger()])); // what the registry does when the agent version changes
    await r.settle();
    expect(r.rt().state).toBe("idle");
    expect(r.gh.pollsOf()).toHaveLength(1);
  });

  it("reports 401, 403 and 404 as plain errors, keeps polling, and recovers", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    for (const [status, text] of [[401, "rejected the token"], [403, "not allowed to read"], [404, "not found"]] as const) {
      r.gh.failWith("acme/app", status);
      await r.settle(60_000);
      expect(r.rt(), String(status)).toMatchObject({ state: "error", error: expect.stringContaining(text) });
      expect(r.rt().nextRunAt).toBeDefined();
    }
    r.gh.clearFailures();
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    expect(r.rt()).toMatchObject({ state: "idle" });
    expect(r.rt().error).toBeUndefined();
  });

  it("never makes a request for a repo that could leave /repos/ (a config read before it was validated)", async () => {
    const r = await rig();
    for (const repo of ["../x", "acme/.."]) {
      // built by hand: this is what a config that skipped the schema would look like
      const trigger = { id: "prs", type: "github-pr", repo, tokenEnv: "GITHUB_TOKEN", prompt: "x", enabled: true, deliverToTelegram: true, events: ["opened"], intervalSec: 60, includeDrafts: false } as Trigger;
      r.mgr.sync("reviewer", { ...r.resolved([]), triggers: [trigger] });
      await r.settle();
      expect(r.rt(), repo).toMatchObject({ state: "error", error: expect.stringContaining("not an owner/name repository") });
      expect(await r.mgr.runNow("reviewer", "prs"), repo).toEqual({ ok: false, error: `"${repo}" is not an owner/name repository` });
    }
    expect(r.gh.requests).toEqual([]);
  });

  it("sends the token only to the API base, only as a Bearer header, and a redirect does not carry it elsewhere", async () => {
    const r = await rig();
    const elsewhere = await fakeGithub();
    closers.push(elsewhere.close);
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000);
    expect(r.gh.requests.length).toBeGreaterThan(0);
    for (const req of r.gh.requests) {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.path + req.query.toString()).not.toContain(TOKEN);
      expect(Object.entries(req.headers).filter(([k, v]) => k !== "authorization" && v?.includes(TOKEN))).toEqual([]);
    }
    r.gh.redirect("acme/app", `${elsewhere.url}/steal`);
    await r.settle(60_000);
    expect(r.rt()).toMatchObject({ state: "error", error: expect.stringContaining("redirected") });
    expect(elsewhere.requests).toEqual([]);
  });

  it("keeps the token out of logs, events, runtimes, the run history and the stored files, even when GitHub echoes it back", async () => {
    const a = await rig({ runAgent: async () => ({ text: `The token was ${TOKEN} and Bearer ${TOKEN}`, declined: [] }) });
    a.gh.setPulls("acme/app", [pr(1)]);
    a.mgr.sync("reviewer", a.resolved([ghTrigger()]));
    await a.settle();
    a.gh.addPull("acme/app", pr(2));
    await a.settle(60_000);
    expect(a.rt().lastRun?.reply).toContain("[redacted]");
    expect(a.telegram!.sent.map((s) => s.text).join()).not.toContain(TOKEN);
    expect(a.allText()).not.toContain(TOKEN);
    expect(a.allText()).not.toContain("Tok3nThatMustNeverLeak");

    // a failing GitHub that echoes the Authorization header
    const bad = await fakeGithub({ token: "another-token" });
    closers.push(bad.close);
    bad.echoTokenInErrors();
    const r = await rig({ env: { GITHUB_API_BASE_URL: bad.url } });
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    expect(r.rt()).toMatchObject({ state: "error", error: expect.stringContaining("401") });
    expect(r.allText()).not.toContain("Tok3nThatMustNeverLeak");
  });
});

describe("cron", () => {
  it("runs at the time in its own zone with date and time filled, then waits for the next day", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z" }); // 08:59 in Kolkata
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    expect(r.rt()).toMatchObject({ id: "daily", type: "cron", state: "idle", nextRunAt: "2026-10-04T03:30:00.000Z" });
    r.fc.advance(30_000);
    await sleep(30);
    expect(r.runs).toEqual([]); // not yet
    r.fc.advance(30_000);
    await until(() => r.rt().lastRun?.status === "ok");
    expect(r.runs[0]!.prompt.split("\n\n")[0]).toBe("Summary for 2026-10-04 at 09:00");
    expect(r.rt()).toMatchObject({ state: "idle", nextRunAt: "2026-10-05T03:30:00.000Z", lastRun: { subject: "cron 0 9 * * *", status: "ok", delivered: true } });
  });

  it("uses the root time zone when the trigger names none", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z", timezone: "UTC" });
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ timezone: undefined })]));
    expect(r.rt().nextRunAt).toBe("2026-10-04T09:00:00.000Z");
  });

  it("skips a time that passed while the machine was asleep or the engine was down, and never replays it", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z" });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    r.fc.sleep(3 * 3_600_000); // 06:29 UTC: the 09:00 IST run is 3 hours late
    await until(() => r.logs.some((l) => l.includes("missed")));
    expect(r.runs).toEqual([]);
    expect(r.logs.join()).toContain("skipped, not replayed");
    expect(r.rt().nextRunAt).toBe("2026-10-05T03:30:00.000Z");

    // a process that starts after the time has passed does not look back
    const late = await rig({ start: "2026-10-04T05:00:00Z" });
    late.mgr.sync("reviewer", late.resolved([cronTrigger()]));
    expect(late.rt().nextRunAt).toBe("2026-10-05T03:30:00.000Z");
    late.fc.advance(60_000);
    await sleep(30);
    expect(late.runs).toEqual([]);
  });

  it("a run that comes due while the previous one is still going is skipped and logged", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = await rig({ start: "2026-10-04T08:59:00Z", runAgent: async () => (await gate, { text: "slow", declined: [] }) });
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ cron: "* * * * *", timezone: "UTC" })]));
    r.fc.advance(60_000); // 09:00: the run starts and blocks
    await until(() => r.rt().state === "running");
    r.fc.advance(60_000); // 09:01 comes due during it
    await until(() => r.logs.some((l) => l.includes("skipped: the previous run is still going")));
    expect(r.mgr.runs("reviewer").filter((x) => x.status === "running")).toHaveLength(1);
    release();
    await until(() => r.rt().state === "idle");
    expect(r.mgr.runs("reviewer").filter((x) => x.status !== "running")).toHaveLength(1);
    expect(r.rt().nextRunAt).toBeDefined();
  });

  it("waits for a far-off time in hour-long steps and does not fire early", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z" });
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ cron: "0 0 1 1 *", timezone: "UTC" })]));
    expect(r.rt().nextRunAt).toBe("2027-01-01T00:00:00.000Z");
    r.fc.advance(3 * 3_600_000);
    await sleep(30);
    expect(r.runs).toEqual([]);
    expect(r.fc.pending()).toBe(1); // still one timer, re-armed
    expect(r.rt().nextRunAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("shows an error, not a crash, for an expression or a time zone it cannot schedule, and recovers when the zone is fixed", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z", timezone: "Mars/Base" });
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ id: "bad-expr", cron: "99 9 * * *", timezone: "UTC" }), cronTrigger({ timezone: undefined })]));
    expect(r.rt(0)).toMatchObject({ state: "error", error: expect.stringContaining('cannot schedule "99 9 * * *"') });
    expect(r.rt(1)).toMatchObject({ state: "error", error: expect.stringContaining("Mars/Base") });
    expect(r.rt(1).nextRunAt).toBeUndefined();
    r.zone.current = "UTC"; // config.json fixed; the next reload of the agent re-reads it
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ id: "bad-expr", cron: "99 9 * * *", timezone: "UTC" }), cronTrigger({ timezone: undefined })]));
    expect(r.rt(1)).toMatchObject({ state: "idle", nextRunAt: "2026-10-04T09:00:00.000Z" });
    expect(r.rt(1).error).toBeUndefined();
    expect(r.rt(0).state).toBe("error");
  });
})

describe("run now", () => {
  it("runs a cron trigger immediately, without moving its schedule", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z" });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(res).toMatchObject({ ok: true, run: { status: "ok", subject: "manual", reply: "Reviewed (1)", delivered: true } });
    expect(r.runs[0]!.prompt).toContain('"manual":true');
    expect(r.rt().nextRunAt).toBe("2026-10-04T03:30:00.000Z");
    expect(r.mgr.runs("reviewer")[0]!.id).toBe(res!.run!.id);
  });

  it("runs a github-pr trigger for the most recently updated open pull request, without touching the seen-list", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1), pr(5), pr(3)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    const seenBefore = readFileSync(seenFile(r.p, "reviewer", "prs"), "utf8");
    r.gh.addPull("acme/app", pr(6)); // the newest
    const res = await r.mgr.runNow("reviewer", "prs");
    expect(res).toMatchObject({ ok: true, run: { subject: "manual acme/app#6" } });
    expect(r.runs[0]!.prompt.split("\n\n")[0]).toBe("Review Change 6");
    expect(readFileSync(seenFile(r.p, "reviewer", "prs"), "utf8")).toBe(seenBefore);
    // #6 is still unseen, so the poller fires for it as a real event
    await r.settle(60_000);
    expect(r.runs).toHaveLength(2);
    expect(r.rt().lastRun?.subject).toBe("acme/app#6 opened");
  });

  it('says "no open pull requests" and missing token plainly, and 404s an unknown agent or trigger', async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", []);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    expect(await r.mgr.runNow("reviewer", "prs")).toEqual({ ok: false, error: "no open pull requests" });
    expect(r.runs).toEqual([]);
    expect(r.mgr.runNow("reviewer", "nope")).toBeUndefined();
    expect(r.mgr.runNow("ghost", "prs")).toBeUndefined();

    const noToken = await rig({ env: { GITHUB_TOKEN: undefined } });
    noToken.mgr.sync("reviewer", noToken.resolved([ghTrigger()]));
    expect(await noToken.mgr.runNow("reviewer", "prs")).toEqual({ ok: false, error: "GITHUB_TOKEN is not set in .env" });
  });

  it("refuses to start a second run while one is going, and a poll that comes due then is skipped and logged", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = await rig({ runAgent: async () => (await gate, { text: "slow", declined: [] }) });
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    const first = r.mgr.runNow("reviewer", "prs")!;
    await until(() => r.rt().state === "running");
    expect(await r.mgr.runNow("reviewer", "prs")).toEqual({ ok: false, error: "this trigger is already running" });
    const polls = r.gh.pollsOf().length;
    r.fc.advance(60_000);
    await until(() => r.logs.some((l) => l.includes("poll skipped")));
    expect(r.gh.pollsOf()).toHaveLength(polls);
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("reports a failed run as ok:false with the error, records it, and delivers nothing", async () => {
    const r = await rig({ runAgent: async () => Promise.reject(new Error("the model is down")) });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(res).toMatchObject({ ok: false, error: "the model is down", run: { status: "error", error: "the model is down" } });
    expect(res!.run!.delivered).toBeUndefined();
    expect(r.telegram!.sent).toEqual([]);
    expect(r.rt()).toMatchObject({ state: "error", error: "the model is down" });
  });
});

describe("a run", () => {
  it("scopes memory like the agent's chats: the user's own resource when memory is shared, a private one when isolated", async () => {
    const shared = await rig();
    shared.mgr.sync("reviewer", shared.resolved([cronTrigger()], { memory: { scope: "shared" } }));
    await shared.mgr.runNow("reviewer", "daily");
    expect(shared.runs[0]).toMatchObject({ threadId: "trigger-reviewer-daily", resourceId: "telegram:7" });
    const isolated = await rig();
    isolated.mgr.sync("reviewer", isolated.resolved([cronTrigger()]));
    await isolated.mgr.runNow("reviewer", "daily");
    expect(isolated.runs[0]).toMatchObject({ threadId: "trigger-reviewer-daily", resourceId: "agent-reviewer" });
    expect(triggerResource({ id: "x", memory: { scope: "shared" }, telegram: { allowedUserIds: [] } } as never)).toBe("agent-x");
  });

  it("uses the agent's maxSteps", async () => {
    const r = await rig();
    r.mgr.sync("reviewer", r.resolved([cronTrigger()], { limits: { maxSteps: 7 } }));
    await r.mgr.runNow("reviewer", "daily");
    expect(r.runs[0]!.maxSteps).toBe(7);
  });

  it("is cut off after its timeout even when the agent never answers", async () => {
    const r = await rig({ runAgent: () => new Promise(() => undefined), runTimeoutMs: 50 });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    expect(await r.mgr.runNow("reviewer", "daily")).toMatchObject({ ok: false, run: { status: "error", error: "timed out after 0.05 seconds" } });
    expect(r.rt()).toMatchObject({ state: "error" });
  });

  it("records the reply, redacted and cut to 4000 characters, and delivers the whole thing in parts", async () => {
    const long = Array.from({ length: 300 }, (_, i) => `Line ${i} ${"y".repeat(30)}`).join("\n");
    const r = await rig({ runAgent: async () => ({ text: long, declined: [] }) });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(res!.run!.reply!.length).toBe(4000);
    const forFirstUser = r.telegram!.sent.filter((s) => s.chat === "telegram:7");
    expect(forFirstUser.length).toBeGreaterThan(2);
    expect(forFirstUser.every((s) => s.text.length <= 4096)).toBe(true);
    expect(forFirstUser[0]!.text.startsWith("Trigger daily - manual\n\nLine 0")).toBe(true);
    expect(forFirstUser.map((s) => s.text).join("\n")).toContain("Line 299");
  });

  it("notes the tool calls that were declined because nobody can approve them", async () => {
    const r = await rig({ runAgent: async () => ({ text: "I could not delete the file.", declined: ["bash", "bash", "write"] }) });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(res!.run!.reply).toContain("I could not delete the file.");
    expect(res!.run!.reply).toContain("3 tool calls (bash, write) needed approval");
  });

  it("says so when the agent is not available", async () => {
    const r = await rig();
    const mgr = createTriggerManager({ paths: r.p, env: {}, clock: r.fc.clock, timezone: () => "UTC", agentOf: () => undefined, botOf: () => undefined });
    closers.push(() => mgr.close());
    mgr.sync("reviewer", r.resolved([cronTrigger()]));
    expect(await mgr.runNow("reviewer", "daily")).toMatchObject({ ok: false, error: expect.stringContaining("the agent is not available") });
  });
});

describe("delivery to Telegram", () => {
  it("sends the reply to every allowed user with a header naming the trigger and the subject, as plain text", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2, { title: "<b>bold</b> *md* [x](http://evil)" }));
    await r.settle(60_000);
    expect(r.telegram!.sent).toEqual([
      { chat: "telegram:7", text: "Trigger prs - acme/app#2 opened\n\nReviewed (1)" },
      { chat: "telegram:8", text: "Trigger prs - acme/app#2 opened\n\nReviewed (1)" },
    ]);
  });

  it("delivers through a bot that is still starting (just rebuilt by a reload), not through one that failed", async () => {
    const bot = fakeBot("starting");
    const r = await rig({ bot });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    expect((await r.mgr.runNow("reviewer", "daily"))!.run).toMatchObject({ delivered: true });
    expect(bot.sent).toHaveLength(2);
    bot.setState("error");
    expect((await r.mgr.runNow("reviewer", "daily"))!.run).toMatchObject({ delivered: false });
    expect(bot.sent).toHaveLength(2);
  });

  it("does not send when deliverToTelegram is off, and the run says nothing about delivery", async () => {
    const r = await rig();
    r.mgr.sync("reviewer", r.resolved([cronTrigger({ deliverToTelegram: false })]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(r.telegram!.sent).toEqual([]);
    expect(res!.run).toMatchObject({ status: "ok" });
    expect(res!.run!.delivered).toBeUndefined();
  });

  it("records delivered:false and logs why when there is no bot, or it is not running, or the agent has no allowed users", async () => {
    const none = await rig({ bot: null });
    none.mgr.sync("reviewer", none.resolved([cronTrigger()]));
    expect((await none.mgr.runNow("reviewer", "daily"))!.run).toMatchObject({ status: "ok", delivered: false, deliveryError: "the agent has no Telegram bot" });
    expect(none.logs.join()).toContain("the agent has no Telegram bot");

    const down = await rig({ bot: fakeBot("error") });
    down.mgr.sync("reviewer", down.resolved([cronTrigger()]));
    expect((await down.mgr.runNow("reviewer", "daily"))!.run).toMatchObject({ delivered: false, deliveryError: "the agent's Telegram bot is not running (error)" });
    expect(down.logs.join()).toContain("not running (error)");

    const nobody = await rig();
    nobody.mgr.sync("reviewer", nobody.resolved([cronTrigger()], { telegram: { allowedUserIds: [] } }));
    expect((await nobody.mgr.runNow("reviewer", "daily"))!.run).toMatchObject({ delivered: false });
    expect(nobody.logs.join()).toContain("no allowed Telegram user ids");
  });

  it("records delivered:false when Telegram fails for someone, still delivers to the others, and the run stays ok", async () => {
    const bot = fakeBot();
    bot.failFor.add("telegram:7");
    const r = await rig({ bot });
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    const res = await r.mgr.runNow("reviewer", "daily");
    expect(res!.run).toMatchObject({ status: "ok", delivered: false, reply: "Reviewed (1)" });
    expect(bot.sent.map((s) => s.chat)).toEqual(["telegram:8"]);
    expect(r.logs.join()).toContain("not delivered to 7");
    expect(r.mgr.runs("reviewer")[0]).toMatchObject({ delivered: false });
  });
});

describe("hot reload", () => {
  it("leaves an unchanged trigger running when the agent reloads for another reason", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    const next = r.rt().nextRunAt;
    const timers = r.fc.pending();
    r.mgr.sync("reviewer", r.resolved([ghTrigger()], { description: "Edited description." }));
    expect(r.rt().nextRunAt).toBe(next);
    expect(r.fc.pending()).toBe(timers);
    expect(r.gh.pollsOf()).toHaveLength(1);
  });

  it("restarts an edited trigger, keeps what it had seen and its last run, and does not re-fire", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2));
    await r.settle(60_000);
    expect(r.runs).toHaveLength(1);
    const lastRun = r.rt().lastRun;

    r.mgr.sync("reviewer", r.resolved([ghTrigger({ prompt: "Look at {{pr.title}} carefully", intervalSec: 120 })]));
    expect(r.rt().lastRun).toEqual(lastRun);
    await r.settle(); // the restarted trigger polls at once
    expect(r.runs).toHaveLength(1);
    expect(r.rt().nextRunAt).toBe(new Date(r.fc.now() + 120_000).toISOString());
    r.gh.addPull("acme/app", pr(3, { title: "Third" }));
    await r.settle(120_000);
    expect(r.runs[1]!.prompt.split("\n\n")[0]).toBe("Look at Third carefully"); // the new definition
  });

  it("starts added triggers, stops removed ones, and keeps disabled ones listed as disabled", async () => {
    const r = await rig({ start: "2026-10-04T03:29:00Z" });
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([cronTrigger()]));
    expect(r.mgr.runtimes("reviewer")!.map((t) => t.id)).toEqual(["daily"]);
    r.mgr.sync("reviewer", r.resolved([cronTrigger(), ghTrigger(), cronTrigger({ id: "off", enabled: false })]));
    expect(r.mgr.runtimes("reviewer")!.map((t) => [t.id, t.state])).toEqual([["daily", "idle"], ["prs", "idle"], ["off", "disabled"]]);
    expect(r.mgr.runtimes("reviewer")![2]!.nextRunAt).toBeUndefined();

    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    expect(r.mgr.runtimes("reviewer")!.map((t) => t.id)).toEqual(["prs"]);
    r.fc.advance(2 * 3_600_000); // the removed cron trigger's time passes
    await sleep(30);
    expect(r.runs).toEqual([]);
  });

  it("stops everything when the agent is dropped: no timers, no polls, no runtimes, and the run in flight ends", async () => {
    let started!: () => void;
    const running = new Promise<void>((res) => (started = res));
    const r = await rig({ runAgent: async ({ signal }) => (started(), await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))) });
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger(), cronTrigger({ timezone: "UTC" })]));
    r.fc.advance(0); // the github poll runs once
    await until(() => r.gh.pollsOf().length === 1 && r.mgr.runtimes("reviewer")!.every((t) => t.nextRunAt !== undefined));
    const inFlight = r.mgr.runNow("reviewer", "daily")!;
    await running;
    const polls = r.gh.pollsOf().length;
    r.events.length = 0;
    r.mgr.drop("reviewer");
    expect(r.mgr.runtimes("reviewer")).toBeUndefined();
    expect(await inFlight).toMatchObject({ ok: false, run: { error: expect.stringContaining("interrupted") } });
    expect(r.events).toEqual([]); // the interrupted run is recorded, but the studio is not told about a trigger that no longer exists
    expect(r.fc.pending()).toBe(0);
    r.fc.advance(24 * 3_600_000);
    await sleep(40);
    expect(r.gh.pollsOf()).toHaveLength(polls);
    // the history of what already ran is still there for the studio
    expect(r.mgr.runs("reviewer")).toHaveLength(1);
  });

  it("tells the studio about every state change and finished run with an agent.trigger payload, and about a restart", async () => {
    const r = await rig();
    r.gh.setPulls("acme/app", [pr(1)]);
    r.mgr.sync("reviewer", r.resolved([ghTrigger()]));
    await r.settle();
    r.gh.addPull("acme/app", pr(2));
    r.events.length = 0;
    await r.settle(60_000);
    const states = r.events.map((e) => e.trigger.state);
    expect(states).toContain("running");
    expect(r.events.at(-1)!.trigger).toMatchObject({ id: "prs", state: "idle", lastRun: { status: "ok", subject: "acme/app#2 opened" } });
    expect(r.events.every((e) => e.id === "reviewer" && e.trigger.id === "prs")).toBe(true);
    // a restart announces the fresh state, and a dropped agent is silent afterwards
    r.events.length = 0;
    r.mgr.sync("reviewer", r.resolved([ghTrigger({ intervalSec: 300 })]));
    expect(r.events.length).toBeGreaterThan(0);
    r.mgr.drop("reviewer");
    r.events.length = 0;
    r.fc.advance(3_600_000);
    await sleep(30);
    expect(r.events).toEqual([]);
  });
});

describe("chunkText", () => {
  it("cuts at a line break when there is one in the back half, and never makes an empty or oversized part", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(100)}`;
    const parts = chunkText(text, 4000);
    expect(parts).toEqual(["a".repeat(3000), `${"b".repeat(3000)}\n${"c".repeat(100)}`]);
    expect(parts.join("\n")).toBe(text);
  });

  it("splits a single huge line, and does not cut an emoji in half", () => {
    const parts = chunkText("x".repeat(9000), 4000);
    expect(parts.map((p) => p.length)).toEqual([4000, 4000, 1000]);
    const emoji = chunkText(`${"x".repeat(3999)}\u{1F600}${"y".repeat(10)}`, 4000);
    expect(emoji[0]).toBe("x".repeat(3999));
    expect(emoji[1]!.startsWith("\u{1F600}")).toBe(true);
  });

  it("returns short text as it is and drops nothing", () => {
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("")).toEqual([]);
  });
});
