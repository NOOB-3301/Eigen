import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { makeSandbox } from "../src/mastra/lib/sandbox.ts";
import { tmpAgent, type TmpAgent } from "./helpers/agent-folder.ts";

const backend = LocalSandbox.detectIsolation();

async function exec(allowNetwork: boolean, command: string, t: TmpAgent = tmpAgent({ sandbox: { allowNetwork } })) {
  const p = t.paths;
  const sandbox = makeSandbox(p, { ...t.r.sandbox, allowNetwork }, backend.backend as "bwrap" | "seatbelt");
  await sandbox.start();
  try {
    const r = await sandbox.executeCommand!(command, [], { timeout: 20_000 });
    return { ...r, text: `${r.stdout}${r.stderr}`.trim() };
  } finally {
    await sandbox.destroy?.();
  }
}

describe.skipIf(!backend.available)(`OS isolation (${backend.backend})`, () => {
  it("lets commands write inside the sandbox", async () => {
    const t = tmpAgent();
    const r = await exec(true, "echo hi > ok.txt && cat ok.txt", t);
    expect(r.text).toBe("hi");
    expect(readFileSync(join(t.paths.sandboxDir, "ok.txt"), "utf8").trim()).toBe("hi");
  });

  it("keeps writes outside the sandbox off the real filesystem", async () => {
    const t = tmpAgent();
    await exec(true, `echo x > ${t.home}/outside.txt; echo y > ${t.other.dir}/config.json`, t);
    expect(existsSync(join(t.home, "outside.txt"))).toBe(false);
    expect(readFileSync(t.other.configFile, "utf8")).not.toContain("y");
  });

  it("does not expose this agent's .env, config or memory, or any other agent", async () => {
    const t = tmpAgent();
    writeFileSync(t.paths.envFile, "TELEGRAM_BOT_TOKEN=secret-value");
    writeFileSync(t.paths.memoryDbFile, "memory-bytes");
    for (const file of [t.paths.envFile, t.paths.configFile, t.paths.memoryDbFile, t.other.envFile]) {
      const r = await exec(true, `cat ${file}`, t);
      expect(r.exitCode, file).not.toBe(0);
      expect(r.text).not.toMatch(/secret-value|memory-bytes|other-agent-secret|"models"/);
    }
  });

  it("can read its own skills but not change them", async () => {
    const t = tmpAgent();
    writeFileSync(join(t.paths.skillsDir, "note.md"), "skill text");
    const r = await exec(true, `cat ${t.paths.skillsDir}/note.md; echo changed > ${t.paths.skillsDir}/note.md`, t);
    expect(r.text).toContain("skill text");
    expect(readFileSync(join(t.paths.skillsDir, "note.md"), "utf8")).toBe("skill text");
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
