import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent, createBuiltinTools } from "../../src/core/agent.ts";
import type { AgentEvent } from "../../src/core/events.ts";
import { defineTool } from "../../src/tools/registry.ts";
import type { Config } from "../../src/config/schema.ts";
import { FakeProvider, FakeRegistry, testConfig } from "./fake-provider.ts";
import type { Script } from "./fake-provider.ts";

export function tempHome(files: Record<string, string> = { "SOUL.md": "Home soul.", "prompts/system.md": "Home system." }): string {
  const home = mkdtempSync(join(tmpdir(), "eigen-test-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), body);
  }
  return home;
}

export const sleepTool = defineTool({
  name: "sleep",
  description: "sleep for ms",
  inputSchema: z.object({ ms: z.number() }),
  execute: ({ ms }, { signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve("slept"), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    }),
});

export function makeAgent(steps: Script[], opts: { config?: Config; limits?: Partial<Config["limits"]> } = {}) {
  const config = opts.config ?? testConfig(opts.limits);
  const provider = new FakeProvider(steps);
  const tools = createBuiltinTools().register(sleepTool);
  const agent = new Agent({ config, home: tempHome(), tools, models: new FakeRegistry(config, provider) });
  const events: AgentEvent[] = [];
  agent.on((e) => events.push(e));
  const doneCount = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => (events.filter((e) => e.type === "done").length >= n ? resolve() : setTimeout(check, 2));
      check();
    });
  return { agent, provider, events, doneCount };
}
