import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { makeSandbox } from "../src/mastra/lib/sandbox.ts";
import { tmpHome } from "./helpers/home.ts";

const backend = LocalSandbox.detectIsolation();

async function exec(allowNetwork: boolean, command: string, p = tmpHome({ sandbox: { allowNetwork } })) {
  const sandbox = makeSandbox(p, loadConfig(p.configFile), backend.backend as "bwrap" | "seatbelt");
  await sandbox.start();
  try {
    const r = await sandbox.executeCommand!(command, [], { timeout: 20_000 });
    return { ...r, p, text: `${r.stdout}${r.stderr}`.trim() };
  } finally {
    await sandbox.destroy?.();
  }
}

describe.skipIf(!backend.available)(`OS isolation (${backend.backend})`, () => {
  it("lets commands write inside the sandbox", async () => {
    const r = await exec(true, "echo hi > ok.txt && cat ok.txt");
    expect(r.text).toBe("hi");
    expect(readFileSync(join(r.p.sandboxDir, "ok.txt"), "utf8").trim()).toBe("hi");
  });

  it("keeps writes outside the sandbox off the real filesystem", async () => {
    const p = tmpHome();
    await exec(true, `echo x > ${p.home}/outside.txt`, p);
    expect(existsSync(join(p.home, "outside.txt"))).toBe(false);
  });

  it("does not expose files next to the sandbox (.env)", async () => {
    const p = tmpHome();
    writeFileSync(p.envFile, "TELEGRAM_BOT_TOKEN=secret-value");
    const r = await exec(true, `cat ${p.envFile}`, p);
    expect(r.exitCode).not.toBe(0);
    expect(r.text).not.toContain("secret-value");
  });

  it("allowNetwork gates network access", async () => {
    const server = createServer((_req, res) => res.end("pong"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await exec(true, `curl -s -m 5 ${url}`)).text).toBe("pong");
      expect((await exec(false, `curl -s -m 5 ${url}`)).text).not.toContain("pong");
    } finally {
      server.close();
    }
  });
});
