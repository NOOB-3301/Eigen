import { createRequire } from "node:module";
import { it } from "vitest";
const require = createRequire(import.meta.url);
import { startEigen } from "./harness.ts";
it("debug", async () => {
  try {
    const e = await startEigen([{ id: "alpha" }, { id: "beta" }]);
    console.log("UP");
    await e.stop();
  } catch (err) {
    require("node:fs").writeFileSync("/tmp/eigen-v2-debug.txt", String((err as Error).message));
  }
}, 200_000);
