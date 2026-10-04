import { afterEach, describe, it } from "vitest";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

describe("service start (what launchd runs)", () => {
  it("`mastra start --env ~/.eigen/.env` reads the token from the env file and answers", async () => {
    eigen = await startEigen([{ text: "up and running" }], {}, { service: true });
    eigen.tg.say("hello");
    await waitFor(() => eigen!.tg.sent().some((t) => t.includes("up and running")));
  });
});
