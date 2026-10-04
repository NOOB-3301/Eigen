/**
 * What triggers keep on disk, in the agent's own folder, under ~/.eigen/agents/<id>/data/triggers/:
 *   runs.jsonl            append-only run history (newest 200)
 *   <trigger>.seen.json   the pull requests a github-pr trigger has already seen, per repo
 * Both are written only with ids the config schema has validated, so a path can never leave that folder.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { truncate } from "lodash-es";
import type { AgentPaths } from "./home.ts";
import { AgentId, TriggerId, type TriggerRun } from "./schema.ts";
import { redact } from "./secrets.ts";

export const MAX_RUNS = 200;
export const MAX_REPLY_CHARS = 4000;
const MAX_ERROR_CHARS = 500;
const MAX_SEEN = 1000;
/** A value this short is not a credential, and removing it would shred ordinary words. */
const MIN_SECRET_CHARS = 6;

/** Removes secret-shaped text and the exact values in `secrets` (the token a trigger used, the keys the agent holds). */
export function scrubText(text: string, secrets: Array<string | undefined> = []) {
  let out = redact(text);
  for (const s of secrets) if (s && s.length >= MIN_SECRET_CHARS) out = out.split(s).join("[redacted]");
  return out;
}

/** What may be stored, emitted or returned about a run: redacted, and cut to size. */
export function cleanRun(run: TriggerRun, secrets: Array<string | undefined> = []): TriggerRun {
  const clean = (text: string | undefined, length: number) => (text === undefined ? undefined : truncate(scrubText(text, secrets), { length, omission: "…" }));
  const { reply, error, deliveryError, ...rest } = run;
  return {
    ...rest,
    ...(reply !== undefined && { reply: clean(reply, MAX_REPLY_CHARS) }),
    ...(error !== undefined && { error: clean(error, MAX_ERROR_CHARS) }),
    ...(deliveryError !== undefined && { deliveryError: clean(deliveryError, MAX_ERROR_CHARS) }),
  };
}

/** The agent's triggers folder. Its id is checked again here: agentPaths trusts it, and this is where files get written. */
const dirOf = (a: Pick<AgentPaths, "id" | "triggersDir">) => (AgentId.parse(a.id), a.triggersDir);
export const runsFile = (a: Pick<AgentPaths, "id" | "triggersDir">) => join(dirOf(a), "runs.jsonl");
export const seenFile = (a: Pick<AgentPaths, "id" | "triggersDir">, triggerId: string) => join(dirOf(a), `${TriggerId.parse(triggerId)}.seen.json`);

const readRuns = (file: string): TriggerRun[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as TriggerRun] : [];
      } catch {
        return []; // a half-written last line (power loss) must not take the history with it
      }
    });
};

/** Append-only; past `cap` entries the file is rewritten with the newest ones. */
export function runHistory(file: string, cap = MAX_RUNS) {
  let runs: TriggerRun[] | undefined; // oldest first
  const all = () => (runs ??= readRuns(file));
  return {
    append(run: TriggerRun) {
      const list = all();
      list.push(run);
      mkdirSync(dirname(file), { recursive: true });
      if (list.length <= cap) return appendFileSync(file, `${JSON.stringify(run)}\n`);
      list.splice(0, list.length - cap);
      writeFileSync(`${file}.tmp`, list.map((r) => `${JSON.stringify(r)}\n`).join(""));
      renameSync(`${file}.tmp`, file);
    },
    /** Newest first. */
    list: (limit = cap) => all().slice(-limit).reverse(),
    last: (triggerId: string) => all().findLast((r) => r.triggerId === triggerId),
  };
}
export type RunHistory = ReturnType<typeof runHistory>;

/** Pull request number -> head sha, for one repo. */
export type Seen = { repo: string; prs: Record<string, string> };

/** Undefined when there is nothing usable for this repo (never polled, unreadable, or the trigger now points elsewhere): the next poll then only records. */
export function loadSeen(file: string, repo: string): Seen | undefined {
  try {
    const seen = JSON.parse(readFileSync(file, "utf8")) as Seen;
    return seen.repo === repo && seen.prs && typeof seen.prs === "object" ? seen : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the newest pull requests (highest numbers) so the file cannot grow without bound. */
export function saveSeen(file: string, seen: Seen) {
  const keep = Object.keys(seen.prs)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, MAX_SEEN);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ repo: seen.repo, prs: Object.fromEntries(keep.map((n) => [n, seen.prs[n]])) }));
  renameSync(`${file}.tmp`, file);
}
