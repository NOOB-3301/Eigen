import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatValue, parseEnv, secretStatuses, setSecret, syncEnv, unsetSecret } from "../src/mastra/lib/envfile.ts";
import { tmpHome } from "./helpers/home.ts";

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
    const p = tmpHome();
    writeFileSync(p.envFile, "# my keys\nKEEP=1\nTELEGRAM_BOT_TOKEN=old\nAFTER=2\nTELEGRAM_BOT_TOKEN=older\n");
    setSecret(p, "TELEGRAM_BOT_TOKEN", "111:new");
    expect(readFileSync(p.envFile, "utf8")).toBe("# my keys\nKEEP=1\nAFTER=2\nTELEGRAM_BOT_TOKEN=111:new\n");
    setSecret(p, "OPENAI_API_KEY", "sk-abc 123");
    expect(parseEnv(readFileSync(p.envFile, "utf8")).get("OPENAI_API_KEY")).toBe("sk-abc 123");
    expect(statSync(p.envFile).mode & 0o777).toBe(0o600);
    expect(unsetSecret(p, "KEEP")).toBe(true);
    expect(unsetSecret(p, "KEEP")).toBe(false);
    expect(readFileSync(p.envFile, "utf8")).not.toContain("KEEP");
    expect(readFileSync(p.envFile, "utf8")).toContain("# my keys");
  });

  it("creates the file when missing and rejects bad names (no path or shell tricks)", () => {
    const p = tmpHome();
    expect(existsSync(p.envFile)).toBe(true);
    for (const bad of ["lower", "1A", "A B", "A=B", "A\nB", "../X", "", "A".repeat(65)]) expect(() => setSecret(p, bad, "v")).toThrow(/invalid variable name/);
  });
});

describe("secretStatuses", () => {
  it("reports set / unset per referenced name and never a value", () => {
    const p = tmpHome();
    writeFileSync(p.envFile, "A_KEY=secret-value\nEMPTY=\n");
    const out = secretStatuses(p, new Map([["A_KEY", ["models.cloud"]], ["EMPTY", ["telegram"]], ["MISSING", ["agents.x.telegram"]]]));
    expect(out).toEqual([
      { name: "A_KEY", set: true, usedBy: ["models.cloud"] },
      { name: "EMPTY", set: false, usedBy: ["telegram"] },
      { name: "MISSING", set: false, usedBy: ["agents.x.telegram"] },
    ]);
    expect(JSON.stringify(out)).not.toContain("secret-value");
  });
});

describe("syncEnv", () => {
  it("applies new and changed values, removes what it applied, and never touches the shell's own variables", () => {
    const p = tmpHome();
    const env: NodeJS.ProcessEnv = { FROM_SHELL: "shell", ADOPT: "same" };
    const owned = new Map<string, string>();
    writeFileSync(p.envFile, "NEW_KEY=one\nFROM_SHELL=file\nADOPT=same\n");
    expect(syncEnv(p, owned, env).sort()).toEqual(["NEW_KEY"]);
    expect(env).toMatchObject({ NEW_KEY: "one", FROM_SHELL: "shell", ADOPT: "same" });

    writeFileSync(p.envFile, "NEW_KEY=two\nADOPT=changed\n");
    expect(syncEnv(p, owned, env).sort()).toEqual(["ADOPT", "NEW_KEY"]);
    expect(env).toMatchObject({ NEW_KEY: "two", ADOPT: "changed", FROM_SHELL: "shell" });

    writeFileSync(p.envFile, "");
    expect(syncEnv(p, owned, env).sort()).toEqual(["ADOPT", "NEW_KEY"]);
    expect(env).toEqual({ FROM_SHELL: "shell" });
  });
});
