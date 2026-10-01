import { existsSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { LocalSandbox } from "@mastra/core/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { CLAWHUB_VERSION } from "../src/mastra/lib/skills.ts";
import { makeWorkspace } from "../src/mastra/lib/workspace.ts";
import { fakeLlm } from "../test/helpers/fake-llm.ts";
import { tmpHome } from "../test/helpers/home.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const iso = LocalSandbox.detectIsolation();

describe("real ClawHub install through the agent (needs network)", () => {
  it("is approval-gated, installs into the sandbox, and the skill is usable on the next step", async () => {
    // In this container the proxy's CA file lives outside the sandbox; a real machine needs no extra paths.
    const extra = existsSync("/root/.ccr") ? ["/root/.ccr"] : [];
    const p = tmpHome({ sandbox: { isolation: iso.available ? "auto" : "none", readOnlyPaths: extra } });
    const cfg = loadConfig(p.configFile);
    const install = `npx --yes clawhub@${CLAWHUB_VERSION} install @steipete/weather`;
    const llm = await fakeLlm([{ calls: [{ name: "bash", args: { description: "install weather skill", command: install } }] }, { text: "installed" }]);
    closers.push(llm.close);
    const agent = new Agent({ id: "t", name: "t", instructions: "test", model: { id: "fake/model", url: llm.url }, workspace: makeWorkspace(p, cfg) });
    const mastra = new Mastra({ agents: { t: agent }, storage: new LibSQLStore({ id: "t", url: `file:${join(p.dataDir, "t.db")}` }) });

    const held = await mastra.getAgent("t").generate("install the weather skill", { maxSteps: 6 });
    expect(held.finishReason).toBe("suspended");
    expect(existsSync(join(p.sandboxSkillsDir, "@steipete"))).toBe(false);

    await mastra.getAgent("t").approveToolCallGenerate({ runId: held.runId!, toolCallId: held.suspendPayload.toolCallId });

    expect(existsSync(join(p.sandboxSkillsDir, "@steipete/weather/SKILL.md"))).toBe(true);
    expect(existsSync(join(p.sandboxDir, ".clawhub/lock.json"))).toBe(true);
    const afterInstall = JSON.stringify(llm.requests.at(-1));
    expect(afterInstall).toContain("weather");
    expect(afterInstall).toMatch(/Get current weather and forecasts/);
  });
});
