#!/usr/bin/env node
/**
 * Proves the studio's API cannot be driven cross-site. Run against a live `next dev` / `next start`:
 *
 *   node scripts/security-check.mjs [http://127.0.0.1:4100]
 *
 * Uses node:http (not fetch) so it can forge Host, Origin and Sec-Fetch-Site the way a browser or a rebinding attack would.
 * Exits non-zero if any expectation fails. Its only writes are same-origin and tidy: it saves an agent's, the root
 * config's and SOUL.md's own current content, sets then removes one throwaway variable (EIGEN_SECCHECK_*) in .env, and
 * creates, edits and trashes one throwaway skill (seccheck-*, left in skills/.trash because trash is never erased).
 * SECCHECK_NO_WRITE=1 skips every write, including those. EIGEN_HOME=<the server's home> also compares every file under it
 * before and after the refused requests.
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

/* ------------------------------------------------------------------------------------------------ */
/* Builder routes: skill library, shared soul, trigger runs, GitHub check                             */
/* ------------------------------------------------------------------------------------------------ */
// With EIGEN_HOME set (the home the server uses), every file under it is compared before and after the refused requests.
const home = process.env.EIGEN_HOME;
const fsSnapshot = async () => {
  if (!home) return "";
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  return readdirSync(home, { recursive: true })
    .map(String)
    .filter((f) => !/^(logs|data|sandbox)\//.test(f))
    .sort()
    .map((f) => {
      const s = statSync(join(home, f), { throwIfNoEntry: false });
      return `${f}:${s?.isFile() ? `${s.size}:${s.mtimeMs}` : "d"}`;
    })
    .join("\n");
};
const skillsList = JSON.parse((await req("GET", "/api/skills", { headers: sameOrigin })).body).skills ?? [];
const soulGet = JSON.parse((await req("GET", "/api/soul", { headers: sameOrigin })).body);
const userSkill = skillsList.find((s) => s.origin === "user")?.slug;
const clawSkill = skillsList.find((s) => s.origin === "clawhub")?.slug;
const skillPath = (slug) => `/api/skills/${slug.split("/").map(encodeURIComponent).join("/")}`;
const skillEtags = async () => Promise.all(skillsList.map(async (s) => JSON.parse((await req("GET", skillPath(s.slug), { headers: sameOrigin })).body).etag));
const fsBefore = await fsSnapshot();
const skillEtagsBefore = await skillEtags();

for (const path of ["/api/skills", "/api/soul", `/api/agents/${id}/triggers/runs`, ...(userSkill ? [skillPath(userSkill)] : [])]) {
  r = await req("GET", path, { headers: sameOrigin });
  expect(`same-origin GET ${path} answers JSON, not cached`, r.status < 600 && String(r.headers["content-type"]).includes("application/json") && r.headers["cache-control"] === "no-store", `status ${r.status} cache-control ${r.headers["cache-control"]}`);
  r = await req("GET", path, { headers: { host: `evil.example:${base.port}` } });
  expect(`wrong Host on GET ${path} is refused`, r.status === 403, `status ${r.status}`);
  r = await req("GET", path, { headers: { origin: "http://evil.example" } });
  expect(`foreign Origin on GET ${path} is refused`, r.status === 403, `status ${r.status}`);
}

const builderMutating = [
  ["POST", "/api/skills", JSON.stringify({ slug: "pwned", description: "pwned" })],
  ["PUT", skillPath(userSkill ?? "pdf"), JSON.stringify({ text: "---\nname: pwned\ndescription: pwned\n---\n" })],
  ["DELETE", skillPath(userSkill ?? "pdf"), undefined],
  ["PUT", "/api/soul", JSON.stringify({ text: "pwned" })],
  ["POST", `/api/agents/${id}/triggers/any/run`, "{}"],
  ["POST", "/api/github/check", JSON.stringify({ tokenEnv: "GITHUB_TOKEN", repo: "acme/web" })],
];
for (const [method, path, body] of builderMutating) {
  const tag = `${method} ${path}`;
  r = await req(method, path, { headers: { "content-type": "text/plain", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: cross-origin text/plain refused`, r.status === 403 || r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { "content-type": "text/plain" }, body });
  expect(`${tag}: text/plain without Origin refused`, r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, origin: "http://evil.example" }, body });
  expect(`${tag}: JSON with a foreign Origin refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: Sec-Fetch-Site cross-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "same-site" }, body });
  expect(`${tag}: Sec-Fetch-Site same-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, host: `evil.example:${base.port}` }, body });
  expect(`${tag}: foreign Host refused`, r.status === 403, `status ${r.status}`);
  r = await req("OPTIONS", path, { headers: { origin: "http://evil.example", "access-control-request-method": method, "access-control-request-headers": "content-type" } });
  expect(`${tag}: OPTIONS preflight refused, no CORS headers`, r.status === 403 && noCors(r), `status ${r.status}`);
}

// Slugs that try to leave ~/.eigen/skills. Next answers a literal ".." segment itself (308 / 404) before any handler; everything else must be our 400.
const traversals = ["..%2F..%2Fconfig.json", "%2e%2e", "%2e%2e/%2e%2e/config.json", "@..%2Fx", "@%2e%2e/x", "%40..%2F..%2F.env", "pdf%2F..%2F..%2F.env", "%252e%252e%252f.env", "%2Fetc%2Fpasswd", ".trash", "%2Etrash/x", "x%00", "a%5C..%5Cb", "PDF", "@owner/../../.env"];
for (const t of traversals) {
  for (const [method, body] of [["GET"], ["PUT", JSON.stringify({ text: "---\nname: x\ndescription: pwned\n---\n" })], ["DELETE"]]) {
    r = await req(method, `/api/skills/${t}`, { headers: { ...sameOrigin, ...json }, body });
    expect(`skill slug "${decodeURIComponent(t).replace(/\0/g, "\\0")}" refused on ${method}`, [308, 400, 404].includes(r.status) && !r.body.includes('"text"'), `status ${r.status}`);
  }
}
r = await req("POST", "/api/skills", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ slug: "../pwned", description: "d" }) });
expect("creating a skill with a traversal slug is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", "/api/skills", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ slug: "@owner/pwned", description: "d" }) });
expect("creating a skill under @owner/ is a 400", r.status === 400, `status ${r.status}`);
if (clawSkill) {
  r = await req("PUT", skillPath(clawSkill), { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ text: `---\nname: ${clawSkill.split("/")[1]}\ndescription: mine now\n---\n` }) });
  expect("writing a ClawHub skill is refused (403)", r.status === 403, `status ${r.status}`);
  r = await req("DELETE", skillPath(clawSkill), { headers: { ...sameOrigin, ...json } });
  expect("trashing a ClawHub skill is refused (403)", r.status === 403, `status ${r.status}`);
} else console.log("SKIP  no ClawHub skill installed: write/trash refusal not checked");
r = await req("GET", "/api/agents/NOT_AN_ID/triggers/runs", { headers: sameOrigin });
expect("trigger runs for a bad agent id is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", `/api/agents/${id}/triggers/..%2Fx/run`, { headers: { ...sameOrigin, ...json }, body: "{}" });
expect("running a trigger with a bad trigger id is a 400", r.status === 400, `status ${r.status}`);
for (const bad of [{ tokenEnv: "lower", repo: "acme/web" }, { tokenEnv: "GITHUB_TOKEN", repo: "../x" }, { tokenEnv: "GITHUB_TOKEN", repo: "acme" }]) {
  r = await req("POST", "/api/github/check", { headers: { ...sameOrigin, ...json }, body: JSON.stringify(bad) });
  expect(`github check rejects ${JSON.stringify(bad)}`, r.status === 400, `status ${r.status}`);
}
r = await req("POST", "/api/github/check", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ tokenEnv: "GITHUB_TOKEN", repo: "acme/web" }) });
expect("github check answers with JSON { ok } (engine up or offline)", [200, 501, 502, 503, 504].includes(r.status) && typeof JSON.parse(r.body).ok === "boolean", `status ${r.status}`);

expect("every skill unchanged by the refused requests", JSON.stringify(await skillEtags()) === JSON.stringify(skillEtagsBefore));
const soulAfter = JSON.parse((await req("GET", "/api/soul", { headers: sameOrigin })).body);
expect("SOUL.md unchanged by the refused requests", soulAfter.etag === soulGet.etag, `${soulGet.etag} -> ${soulAfter.etag}`);
if (home) expect("no file under EIGEN_HOME changed", (await fsSnapshot()) === fsBefore);
else console.log("SKIP  EIGEN_HOME not set: file-system snapshot not compared");

if (!noWrite) {
  // Tidy same-origin writes: the soul's own content back with its etag; a throwaway skill created, edited, then trashed (kept in skills/.trash).
  r = await req("PUT", "/api/soul", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ text: soulGet.text, etag: soulGet.etag }) });
  expect("same-origin save of SOUL.md is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  r = await req("PUT", "/api/soul", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ text: soulGet.text, etag: "0000000000000000" }) });
  expect("SOUL.md save with a stale etag is a 409", r.status === 409 && typeof JSON.parse(r.body).etag === "string", `status ${r.status}`);
  const slug = `seccheck-${rand.toLowerCase()}`;
  r = await req("POST", "/api/skills", { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ slug, description: "Throwaway skill from scripts/security-check.mjs." }) });
  expect("same-origin skill create is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  const made = JSON.parse((await req("GET", skillPath(slug), { headers: sameOrigin })).body);
  r = await req("PUT", skillPath(slug), { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ text: made.text.replace("Throwaway", "Edited throwaway"), etag: made.etag }) });
  expect("same-origin skill save is accepted", r.status === 200 && JSON.parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  r = await req("PUT", skillPath(slug), { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ text: made.text, etag: made.etag }) });
  expect("skill save with a stale etag is a 409", r.status === 409, `status ${r.status}`);
  r = await req("DELETE", skillPath(slug), { headers: { ...sameOrigin, ...json } });
  expect("same-origin skill trash is accepted", r.status === 200 && !r.body.includes(".trash"), `status ${r.status} ${r.body}`);

  // Write-only secrets, again for the new routes: set one, then no builder route may answer with it.
  r = await req("PUT", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ value: SECRET_VALUE }) });
  expect("throwaway secret set for the builder routes", r.status === 200, `status ${r.status}`);
  for (const [m, path, body] of [
    ["GET", "/api/skills"],
    ["GET", "/api/soul"],
    ["GET", `/api/agents/${id}`],
    ["GET", `/api/agents/${id}/triggers/runs`],
    ["POST", `/api/agents/${id}/triggers/any/run`, "{}"],
    ["POST", "/api/github/check", JSON.stringify({ tokenEnv: SECRET_NAME, repo: "acme/web" })],
    ...(userSkill ? [["GET", skillPath(userSkill)]] : []),
  ]) {
    const res = await req(m, path, { headers: m === "GET" ? sameOrigin : { ...sameOrigin, ...json }, body });
    expect(`${m} ${path} never contains a secret value`, !res.body.includes(SECRET_VALUE), `status ${res.status}`);
  }
  r = await req("DELETE", `/api/secrets/${SECRET_NAME}`, { headers: { ...sameOrigin, ...json } });
  expect("throwaway secret removed again", r.status === 200 && JSON.parse(r.body).removed === true, `status ${r.status}`);
}

/* ------------------------------------------------------------------------------------------------ */
/* Chat: POST /api/chat/[agentId] streams an agent's reply; GET ?session= returns its history         */
/* ------------------------------------------------------------------------------------------------ */
// Nothing here reaches the model: every request is either refused by the guard or rejected by the proxy's own validation first.
const chatPath = `/api/chat/${id}`;
const chatTurn = JSON.stringify({ session: "seccheck-session", message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } });
r = await req("POST", chatPath, { headers: { "content-type": "text/plain", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body: chatTurn });
expect("chat: cross-origin text/plain POST refused", r.status === 403 || r.status === 415, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { "content-type": "text/plain" }, body: chatTurn });
expect("chat: text/plain POST without Origin refused", r.status === 415, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...json, origin: "http://evil.example" }, body: chatTurn });
expect("chat: JSON with a foreign Origin refused", r.status === 403, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...json, origin: "null" }, body: chatTurn });
expect("chat: JSON from an opaque origin refused", r.status === 403, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...json, "sec-fetch-site": "cross-site" }, body: chatTurn });
expect("chat: Sec-Fetch-Site cross-site refused", r.status === 403, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...json, "sec-fetch-site": "same-site" }, body: chatTurn });
expect("chat: Sec-Fetch-Site same-site refused", r.status === 403, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...json, host: `evil.example:${base.port}` }, body: chatTurn });
expect("chat: foreign Host refused", r.status === 403, `status ${r.status}`);
r = await req("OPTIONS", chatPath, { headers: { origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
expect("chat: OPTIONS preflight refused, no CORS headers", r.status === 403 && noCors(r), `status ${r.status}`);
r = await req("GET", `${chatPath}?session=seccheck-session`, { headers: { host: `evil.example:${base.port}` } });
expect("chat history: wrong Host refused", r.status === 403, `status ${r.status}`);
r = await req("GET", `${chatPath}?session=seccheck-session`, { headers: { origin: "http://evil.example" } });
expect("chat history: foreign Origin refused", r.status === 403, `status ${r.status}`);
r = await req("POST", "/api/chat/NOT_AN_ID", { headers: { ...sameOrigin, ...json }, body: chatTurn });
expect("chat: a bad agent id is a 400", r.status === 400 && noCors(r), `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ session: "../telegram", message: { id: "m", role: "user", parts: [] } }) });
expect("chat: a bad session id is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ session: "seccheck-session", message: { id: "m", role: "system", parts: [] } }) });
expect("chat: a system message is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", chatPath, { headers: { ...sameOrigin, ...json }, body: JSON.stringify({ session: "seccheck-session", message: { id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(1_100_000) }] } }) });
expect("chat: a body over 1 MB is a 413", r.status === 413, `status ${r.status}`);
r = await req("GET", `${chatPath}?session=..%2F..%2Fx`, { headers: sameOrigin });
expect("chat history: a bad session id is a 400", r.status === 400, `status ${r.status}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
