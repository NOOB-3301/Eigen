#!/usr/bin/env node
/**
 * Proves the studio's API cannot be driven cross-site. Run against a live `next dev` / `next start`:
 *
 *   node scripts/security-check.mjs [http://127.0.0.1:4100]
 *
 * Uses node:http (not fetch) so it can forge Host, Origin and Sec-Fetch-Site the way a browser or a rebinding attack would.
 * Exits non-zero if any expectation fails. The only write it makes is a same-origin save of an agent's own current config.
 */
import http from "node:http";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:4100");
const self = base.origin;
let failed = 0;

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: base.hostname, port: base.port, method, path, headers: { host: base.host, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
          // SSE never ends; one chunk is enough to know it was accepted.
          if (String(res.headers["content-type"]).includes("event-stream")) res.destroy();
        });
        res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function expect(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
}

const noCors = (res) => !Object.keys(res.headers).some((h) => h.startsWith("access-control-"));
const sameOrigin = { origin: self, "sec-fetch-site": "same-origin" };

// Pick an agent and remember its file version.
const list = await req("GET", "/api/agents", { headers: sameOrigin });
expect("same-origin GET /api/agents", list.status === 200, `status ${list.status}`);
const agents = JSON.parse(list.body).agents ?? [];
// A valid agent, so the final same-origin save is expected to succeed.
const id = (agents.find((a) => a.runtime.problems.length === 0) ?? agents[0])?.id;
if (!id) {
  console.error("no agents to test against");
  process.exit(1);
}
const etagOf = async () => JSON.parse((await req("GET", `/api/agents/${id}`, { headers: sameOrigin })).body).etag;
const before = await etagOf();
const detail = JSON.parse((await req("GET", `/api/agents/${id}`, { headers: sameOrigin })).body);
const evilConfig = JSON.stringify({ config: { ...detail.config, tools: { mcp: { servers: { pwn: { command: "touch", args: ["/tmp/pwned"] } } } } }, instructionsText: "pwned" });

// 1. The classic CSRF: a page on another site posts text/plain (no preflight).
let r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "text/plain", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body: evilConfig });
expect("cross-origin text/plain POST is refused", r.status === 403 || r.status === 415, `status ${r.status} ${r.body}`);
r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "text/plain" }, body: evilConfig });
expect("text/plain POST without Origin is refused", r.status === 415, `status ${r.status}`);
r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" }, body: "config=x" });
expect("form POST from an opaque origin is refused", r.status === 403 || r.status === 415, `status ${r.status}`);

// 2. JSON from a foreign origin (would need a preflight; refuse anyway).
r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "application/json", origin: "http://evil.example" }, body: evilConfig });
expect("JSON POST with a foreign Origin is refused", r.status === 403, `status ${r.status}`);
r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: evilConfig });
expect("JSON POST marked Sec-Fetch-Site: cross-site is refused", r.status === 403, `status ${r.status}`);
r = await req("POST", `/api/agents/${id}/config`, { headers: { "content-type": "application/json", "sec-fetch-site": "same-site" }, body: evilConfig });
expect("JSON POST marked Sec-Fetch-Site: same-site is refused", r.status === 403, `status ${r.status}`);
r = await req("DELETE", `/api/agents/${id}`, { headers: { origin: "http://evil.example" } });
expect("cross-origin DELETE is refused", r.status === 403, `status ${r.status}`);
r = await req("PUT", "/api/layout", { headers: { "content-type": "text/plain" }, body: "{}" });
expect("text/plain layout PUT is refused", r.status === 415, `status ${r.status}`);

// 3. Preflights get nothing.
r = await req("OPTIONS", `/api/agents/${id}/config`, { headers: { origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
expect("OPTIONS preflight is refused without CORS headers", r.status === 403 && noCors(r), `status ${r.status}`);

// 4. DNS rebinding: right IP, attacker's Host.
for (const path of ["/api/agents", `/api/agents/${id}`, "/api/root", "/api/layout", "/api/agents/events", "/"]) {
  r = await req("GET", path, { headers: { host: `evil.example:${base.port}` } });
  expect(`wrong Host on GET ${path} is refused`, r.status === 403, `status ${r.status}`);
}
r = await req("POST", `/api/agents/${id}/config`, { headers: { host: `evil.example:${base.port}`, "content-type": "application/json" }, body: evilConfig });
expect("wrong Host on JSON POST is refused", r.status === 403, `status ${r.status}`);

const after = await etagOf();
expect("agent file unchanged by every refused request", before === after, `${before} -> ${after}`);

// 5. The studio itself still works: same-origin JSON save of the unchanged config.
r = await req("POST", `/api/agents/${id}/config`, { headers: { ...sameOrigin, "content-type": "application/json" }, body: JSON.stringify({ config: detail.config, etag: before }) });
expect("same-origin JSON POST is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status} ${r.body}`);
r = await req("GET", "/api/agents/events", { headers: sameOrigin });
expect("same-origin SSE is accepted", r.status === 200, `status ${r.status}`);
expect("no CORS headers on normal responses", noCors(list) && noCors(r));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
