import { afterEach, describe, expect, it } from "vitest";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const replied = (text: string) => () => eigen!.tg.sent().some((t) => t.includes(text));
const order = (...texts: string[]) => texts.map((t) => eigen!.tg.sent().findIndex((s) => s.includes(t)));

describe("message ordering (built server)", () => {
  it("answers a message sent right after a reply", async () => {
    eigen = await startEigen([{ text: "answer one" }, { text: "answer two" }, { text: "answer three" }]);
    eigen.tg.say("first");
    await waitFor(replied("answer one"));
    eigen.tg.say("second");
    await waitFor(replied("answer two"), 12_000);
    eigen.tg.say("third");
    await waitFor(replied("answer three"), 12_000);
    expect(eigen.llm.requests).toHaveLength(3);
  });

  it("queues a message sent mid-run and answers it afterwards, in order", async () => {
    eigen = await startEigen([{ text: "answer one", delayMs: 1500 }, { text: "answer two" }]);
    eigen.tg.say("first");
    await waitFor(() => eigen!.llm.requests.length === 1);
    eigen.tg.say("second");
    await waitFor(replied("answer two"), 12_000);
    const [one, two] = order("answer one", "answer two");
    expect(one).toBeGreaterThanOrEqual(0);
    expect(two).toBeGreaterThan(one!);
  });

  it("/stop ends the run and drops what was queued behind it", async () => {
    eigen = await startEigen([{ text: "slow answer", delayMs: 3000 }, { text: "queued answer" }]);
    eigen.tg.say("first");
    await waitFor(() => eigen!.llm.requests.length === 1);
    eigen.tg.say("second");
    await sleep(800);
    eigen.tg.say("/stop");
    await waitFor(replied("Stopped."));
    await sleep(4500);
    expect(replied("slow answer")()).toBe(false);
    expect(replied("queued answer")()).toBe(false);
    expect(eigen.llm.requests).toHaveLength(1);
  });
});
