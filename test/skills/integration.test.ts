import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.ts";
import type { AgentEvent } from "../../src/core/events.ts";
import { FakeProvider, FakeRegistry, testConfig } from "../helpers/fake-provider.ts";
import { tempHome } from "../helpers/agent.ts";
import type { Config } from "../../src/config/schema.ts";

const GOOD_BODY = [
  "## Preconditions",
  "- DIRECTUS_URL and DIRECTUS_TOKEN are set in the environment",
  "",
  "## Steps",
  "1. GET $DIRECTUS_URL/collections with header Authorization: Bearer $DIRECTUS_TOKEN",
  "2. Read the `data` array; each entry has a `collection` field with the name",
  "3. For a custom collection, fetch items at $DIRECTUS_URL/items/<collection>",
  "",
  "## Notes",
  "- System users live at /users, not /items/users — that returns 403",
].join("\n");
const DRAFT = `---\nname: directus collections\ndescription: List collections from a Directus instance over HTTP\nwhen: asked what is in a Directus database\n---\n\n${GOOD_BODY}`;
const PASS = JSON.stringify({ worthCapturing: 3, taskSucceeded: 0.95, alreadyCovered: 0.05, reusable: 3, specific: 0.9, preconditions: 0.9, redundant: 0.1, verdict: "keep" });

function makeAgent(steps: Array<Record<string, unknown>>, patch: Partial<Config["skills"]> = {}) {
  const base = testConfig();
  const config: Config = { ...base, skills: { ...base.skills, capture: { ...base.skills.capture, enabled: true }, ...patch } };
  const home = tempHome();
  const provider = new FakeProvider(steps as never);
  const agent = new Agent({ config, home, models: new FakeRegistry(config, provider) });
  const events: AgentEvent[] = [];
  agent.on((e) => events.push(e));
  const wait = async (fn: () => boolean, ms = 3000) => {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 5));
    return fn();
  };
  return { agent, provider, events, home, wait };
}

describe("skills end to end", () => {
  it("captures a skill after the reply, and the index reaches the next session's prompt", async () => {
    const { agent, provider, events, wait } = makeAgent([
      { calls: [{ name: "current_time" }] },       // step 1: a tool runs
      { text: "It is 14:02." },                     // step 2: the reply
      { text: PASS },                               // triage
      { text: DRAFT },                              // draft
      { text: PASS },                               // eval
      { text: "next answer" },
    ]);
    agent.submit({ sessionId: "s", text: "what time is it?", channel: "test" });
    expect(await wait(() => events.some((e) => e.type === "done"))).toBe(true);

    // the reply was emitted before any capture work
    const replyIndex = events.findIndex((e) => e.type === "assistant_message" && !e.interim);
    const doneIndex = events.findIndex((e) => e.type === "done");
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(replyIndex);

    expect(await wait(() => agent.skills.slugs().length > 0)).toBe(true);
    expect(agent.skills.slugs()).toEqual(["directus-collections"]);
    const notice = events.find((e) => e.type === "notice");
    expect(notice && "text" in notice ? notice.text : "").toMatch(/learned skill: directus-collections/);
    expect(agent.status("s").skills).toEqual({ total: 1, custom: 0 });

    // a fresh session sees it in the system prompt; skill_read is registered
    agent.newSession("s2");
    agent.submit({ sessionId: "s2", text: "hello", channel: "test" });
    expect(await wait(() => provider.requests.length >= 6)).toBe(true);
    const system = provider.requests.at(-1)!.system;
    expect(system).toContain("<skill_index>");
    expect(system).toContain("- directus-collections: List collections from a Directus instance over HTTP");
    expect(system).not.toContain("Preconditions"); // body stays out of the prompt
    expect(agent.tools.names()).toContain("skill_read");
  });

  it("does not capture a cancelled or failed run", async () => {
    const { agent, provider, events, wait } = makeAgent([{ calls: [{ name: "nope" }] }]);
    agent.submit({ sessionId: "s", text: "do a thing", channel: "test" });
    expect(await wait(() => events.some((e) => e.type === "done"))).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // give capture a chance to (not) run
    expect(agent.skills.slugs()).toEqual([]);
    expect(provider.requests.every((r) => !JSON.stringify(r.messages).includes("Write a reusable skill"))).toBe(true);
  });

  it("skill_read returns a stored body and counts the use", async () => {
    const { agent, provider, wait } = makeAgent([
      { calls: [{ name: "skill_read", args: { slug: "deploy-check" } }] },
      { text: "done" },
      { text: JSON.stringify({ worthCapturing: 0, taskSucceeded: 0.9, alreadyCovered: 0 }) },
    ]);
    mkdirSync(join(agent.skills.root("custom"), "deploy-check"), { recursive: true });
    writeFileSync(join(agent.skills.root("custom"), "deploy-check", "SKILL.md"), `---\nname: deploy check\ndescription: Verify a staging deploy before promoting it\nversion: 1\n---\n\n${GOOD_BODY}`);
    expect(agent.reloadSkills().ok).toBe(true);

    agent.submit({ sessionId: "s", text: "check the deploy", channel: "test" });
    expect(await wait(() => provider.requests.length >= 2)).toBe(true);
    const toolMsg = JSON.stringify(provider.requests[1]!.messages.at(-1));
    expect(toolMsg).toContain("deploy check (v1, custom)");
    expect(toolMsg).toContain("GET $DIRECTUS_URL/collections");
    expect(agent.skills.get("deploy-check")!.meta.uses).toBe(1);
  });

  it("/save-skill uses the last run, and --force still refuses a secret", async () => {
    const withSecret = DRAFT.replace("## Notes", "export DIRECTUS_TOKEN=sk-abcdefghijklmnop123\n\n## Notes");
    const { agent, events, wait, provider } = makeAgent([
      { calls: [{ name: "current_time" }] },
      { text: "done" },
      { text: JSON.stringify({ worthCapturing: 0, taskSucceeded: 0.9, alreadyCovered: 0 }) }, // triage says no
      { text: DRAFT },  // /save-skill draft
      { text: PASS },   // its eval
      { text: withSecret },
    ]);
    expect((await agent.saveSkillFromLastRun("s")).message).toMatch(/No completed run/);

    agent.submit({ sessionId: "s", text: "what time is it?", channel: "test" });
    expect(await wait(() => events.some((e) => e.type === "done"))).toBe(true);
    expect(await wait(() => provider.requests.length >= 3)).toBe(true); // triage ran
    expect(agent.skills.slugs()).toEqual([]); // ...and refused

    const saved = await agent.saveSkillFromLastRun("s", { name: "manual save" });
    expect(saved.message).toBe('Saved skill "manual-save".');
    expect(agent.skills.slugs()).toEqual(["manual-save"]);

    const forced = await agent.saveSkillFromLastRun("s", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.message).toMatch(/secret/);
  });

  it("reload reports invalid skills and forget deletes an agent-created one", async () => {
    const { agent } = makeAgent([{ text: "hi" }]);
    mkdirSync(join(agent.skills.root("custom"), "broken"), { recursive: true });
    writeFileSync(join(agent.skills.root("custom"), "broken", "SKILL.md"), "not a skill");
    const r = agent.reloadSkills();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/custom\/broken: missing frontmatter/);

    agent.skills.write({ name: "temp skill", description: "Temporary skill for the test", body: GOOD_BODY }, "agent-created");
    expect(agent.forgetSkill("temp-skill")).toMatchObject({ ok: true });
    expect(agent.skills.get("temp-skill")).toBeUndefined();
    expect(agent.forgetSkill("nope").ok).toBe(false);
  });
});
