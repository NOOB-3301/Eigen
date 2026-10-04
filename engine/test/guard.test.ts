import { describe, expect, it } from "vitest";
import { denyEngineRequest, hostAllowed } from "../src/mastra/lib/guard.ts";

const req = (method: string, headers: Record<string, string>) => new Request("http://127.0.0.1:4111/eigen/agents", { method, headers, ...(method === "POST" && { body: "{}" }) });

describe("hostAllowed", () => {
  it("accepts only loopback names on the engine's own port", () => {
    for (const h of ["127.0.0.1:4111", "localhost:4111", "LOCALHOST:4111", "[::1]:4111"]) expect(hostAllowed(h, 4111), h).toBe(true);
    for (const h of ["evil.example:4111", "127.0.0.1.evil.example:4111", "127.0.0.1:4112", "127.0.0.1", "0.0.0.0:4111", "10.0.0.5:4111", "", undefined, null, "127.0.0.1:4111@evil.example"]) expect(hostAllowed(h, 4111), String(h)).toBe(false);
  });
});

describe("denyEngineRequest", () => {
  it("403 for a rebinding Host, on every method", async () => {
    for (const method of ["GET", "POST"]) {
      const res = denyEngineRequest(req(method, { host: "attacker.example:4111", "content-type": "application/json" }), 4111);
      expect(res?.status, method).toBe(403);
    }
  });
  it("lets a plain GET from the studio's server through (a browser Origin on a GET is already unreadable: no CORS)", () => {
    expect(denyEngineRequest(req("GET", { host: "127.0.0.1:4111" }), 4111)).toBeNull();
    expect(denyEngineRequest(req("GET", { host: "127.0.0.1:4111", origin: "https://evil.example" }), 4111)).toBeNull();
  });
  it("a POST must be JSON and must not come from a browser", () => {
    const ok = { host: "127.0.0.1:4111", "content-type": "application/json" };
    expect(denyEngineRequest(req("POST", ok), 4111)).toBeNull();
    expect(denyEngineRequest(req("POST", { ...ok, "content-type": "application/json; charset=utf-8" }), 4111)).toBeNull();
    expect(denyEngineRequest(req("POST", { ...ok, origin: "https://evil.example" }), 4111)?.status).toBe(403);
    expect(denyEngineRequest(req("POST", { ...ok, origin: "http://127.0.0.1:4100" }), 4111)?.status).toBe(403);
    expect(denyEngineRequest(req("POST", { host: "127.0.0.1:4111", "content-type": "text/plain" }), 4111)?.status).toBe(415);
    expect(denyEngineRequest(req("POST", { host: "127.0.0.1:4111" }), 4111)?.status).toBe(415);
  });
});
