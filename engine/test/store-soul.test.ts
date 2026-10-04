/* One agent's soul file: read with the agent, written in the same save as its config, confined to its folder. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgent, validateAgent, writeAgent } from "../src/mastra/lib/store.ts";
import { addAgent, agentConfig, emptyHome } from "./helpers/agent-home.ts";

const base = agentConfig("helper");
const on = { ...base, soul: { enabled: true } };
const setup = (soul?: string) => {
  const p = emptyHome();
  const a = addAgent(p, "helper");
  if (soul !== undefined) writeFileSync(join(a.dir, "soul.md"), soul);
  return { p, dir: a.dir };
};
const etag = (p: ReturnType<typeof emptyHome>) => readAgent(p, "helper")!.etag;

describe("agent soul", () => {
  it("readAgent returns the soul file named by the config, or null", () => {
    const { p, dir } = setup();
    expect(readAgent(p, "helper")!.soulText).toBeNull();
    writeFileSync(join(dir, "soul.md"), "Warm.");
    expect(readAgent(p, "helper")!.soulText).toBe("Warm.");
  });

  it("an enabled soul needs its file on disk or in the same request", () => {
    const { p, dir } = setup();
    expect(validateAgent(p, "helper", on).issues).toEqual([expect.stringMatching(/^soul: no soul.md yet/)]);
    expect(validateAgent(p, "helper", on, { soulText: "Warm." }).issues).toEqual([]);
    expect(writeAgent(p, "helper", { config: on }).status).toBe(400);

    const w = writeAgent(p, "helper", { config: on, soulText: "Warm.", etag: etag(p) });
    expect(w).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(join(dir, "soul.md"), "utf8")).toBe("Warm.\n");
    expect(etag(p)).toBe((w.body as { etag: string }).etag);
    expect(validateAgent(p, "helper", on).issues).toEqual([]);
  });

  it("the etag covers the soul, so a concurrent soul edit is a 409", () => {
    const { p, dir } = setup("One.");
    const before = etag(p);
    writeFileSync(join(dir, "soul.md"), "Two.");
    expect(etag(p)).not.toBe(before);
    const stale = writeAgent(p, "helper", { config: base, soulText: "Mine.", etag: before });
    expect(stale).toMatchObject({ status: 409, body: { ok: false, etag: etag(p) } });
    expect(readFileSync(join(dir, "soul.md"), "utf8")).toBe("Two.");
  });

  it("writes the soul before the config, so a failed config write never names a missing soul", () => {
    const { p, dir } = setup();
    const cfg = readFileSync(join(dir, "config.json"), "utf8");
    // A directory where config.json's temp file goes makes exactly that write fail.
    mkdirSync(join(dir, `config.json.${process.pid}.tmp`));
    expect(() => writeAgent(p, "helper", { config: { ...base, soul: { enabled: true, file: "persona.md" } }, soulText: "Warm." })).toThrow();
    expect(readFileSync(join(dir, "persona.md"), "utf8")).toBe("Warm.\n");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(cfg);
  });

  it("never writes a soul outside the agent folder", () => {
    const { p, dir } = setup();
    for (const file of ["../other/soul.md", "../../x.md", "notes/x.md", ".env.md", "soul.txt"]) {
      const r = writeAgent(p, "helper", { config: { ...base, soul: { enabled: true, file } }, soulText: "pwned" });
      expect(r.status, file).toBe(400);
    }
    expect(existsSync(join(dir, "..", "other"))).toBe(false);
    expect(existsSync(join(dir, "notes"))).toBe(false);
  });
});
