#!/usr/bin/env node
/**
 * Proves the studio's API cannot be driven cross-site. Run against a live `next dev` / `next start`:
 *
 *   node scripts/security-check.mjs [http://127.0.0.1:4100]
 *
 * Uses node:http (not fetch) so it can forge Host, Origin and Sec-Fetch-Site the way a browser or a rebinding attack would.
 * Exits non-zero if any expectation fails. Its only writes are same-origin and tidy: it saves an agent's and the root
 * config's own current content, and sets then removes one throwaway variable (EIGEN_SECCHECK_*) in .env.
 * SECCHECK_NO_WRITE=1 skips every write, including those.
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

/* ------------------------------------------------------------------------------------------------ */
/* Settings routes: root config, secrets, probes                                                      */
/* ------------------------------------------------------------------------------------------------ */
const noWrite = process.env.SECCHECK_NO_WRITE === "1";
const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
const SECRET_NAME = `EIGEN_SECCHECK_${rand}`;
const SECRET_VALUE = `sk-seccheck-${rand.toLowerCase()}-${Math.random().toString(36).slice(2, 12)}`;
const rootGet = JSON.parse((await req("GET", "/api/root/config", { headers: sameOrigin })).body);
const modelKey = Object.keys(rootGet.config?.models ?? {})[0] ?? "x";
const evilBodies = {
  "/api/root/config": JSON.stringify({ config: { ...rootGet.config, mcpServers: { pwn: { command: "touch", args: ["/tmp/pwned"] } } } }),
};
const mutating = [
  ["PUT", "/api/root/config", evilBodies["/api/root/config"]],
  ["PUT", `/api/secrets/${SECRET_NAME}`, JSON.stringify({ value: SECRET_VALUE })],
  ["DELETE", `/api/secrets/${SECRET_NAME}`, undefined],
  ["POST", "/api/telegram/check", JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" })],
  ["POST", `/api/models/${encodeURIComponent(modelKey)}/test`, "{}"],
];
const json = { "content-type": "application/json" };
for (const [method, path, body] of mutating) {
  const tag = `${method} ${path.replace(SECRET_NAME, ":name")}`;
  r = await req(method, path, { headers: { "content-type": "text/plain", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: cross-origin text/plain refused`, r.status === 403 || r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { "content-type": "text/plain" }, body });
  expect(`${tag}: text/plain without Origin refused`, r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, origin: "http://evil.example" }, body });
  expect(`${tag}: JSON with a foreign Origin refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, origin: "null" }, body });
  expect(`${tag}: JSON from an opaque origin refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: Sec-Fetch-Site cross-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "same-site" }, body });
  expect(`${tag}: Sec-Fetch-Site same-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, host: `evil.example:${base.port}` }, body });
  expect(`${tag}: foreign Host refused`, r.status === 403, `status ${r.status}`);
  r = await req("OPTIONS", path, { headers: { origin: "http://evil.example", "access-control-request-method": method, "access-control-request-headers": "content-type" } });
  expect(`${tag}: OPTIONS preflight refused, no CORS headers`, r.status === 403 && noCors(r), `status ${r.status}`);
}
for (const path of ["/api/root/config", "/api/secrets"]) {
  r = await req("GET", path, { headers: { host: `evil.example:${base.port}` } });
  expect(`wrong Host on GET ${path} is refused`, r.status === 403, `status ${r.status}`);
  r = await req("GET", path, { headers: { origin: "http://evil.example" } });
  expect(`foreign Origin on GET ${path} is refused`, r.status === 403, `status ${r.status}`);
}

// Nothing refused above changed anything.
const rootAfterRefused = JSON.parse((await req("GET", "/api/root/config", { headers: sameOrigin })).body);
expect("root config.json unchanged by every refused request", rootAfterRefused.etag === rootGet.etag, `${rootGet.etag} -> ${rootAfterRefused.etag}`);
const listed = async (name) => JSON.parse((await req("GET", `/api/secrets?names=${name}`, { headers: sameOrigin })).body).secrets.find((x) => x.name === name);
expect("a secret named by a refused request was never set", (await listed(SECRET_NAME))?.set === false);

// Names that are not plain upper-case variable names never reach .env.
if (!noWrite) {
  // A literal ".." segment is redirected (308) by Next itself before any handler runs; every other name reaches our 400.
  for (const bad of ["lower", "..%2Fx", "A%3DB", "A%0AB", "a-b", "1ABC", "%2E%2E", "A".repeat(65)]) {
    r = await req("PUT", `/api/secrets/${bad}`, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ value: "v" }) });
    expect(`secret name "${decodeURIComponent(bad).replace(/\n/g, "\\n").slice(0, 20)}" is rejected`, [308, 400, 404].includes(r.status), `status ${r.status}`);
    r = await req("DELETE", `/api/secrets/${bad}`, { headers: { ...sameOrigin, ...json } });
    expect(`secret name "${decodeURIComponent(bad).replace(/\n/g, "\\n").slice(0, 20)}" cannot be deleted either`, [308, 400, 404].includes(r.status), `status ${r.status}`);
  }
  r = await req("PUT", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ value: "two\nlines" }) });
  expect("a multi-line secret value is rejected without echoing it", r.status === 400 && !r.body.includes("two"), `status ${r.status}`);
  r = await req("PUT", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ value: 42 }) });
  expect("a non-string secret value is rejected", r.status === 400, `status ${r.status}`);

  // The write-only guarantee: set a secret, then no route may ever answer with it.
  r = await req("PUT", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ value: SECRET_VALUE }) });
  expect("same-origin PUT of a secret is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status}`);
  expect("the PUT answer does not contain the value", !r.body.includes(SECRET_VALUE));
  expect("the secret now reads as set", (await listed(SECRET_NAME))?.set === true);
  const probes = [
    ["GET", "/api/agents"],
    ["GET", `/api/agents/${id}`],
    ["GET", `/api/agents/${id}/config`],
    ["GET", "/api/root"],
    ["GET", "/api/root/config"],
    ["GET", "/api/secrets"],
    ["GET", `/api/secrets?names=${SECRET_NAME}`],
    ["GET", "/api/layout"],
    ["GET", "/api/agents/events"],
    ["POST", "/api/telegram/check", JSON.stringify({ tokenEnv: SECRET_NAME })],
    ["POST", `/api/models/${encodeURIComponent(modelKey)}/test`, "{}"],
  ];
  for (const [m, path, body] of probes) {
    const res = await req(m, path, { headers: m === "GET" ? sameOrigin : { ...sameOrigin, ...json }, body });
    expect(`${m} ${path.split("?")[0]} never contains a secret value`, !res.body.includes(SECRET_VALUE), `status ${res.status}`);
  }
  r = await req("DELETE", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json } });
  expect("same-origin DELETE of the secret is accepted", r.status === 200 && JSON.parse(r.body).removed === true, `status ${r.status}`);
  expect("the secret now reads as not set", (await listed(SECRET_NAME))?.set === false);
  r = await req("DELETE", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json } });
  expect("deleting it again reports removed: false", r.status === 200 && JSON.parse(r.body).removed === false, `status ${r.status}`);

  // Root config: a same-origin save of its own content works, and a stale version is a 409.
  r = await req("PUT", "/api/root/config", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ config: rootGet.config, etag: rootGet.etag }) });
  expect("same-origin root config save is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  r = await req("PUT", "/api/root/config", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ config: rootGet.config, etag: "0000000000000000" }) });
  expect("root config save with a stale etag is a 409", r.status === 409, `status ${r.status}`);
  r = await req("PUT", "/api/root/config", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ config: { ...rootGet.config, defaultModel: "no-such-model" } }) });
  expect("root config save with a schema error is a 400", r.status === 400, `status ${r.status}`);
}

// Probes: validated input, and the studio never needs the engine for the guard to hold.
r = await req("POST", "/api/telegram/check", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ tokenEnv: "lower-case" }) });
expect("telegram check rejects a bad variable name", r.status === 400, `status ${r.status}`);
r = await req("POST", "/api/telegram/check", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" }) });
expect("telegram check answers with JSON { ok } (engine up or offline)", [200, 501, 502, 503, 504].includes(r.status) && typeof JSON.parse(r.body).ok === "boolean", `status ${r.status}`);
r = await req("POST", "/api/models/no-such-model-key/test", { headers: { ...sameOrigin, ...json }, body: "{}" });
expect("model test for an unknown model is a 404", r.status === 404, `status ${r.status}`);
expect("no CORS headers on any settings response", noCors(r));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
