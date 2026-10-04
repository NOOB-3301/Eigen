import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the primary's semantic recall (built server, fake embedder)", () => {
  it("finds an old message by similarity once it has left the recent-message window, and not when recall is off", async () => {
    eigen = await startEigen([{ text: "noted" }], {}, { port: 4127 });
    const lastRequest = () => JSON.stringify(eigen!.llm.requests.at(-1));
    const say = async (text: string) => {
      const seen = eigen!.llm.requests.length;
      eigen!.tg.say(text);
      await waitFor(() => eigen!.llm.requests.length > seen);
      await sleep(600); // Mastra saves the reply and embeds the messages after the turn
    };
    const file = join(eigen.p.agentsDir, "eigen", "config.json");
    const memory = (semanticRecall: Record<string, unknown>) => {
      const c = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...c, memory: { scope: "shared", lastMessages: 1, semanticRecall } }));
    };
    const reloaded = async (check: (m: { semanticRecall: { enabled: boolean } }) => boolean) => {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const d = (await fetch(`${eigen!.url}/eigen/agents/eigen`).then((r) => r.json())) as { resolved?: { memory: { semanticRecall: { enabled: boolean } } } };
        if (d.resolved && check(d.resolved.memory)) return;
        await sleep(150);
      }
      throw new Error("the primary never reloaded");
    };

    // Only the latest message is kept as history, so anything older reaches the model only through recall.
    memory({ enabled: true, topK: 3, messageRange: 1 });
    await reloaded((m) => m.semanticRecall.enabled);
    await say("my favourite fruit is mango pudding");
    await say("the weather is cold today");
    await say("remind me to water the plants");
    await say("which fruit is mango pudding");
    expect(lastRequest()).toContain("my favourite fruit is mango pudding");

    memory({ enabled: false });
    await reloaded((m) => !m.semanticRecall.enabled);
    await say("which fruit is mango pudding again");
    expect(lastRequest()).not.toContain("my favourite fruit is mango pudding");
  });
});
