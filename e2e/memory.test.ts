import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const curated = JSON.stringify({ files: [{ name: "profile.md", content: "- Name: Sam\n- Works on Eigen" }], timeline: "Sam introduced themselves." });

describe("memory loop (built server)", () => {
  it("registers the nightly schedule with the configured cron", async () => {
    eigen = await startEigen([{ text: "hi" }]);
    const list = await eigen.api("/schedules");
    const all = Array.isArray(list) ? list : (list.schedules ?? list.data ?? []);
    const s = all.find((x: any) => /consolidate/.test(JSON.stringify(x)));
    expect(s, JSON.stringify(list).slice(0, 400)).toBeTruthy();
    expect(JSON.stringify(s)).toContain("30 3 * * *");
  });

  it("folds a chat into the memory files, and the next message sees them", async () => {
    eigen = await startEigen([{ text: "Nice to meet you, Sam" }, { text: curated }, { text: "You are Sam" }]);
    const seen = () => eigen!.tg.sent().some((t) => t.includes("Nice to meet you, Sam"));
    eigen.tg.say("I'm Sam and I work on Eigen");
    await waitFor(seen);

    const list = await eigen.api("/schedules");
    const all = Array.isArray(list) ? list : (list.schedules ?? list.data ?? []);
    const id = all.find((x: any) => /consolidate/.test(JSON.stringify(x))).id;
    await eigen.api(`/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });

    const profile = join(eigen.p.memoryDir, "profile.md");
    await waitFor(() => readFileSync(profile, "utf8").includes("Name: Sam"));
    expect(readFileSync(join(eigen.p.memoryDir, "timeline", `${new Date().toISOString().slice(0, 7)}.md`), "utf8")).toContain("Sam introduced themselves.");
    const gitLog = () => {
      try {
        return execFileSync("git", ["-C", eigen!.p.memoryDir, "log", "--format=%s"], { encoding: "utf8", stdio: "pipe" });
      } catch {
        return "";
      }
    };
    await waitFor(() => gitLog().includes("memory: through"));

    eigen.tg.say("who am i?");
    await waitFor(() => eigen!.tg.sent().some((t) => t.includes("You are Sam")));
    const lastChat = JSON.stringify(eigen.llm.requests.at(-1));
    expect(lastChat).toContain("Name: Sam");
  });
});
