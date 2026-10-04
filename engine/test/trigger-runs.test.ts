import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TriggerRun } from "../src/mastra/lib/schema.ts";
import { cleanRun, loadSeen, MAX_REPLY_CHARS, MAX_RUNS, runHistory, runsFile, saveSeen, scrubText, seenFile } from "../src/mastra/lib/trigger-runs.ts";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { tmpHome } from "./helpers/home.ts";

const run = (n: number, o: Partial<TriggerRun> = {}): TriggerRun => ({ id: `run-${n}`, agentId: "reviewer", triggerId: "prs", type: "github-pr", startedAt: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}Z`, status: "ok", subject: `acme/app#${n} opened`, ...o });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("run history", () => {
  it("appends one JSON line per run and lists newest first", () => {
    const p = tmpHome();
    const file = runsFile(agentPaths(p, "reviewer"));
    const h = runHistory(file);
    for (const n of [1, 2, 3]) h.append(run(n));
    expect(lines(file)).toHaveLength(3);
    expect(h.list().map((r) => r.id)).toEqual(["run-3", "run-2", "run-1"]);
    expect(h.list(2).map((r) => r.id)).toEqual(["run-3", "run-2"]);
    expect(h.last("prs")?.id).toBe("run-3");
    expect(h.last("other")).toBeUndefined();
  });

  it("survives a restart: a new reader sees what was written", () => {
    const p = tmpHome();
    const file = runsFile(agentPaths(p, "reviewer"));
    runHistory(file).append(run(1));
    expect(runHistory(file).list().map((r) => r.id)).toEqual(["run-1"]);
  });

  it(`keeps only the newest ${MAX_RUNS}: the file is rewritten on overflow`, () => {
    const p = tmpHome();
    const file = runsFile(agentPaths(p, "reviewer"));
    const h = runHistory(file);
    for (let n = 1; n <= MAX_RUNS + 25; n++) h.append(run(n));
    const stored = lines(file).map((l) => JSON.parse(l) as TriggerRun);
    expect(stored).toHaveLength(MAX_RUNS);
    expect(stored[0]!.id).toBe("run-26");
    expect(stored.at(-1)!.id).toBe(`run-${MAX_RUNS + 25}`);
    expect(h.list(1000)).toHaveLength(MAX_RUNS);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("skips a damaged line instead of losing the history", () => {
    const p = tmpHome();
    const file = runsFile(agentPaths(p, "reviewer"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(run(1))}\n{"half":\n${JSON.stringify(run(2))}\n`);
    expect(runHistory(file).list().map((r) => r.id)).toEqual(["run-2", "run-1"]);
  });

  it("only builds paths from valid ids", () => {
    const p = tmpHome();
    expect(() => runsFile(agentPaths(p, "../etc"))).toThrow();
    expect(() => seenFile(agentPaths(p, "reviewer"), "../x")).toThrow();
    expect(seenFile(agentPaths(p, "reviewer"), "prs")).toBe(join(p.agentsDir, "reviewer", "data", "triggers", "prs.seen.json"));
  });
});

describe("cleanRun and scrubText", () => {
  it("redacts secret-shaped text and the exact secrets it is given, in the reply and the error", () => {
    const token = "plain-looking-secret-value";
    const r = cleanRun(run(1, { reply: `Used ${token} and Bearer abcdefghijklmnopqrstuvwxyz and ghp_${"a".repeat(30)}`, error: `failed with ${token}` }), [token]);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(r)).not.toContain("ghp_aaaa");
    expect(r.reply).toContain("[redacted]");
  });

  it(`cuts a reply to ${MAX_REPLY_CHARS} characters and leaves the rest of the run alone`, () => {
    const r = cleanRun(run(1, { reply: "x".repeat(10_000), delivered: true }));
    expect(r.reply!.length).toBe(MAX_REPLY_CHARS);
    expect(r).toMatchObject({ id: "run-1", status: "ok", delivered: true });
    expect("error" in cleanRun(run(2))).toBe(false);
  });

  it("does not mangle ordinary words for a short secret value", () => {
    expect(scrubText("a b abc", ["a", "abc"])).toBe("a b abc");
  });
});

describe("seen list", () => {
  it("round-trips per repo, and a different repo (or a missing or damaged file) means nothing is known", () => {
    const p = tmpHome();
    const file = seenFile(agentPaths(p, "reviewer"), "prs");
    expect(loadSeen(file, "acme/app")).toBeUndefined();
    saveSeen(file, { repo: "acme/app", prs: { 1: "sha1", 2: "sha2" } });
    expect(loadSeen(file, "acme/app")).toEqual({ repo: "acme/app", prs: { 1: "sha1", 2: "sha2" } });
    expect(loadSeen(file, "acme/other")).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(loadSeen(file, "acme/app")).toBeUndefined();
  });

  it("keeps the newest 1000 pull requests so the file cannot grow forever", () => {
    const p = tmpHome();
    const file = seenFile(agentPaths(p, "reviewer"), "prs");
    saveSeen(file, { repo: "acme/app", prs: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [i + 1, `sha${i}`])) });
    const seen = loadSeen(file, "acme/app")!;
    expect(Object.keys(seen.prs)).toHaveLength(1000);
    expect(seen.prs[1200]).toBe("sha1199");
    expect(seen.prs[200]).toBeUndefined();
    expect(seen.prs[201]).toBe("sha200");
  });
});
