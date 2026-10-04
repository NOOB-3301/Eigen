import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `mastra dev` bundles a lazily imported module into its own chunk. That chunk imports the entry module, which is still starting up
 * (it awaits the HTTP server) while route setup runs, so awaiting the import there never finishes and the engine never listens.
 * The built server does not show it, so the e2e suite cannot catch it.
 */
const lazyImports = (source: string) => [...source.matchAll(/(?<![.\w])import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

describe("route setup (server.ts)", () => {
  it("imports its modules statically", () => {
    const source = readFileSync(new URL("../src/mastra/server.ts", import.meta.url), "utf8");
    expect(lazyImports(source)).toEqual([]);
  });

  it("the check sees the lazy import it exists to stop", () => {
    expect(lazyImports(`createHandler: async (o) => { const chat = await import("./lib/chat.ts").then((m) => m.studioChat()); }`)).toEqual(["./lib/chat.ts"]);
  });
});
