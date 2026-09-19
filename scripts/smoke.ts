// Dev-only: talk to the agent from stdin against a real configured model. Not a channel.
// Usage: node scripts/smoke.ts [modelEntry]
import { createInterface } from "node:readline";
import { eigenHome, ensureHome } from "../src/config/home.ts";
import { loadConfig } from "../src/config/load.ts";
import { Agent } from "../src/core/agent.ts";

const home = eigenHome();
ensureHome(home);
const config = loadConfig(home);
const agent = new Agent({ config, home });
const sid = "smoke";
const entry = process.argv[2];
if (entry) {
  const r = agent.setModel(sid, entry);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
}
const s = agent.status(sid);
console.log(`model: ${s.model} (${s.provider}, ${s.providerModel}). Type a message; /model <name>, /new, Ctrl-C to stop a run, Ctrl-D to quit.`);

let finish: (() => void) | undefined;
let current: Promise<void> = Promise.resolve();
agent.on((e) => {
  if (e.sessionId !== sid) return;
  if (e.type === "assistant_message") console.log(e.interim ? `  (${e.text})` : `\neigen> ${e.text}\n`);
  else if (e.type === "tool_start") console.log(`  ⚙ ${e.name} ${JSON.stringify(e.args)}`);
  else if (e.type === "tool_end") console.log(`  ${e.ok ? "✓" : "✗"} ${e.name} ${e.durationMs}ms`);
  else if (e.type === "error") console.log(`  ⚠ ${e.message}`);
  else if (e.type === "done") {
    console.log(`  [done: ${e.reason}, ${e.steps} steps, ${e.tokens} tokens]`);
    finish?.();
  }
});

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.on("SIGINT", () => {
  if (agent.status(sid).running) agent.cancel(sid);
  else rl.close();
});

// Async iteration buffers lines, so piped multi-line input is processed in order.
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line.startsWith("/model ")) console.log(agent.setModel(sid, line.slice(7).trim()).message);
  else if (line === "/new") console.log(agent.newSession(sid).message);
  else if (line) {
    const done = new Promise<void>((r) => (finish = r));
    agent.submit({ sessionId: sid, text: line, channel: "smoke" });
    await done;
  }
  rl.prompt();
}
process.exit(0);
