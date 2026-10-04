/**
 * Triggers: things that wake an agent without a message from the user.
 *
 *   cron       a five-field expression in a time zone, run by an in-process scheduler (croner computes the times, one timer waits for the next).
 *              Mastra's own Schedules were considered and not used: they persist a row per schedule and wake a thread through a signal, which gives
 *              no hook for what a trigger needs (its own prompt wrapper, an overlap guard, a run history with the reply, Telegram delivery, no
 *              catch-up). A time that passes while the engine is down is skipped by construction: the next time is always computed from "now".
 *   github-pr  polls the REST API for open pull requests; the seen-list is on disk, so a restart or hot reload never re-fires.
 *
 * The registry (lib/agents.ts) calls sync() every time an agent version is added and drop() when it goes away. sync() keeps a trigger whose
 * definition did not change running (a rate-limit backoff, an in-flight run and its schedule survive an unrelated edit) and restarts the rest.
 *
 * A run has no human: a tool that needs approval is declined (see generateUnattended). Event text is untrusted (lib/trigger-prompt.ts).
 */
import { randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import { Cron } from "croner";
import { isEqual, truncate } from "lodash-es";
import { TRIGGER_THREAD_PREFIX } from "./memory.ts";
import { valueFingerprint } from "./envfile.ts";
import { githubBase, listPulls, type GithubPull } from "./github.ts";
import { agentPaths, type HomePaths } from "./home.ts";
import { scrub } from "./probes.ts";
import type { ResolvedAgent, RunTriggerResponse, Trigger, TriggerRun, TriggerRuntime } from "./schema.ts";
import type { TelegramBot } from "./telegram.ts";
import { buildPrompt, subjectOf, type TriggerEvent } from "./trigger-prompt.ts";
import { cleanRun, loadSeen, runHistory, runsFile, saveSeen, scrubText, seenFile, type RunHistory, type Seen } from "./trigger-runs.ts";
import { dayjs } from "./time.ts";

const RUN_TIMEOUT_MS = 5 * 60_000;
/** A cron time more than this late (the machine slept, the loop was blocked) is a missed time, and missed times are skipped. */
const MISSED_MS = 60_000;
/** Longest single timer. Re-arming hourly keeps far-off cron times off setTimeout's 24-day ceiling. */
const MAX_WAIT_MS = 3_600_000;
const MAX_FIRES_PER_POLL = 5;
const MAX_DECLINES = 20;
const TELEGRAM_CHUNK = 4000;
const MAX_DELIVERED_CHARS = 20_000;

export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };

export type UnattendedRun = { agent: Agent; prompt: string; threadId: string; resourceId: string; maxSteps: number; signal: AbortSignal };
export type TriggerAgentRun = (input: UnattendedRun) => Promise<{ text: string; declined: string[] }>;

const UNATTENDED = "Nobody is available to approve tool calls during an unattended trigger run, so this call was not allowed. Do not try it again; finish the task without it and say in your reply what you could not do.";

/**
 * agent.generate, and a decline for every tool call that asks for approval. Reminders (Mastra schedules) wake a Telegram thread, so an
 * approval there is an Approve/Deny card the user can tap; a trigger run calls the agent directly, nobody is watching, and a suspended run
 * would simply hang. Declining lets the model carry on and explain, and the names of what was declined go on the reply.
 */
export const generateUnattended: TriggerAgentRun = async ({ agent, prompt, threadId, resourceId, maxSteps, signal }) => {
  const options = { memory: { thread: threadId, resource: resourceId }, maxSteps, abortSignal: signal };
  let out = await agent.generate(prompt, options);
  const declined: string[] = [];
  while (out.finishReason === "suspended" && declined.length < MAX_DECLINES) {
    declined.push(String(out.suspendPayload?.toolName ?? "a tool"));
    out = await agent.declineToolCallGenerate({ ...options, runId: out.runId!, toolCallId: out.suspendPayload?.toolCallId, reason: UNATTENDED });
  }
  signal.throwIfAborted(); // generate does not throw when it is aborted: it resolves with whatever it had (usually nothing)
  if (out.error) throw out.error;
  if (out.finishReason === "suspended") throw new Error(`the agent kept asking for approval (${declined.length} tool calls declined)`);
  return { text: out.text, declined };
};

/** Telegram refuses a message over 4096 characters. Cut at a line break when there is one in the back half. */
export function chunkText(text: string, size = TELEGRAM_CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const nl = rest.lastIndexOf("\n", size);
    const atBreak = nl > size / 2;
    const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
    const at = atBreak ? nl : high(rest.charCodeAt(size - 1)) ? size - 1 : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(atBreak ? at + 1 : at);
  }
  return [...out, rest].filter((c) => c.trim());
}

/**
 * The person an agent works for, as its memory knows them: the resource Mastra's Telegram channel gives its first allowed user, so working memory
 * is the same person in Telegram, the studio chat and trigger runs. Each agent has its own storage, so this never reaches another agent's memory.
 */
export const userResource = (r: Pick<ResolvedAgent, "telegram">) => {
  const user = r.telegram.allowedUserIds[0];
  return user === undefined ? "studio" : `telegram:${user}`;
};

export type TriggerDeps = {
  paths: Pick<HomePaths, "agentsDir">;
  /** The agent's .env as its running version read it. The GitHub token, and the values scrubbed out of what a run says, come from here only. */
  envOf: (agentId: string) => ReadonlyMap<string, string>;
  /** GitHub's API base (GITHUB_API_BASE_URL, for tests and GitHub Enterprise). Not a secret, so it may come from the engine's environment. */
  githubApi?: string;
  clock?: Clock;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  /** Called whenever a trigger's runtime changes (state, next time, last run). */
  emit?: (agentId: string, trigger: TriggerRuntime) => void;
  agentOf: (agentId: string) => Agent | undefined;
  botOf: (agentId: string) => Pick<TelegramBot, "adapter" | "state"> | undefined;
  runAgent?: TriggerAgentRun;
  /** How long one run may take. Tests shorten it. */
  runTimeoutMs?: number;
};

type Entry = { resolved: ResolvedAgent; handles: Map<string, Handle> };
type Handle = { def: Trigger; runtime(): TriggerRuntime; stop(): void; refresh(): void; runNow(): Promise<RunTriggerResponse> };

export function createTriggerManager(deps: TriggerDeps) {
  const { paths, envOf, githubApi = githubBase(), clock = realClock, fetchFn = fetch, log = () => undefined, emit = () => undefined, runAgent = generateUnattended, runTimeoutMs = RUN_TIMEOUT_MS } = deps;
  const entries = new Map<string, Entry>();
  const histories = new Map<string, RunHistory>();
  const inflight = new Map<string, Map<string, TriggerRun>>();
  const pending = new Set<Promise<unknown>>();

  const historyOf = (agentId: string) => histories.get(agentId) ?? histories.set(agentId, runHistory(runsFile(agentPaths(paths, agentId)))).get(agentId)!;
  /** Keeps a background job where close() can wait for it. */
  const track = (job: Promise<unknown>) => {
    const done = job.catch(() => undefined).finally(() => pending.delete(done));
    pending.add(done);
  };

  function start(entry: Entry, agentId: string, def: Trigger): Handle {
    const history = historyOf(agentId);
    const running = inflight.get(agentId) ?? inflight.set(agentId, new Map()).get(agentId)!;
    const abort = new AbortController();
    let stopped = false;
    let busy = false;
    let timer: unknown;
    let rt: TriggerRuntime = { id: def.id, type: def.type, state: def.enabled ? "idle" : "disabled", lastRun: history.last(def.id) };

    // GitHub poller state that lives only as long as this trigger does.
    let etag: { fp: string; value: string } | undefined;
    let seen: Seen | undefined;
    let polledFp: string | undefined;
    let backoffUntil = 0;

    const env = () => envOf(agentId);
    /** Every value in the agent's .env: a run may quote any of them (a tool dumping its environment), and none may leave in a reply, log or event. */
    const secrets = () => [...env().values()].filter((s) => !!s);
    const zone = () => (def.type === "cron" && def.timezone) || entry.resolved.timezone;
    const warn = (msg: string) => log(`trigger ${agentId}/${def.id}: ${scrubText(msg, secrets())}`);
    const iso = (ms: number) => new Date(ms).toISOString();

    function setRt(patch: Partial<TriggerRuntime>) {
      const next = { ...rt, ...patch };
      for (const k of Object.keys(next) as Array<keyof TriggerRuntime>) if (next[k] === undefined) delete next[k];
      const changed = JSON.stringify(next) !== JSON.stringify(rt);
      rt = next;
      if (changed && !stopped) emit(agentId, rt);
    }

    /** One timer for `at`; far-off times wait in hour-long steps. */
    function arm(at: number, fire: () => void) {
      clock.clearTimeout(timer);
      if (stopped) return;
      const wait = at - clock.now();
      timer = clock.setTimeout(wait > MAX_WAIT_MS ? () => arm(at, fire) : fire, Math.min(Math.max(wait, 0), MAX_WAIT_MS));
    }

    /** At most one run of this trigger at a time (a scheduled fire, a poll, and "run now" all go through here). */
    async function exclusive<T>(job: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      try {
        return await job();
      } finally {
        busy = false;
      }
    }

    function deliveryTarget(): { ids: number[]; adapter: TelegramBot["adapter"] } | string {
      const bot = deps.botOf(agentId);
      if (!bot) return "the agent has no Telegram bot";
      // A bot that is "starting" (just rebuilt by a reload, first poll not confirmed yet) can already send; only a bot that failed or is off cannot.
      const state = bot.state().state;
      if (state !== "polling" && state !== "starting") return `the agent's Telegram bot is not running (${state})`;
      const ids = entry.resolved.telegram.allowedUserIds;
      return ids.length ? { ids, adapter: bot.adapter } : "the agent has no allowed Telegram user ids";
    }

    /** Undefined when every allowed user got every part, otherwise why not. Text is plain: nothing in a reply is ever parsed as Telegram markup. */
    async function deliver(text: string, subject: string): Promise<string | undefined> {
      const target = deliveryTarget();
      if (typeof target === "string") return warn(`reply not delivered: ${target}`), target;
      const parts = chunkText(`Trigger ${def.id} - ${subject}\n\n${truncate(text, { length: MAX_DELIVERED_CHARS, omission: "\n[reply cut]" })}`);
      let failed: string | undefined;
      for (const id of target.ids) {
        try {
          const thread = await target.adapter.openDM(String(id));
          for (const part of parts) await target.adapter.postMessage(thread, part);
        } catch (e) {
          const why = scrub(e, secrets());
          failed ??= `Telegram would not take the message for user ${id}: ${why}`;
          warn(`reply not delivered to ${id}: ${why}`);
        }
      }
      return failed;
    }

    async function generate(event: TriggerEvent) {
      const agent = deps.agentOf(agentId);
      if (!agent) throw new Error("the agent is not available (it is still starting, or it was removed)");
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(runTimeoutMs)]);
      // generate may ignore the signal while a model call hangs; the run must still end.
      const gone = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error(abort.signal.aborted ? "interrupted: the agent was reloaded or stopped" : `timed out after ${runTimeoutMs >= 60_000 ? `${runTimeoutMs / 60_000} minutes` : `${runTimeoutMs / 1000} seconds`}`)), { once: true }));
      const job = runAgent({ agent, prompt: buildPrompt(def.prompt, event), threadId: `${TRIGGER_THREAD_PREFIX}${agentId}-${def.id}`, resourceId: userResource(entry.resolved), maxSteps: entry.resolved.maxSteps, signal });
      void job.catch(() => undefined); // the loser of the race must not become an unhandled rejection
      const out = await Promise.race([job, gone]);
      const note = out.declined.length ? `\n\n(Not done: ${out.declined.length} tool call${out.declined.length > 1 ? "s" : ""} (${[...new Set(out.declined)].join(", ")}) needed approval, and nobody can give it during a trigger run.)` : "";
      return `${out.text.trim() || "(the agent finished without a reply)"}${note}`;
    }

    /** One firing, start to finish: the run, its record, delivery. Never throws. */
    async function execute(event: TriggerEvent): Promise<TriggerRun> {
      let run: TriggerRun = { id: randomUUID(), agentId, triggerId: def.id, type: def.type, startedAt: iso(clock.now()), status: "running", subject: subjectOf(event) };
      running.set(run.id, run);
      setRt({ state: "running", lastRun: run });
      let full = "";
      try {
        full = scrubText(await generate(event), secrets());
        run = { ...run, status: "ok", reply: full };
      } catch (e) {
        run = { ...run, status: "error", error: String((e as Error)?.message ?? e) };
      }
      run = { ...run, finishedAt: iso(clock.now()) };
      // Nobody is told about a failure, only about a reply; a failed run is on the studio's run list.
      if (run.status === "ok" && def.deliverToTelegram) {
        const why = await deliver(full, run.subject);
        run = { ...run, delivered: why === undefined, ...(why && { deliveryError: why }) };
      }
      run = cleanRun(run, secrets());
      try {
        history.append(run);
      } catch (e) {
        warn(`could not save the run to the history: ${(e as Error).message}`);
      }
      running.delete(run.id);
      setRt({ state: run.status === "ok" ? "idle" : "error", error: run.error, lastRun: run });
      return run;
    }

    /* ---- cron ---- */

    let unschedulableNow = false;
    function unschedulable(error: string) {
      unschedulableNow = true;
      clock.clearTimeout(timer);
      setRt({ state: "error", error, nextRunAt: undefined });
    }

    function scheduleCron(from = clock.now()) {
      if (def.type !== "cron") return;
      const tz = zone();
      let due: Date | null;
      try {
        due = new Cron(def.cron, { timezone: tz, mode: "5-part" }).nextRun(new Date(from));
      } catch (e) {
        return unschedulable(`cannot schedule "${def.cron}" in ${tz}: ${(e as Error).message}`);
      }
      if (!due) return unschedulable(`"${def.cron}" never fires`);
      // A zone or expression that works again (the agent's timezone fixed) clears the error that said it did not.
      if (unschedulableNow) setRt({ state: "idle", error: undefined });
      unschedulableNow = false;
      setRt({ nextRunAt: due.toISOString() });
      arm(due.getTime(), () => track(fireCron(due.getTime(), tz).catch((e) => warn(`run failed: ${(e as Error).message}`))));
    }

    async function fireCron(dueMs: number, zone: string) {
      if (stopped || def.type !== "cron") return;
      // The next time is armed BEFORE the run: one that comes due while this run is still going is an overlap (skipped and logged), and a time the
      // engine was not running for is never looked at again.
      scheduleCron(Math.max(clock.now(), dueMs));
      const late = clock.now() - dueMs;
      if (late > MISSED_MS) return warn(`missed the ${iso(dueMs)} run (${Math.round(late / 1000)} s late); skipped, not replayed`);
      if (!(await exclusive(() => execute({ type: "cron", schedule: def.cron, at: dueMs, zone, manual: false })))) warn(`the ${iso(dueMs)} run was skipped: the previous run is still going`);
    }

    /* ---- github-pr ---- */

    const intervalMs = () => (def.type === "github-pr" ? def.intervalSec * 1000 : 0);

    function schedulePoll(delayMs: number) {
      const at = clock.now() + delayMs;
      setRt({ nextRunAt: iso(at) });
      arm(at, () => track(tick().catch((e) => warn(`poll failed: ${(e as Error).message}`))));
    }

    async function tick() {
      if (stopped) return;
      setRt({ nextRunAt: undefined });
      let next = intervalMs();
      const ran = await exclusive(async () => {
        try {
          next = await pollOnce();
        } catch (e) {
          setRt({ state: "error", error: `poll failed: ${scrubText(String((e as Error)?.message ?? e), secrets())}` });
        }
        return true;
      });
      if (!ran) warn("poll skipped: the previous run is still going");
      if (!stopped) schedulePoll(next);
    }

    /** One poll; resolves to how long to wait before the next one. */
    async function pollOnce(): Promise<number> {
      if (def.type !== "github-pr") return 0;
      const token = env().get(def.tokenEnv);
      polledFp = valueFingerprint(token);
      if (!token) return setRt({ state: "missing-token", error: `${def.tokenEnv} is not set in this agent's keys` }), intervalMs();
      const res = await listPulls({ base: githubApi, repo: def.repo, token, etag: etag?.fp === polledFp ? etag.value : undefined, fetchFn, signal: abort.signal, now: () => clock.now() });
      if (stopped) return 0;
      if (res.kind === "error") return setRt({ state: "error", error: res.message }), intervalMs();
      if (res.kind === "rate-limited") {
        backoffUntil = res.resetAt;
        setRt({ state: "error", error: `GitHub's rate limit is used up; polling resumes at ${dayjs(res.resetAt).tz(entry.resolved.timezone).format("HH:mm")}` });
        return Math.max(res.resetAt - clock.now(), intervalMs());
      }
      backoffUntil = 0;
      if (res.kind === "not-modified") return setRt({ state: "idle", error: undefined }), intervalMs();

      if (res.dropped) warn(`${res.dropped} pull request(s) in the answer were not understood and were ignored`);
      etag = res.etag ? { fp: polledFp, value: res.etag } : undefined;
      const file = seenFile(agentPaths(paths, agentId), def.id);
      const before = (seen ??= loadSeen(file, def.repo));
      // Drafts are neither fired nor remembered: a draft that is later marked ready is a pull request opening for review, so it fires then.
      const open = res.pulls.filter((p) => def.includeDrafts || !p.draft);
      const fires = before
        ? open.flatMap((p): Array<{ pull: GithubPull; kind: "opened" | "updated" }> => {
            const known = before.prs[p.number];
            if (known === undefined) return def.events.includes("opened") ? [{ pull: p, kind: "opened" }] : [];
            return known !== p.sha && def.events.includes("updated") ? [{ pull: p, kind: "updated" }] : [];
          })
        : []; // the very first poll only records what is already open
      // Remembered before anything runs: a crash or a failing run must never turn into the same pull request firing again and again.
      seen = { repo: def.repo, prs: { ...before?.prs, ...Object.fromEntries(open.map((p) => [p.number, p.sha])) } };
      saveSeen(file, seen);

      const chosen = fires.slice(0, MAX_FIRES_PER_POLL);
      if (fires.length > chosen.length) warn(`${fires.length} pull requests are new or updated; running the newest ${chosen.length} and skipping ${fires.length - chosen.length}`);
      if (!chosen.length) setRt({ state: "idle", error: undefined });
      for (const f of chosen) {
        if (stopped) break;
        await execute({ type: "github-pr", repo: def.repo, kind: f.kind, pull: f.pull });
      }
      return intervalMs();
    }

    /** The newest open pull request, for "run now". Does not touch the seen-list or the ETag. */
    async function latestPull(): Promise<{ pull: GithubPull } | { error: string }> {
      if (def.type !== "github-pr") return { error: "not a github-pr trigger" };
      const token = env().get(def.tokenEnv);
      if (!token) return { error: `${def.tokenEnv} is not set in this agent's keys` };
      const res = await listPulls({ base: githubApi, repo: def.repo, token, fetchFn, signal: abort.signal, now: () => clock.now() });
      if (res.kind === "error") return { error: res.message };
      if (res.kind === "rate-limited") return { error: "GitHub's rate limit is used up for this token; try again later" };
      if (res.kind === "not-modified" || !res.pulls[0]) return { error: "no open pull requests" };
      return { pull: res.pulls[0] };
    }

    /* ---- lifecycle ---- */

    if (def.enabled) {
      if (def.type === "cron") scheduleCron();
      else schedulePoll(0);
    }
    emit(agentId, rt); // the studio learns the fresh state of a trigger that was just (re)started

    return {
      def,
      runtime: () => rt,
      stop() {
        stopped = true;
        clock.clearTimeout(timer);
        abort.abort();
      },
      /** The agent was reloaded without this trigger changing: re-read its time zone, and look at GitHub again if the token changed. */
      refresh() {
        if (!def.enabled || busy || stopped) return;
        if (def.type === "cron") scheduleCron();
        else if (valueFingerprint(env().get(def.tokenEnv)) !== polledFp && clock.now() >= backoffUntil) schedulePoll(0);
      },
      async runNow() {
        const result = await exclusive(async () => {
          let event: TriggerEvent;
          if (def.type === "cron") event = { type: "cron", schedule: def.cron, at: clock.now(), zone: zone(), manual: true };
          else {
            const found = await latestPull();
            if ("error" in found) return { ok: false, error: found.error } satisfies RunTriggerResponse;
            event = { type: "github-pr", repo: def.repo, kind: "manual", pull: found.pull };
          }
          const run = await execute(event);
          return { ok: run.status === "ok", run, ...(run.error && { error: run.error }) } satisfies RunTriggerResponse;
        });
        return result ?? { ok: false, error: "this trigger is already running" };
      },
    };
  }

  return {
    /** An agent version was added (or the same agent reloaded): start new triggers, restart changed ones, stop removed ones, leave the rest running. */
    sync(agentId: string, resolved: ResolvedAgent) {
      const entry = entries.get(agentId) ?? entries.set(agentId, { resolved, handles: new Map() }).get(agentId)!;
      entry.resolved = resolved;
      const wanted = new Map(resolved.triggers.map((t) => [t.id, t]));
      for (const [id, h] of entry.handles)
        if (!isEqual(h.def, wanted.get(id))) {
          h.stop();
          entry.handles.delete(id);
        }
      for (const [id, def] of wanted) {
        const kept = entry.handles.get(id);
        if (kept) kept.refresh();
        else entry.handles.set(id, start(entry, agentId, def));
      }
    },

    /** The agent is gone (removed, disabled, trashed): stop everything it had. Its history stays on disk. */
    drop(agentId: string) {
      entries.get(agentId)?.handles.forEach((h) => h.stop());
      entries.delete(agentId);
      inflight.delete(agentId);
    },

    /** One entry per configured trigger, in config order; undefined when the agent is not running. */
    runtimes(agentId: string): TriggerRuntime[] | undefined {
      const entry = entries.get(agentId);
      return entry && entry.resolved.triggers.map((t) => entry.handles.get(t.id)!.runtime());
    },

    /** Newest first: runs in progress, then the finished ones on disk. */
    runs(agentId: string, limit = 50): TriggerRun[] {
      return [...[...(inflight.get(agentId)?.values() ?? [])].reverse(), ...historyOf(agentId).list()].slice(0, limit);
    },

    /** Undefined for an agent or trigger that is not running. */
    runNow(agentId: string, triggerId: string): Promise<RunTriggerResponse> | undefined {
      return entries.get(agentId)?.handles.get(triggerId)?.runNow();
    },

    /** Stops every trigger and waits for the runs in flight to wind down. */
    async close() {
      for (const id of [...entries.keys()]) this.drop(id);
      await Promise.allSettled([...pending]);
    },
  };
}

export type TriggerManager = ReturnType<typeof createTriggerManager>;
