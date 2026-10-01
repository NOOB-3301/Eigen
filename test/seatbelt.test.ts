import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LocalSandbox } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { makeSandbox, secretsHidden } from "../src/mastra/lib/sandbox.ts";
import { seatbeltProfile, writeSeatbeltProfile } from "../src/mastra/lib/seatbelt.ts";
import { tmpHome } from "./helpers/home.ts";

const USER = "/Users/sam";
const profileFor = (patch: Record<string, unknown> = {}) => {
  const p = tmpHome({ sandbox: patch });
  return { p, text: seatbeltProfile(p, loadConfig(p.configFile), USER) };
};
const at = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle));

describe("seatbelt profile", () => {
  it("is plain SBPL with balanced parentheses, and is not mistaken for a Mastra-generated one", () => {
    const { text } = profileFor();
    const count = (c: string) => text.split(c).length - 1;
    expect(count("(")).toBe(count(")"));
    expect(text).toMatch(/^\(version 1\)\n\(deny default/);
    expect(text).not.toContain("mastra-generated-profile");
  });

  it("hides your home, keys and personal folders, and reopens only the sandbox and your skills", () => {
    const { p, text } = profileFor();
    const allowAll = at(text, "(allow file-read*)");
    for (const hidden of [p.home, `${USER}/.ssh`, `${USER}/.aws`, `${USER}/Library/Keychains`, `${USER}/Documents`]) {
      expect(at(text, `(deny file-read-data (subpath "${hidden}"))`), hidden).toBeGreaterThan(allowAll);
    }
    const lastDeny = Math.max(...text.split("\n").map((l, i) => (l.startsWith("(deny file-read-data") ? i : -1)));
    for (const open of [p.sandboxDir, p.userSkillsDir]) {
      expect(at(text, `(allow file-read-data (subpath "${open}"))`), open).toBeGreaterThan(lastDeny);
    }
  });

  it("lets config.json open extra read and write paths after the denials, and add its own", () => {
    const { text } = profileFor({ readOnlyPaths: ["/Users/sam/Documents/notes"], readWritePaths: ["/Users/sam/scratch"], denyReadPaths: ["~/Pictures"] });
    const deny = at(text, `(deny file-read-data (subpath "${USER}/Pictures"))`);
    expect(deny).toBeGreaterThan(-1);
    expect(at(text, '(allow file-read-data (subpath "/Users/sam/Documents/notes"))')).toBeGreaterThan(deny);
    expect(text).toContain('(allow file-write* (subpath "/Users/sam/scratch"))');
    expect(text).not.toContain(`${USER}/.ssh`);
  });

  it("allows writes only to the sandbox, temp dirs and configured paths", () => {
    const { p, text } = profileFor();
    const writes = text.split("\n").filter((l) => l.startsWith("(allow file-write* "));
    expect(writes).toContain(`(allow file-write* (subpath "${p.sandboxDir}"))`);
    expect(writes).toHaveLength(4);
    expect(text).not.toContain(`(allow file-write* (subpath "${p.home}"))`);
  });

  it("follows allowNetwork", () => {
    expect(profileFor({ allowNetwork: true }).text).toContain("(allow network*)");
    expect(profileFor({ allowNetwork: false }).text).toContain("(deny network*");
  });

  it("is written to the data folder for Mastra to use as is", () => {
    const p = tmpHome();
    const file = writeSeatbeltProfile(p, loadConfig(p.configFile));
    expect(file).toBe(`${p.dataDir}/seatbelt.sb`);
    expect(existsSync(file) && readFileSync(file, "utf8")).toContain("(deny default");
  });
});

const backend = LocalSandbox.detectIsolation();

describe("secretsHidden", () => {
  async function probe(isolation: "none" | "bwrap" | "seatbelt") {
    const p = tmpHome();
    writeFileSync(p.envFile, "TELEGRAM_BOT_TOKEN=secret-value");
    const sandbox = makeSandbox(p, loadConfig(p.configFile), isolation);
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
