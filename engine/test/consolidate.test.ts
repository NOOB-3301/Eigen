import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPrompt, consolidate, consolidateOnce, type Deps } from "../src/mastra/lib/consolidate.ts";
import type { Update } from "../src/mastra/lib/curate.ts";
import { transcripts, type Row } from "../src/mastra/lib/memory-delta.ts";
import { tmpHome } from "./helpers/home.ts";

const row = (iso: string, role: string, text: string): Row => ({ at: new Date(iso), role, text });
const ROWS = [row("2026-10-01T09:00:00Z", "user", "I'm Sam, I work on Eigen"), row("2026-10-01T09:01:00Z", "assistant", "Nice to meet you Sam")];
const good: Update = { files: [{ name: "profile.md", content: "- Name: Sam\n- Works on Eigen" }], timeline: "Introduced themselves." };

function deps(overrides: Partial<Deps> = {}) {
  const paths = tmpHome();
  const since: Date[] = [];
  const d: Deps = {
    paths,
    zone: "UTC",
    rows: async (s) => (since.push(s), ROWS.filter((r) => r.at > s)),
    curate: vi.fn(async () => good),
    ...overrides,
  };
  return { d, paths, since };
}

describe("transcripts", () => {
  it("formats rows in the owner's timezone and splits at the size cap", () => {
    const [one] = transcripts(ROWS, "Asia/Kolkata");
    expect(one!.text).toContain("[2026-10-01 14:30] user: I'm Sam");
    const many = transcripts([...ROWS, ...ROWS, ...ROWS], "UTC", 120);
    expect(many.length).toBeGreaterThan(1);
    expect(many.at(-1)!.until).toEqual(ROWS[1]!.at);
  });
});

describe("consolidate", () => {
  it("does nothing when there is nothing new", async () => {
    const { d } = deps({ rows: async () => [] });
    expect(await consolidate(d)).toEqual({ status: "nothing", chunks: 0 });
    expect(d.curate).not.toHaveBeenCalled();
  });

  it("applies the update, commits it, and only reads newer messages next time", async () => {
    const { d, paths, since } = deps();
    expect(await consolidate(d)).toEqual({ status: "updated", chunks: 1 });
    expect(readFileSync(join(paths.memoryDir, "profile.md"), "utf8")).toContain("Name: Sam");
    expect(readFileSync(join(paths.memoryDir, "timeline", "2026-10.md"), "utf8")).toContain("Introduced themselves.");

    expect(await consolidate(d)).toEqual({ status: "nothing", chunks: 0 });
    expect(since.at(-1)).toEqual(ROWS[1]!.at);
  });

  it("shows the curator the current files, the transcript, and its caps", async () => {
    const { d, paths } = deps();
    await consolidate(d);
    const prompt = vi.mocked(d.curate).mock.calls[0]![0];
    expect(prompt).toContain('<file name="profile.md" cap="4000">');
    expect(prompt).toContain("I'm Sam, I work on Eigen");
    expect(buildPrompt(paths, "x", ["too long"])).toContain("- too long");
  });

  it("retries once with the problems listed, then accepts the fix", async () => {
    const bad: Update = { files: [{ name: "profile.md", content: "TOKEN=abc12345" }] };
    const curate = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    const { d } = deps({ curate });
    expect((await consolidate(d)).status).toBe("updated");
    expect(curate.mock.calls[1]![0]).toContain("looks like a secret");
  });

  it("rejects after two bad answers and does not advance", async () => {
    const bad: Update = { files: [{ name: "profile.md", content: "TOKEN=abc12345" }] };
    const { d, paths, since } = deps({ curate: vi.fn(async () => bad) });
    expect((await consolidate(d)).status).toBe("rejected");
    expect(readFileSync(join(paths.memoryDir, "profile.md"), "utf8")).toBe("# Profile\n");
    await consolidate(d);
    expect(since.every((s) => s.getTime() === 0)).toBe(true);
  });

  it("joins an overlapping run instead of starting a second one", async () => {
    const { d } = deps({ curate: vi.fn(() => new Promise<Update>((r) => setTimeout(() => r(good), 50))) });
    const [a, b] = await Promise.all([consolidateOnce(d), consolidateOnce(d)]);
    expect(a).toBe(b);
    expect(d.curate).toHaveBeenCalledTimes(1);
  });
});
