import dns from "node:dns";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECT_ATTEMPT_MS, tuneNetwork } from "../src/mastra/lib/network.ts";

const before = { order: dns.getDefaultResultOrder(), attempt: net.getDefaultAutoSelectFamilyAttemptTimeout() };
afterEach(() => {
  dns.setDefaultResultOrder(before.order);
  net.setDefaultAutoSelectFamilyAttemptTimeout(before.attempt);
});

describe("tuneNetwork", () => {
  it("tries IPv4 first and gives each address long enough to answer on a slow link", () => {
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBeLessThan(CONNECT_ATTEMPT_MS); // Node's own 250 ms
    tuneNetwork();
    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
  });

  it("is applied when the engine's shared boot module loads, so it holds before the first connection", async () => {
    const { readFileSync } = await import("node:fs");
    const fleet = readFileSync(new URL("../src/mastra/lib/fleet.ts", import.meta.url), "utf8");
    // The call must come before the home is read and the registry exists (bots, models and MCP connect once it loads agents).
    expect(fleet.indexOf("tuneNetwork();")).toBeGreaterThan(-1);
    expect(fleet.indexOf("tuneNetwork();")).toBeLessThan(fleet.indexOf("readyHome()"));
    expect(fleet.indexOf("tuneNetwork();")).toBeLessThan(fleet.indexOf("createAgentRegistry({"));
  });
});
