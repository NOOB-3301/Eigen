import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type GhRequest = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined> };

/** A pull request as the REST API returns it (only what the engine reads, plus noise it must ignore). */
export type FakePull = { number: number; title: string; html_url: string; draft: boolean; body: string | null; updated_at: string; user: { login: string }; head: { sha: string; ref: string }; base: { ref: string }; labels: unknown[] };

export const pull = (number: number, o: Partial<{ title: string; draft: boolean; body: string | null; sha: string; updated: string; author: string; head: string; base: string }> = {}): FakePull => ({
  number,
  title: o.title ?? `Change ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  draft: o.draft ?? false,
  body: o.body === undefined ? `Body of ${number}` : o.body,
  updated_at: o.updated ?? new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
  user: { login: o.author ?? "octocat" },
  head: { sha: o.sha ?? `sha-${number}-a`, ref: o.head ?? `feature-${number}` },
  base: { ref: o.base ?? "main" },
  labels: [],
});

/**
 * A GitHub REST API for tests: serves /repos/:owner/:name/pulls (newest update first, per_page honoured, ETag and 304), GET /user, and can be told to
 * rate-limit, reject the token, answer an error or redirect. It records every request with its headers, so a test can say where the token went.
 */
export async function fakeGithub({ token }: { token?: string } = {}) {
  const requests: GhRequest[] = [];
  const repos = new Map<string, FakePull[]>();
  const failures = new Map<string, { status: number; body: unknown }>();
  const redirects = new Map<string, string>();
  let limit: { status: number; headers: Record<string, string> } | undefined;
  let login = "octocat";
  let echoToken = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join() : v]));
    requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers });
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      // A hostile or sloppy server may echo what it was sent; nothing the engine reports may carry it.
      return send(401, { message: echoToken ? `Bad credentials: ${req.headers.authorization}` : "Bad credentials" });
    }
    if (url.pathname === "/user") return send(200, { login });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (!m) return send(404, { message: "Not Found" });
    const repo = `${m[1]}/${m[2]}`;
    if (limit) return send(limit.status, { message: "API rate limit exceeded" }, limit.headers);
    const redirect = redirects.get(repo);
    if (redirect) return send(301, undefined, { location: redirect });
    const failure = failures.get(repo);
    if (failure) return send(failure.status, failure.body);
    const pulls = repos.get(repo);
    if (!pulls) return send(404, { message: "Not Found" });
    const page = [...pulls].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Number(url.searchParams.get("per_page") ?? 30));
    const body = JSON.stringify(page);
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag });
    res.writeHead(200, { "content-type": "application/json", etag });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    /** Requests for a repo's pull list. */
    pollsOf: (repo = "acme/app") => requests.filter((r) => r.path === `/repos/${repo}/pulls`),
    setPulls: (repo: string, pulls: FakePull[]) => void repos.set(repo, pulls),
    addPull: (repo: string, p: FakePull) => void repos.set(repo, [...(repos.get(repo) ?? []).filter((x) => x.number !== p.number), p]),
    /**
     * Every pull-list call answers `status` until cleared. `resetEpochSec` is the primary limit (x-ratelimit-remaining: 0 and a reset time);
     * `retryAfterSec` alone is a secondary limit, which GitHub signals with Retry-After and no remaining count.
     */
    rateLimit: (status: 403 | 429, { resetEpochSec, retryAfterSec }: { resetEpochSec?: number; retryAfterSec?: number }) => {
      limit = { status, headers: { ...(resetEpochSec && { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSec) }), ...(retryAfterSec !== undefined && { "retry-after": String(retryAfterSec) }) } };
    },
    clearRateLimit: () => (limit = undefined),
    failWith: (repo: string, status: number, body: unknown = { message: "nope" }) => void failures.set(repo, { status, body }),
    clearFailures: () => failures.clear(),
    redirect: (repo: string, to: string) => void redirects.set(repo, to),
    setLogin: (name: string) => (login = name),
    echoTokenInErrors: () => (echoToken = true),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
