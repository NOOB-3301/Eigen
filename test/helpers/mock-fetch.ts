import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/models/provider.ts";

export type Recorded = { url: string; headers: Record<string, string>; body: any };
export type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

export function fixture(name: string): any {
  return JSON.parse(readFileSync(join(import.meta.dirname, "../models/fixtures", name), "utf8"));
}

// Replies are consumed in order (the last one repeats); every request is recorded.
export function mockFetch(replies: Reply[] | ((url: string, body: any) => Reply)) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn: FetchFn = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const r = typeof replies === "function" ? replies(url, body) : replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { fn, calls };
}
