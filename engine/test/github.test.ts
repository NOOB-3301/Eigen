import { afterEach, describe, expect, it } from "vitest";
import { checkGithubToken, githubBase, listPulls } from "../src/mastra/lib/github.ts";
import { githubEnvAllowed } from "../src/mastra/lib/probes.ts";
import { fakeGithub, pull } from "./helpers/fake-github.ts";

const TOKEN = "gho_Tok3nThatMustNeverLeak0123456789";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});
async function github(opts: Parameters<typeof fakeGithub>[0] = {}) {
  const gh = await fakeGithub(opts);
  closers.push(gh.close);
  return gh;
}

describe("githubBase", () => {
  it("is api.github.com unless GITHUB_API_BASE_URL says otherwise, without a trailing slash", () => {
    expect(githubBase({})).toBe("https://api.github.com");
    expect(githubBase({ GITHUB_API_BASE_URL: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });
});

describe("listPulls", () => {
  it("asks for the open pulls, newest update first, with the token only as a Bearer header", async () => {
    const gh = await github();
    gh.setPulls("acme/app", [pull(1), pull(2, { draft: true })]);
    const r = await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN });
    expect(r).toMatchObject({ kind: "ok", pulls: [{ number: 2, draft: true, sha: "sha-2-a", head: "feature-2", base: "main", author: "octocat" }, { number: 1 }] });
    const [req] = gh.requests;
    expect(req!.path).toBe("/repos/acme/app/pulls");
    expect(Object.fromEntries(req!.query)).toEqual({ state: "open", sort: "updated", direction: "desc", per_page: "30" });
    expect(req!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": expect.stringContaining("eigen") });
    expect(req!.path + req!.query.toString()).not.toContain(TOKEN);
  });

  it("sends If-None-Match and understands a 304", async () => {
    const gh = await github();
    gh.setPulls("acme/app", [pull(1)]);
    const first = await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN });
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(first.etag).toBeTruthy();
    expect(await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN, etag: first.etag })).toEqual({ kind: "not-modified" });
    expect(gh.requests[1]!.headers["if-none-match"]).toBe(first.etag);
  });

  it("tells 401, 403 and 404 apart in plain words, with GitHub's own explanation, and never the token", async () => {
    const gh = await github({ token: "the-real-token-value" });
    gh.setPulls("acme/app", [pull(1)]);
    gh.echoTokenInErrors();
    const bad = await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN });
    expect(bad).toMatchObject({ kind: "error", message: expect.stringContaining("HTTP 401") });
    expect(JSON.stringify(bad)).not.toContain(TOKEN);

    const ok = await github();
    ok.failWith("acme/app", 403, { message: "Resource not accessible by personal access token" });
    ok.failWith("acme/gone", 404, { message: "Not Found" });
    expect(await listPulls({ base: ok.url, repo: "acme/app", token: TOKEN })).toEqual({ kind: "error", message: "the token is not allowed to read pull requests of acme/app (HTTP 403): Resource not accessible by personal access token" });
    expect(await listPulls({ base: ok.url, repo: "acme/gone", token: TOKEN })).toMatchObject({ kind: "error", message: expect.stringContaining("HTTP 404") });
    expect(await listPulls({ base: ok.url, repo: "acme/never-heard-of-it", token: TOKEN })).toMatchObject({ kind: "error", message: expect.stringContaining("not found") });
  });

  it("scrubs the token out of a message even when the server echoes it back", async () => {
    const gh = await github({ token: "something-else" });
    gh.echoTokenInErrors();
    // The server echoes the Authorization header it received, which is `Bearer <TOKEN>`: the redaction rules and the exact-value scrub both apply.
    const r = await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN });
    expect(r.kind).toBe("error");
    expect(JSON.stringify(r)).not.toContain("Tok3nThatMustNeverLeak");
  });

  it("reads a rate limit from x-ratelimit-reset, or from retry-after, and caps it at an hour", async () => {
    const gh = await github();
    gh.setPulls("acme/app", [pull(1)]);
    const now = 1_800_000_000_000;
    gh.rateLimit(403, { resetEpochSec: now / 1000 + 600 });
    expect(await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN, now: () => now })).toEqual({ kind: "rate-limited", resetAt: now + 600_000 });
    gh.rateLimit(429, { retryAfterSec: 90 });
    expect(await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN, now: () => now })).toEqual({ kind: "rate-limited", resetAt: now + 90_000 });
    gh.rateLimit(403, { resetEpochSec: now / 1000 + 86_400 });
    expect(await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN, now: () => now })).toEqual({ kind: "rate-limited", resetAt: now + 3_600_000 });
  });

  it("does not follow a redirect, so the token cannot be carried to another host", async () => {
    const gh = await github();
    const elsewhere = await github();
    gh.redirect("acme/app", `${elsewhere.url}/steal`);
    const r = await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN });
    expect(r).toMatchObject({ kind: "error", message: expect.stringContaining("redirected") });
    expect(elsewhere.requests).toEqual([]);
  });

  it("reports an unreachable GitHub without the token", async () => {
    const r = await listPulls({ base: "http://127.0.0.1:1", repo: "acme/app", token: TOKEN });
    expect(r).toMatchObject({ kind: "error", message: expect.stringContaining("could not reach GitHub") });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("ignores entries it does not understand and says how many", async () => {
    const gh = await github();
    gh.setPulls("acme/app", [pull(1), { number: "two" } as never]);
    expect(await listPulls({ base: gh.url, repo: "acme/app", token: TOKEN })).toMatchObject({ kind: "ok", pulls: [{ number: 1 }], dropped: 1 });
  });

  it('never makes a request for a repo that could leave /repos/: "../x", "acme/..", ".", "a/b/c", encoded dots', async () => {
    const gh = await github();
    for (const repo of ["../x", "acme/..", "./x", "acme/.", "a/b/c", "..%2F/x", "acme/app/../../user", "", "acme"]) {
      const r = await listPulls({ base: gh.url, repo, token: TOKEN });
      expect(r, repo).toMatchObject({ kind: "error", message: expect.stringContaining("not an owner/name repository") });
    }
    expect(await checkGithubToken(TOKEN, "../x", gh.url)).toMatchObject({ ok: false });
    expect(gh.requests).toEqual([]);
  });
});

describe("checkGithubToken", () => {
  it("returns who the token is and how many pulls are open", async () => {
    const gh = await github({ token: TOKEN });
    gh.setPulls("acme/app", [pull(1), pull(2), pull(3)]);
    gh.setLogin("hubot");
    expect(await checkGithubToken(TOKEN, "acme/app", gh.url)).toEqual({ ok: true, login: "hubot", openPulls: 3 });
    expect(Object.fromEntries(gh.pollsOf()[0]!.query)).toMatchObject({ state: "open", per_page: "100" });
  });

  it("is still ok when the token cannot read /user (an app installation)", async () => {
    const gh = await github();
    gh.setPulls("acme/app", [pull(1)]);
    const r = await checkGithubToken(TOKEN, "acme/app", gh.url, (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/user")) return new Response("{}", { status: 403 });
      return fetch(input, init);
    }) as typeof fetch);
    expect(r).toEqual({ ok: true, openPulls: 1 });
  });

  it("explains an unset variable, a rejected token and an unknown repo, without the token", async () => {
    const gh = await github({ token: "the-right-one" });
    gh.setPulls("acme/app", [pull(1)]);
    expect(await checkGithubToken(undefined, "acme/app", gh.url)).toEqual({ ok: false, error: "that variable is not set in .env" });
    const bad = await checkGithubToken(TOKEN, "acme/app", gh.url);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 401") });
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    expect(await checkGithubToken("the-right-one", "acme/missing", gh.url)).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 404") });
  });

  it("reports a used-up rate limit", async () => {
    const gh = await github();
    gh.rateLimit(403, { retryAfterSec: 30 });
    expect(await checkGithubToken(TOKEN, "acme/app", gh.url)).toMatchObject({ ok: false, error: expect.stringContaining("rate limit") });
  });
});

describe("githubEnvAllowed", () => {
  it("only GITHUB_* names or names some github-pr trigger uses as its token", () => {
    expect(githubEnvAllowed("GITHUB_TOKEN", [])).toBe(true);
    expect(githubEnvAllowed("GITHUB_TOKEN_WORK", [])).toBe(true);
    expect(githubEnvAllowed("REVIEW_PAT", ["REVIEW_PAT"])).toBe(true);
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "PATH", "REVIEW_PAT"]) expect(githubEnvAllowed(n, ["GH_OTHER"]), n).toBe(false);
  });
});
