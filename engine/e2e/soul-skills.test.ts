import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomePaths } from "../src/mastra/lib/home.ts";
import type { GetAgentRuntimeResponse } from "../src/mastra/lib/schema.ts";
import type { RecordedRequest, Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const SHARED = "Shared voice: formal and precise.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const system = (r: RecordedRequest) => r.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
/** The skills a request's system prompt advertises (Mastra's <available_skills> catalog). */
const skillNames = (r: RecordedRequest) => [...(/<available_skills>([\s\S]*?)<\/available_skills>/.exec(system(r))?.[1] ?? "").matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]).sort();
/** Requests made by the specialist `id` (its role prompt is "You are the <id>."), in order. */
const by = (id: string) => (eigen!.llm.requests as RecordedRequest[]).filter((r) => system(r).includes(`You are the ${id}.`));
const isSpecialist = (r: RecordedRequest) => /You are the (poet|alpha|beta|gamma)\./.test(system(r));
/** The primary is waiting for the user: its last message is theirs and contains `text`. */
const userSays = (text: string) => (r: RecordedRequest) => !isSpecialist(r) && r.messages.at(-1)?.role === "user" && JSON.stringify(r.messages.at(-1)!.content).includes(text);
const delegate = (text: string, ...ids: string[]): Turn => ({ when: userSays(text), calls: ids.map((id) => ({ name: `agent-${id}`, args: { prompt: `do the ${text} thing` } })) });
const specialistReply: Turn = { when: isSpecialist, text: "specialist done" };
const replied = (text: string) => () => eigen!.tg.sent().some((t) => t.includes(text));

function addAgent(p: HomePaths, id: string, patch: Record<string, unknown> = {}, soul?: string) {
  const dir = join(p.agentsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.md"), `You are the ${id}.`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ id, name: id, role: "specialist", description: `Does ${id} work.`, ...patch }));
  if (soul !== undefined) writeFileSync(join(dir, "soul.md"), soul);
  return dir;
}

function librarySkill(p: HomePaths, slug: string) {
  const file = join(p.userSkillsDir, slug, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${slug}\ndescription: the ${slug} skill\n---\n\nSteps.\n`);
}

const detail = async (id: string) => (await (await fetch(`${eigen!.url}/eigen/agents/${id}`)).json()) as GetAgentRuntimeResponse;
const patchConfig = (file: string, patch: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));

async function until(check: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for condition");
}

describe("per-agent soul (built server)", () => {
  it("an own soul replaces the shared one, follows edits on the next message with no reload, and none drops the block", async () => {
    eigen = await startEigen([delegate("go1", "poet"), delegate("go2", "poet"), delegate("go3", "poet"), specialistReply, { text: "primary done" }], {}, {
      port: 4121,
      prepare: (p) => {
        writeFileSync(p.soulFile, SHARED);
        addAgent(p, "poet", { soul: { source: "own" } }, "Own voice: playful, full of puns.");
      },
    });
    const dir = join(eigen.p.agentsDir, "poet");
    const before = (await detail("poet")).runtime;

    eigen.tg.say("go1");
    await waitFor(() => by("poet").length >= 1);
    expect(system(by("poet")[0]!)).toContain("<soul>\nOwn voice: playful, full of puns.\n</soul>");
    expect(system(by("poet")[0]!)).not.toContain(SHARED);
    expect(system(eigen.llm.requests.find((r) => !isSpecialist(r))!)).toContain(SHARED); // the primary is still on the shared soul
    await waitFor(replied("primary done"));

    writeFileSync(join(dir, "soul.md"), "Own voice: terse and grave.");
    eigen.tg.say("go2");
    await waitFor(() => by("poet").length >= 2);
    expect(system(by("poet")[1]!)).toContain("Own voice: terse and grave.");
    expect(system(by("poet")[1]!)).not.toContain("playful");
    const after = (await detail("poet")).runtime;
    expect(after.loadedHash).toBe(before.loadedHash); // an edit to the soul text rebuilt nothing
    expect(after.loadedAt).toBe(before.loadedAt);

    patchConfig(join(dir, "config.json"), { soul: { source: "none" } });
    await until(async () => (await detail("poet")).resolved?.soul.source === "none");
    eigen.tg.say("go3");
    await waitFor(() => by("poet").length >= 3);
    const dropped = system(by("poet")[2]!);
    expect(dropped).not.toContain("<soul>");
    expect(dropped).not.toContain("terse and grave");
    expect(dropped).not.toContain(SHARED);
  });

  it("an own soul whose file is missing makes the agent invalid, and it loads when the file appears", async () => {
    eigen = await startEigen([{ text: "hi" }], {}, { port: 4122, prepare: (p) => addAgent(p, "poet", { soul: { source: "own" } }) });
    const missing = await detail("poet");
    expect(missing.runtime.status).toBe("invalid");
    expect(missing.runtime.problems).toEqual(["soul file soul.md is missing or unreadable"]);

    writeFileSync(join(eigen.p.agentsDir, "poet", "soul.md"), "Now I have a voice.");
    await until(async () => (await detail("poet")).runtime.status === "loaded");
  });
});

describe("per-agent skills and live memory switches (built server)", () => {
  it("each agent sees only its selected skills, a new library skill reaches agents on all within seconds, and the primary follows its own config live", async () => {
    eigen = await startEigen([delegate("go1", "alpha", "beta", "gamma"), delegate("go2", "gamma"), specialistReply, { text: "primary done" }], {}, {
      port: 4123,
      prepare: (p) => {
        for (const slug of ["pdf", "notes"]) librarySkill(p, slug);
        addAgent(p, "alpha", { skills: { inherit: ["pdf"] } });
        addAgent(p, "beta", { skills: { inherit: "none" } });
        addAgent(p, "gamma");
      },
    });

    eigen.tg.say("go1");
    await waitFor(() => by("alpha").length > 0 && by("beta").length > 0 && by("gamma").length > 0);
    expect(skillNames(by("alpha")[0]!)).toEqual(["pdf"]);
    expect(skillNames(by("beta")[0]!)).toEqual([]);
    expect(skillNames(by("gamma")[0]!)).toEqual(["notes", "pdf"]);
    const firstPrimary = eigen.llm.requests.find((r) => !isSpecialist(r))!;
    expect(skillNames(firstPrimary)).toEqual(["clawhub", "notes", "pdf"]); // clawhub is the primary's own built-in skill (agents/eigen/skills)
    await waitFor(replied("primary done"));

    // A skill written by the studio is on the next turn of every agent that sees the whole library: the watcher refreshes them, the 30 s staleness check never has to run.
    librarySkill(eigen.p, "fresh");
    await sleep(1500);
    eigen.tg.say("go2");
    await waitFor(() => by("gamma").length >= 2);
    expect(skillNames(by("gamma")[1]!)).toEqual(["fresh", "notes", "pdf"]);

    // The primary's workspace is built once by Mastra; its selection is read from its config on every turn.
    patchConfig(join(eigen.p.agentsDir, "eigen", "config.json"), { skills: { inherit: ["notes"] } });
    await until(async () => JSON.stringify((await detail("eigen")).resolved?.skills.inherit) === '["notes"]');
    const seen = eigen.llm.requests.length;
    eigen.tg.say("what skills do you have");
    await waitFor(() => eigen!.llm.requests.length > seen);
    const next = eigen.llm.requests.slice(seen).find((r) => !isSpecialist(r))!;
    expect(skillNames(next)).toEqual(["clawhub", "notes"]);
  });

  it("flipping the primary's memory switches applies to its next message with no restart", async () => {
    eigen = await startEigen([{ text: "noted" }], {}, { port: 4124 });
    const lastRequest = () => JSON.stringify(eigen!.llm.requests.at(-1));
    // The model request for this message is the last one once it arrives; the pause lets Mastra save the reply before the next message loads history.
    const say = async (text: string) => {
      const seen = eigen!.llm.requests.length;
      eigen!.tg.say(text);
      await waitFor(() => eigen!.llm.requests.length > seen);
      await sleep(600);
    };
    const primaryFile = join(eigen.p.agentsDir, "eigen", "config.json");

    await say("my favourite fruit is mango pudding");
    await say("what did I just say");
    expect(lastRequest()).toContain("mango pudding");

    // Semantic recall goes off too: with it on, the earlier "what did I just say" would bring the old messages back by similarity.
    patchConfig(primaryFile, { memory: { scope: "shared", lastMessages: 0, semanticRecall: { enabled: false } } });
    await until(async () => (await detail("eigen")).resolved?.memory.lastMessages === 0);
    await say("what did I just say");
    expect(lastRequest()).not.toContain("mango pudding");

    patchConfig(primaryFile, { memory: { scope: "shared", lastMessages: 20, semanticRecall: { enabled: false } } });
    await until(async () => (await detail("eigen")).resolved?.memory.lastMessages === 20);
    await say("my favourite colour is teal");
    await say("what did I just say");
    expect(lastRequest()).toContain("teal");
  });
});
