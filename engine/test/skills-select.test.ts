import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { tmpHome, writeAgent } from "./helpers/home.ts";
import { closeRegistries, registryRig, sleep } from "./helpers/registry.ts";

afterEach(closeRegistries);

function skill(root: string, rel: string, description = "Does a thing.") {
  const file = join(root, rel, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${rel.split("/").pop()}\ndescription: ${description}\n---\n\nSteps.\n`);
}

/** Waits for the watcher (a loaded machine delivers file events late), then gives any wrongly refreshed agent time to show up too. */
async function settle(refreshed: string[], count: number) {
  const end = Date.now() + 5000;
  while (refreshed.length < count && Date.now() < end) await sleep(25);
  await sleep(300);
}

/** Which agents refreshed (a folder and its file can arrive as two bursts under load; what matters here is WHO refreshed). */
const who = (refreshed: string[]) => [...new Set(refreshed)].sort();

describe("the registry's skills watcher", () => {
  it("a change in an agent's skills/ or sandbox/skills/ refreshes that agent only", async () => {
    const p = tmpHome();
    for (const id of ["alpha", "beta"]) writeAgent(p, id);
    const { refreshed, attach, watch } = registryRig(p);
    await attach();
    await watch();

    skill(agentPaths(p, "alpha").skillsDir, "pdf");
    await settle(refreshed, 1);
    expect(who(refreshed)).toEqual(["alpha"]);

    refreshed.length = 0;
    skill(agentPaths(p, "beta").sandboxSkillsDir, "notes");
    await settle(refreshed, 1);
    expect(who(refreshed)).toEqual(["beta"]);

    refreshed.length = 0;
    skill(agentPaths(p, "alpha").skillsDir, "@acme/weather");
    await settle(refreshed, 1);
    expect(who(refreshed)).toEqual(["alpha"]);
  });

  it("a skills change never rebuilds the agent", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha");
    const { builds, refreshed, attach, watch } = registryRig(p);
    await attach();
    await watch();
    skill(agentPaths(p, "alpha").skillsDir, "pdf");
    await settle(refreshed, 1);
    expect(builds).toEqual({ alpha: 1 });
  });

  it("a burst of writes refreshes the agent once, after the last one (every write restarts the wait)", async () => {
    // Wide margins: the writes must land closer together than the wait, even when the machine is busy.
    const p = tmpHome();
    writeAgent(p, "alpha");
    const { refreshed, attach, watch } = registryRig(p, { debounceMs: 1000 });
    await attach();
    await watch();
    for (const name of ["a", "b", "c"]) {
      skill(agentPaths(p, "alpha").skillsDir, name);
      await sleep(100);
    }
    await sleep(2500);
    expect(refreshed).toEqual(["alpha"]);
  });

  it("ignores the studio's temporary files, dot folders, and the rest of the sandbox", async () => {
    const p = tmpHome();
    writeAgent(p, "alpha");
    const a = agentPaths(p, "alpha");
    skill(a.skillsDir, "pdf");
    const { refreshed, attach, watch } = registryRig(p);
    await attach();
    await watch();
    writeFileSync(join(a.skillsDir, "pdf", "SKILL.md.123.tmp"), "x");
    mkdirSync(join(a.skillsDir, ".cache"));
    writeFileSync(join(a.skillsDir, ".cache", "index.json"), "{}");
    writeFileSync(join(a.sandboxDir, "notes.txt"), "x");
    await sleep(400);
    expect(refreshed).toEqual([]);
  });
});
