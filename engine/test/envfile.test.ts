import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatValue, parseEnv, readEnvFile, secretStatuses, setSecret, unsetSecret, valueFingerprint } from "../src/mastra/lib/envfile.ts";

/** One agent's .env, by path: every function takes the file it works on. */
const envFile = () => join(mkdtempSync(join(tmpdir(), "eigen-env-")), "agent", ".env");

describe("parseEnv", () => {
  it("reads bare, quoted and exported values, skips comments, last line wins", () => {
    const m = parseEnv(["# a comment", "A=1", "export B='two words'", 'C="x\\ny"', "D=plain # trailing", "A=2", "not a line", ""].join("\n"));
    expect(Object.fromEntries(m)).toEqual({ A: "2", B: "two words", C: "x\ny", D: "plain" });
  });
});

describe("formatValue", () => {
  it("keeps tokens bare, quotes the rest, refuses what cannot be stored", () => {
    expect(formatValue("123456:ABC-def_ghi")).toBe("123456:ABC-def_ghi");
    expect(formatValue("has space # and hash")).toBe("'has space # and hash'");
    expect(() => formatValue("two\nlines")).toThrow(/single line/);
    expect(() => formatValue("it's a \"mix\"")).toThrow(/single quote/);
    expect(() => formatValue("")).toThrow(/empty/);
    expect(() => formatValue("x".repeat(5000))).toThrow(/longer/);
  });
});

describe("setSecret / unsetSecret", () => {
  it("adds, replaces and removes a variable, leaving every other line alone, and keeps the file 0600", () => {
    const file = envFile();
    setSecret(file, "FIRST", "x");
    writeFileSync(file, "# my keys\nKEEP=1\nTELEGRAM_BOT_TOKEN=old\nAFTER=2\nTELEGRAM_BOT_TOKEN=older\n");
    setSecret(file, "TELEGRAM_BOT_TOKEN", "111:new");
    expect(readFileSync(file, "utf8")).toBe("# my keys\nKEEP=1\nAFTER=2\nTELEGRAM_BOT_TOKEN=111:new\n");
    setSecret(file, "OPENAI_API_KEY", "sk-abc 123");
    expect(parseEnv(readFileSync(file, "utf8")).get("OPENAI_API_KEY")).toBe("sk-abc 123");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(unsetSecret(file, "KEEP")).toBe(true);
    expect(unsetSecret(file, "KEEP")).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("KEEP");
    expect(readFileSync(file, "utf8")).toContain("# my keys");
  });

  it("creates the file (and its folder) when missing, 0600, and rejects bad names (no path or shell tricks)", () => {
    const file = envFile();
    expect(existsSync(file)).toBe(false);
    setSecret(file, "A_KEY", "v");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const bad of ["lower", "1A", "A B", "A=B", "A\nB", "../X", "", "A".repeat(65)]) expect(() => setSecret(file, bad, "v")).toThrow(/invalid variable name/);
  });
});

describe("secretStatuses", () => {
  it("reports set / unset per referenced name and never a value", () => {
    const file = envFile();
    setSecret(file, "A_KEY", "secret-value");
    writeFileSync(file, "A_KEY=secret-value\nEMPTY=\nSTALE_KEY=old-value\nlower=x\n");
    const out = secretStatuses(file, new Map([["A_KEY", ["models.cloud"]], ["EMPTY", ["telegram"]], ["MISSING", ["triggers.prs"]]]));
    expect(out).toEqual([
      { name: "A_KEY", set: true, usedBy: ["models.cloud"] },
      { name: "EMPTY", set: false, usedBy: ["telegram"] },
      { name: "MISSING", set: false, usedBy: ["triggers.prs"] },
      { name: "STALE_KEY", set: true, usedBy: [] },
    ]);
    expect(JSON.stringify(out)).not.toContain("old-value");
    expect(JSON.stringify(out)).not.toContain("secret-value");
  });
});

describe("readEnvFile and valueFingerprint", () => {
  it("reads one agent's file fresh (empty when missing) and never touches process.env", () => {
    const file = envFile();
    expect(readEnvFile(file).size).toBe(0);
    setSecret(file, "ONLY_HERE_KEY", "v1");
    expect(readEnvFile(file).get("ONLY_HERE_KEY")).toBe("v1");
    setSecret(file, "ONLY_HERE_KEY", "v2");
    expect(readEnvFile(file).get("ONLY_HERE_KEY")).toBe("v2");
    expect(process.env.ONLY_HERE_KEY).toBeUndefined();
  });

  it("fingerprints change with the value and never contain it", () => {
    expect(valueFingerprint(undefined)).toBe("");
    expect(valueFingerprint("a-secret")).not.toBe(valueFingerprint("b-secret"));
    expect(valueFingerprint("a-secret")).not.toContain("secret");
  });
});
