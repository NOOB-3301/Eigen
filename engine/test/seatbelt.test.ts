import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { makeSandbox, sandboxReach, secretsHidden } from "../src/mastra/lib/sandbox.ts";
import { SandboxSchema } from "../src/mastra/lib/schema.ts";
import { seatbeltProfile, writeSeatbeltProfile } from "../src/mastra/lib/seatbelt.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

const BUILTIN = join(import.meta.dirname, "../defaults/skills");
const profileFor = (patch: Record<string, unknown> | ((t: ReturnType<typeof tmpAgent>) => Record<string, unknown>) = {}) => {
  const t = tmpAgent();
  const reach = sandboxReach(t.paths, SandboxSchema.parse(typeof patch === "function" ? patch(t) : patch), BUILTIN);
  return { ...t, reach, text: seatbeltProfile(reach) };
};
const lines = (text: string) => text.split("\n");
const at = (text: string, line: string) => lines(text).indexOf(line);
const real = (p: string) => realpathSync(p);
/** The last rule in the profile that matches this path for this operation decides: seatbelt applies the last matching rule. */
const lastRuleFor = (text: string, op: "file-read-data" | "file-write*", path: string) =>
  lines(text)
    .map((l) => /^\((allow|deny) (file-read-data|file-write\*) \(subpath "(.*)"\)\)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && (m[2] === op || (op === "file-read-data" && false)) && (path === m[3] || path.startsWith(`${m[3]}/`)))
    .at(-1)?.[1];

describe("seatbelt profile", () => {
  it("is plain SBPL with balanced parentheses, and is not mistaken for a Mastra-generated one", () => {
    const { text } = profileFor();
    const count = (c: string) => text.split(c).length - 1;
    expect(count("(")).toBe(count(")"));
    expect(text).toMatch(/^\(version 1\)\n\(deny default/);
    expect(text).not.toContain("mastra-generated-profile");
  });

  it("hides eigen's home: this agent's .env, config.json, memory.db and data/, and every other agent", () => {
    const { text, paths: p, other } = profileFor();
    for (const hidden of [p.envFile, p.configFile, p.memoryDbFile, p.stateFile, join(p.dir, "instructions.md"), other.envFile, other.sandboxDir, other.skillsDir])
      expect(lastRuleFor(text, "file-read-data", real(join(hidden, "..")) + "/" + hidden.split("/").at(-1)), hidden).toBe("deny");
  });

  it("re-opens only this agent's sandbox (read-write) and its skills and the built-in skills (read)", () => {
    const { text, paths: p } = profileFor();
    for (const open of [join(real(p.sandboxDir), "notes.md"), join(real(p.skillsDir), "pdf/SKILL.md"), join(real(BUILTIN), "clawhub/SKILL.md")])
      expect(lastRuleFor(text, "file-read-data", open), open).toBe("allow");
    expect(lastRuleFor(text, "file-write*", join(real(p.sandboxDir), "out.txt"))).toBe("allow");
    for (const ro of [join(real(p.skillsDir), "pdf/SKILL.md"), join(real(p.dir), "config.json"), join(real(p.dataDir), "state.json")])
      expect(lastRuleFor(text, "file-write*", ro), ro).not.toBe("allow");
  });

  it("never writes into eigen's home outside the sandbox, even though temp dirs (which can hold it) are writable", () => {
    const { text, paths: p, other } = profileFor();
    expect(lastRuleFor(text, "file-write*", join(real(other.dir), "config.json"))).toBe("deny");
    expect(lastRuleFor(text, "file-write*", real(p.envFile))).toBe("deny");
  });

  it("hides personal folders, and lets config open extra paths outside eigen's home", () => {
    const { text } = profileFor({ readOnlyPaths: ["/Users/sam/Documents/notes"], readWritePaths: ["/Users/sam/scratch"], denyReadPaths: ["~/Pictures", "/Users/sam/Documents"] });
    expect(lastRuleFor(text, "file-read-data", `${homedir()}/Pictures/a.png`)).toBe("deny");
    expect(lastRuleFor(text, "file-read-data", "/Users/sam/Documents/x")).toBe("deny");
    expect(lastRuleFor(text, "file-read-data", "/Users/sam/Documents/notes/x")).toBe("allow");
    expect(lastRuleFor(text, "file-write*", "/Users/sam/scratch/x")).toBe("allow");
  });

  it("a configured path that would expose eigen's home is not in the profile", () => {
    const { text, other } = profileFor((t) => ({ readOnlyPaths: [t.home], readWritePaths: [t.other.dir] }));
    expect(lastRuleFor(text, "file-read-data", real(other.envFile))).toBe("deny");
    expect(lastRuleFor(text, "file-write*", join(real(other.dir), "x"))).toBe("deny");
  });

  it("follows allowNetwork", () => {
    expect(profileFor({ allowNetwork: true }).text).toContain("(allow network*)");
    expect(profileFor({ allowNetwork: false }).text).toContain("(deny network*");
  });

  it("is written where it is asked to be, for Mastra to use as is", () => {
    const { paths: p, reach } = profileFor();
    const file = writeSeatbeltProfile(join(p.dataDir, "seatbelt.sb"), reach);
    expect(existsSync(file) && readFileSync(file, "utf8")).toContain("(deny default");
    expect(at(readFileSync(file, "utf8"), "(allow file-read*)")).toBeGreaterThan(0);
  });
});

const backend = LocalSandbox.detectIsolation();

describe("secretsHidden", () => {
  async function probe(isolation: "none" | "bwrap" | "seatbelt") {
    const { paths: p, r } = tmpAgent();
    writeFileSync(p.envFile, "TELEGRAM_BOT_TOKEN=secret-value");
    const sandbox = makeSandbox(p, r.sandbox, isolation);
    await sandbox.start();
    try {
      return await secretsHidden(sandbox, p);
    } finally {
      await sandbox.destroy?.();
    }
  }

  it("says the secrets are readable when nothing isolates the shell", async () => {
    expect(await probe("none")).toBe(false);
  });

  it.skipIf(!backend.available || backend.backend !== "bwrap")("says they are hidden under bwrap", async () => {
    expect(await probe("bwrap")).toBe(true);
  });
});
