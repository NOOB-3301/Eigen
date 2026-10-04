/**
 * The little GitHub REST client the pull-request trigger and the token check share.
 *
 * The token goes to exactly one place: `base` (api.github.com, or GITHUB_API_BASE_URL in tests), as a Bearer header. Redirects are never
 * followed (a hop to another host would otherwise be one request away from receiving it), and every message that leaves this module has the
 * token scrubbed out of it.
 */
import { truncate } from "lodash-es";
import { z } from "zod";
import { GITHUB_REPO, type GithubCheckResponse } from "./schema.ts";
import { scrub } from "./probes.ts";

const DEFAULT_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 3_600_000;

/** Where API calls go. GITHUB_API_BASE_URL is the test hook (like TELEGRAM_API_BASE_URL); an operator-set value is trusted, nothing from a config file is. */
export const githubBase = (env: NodeJS.ProcessEnv = process.env) => (env.GITHUB_API_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");

const Pull = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().default(false),
  body: z.string().nullish(),
  updated_at: z.string().optional(),
  user: z.object({ login: z.string() }).nullish(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** Only the fields a trigger uses: the rest of GitHub's (large) payload is dropped at the door. */
export type GithubPull = { number: number; title: string; url: string; draft: boolean; body: string; author: string; base: string; head: string; sha: string; updatedAt: string };

const toPull = (p: z.infer<typeof Pull>): GithubPull => ({
  number: p.number,
  title: p.title,
  url: p.html_url,
  draft: p.draft,
  body: p.body ?? "",
  author: p.user?.login ?? "unknown",
  base: p.base.ref,
  head: p.head.ref,
  sha: p.head.sha,
  updatedAt: p.updated_at ?? "",
});

export type PullsResult =
  | { kind: "ok"; pulls: GithubPull[]; etag?: string; dropped: number }
  | { kind: "not-modified" }
  /** `resetAt` is epoch ms: when GitHub says the limit lifts (capped at an hour from now). */
  | { kind: "rate-limited"; resetAt: number }
  | { kind: "error"; message: string };

export type ListPullsOptions = {
  base: string;
  repo: string;
  token: string;
  /** The default query is the one the poller uses; the check asks for a bigger page. */
  query?: string;
  etag?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
};

const headersFor = (token: string, etag?: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "eigen-engine",
  ...(etag && { "If-None-Match": etag }),
});

/** Every request is built here, so this is where the repo is validated again: a config can reach the poller before (or without) passing the schema, and "." or ".." as an owner or name would climb out of /repos/. */
const repoParts = (repo: string) => (GITHUB_REPO.test(repo) ? (repo.split("/") as [string, string]) : undefined);

/** Seconds-to-wait or reset-time headers into an epoch ms, at most an hour ahead. */
function resetAt(res: Response, now: number) {
  const wait = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const at = res.headers.has("retry-after") && Number.isFinite(wait) ? now + wait * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000;
  return Math.min(Math.max(at, now), now + MAX_BACKOFF_MS);
}

/** GitHub's own explanation ("Bad credentials", "Resource not accessible by personal access token"), when the body has one. */
async function reason(res: Response, token: string) {
  const body = (await res.json().catch(() => undefined)) as { message?: unknown } | undefined;
  return typeof body?.message === "string" ? `: ${scrub(body.message, [token]).slice(0, 120)}` : "";
}

/** One page of open pull requests (newest update first), or a plain-language reason it did not work. Never throws, never returns the token. */
export async function listPulls({ base, repo, token, query = "state=open&sort=updated&direction=desc&per_page=30", etag, fetchFn = fetch, signal, now = Date.now }: ListPullsOptions): Promise<PullsResult> {
  const parts = repoParts(repo);
  if (!parts) return { kind: "error", message: `"${repo}" is not an owner/name repository` };
  const url = `${base}/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/pulls?${query}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: headersFor(token, etag), redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]) });
  } catch (e) {
    return { kind: "error", message: `could not reach GitHub: ${scrub(e, [token])}` };
  }
  try {
    if (res.status === 304) return { kind: "not-modified" };
    if (res.status === 200) {
      const body = await res.json().catch(() => undefined);
      if (!Array.isArray(body)) return { kind: "error", message: "GitHub sent a response that is not a list of pull requests" };
      const parsed = body.map((p) => Pull.safeParse(p));
      const pulls = parsed.flatMap((p) => (p.success ? [toPull(p.data)] : []));
      return { kind: "ok", pulls, etag: res.headers.get("etag") ?? undefined, dropped: parsed.length - pulls.length };
    }
    if (res.status >= 300 && res.status < 400) return { kind: "error", message: `GitHub redirected the request (HTTP ${res.status}); the repository may have been renamed or moved, so update "repo" in the trigger` };
    // A limit is a 403 or 429 that says so; any other 403 is a permissions problem and retrying will not fix it.
    if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
      await res.body?.cancel();
      return { kind: "rate-limited", resetAt: resetAt(res, now()) };
    }
    if (res.status === 401) return { kind: "error", message: `GitHub rejected the token (HTTP 401)${await reason(res, token)}` };
    if (res.status === 403) return { kind: "error", message: `the token is not allowed to read pull requests of ${repo} (HTTP 403)${await reason(res, token)}` };
    if (res.status === 404) return { kind: "error", message: `${repo} was not found, or the token cannot see it (HTTP 404)` };
    return { kind: "error", message: `GitHub answered HTTP ${res.status}${await reason(res, token)}` };
  } catch (e) {
    return { kind: "error", message: `could not read GitHub's answer: ${scrub(e, [token])}` };
  }
}

/** Whose token it is, for the studio's "connected as ..." line. Best effort: a token that can read pulls but not /user (an app installation) just has no login. */
async function loginOf(base: string, token: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(`${base}/user`, { headers: headersFor(token), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = res.ok ? ((await res.json().catch(() => undefined)) as { login?: unknown } | undefined) : undefined;
    return typeof body?.login === "string" ? truncate(body.login, { length: 100 }) : undefined;
  } catch {
    return undefined;
  }
}

/** Can this token read the pull requests of this repo? `openPulls` counts the first page (up to 100). */
export async function checkGithubToken(token: string | undefined, repo: string, base = githubBase(), fetchFn: typeof fetch = fetch): Promise<GithubCheckResponse> {
  if (!token) return { ok: false, error: "that variable is not set in .env" };
  const r = await listPulls({ base, repo, token, query: "state=open&per_page=100", fetchFn });
  if (r.kind === "error") return { ok: false, error: r.message };
  if (r.kind === "rate-limited") return { ok: false, error: "GitHub's rate limit is used up for this token; try again in a few minutes" };
  if (r.kind === "not-modified") return { ok: false, error: "GitHub answered 304 to a request that was not conditional" };
  const login = await loginOf(base, token, fetchFn);
  return { ok: true, ...(login && { login }), openPulls: r.pulls.length };
}
