#!/usr/bin/env node
/**
 * Proves the studio's API cannot be driven cross-site and keeps every agent to itself. Run against a live `next dev` / `next start`:
 *
 *   node scripts/security-check.mjs [http://127.0.0.1:4100]
 *
 * Uses node:http (not fetch) so it can forge Host, Origin and Sec-Fetch-Site the way a browser or a rebinding attack would.
 * Exits non-zero if any expectation fails.
 *
 * What it proves:
 *   - every mutating route refuses cross-site callers (foreign Origin, opaque Origin, Sec-Fetch-Site, foreign Host, non-JSON bodies, preflights);
 *   - secrets are write-only and per agent: no response ever contains a value, an agent's .env is never served, and one agent's secrets
 *     routes can neither read nor write another agent's .env;
 *   - agent ids and skill slugs are confined: no "..", no other agent's folder.
 *
 * Its writes are same-origin and tidy: it creates two throwaway agents (seccheck-a-*, seccheck-b-*; local model, no bot), sets keys and
 * skills on them only, and trashes them at the end (they stay in agents/.trash, because trash is never erased). Existing agents are only
 * read, except a same-origin save of one agent's own unchanged config. SECCHECK_NO_WRITE=1 skips every write and needs two existing agents.
 * EIGEN_HOME=<the server's home> also compares every file under it before and after the refused requests.
 */
import http from "node:http";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:4100");
const self = base.origin;
let failed = 0;

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // An explicit length: a chunked DELETE body is refused by Node's parser before the app sees it, which would hide what the app does.
    const length = body === undefined ? {} : { "content-length": Buffer.byteLength(body) };
    const r = http.request({ host: base.hostname, port: base.port, method, path, headers: { host: base.host, ...length, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c;
        // SSE never ends; one chunk is enough to know it was accepted.
        if (String(res.headers["content-type"]).includes("event-stream")) res.destroy();
      });
      res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function expect(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
}

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const noCors = (res) => !Object.keys(res.headers).some((h) => h.startsWith("access-control-"));
const sameOrigin = { origin: self, "sec-fetch-site": "same-origin" };
const json = { "content-type": "application/json" };
const same = { ...sameOrigin, ...json };
const evilHost = `evil.example:${base.port}`;
const noWrite = process.env.SECCHECK_NO_WRITE === "1";
const rand = Math.random().toString(36).slice(2, 10);
const RAND = rand.toUpperCase().replace(/[^A-Z0-9]/g, "X");
const SECRET_NAME = `EIGEN_SECCHECK_${RAND}`;
const SECRET_VALUE = `sk-seccheck-${rand}-${Math.random().toString(36).slice(2, 12)}`;
/** Every refused request must leave the bytes of everything it aimed at as they were. */
const REFUSED = [308, 400, 403, 404, 405, 415];

/* ------------------------------------------------------------------------------------------------ */
/* The two agents under test                                                                          */
/* ------------------------------------------------------------------------------------------------ */
const list = await req("GET", "/api/agents", { headers: sameOrigin });
expect("same-origin GET /api/agents", list.status === 200, `status ${list.status}`);
let A;
let B;
const made = [];
if (noWrite) {
  const ids = (parse(list.body).agents ?? []).map((a) => a.id);
  [A, B] = ids;
  if (!A || !B) {
    console.error("SECCHECK_NO_WRITE=1 needs two existing agents");
    process.exit(1);
  }
} else {
  for (const tag of ["a", "b"]) {
    const id = `seccheck-${tag}-${rand}`.slice(0, 32);
    const r = await req("POST", "/api/agents", {
      headers: same,
      body: JSON.stringify({ id, name: `Seccheck ${tag}`, model: { id: "ollama/seccheck", url: "http://127.0.0.1:9/v1" }, instructionsText: "Throwaway agent from scripts/security-check.mjs." }),
    });
    expect(`same-origin create of throwaway agent ${tag} is accepted`, r.status === 200 && parse(r.body).ok === true, `status ${r.status} ${r.body}`);
    made.push(id);
  }
  [A, B] = made;
}
const agentUrl = (id) => `/api/agents/${id}`;
const detailOf = async (id) => parse((await req("GET", agentUrl(id), { headers: sameOrigin })).body);
const before = await detailOf(A);
const evilConfig = JSON.stringify({ config: { ...before.config, tools: { mcp: { pwn: { command: "touch", args: ["/tmp/pwned"] } } } }, instructionsText: "pwned" });

// With EIGEN_HOME set (the home the server uses), every file under it is compared before and after the refused requests.
const home = process.env.EIGEN_HOME;
const fsSnapshot = async () => {
  if (!home) return "";
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  return readdirSync(home, { recursive: true })
    .map(String)
    // Runtime files the engine writes on its own while the check runs.
    .filter((f) => !/(^|\/)(logs|data|sandbox)\/|memory\.db|mastra\.db/.test(f))
    .sort()
    .map((f) => {
      const s = statSync(join(home, f), { throwIfNoEntry: false });
      return `${f}:${s?.isFile() ? `${s.size}:${s.mtimeMs}` : "d"}`;
    })
    .join("\n");
};
const fsBefore = await fsSnapshot();

/* ------------------------------------------------------------------------------------------------ */
/* 1. Cross-site: every mutating route                                                                */
/* ------------------------------------------------------------------------------------------------ */
const skillPath = (id, slug) => `${agentUrl(id)}/skills/${slug.split("/").map(encodeURIComponent).join("/")}`;
const mutating = [
  ["POST", "/api/agents", JSON.stringify({ id: "pwned", name: "pwned", model: { id: "a/b" } })],
  ["POST", `${agentUrl(A)}/config`, evilConfig],
  ["DELETE", agentUrl(A), undefined],
  ["PUT", `${agentUrl(A)}/secrets/${SECRET_NAME}`, JSON.stringify({ value: SECRET_VALUE })],
  ["DELETE", `${agentUrl(A)}/secrets/${SECRET_NAME}`, undefined],
  ["POST", `${agentUrl(A)}/telegram/check`, JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" })],
  ["POST", `${agentUrl(A)}/models/main/test`, "{}"],
  ["POST", `${agentUrl(A)}/github/check`, JSON.stringify({ tokenEnv: "GITHUB_TOKEN", repo: "acme/web" })],
  ["POST", `${agentUrl(A)}/skills`, JSON.stringify({ slug: "pwned", description: "pwned" })],
  ["PUT", skillPath(A, "pwned"), JSON.stringify({ text: "---\nname: pwned\ndescription: pwned\n---\n" })],
  ["DELETE", skillPath(A, "pwned"), undefined],
  ["POST", `${agentUrl(A)}/triggers/any/run`, "{}"],
  ["PUT", "/api/layout", "{}"],
];
for (const [method, path, body] of mutating) {
  const tag = `${method} ${path.replace(SECRET_NAME, ":name").replace(A, ":id")}`;
  let r = await req(method, path, { headers: { "content-type": "text/plain", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: cross-origin text/plain refused`, r.status === 403 || r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { "content-type": "text/plain" }, body });
  expect(`${tag}: text/plain without Origin refused`, r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" }, body: "x=1" });
  expect(`${tag}: form POST from an opaque origin refused`, r.status === 403 || r.status === 415, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, origin: "http://evil.example" }, body });
  expect(`${tag}: JSON with a foreign Origin refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, origin: "null" }, body });
  expect(`${tag}: JSON from an opaque origin refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "cross-site" }, body });
  expect(`${tag}: Sec-Fetch-Site cross-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, "sec-fetch-site": "same-site" }, body });
  expect(`${tag}: Sec-Fetch-Site same-site refused`, r.status === 403, `status ${r.status}`);
  r = await req(method, path, { headers: { ...json, host: evilHost }, body });
  expect(`${tag}: foreign Host refused`, r.status === 403, `status ${r.status}`);
  r = await req("OPTIONS", path, { headers: { origin: "http://evil.example", "access-control-request-method": method, "access-control-request-headers": "content-type" } });
  expect(`${tag}: OPTIONS preflight refused, no CORS headers`, r.status === 403 && noCors(r), `status ${r.status}`);
}

/* 2. DNS rebinding and foreign Origins on reads. */
const reads = ["/api/agents", agentUrl(A), `${agentUrl(A)}/secrets`, `${agentUrl(A)}/skills`, `${agentUrl(A)}/triggers/runs`, "/api/layout", "/api/agents/events", "/"];
for (const path of reads) {
  let r = await req("GET", path, { headers: { host: evilHost } });
  expect(`wrong Host on GET ${path.replace(A, ":id")} is refused`, r.status === 403, `status ${r.status}`);
  if (path === "/") continue;
  r = await req("GET", path, { headers: { origin: "http://evil.example" } });
  expect(`foreign Origin on GET ${path.replace(A, ":id")} is refused`, r.status === 403, `status ${r.status}`);
}
for (const path of ["/api/agents", agentUrl(A), `${agentUrl(A)}/secrets`, `${agentUrl(A)}/skills`, "/api/layout"]) {
  const r = await req("GET", path, { headers: sameOrigin });
  expect(`same-origin GET ${path.replace(A, ":id")} answers JSON, not cached, no CORS`, r.status === 200 && String(r.headers["content-type"]).includes("application/json") && r.headers["cache-control"] === "no-store" && noCors(r), `status ${r.status}`);
}

/* 3. Nothing refused above changed anything. */
const after = await detailOf(A);
expect("agent files unchanged by every refused request", before.etag === after.etag, `${before.etag} -> ${after.etag}`);
const statusOf = async (id, name) => parse((await req("GET", `${agentUrl(id)}/secrets?names=${name}`, { headers: sameOrigin })).body).secrets?.find((x) => x.name === name);
expect("a secret named by a refused request was never set", (await statusOf(A, SECRET_NAME))?.set === false);
expect("no agent named by a refused create exists", (await req("GET", agentUrl("pwned"), { headers: sameOrigin })).status === 404);
if (home) expect("no file under EIGEN_HOME changed", (await fsSnapshot()) === fsBefore);
else console.log("SKIP  EIGEN_HOME not set: file-system snapshot not compared");

/* ------------------------------------------------------------------------------------------------ */
/* 4. Agent id confinement                                                                            */
/* ------------------------------------------------------------------------------------------------ */
// A literal ".." segment is answered by Next itself (308 / 404) before any handler runs; everything else must reach our 400 / 404.
const badIds = ["..", "%2e%2e", "..%2F" + A, "%2E%2E%2F%2E%2E", ".trash", "_x", "UPPER", "a%00", "a%5Cb", `${A}%2F..%2F${B}`, "x".repeat(33)];
for (const bad of badIds) {
  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["DELETE", "", undefined],
    ["POST", "/config", JSON.stringify({ config: before.config })],
    ["GET", "/secrets", undefined],
    ["PUT", `/secrets/${SECRET_NAME}`, JSON.stringify({ value: SECRET_VALUE })],
    ["GET", "/skills", undefined],
  ]) {
    const r = await req(method, `/api/agents/${bad}${suffix}`, { headers: method === "GET" ? sameOrigin : same, body });
    expect(`agent id "${decodeURIComponent(bad).replace(/\0/g, "\\0").slice(0, 24)}" refused on ${method} ${suffix || "/"}`, REFUSED.includes(r.status) && !r.body.includes(SECRET_VALUE), `status ${r.status}`);
  }
}
expect("a secret written through a bad id never landed in an agent", (await statusOf(A, SECRET_NAME))?.set === false && (await statusOf(B, SECRET_NAME))?.set === false);

/* ------------------------------------------------------------------------------------------------ */
/* 5. Secrets: write-only, and per agent                                                              */
/* ------------------------------------------------------------------------------------------------ */
if (!noWrite) {
  for (const bad of ["lower", "..%2Fx", "A%3DB", "A%0AB", "a-b", "1ABC", "%2E%2E", "..%2F..%2F" + B + "%2F.env", "A".repeat(65)]) {
    let r = await req("PUT", `${agentUrl(A)}/secrets/${bad}`, { headers: same, body: JSON.stringify({ value: "v" }) });
    expect(`secret name "${decodeURIComponent(bad).replace(/\n/g, "\\n").slice(0, 24)}" is rejected`, REFUSED.includes(r.status), `status ${r.status}`);
    r = await req("DELETE", `${agentUrl(A)}/secrets/${bad}`, { headers: same });
    expect(`secret name "${decodeURIComponent(bad).replace(/\n/g, "\\n").slice(0, 24)}" cannot be deleted either`, REFUSED.includes(r.status), `status ${r.status}`);
  }
  let r = await req("PUT", `${agentUrl(A)}/secrets/${SECRET_NAME}`, { headers: same, body: JSON.stringify({ value: "two\nlines" }) });
  expect("a multi-line secret value is rejected without echoing it", r.status === 400 && !r.body.includes("two"), `status ${r.status}`);
  r = await req("PUT", `${agentUrl(A)}/secrets/${SECRET_NAME}`, { headers: same, body: JSON.stringify({ value: 42 }) });
  expect("a non-string secret value is rejected", r.status === 400, `status ${r.status}`);
  r = await req("PUT", `${agentUrl("ghost-" + rand)}/secrets/${SECRET_NAME}`, { headers: same, body: JSON.stringify({ value: SECRET_VALUE }) });
  expect("a secret for an agent that does not exist is a 404", r.status === 404, `status ${r.status}`);
  expect("... and created no agent", (await req("GET", agentUrl("ghost-" + rand), { headers: sameOrigin })).status === 404);

  // The write-only guarantee: set a secret on A, then no route may ever answer with it.
  r = await req("PUT", `${agentUrl(A)}/secrets/${SECRET_NAME}`, { headers: same, body: JSON.stringify({ value: SECRET_VALUE }) });
  expect("same-origin PUT of a secret on agent A is accepted", r.status === 200 && parse(r.body).ok === true, `status ${r.status}`);
  expect("the PUT answer does not contain the value", !r.body.includes(SECRET_VALUE));
  expect("A's secret now reads as set", (await statusOf(A, SECRET_NAME))?.set === true);
  expect("B does not see A's secret as set", (await statusOf(B, SECRET_NAME))?.set === false);
  const listedB = parse((await req("GET", `${agentUrl(B)}/secrets`, { headers: sameOrigin })).body).secrets ?? [];
  expect("B's secret list does not even name A's variable", !listedB.some((s) => s.name === SECRET_NAME));

  // B's routes cannot remove or overwrite A's value.
  r = await req("DELETE", `${agentUrl(B)}/secrets/${SECRET_NAME}`, { headers: same });
  expect("deleting the name through B removes nothing (B never had it)", r.status === 200 && parse(r.body).removed === false, `status ${r.status}`);
  expect("A's secret is still set after B's delete", (await statusOf(A, SECRET_NAME))?.set === true);

  // .env is never served, under any spelling.
  const envProbes = [
    `${agentUrl(A)}/.env`,
    `${agentUrl(A)}/secrets/.env`,
    `${agentUrl(A)}/secrets/..%2F.env`,
    `${agentUrl(A)}/skills/..%2F.env`,
    `${agentUrl(A)}/skills/..%2F..%2F.env`,
    `${agentUrl(B)}/skills/..%2F..%2F${A}%2F.env`,
    `/api/agents/..%2F${A}%2F.env`,
    `/api/agents/${A}%2F.env`,
  ];
  for (const path of envProbes) {
    const res = await req("GET", path, { headers: sameOrigin });
    expect(`GET ${path.replaceAll(A, ":a").replaceAll(B, ":b")} never serves .env`, !res.body.includes(SECRET_VALUE) && res.status !== 200, `status ${res.status}`);
  }

  const probes = [
    ["GET", "/api/agents"],
    ["GET", agentUrl(A)],
    ["GET", agentUrl(B)],
    ["GET", `${agentUrl(A)}/secrets`],
    ["GET", `${agentUrl(A)}/secrets?names=${SECRET_NAME}`],
    ["GET", `${agentUrl(B)}/secrets?names=${SECRET_NAME}`],
    ["GET", `${agentUrl(A)}/skills`],
    ["GET", `${agentUrl(A)}/triggers/runs`],
    ["GET", "/api/layout"],
    ["GET", "/api/agents/events"],
    ["POST", `${agentUrl(A)}/telegram/check`, JSON.stringify({ tokenEnv: SECRET_NAME })],
    ["POST", `${agentUrl(B)}/telegram/check`, JSON.stringify({ tokenEnv: SECRET_NAME })],
    ["POST", `${agentUrl(A)}/github/check`, JSON.stringify({ tokenEnv: SECRET_NAME, repo: "acme/web" })],
    ["POST", `${agentUrl(A)}/models/main/test`, "{}"],
    ["POST", `${agentUrl(A)}/triggers/any/run`, "{}"],
  ];
  for (const [m, path, body] of probes) {
    const res = await req(m, path, { headers: m === "GET" ? sameOrigin : same, body });
    expect(`${m} ${path.split("?")[0].replaceAll(A, ":a").replaceAll(B, ":b")} never contains a secret value`, !res.body.includes(SECRET_VALUE), `status ${res.status}`);
  }
  r = await req("DELETE", `${agentUrl(A)}/secrets/${SECRET_NAME}`, { headers: same });
  expect("same-origin DELETE of A's secret is accepted", r.status === 200 && parse(r.body).removed === true, `status ${r.status}`);
  expect("A's secret now reads as not set", (await statusOf(A, SECRET_NAME))?.set === false);
}

/* ------------------------------------------------------------------------------------------------ */
/* 6. Skill slugs: confined to the agent's own skills/                                                */
/* ------------------------------------------------------------------------------------------------ */
const secretSkill = `seccheck-${rand}`;
if (!noWrite) {
  const r = await req("POST", `${agentUrl(B)}/skills`, { headers: same, body: JSON.stringify({ slug: secretSkill, description: "B's own skill, from scripts/security-check.mjs." }) });
  expect("same-origin skill create on B is accepted", r.status === 200 && parse(r.body).ok === true, `status ${r.status} ${r.body}`);
}
const traversals = [
  "..%2F..%2Fconfig.json",
  "%2e%2e",
  "%2e%2e/%2e%2e/config.json",
  "@..%2Fx",
  "@%2e%2e/x",
  "%40..%2F..%2F.env",
  "pdf%2F..%2F..%2F.env",
  "%252e%252e%252f.env",
  "%2Fetc%2Fpasswd",
  ".trash",
  "%2Etrash/x",
  "x%00",
  "a%5C..%5Cb",
  "PDF",
  "@owner/../../.env",
  `..%2F..%2F${B}%2Fskills%2F${secretSkill}`,
  `..%2F..%2F${B}%2F.env`,
];
for (const t of traversals) {
  for (const [method, body] of [["GET"], ["PUT", JSON.stringify({ text: "---\nname: x\ndescription: pwned\n---\n" })], ["DELETE"]]) {
    const r = await req(method, `${agentUrl(A)}/skills/${t}`, { headers: method === "GET" ? sameOrigin : same, body });
    expect(`skill slug "${decodeURIComponent(t).replace(/\0/g, "\\0").replaceAll(B, ":b").slice(0, 40)}" refused on ${method}`, REFUSED.includes(r.status) && !r.body.includes('"text"'), `status ${r.status}`);
  }
}
let r = await req("GET", skillPath(A, secretSkill), { headers: sameOrigin });
expect("A cannot read B's skill by its slug", r.status === 404 && !r.body.includes('"text"'), `status ${r.status}`);
// Dot segments, even percent-encoded ones, are resolved by Next before routing: ".../A/skills/%2e%2e/%2e%2e/B/skills/x" IS the URL of B's
// skill, answered by B's own route (with B's id), exactly as if it had been asked for directly. No handler ever sees a "..".
if (!noWrite) {
  const direct = await req("GET", skillPath(B, secretSkill), { headers: sameOrigin });
  r = await req("GET", `${agentUrl(A)}/skills/%2e%2e/%2e%2e/${B}/skills/${secretSkill}`, { headers: sameOrigin });
  expect("an encoded dot-segment path is routed as the URL it resolves to (B's own route)", r.status === direct.status && r.body === direct.body, `status ${r.status} vs ${direct.status}`);
}
r = await req("POST", `${agentUrl(A)}/skills`, { headers: same, body: JSON.stringify({ slug: "../pwned", description: "d" }) });
expect("creating a skill with a traversal slug is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", `${agentUrl(A)}/skills`, { headers: same, body: JSON.stringify({ slug: "@owner/pwned", description: "d" }) });
expect("creating a skill under @owner/ is a 400", r.status === 400, `status ${r.status}`);

/* ------------------------------------------------------------------------------------------------ */
/* 7. Probes and triggers: validated input, JSON answers with the engine up or down                   */
/* ------------------------------------------------------------------------------------------------ */
r = await req("POST", `${agentUrl(A)}/telegram/check`, { headers: same, body: JSON.stringify({ tokenEnv: "lower-case" }) });
expect("telegram check rejects a bad variable name", r.status === 400, `status ${r.status}`);
r = await req("POST", `${agentUrl(A)}/telegram/check`, { headers: same, body: JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" }) });
expect("telegram check answers with JSON { ok } (engine up or offline)", [200, 501, 502, 503, 504].includes(r.status) && typeof parse(r.body).ok === "boolean", `status ${r.status}`);
r = await req("POST", `${agentUrl("ghost-" + rand)}/telegram/check`, { headers: same, body: JSON.stringify({ tokenEnv: "TELEGRAM_BOT_TOKEN" }) });
expect("telegram check for an unknown agent is a 404", r.status === 404, `status ${r.status}`);
r = await req("POST", `${agentUrl(A)}/models/no-such-model-key/test`, { headers: same, body: "{}" });
expect("model test for a model the agent does not have is a 404", r.status === 404, `status ${r.status}`);
r = await req("POST", `${agentUrl(A)}/models/..%2Fx/test`, { headers: same, body: "{}" });
expect("model test with a bad key is refused", REFUSED.includes(r.status), `status ${r.status}`);
for (const bad of [{ tokenEnv: "lower", repo: "acme/web" }, { tokenEnv: "GITHUB_TOKEN", repo: "../x" }, { tokenEnv: "GITHUB_TOKEN", repo: "acme" }]) {
  r = await req("POST", `${agentUrl(A)}/github/check`, { headers: same, body: JSON.stringify(bad) });
  expect(`github check rejects ${JSON.stringify(bad)}`, r.status === 400, `status ${r.status}`);
}
r = await req("POST", `${agentUrl(A)}/github/check`, { headers: same, body: JSON.stringify({ tokenEnv: "GITHUB_TOKEN", repo: "acme/web" }) });
expect("github check answers with JSON { ok } (engine up or offline)", [200, 501, 502, 503, 504].includes(r.status) && typeof parse(r.body).ok === "boolean", `status ${r.status}`);
r = await req("GET", "/api/agents/NOT_AN_ID/triggers/runs", { headers: sameOrigin });
expect("trigger runs for a bad agent id is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", `${agentUrl(A)}/triggers/..%2Fx/run`, { headers: same, body: "{}" });
expect("running a trigger with a bad trigger id is a 400", r.status === 400, `status ${r.status}`);

/* ------------------------------------------------------------------------------------------------ */
/* 8. The studio itself still works                                                                   */
/* ------------------------------------------------------------------------------------------------ */
if (!noWrite) {
  r = await req("POST", `${agentUrl(A)}/config`, { headers: same, body: JSON.stringify({ config: before.config, etag: before.etag }) });
  expect("same-origin JSON save of the unchanged config is accepted", r.status === 200 && parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  r = await req("POST", `${agentUrl(A)}/config`, { headers: same, body: JSON.stringify({ config: before.config, etag: "0000000000000000" }) });
  expect("a config save with a stale etag is a 409", r.status === 409 && typeof parse(r.body).etag === "string", `status ${r.status}`);
  r = await req("POST", `${agentUrl(A)}/config`, { headers: same, body: JSON.stringify({ config: { ...before.config, id: B } }) });
  expect("a config whose id is another agent's is a 400", r.status === 400, `status ${r.status}`);
  r = await req("POST", "/api/agents", { headers: same, body: JSON.stringify({ id: A, name: "dup", model: { id: "a/b" } }) });
  expect("creating an agent whose id exists is a 409", r.status === 409, `status ${r.status}`);
  r = await req("POST", "/api/agents", { headers: same, body: JSON.stringify({ id: "../evil", name: "x", model: { id: "a/b" } }) });
  expect("creating an agent with a traversal id is a 400", r.status === 400, `status ${r.status}`);

  const s = parse((await req("GET", skillPath(B, secretSkill), { headers: sameOrigin })).body);
  r = await req("PUT", skillPath(B, secretSkill), { headers: same, body: JSON.stringify({ text: s.text.replace("B's own", "B's edited"), etag: s.etag }) });
  expect("same-origin skill save is accepted", r.status === 200 && parse(r.body).ok === true, `status ${r.status} ${r.body}`);
  r = await req("PUT", skillPath(B, secretSkill), { headers: same, body: JSON.stringify({ text: s.text, etag: s.etag }) });
  expect("skill save with a stale etag is a 409", r.status === 409, `status ${r.status}`);
  r = await req("DELETE", skillPath(B, secretSkill), { headers: same });
  expect("same-origin skill trash is accepted and names no path", r.status === 200 && !r.body.includes(".trash"), `status ${r.status} ${r.body}`);
}
r = await req("GET", "/api/agents/events", { headers: sameOrigin });
expect("same-origin SSE is accepted", r.status === 200 && noCors(r), `status ${r.status}`);

/* ------------------------------------------------------------------------------------------------ */
/* 9. Chat: POST /api/chat/[agentId] streams an agent's reply; GET ?session= returns its history      */
/* ------------------------------------------------------------------------------------------------ */
// Nothing here reaches a model: every request is refused by the guard or rejected by the proxy's own validation first.
const chatPath = `/api/chat/${A}`;
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
r = await req("POST", chatPath, { headers: { ...json, host: evilHost }, body: chatTurn });
expect("chat: foreign Host refused", r.status === 403, `status ${r.status}`);
r = await req("OPTIONS", chatPath, { headers: { origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
expect("chat: OPTIONS preflight refused, no CORS headers", r.status === 403 && noCors(r), `status ${r.status}`);
r = await req("GET", `${chatPath}?session=seccheck-session`, { headers: { host: evilHost } });
expect("chat history: wrong Host refused", r.status === 403, `status ${r.status}`);
r = await req("GET", `${chatPath}?session=seccheck-session`, { headers: { origin: "http://evil.example" } });
expect("chat history: foreign Origin refused", r.status === 403, `status ${r.status}`);
r = await req("POST", "/api/chat/NOT_AN_ID", { headers: same, body: chatTurn });
expect("chat: a bad agent id is a 400", r.status === 400 && noCors(r), `status ${r.status}`);
r = await req("POST", chatPath, { headers: same, body: JSON.stringify({ session: "../telegram", message: { id: "m", role: "user", parts: [] } }) });
expect("chat: a bad session id is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", chatPath, { headers: same, body: JSON.stringify({ session: "seccheck-session", message: { id: "m", role: "system", parts: [] } }) });
expect("chat: a system message is a 400", r.status === 400, `status ${r.status}`);
r = await req("POST", chatPath, { headers: same, body: JSON.stringify({ session: "seccheck-session", message: { id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(1_100_000) }] } }) });
expect("chat: a body over 1 MB is a 413", r.status === 413, `status ${r.status}`);
r = await req("GET", `${chatPath}?session=..%2F..%2Fx`, { headers: sameOrigin });
expect("chat history: a bad session id is a 400", r.status === 400, `status ${r.status}`);

/* Tidy up: the throwaway agents go to the trash (kept there; trash is never erased). */
for (const id of made) {
  r = await req("DELETE", agentUrl(id), { headers: same });
  expect(`throwaway agent ${id} trashed`, r.status === 200 && parse(r.body).ok === true && !r.body.includes(".trash"), `status ${r.status}`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
