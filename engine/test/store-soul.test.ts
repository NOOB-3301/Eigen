import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/mastra/lib/config.ts";
import { createAgent, readAgent, readSharedSoul, soulPath, trashAgent, validateAgent, writeAgent, writeSharedSoul } from "../src/mastra/lib/store.ts";
import { tmpHome } from "./helpers/home.ts";

type P = ReturnType<typeof tmpHome>;
const base = { id: "helper", name: "Helper", role: "assistant", description: "Helps." };
const own = { ...base, soul: { source: "own" as const } };
const setup = (soul?: string) => {
  const p = tmpHome();
  const root = loadConfig(p.configFile);
  expect(createAgent(p, root, base, "Help.").status).toBe(200);
  if (soul !== undefined) writeFileSync(join(p.agentsDir, "helper", "soul.md"), soul);
  return { p, root, dir: join(p.agentsDir, "helper") };
};
const etag = (p: P) => readAgent(p, "helper")!.etag;

describe("shared soul", () => {
  it("reads, guards with an etag, and creates the file when it is missing", () => {
    const p = tmpHome();
    const first = readSharedSoul(p);
    expect(first.text).toBe(readFileSync(p.soulFile, "utf8"));
    expect(writeSharedSoul(p, { text: "Calm.", etag: "0000000000000000" })).toMatchObject({ status: 409, body: { ok: false, etag: first.etag } });
    const ok = writeSharedSoul(p, { text: "Calm.", etag: first.etag });
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    expect(readSharedSoul(p)).toEqual({ text: "Calm.\n", etag: (ok.body as { etag: string }).etag });

    rmSync(p.soulFile);
    const empty = readSharedSoul(p);
    expect(empty.text).toBe("");
    expect(writeSharedSoul(p, { text: "New.", etag: empty.etag }).status).toBe(200);
    expect(readFileSync(p.soulFile, "utf8")).toBe("New.\n");
  });

  it("refuses text over the schema's size cap", () => {
    const p = tmpHome();
    const before = readFileSync(p.soulFile, "utf8");
    expect(writeSharedSoul(p, { text: "x".repeat(100_001) }).status).toBe(400);
    expect(readFileSync(p.soulFile, "utf8")).toBe(before);
  });
});

describe("agent soul", () => {
  it("readAgent returns the soul file named by the config, or null", () => {
    const { p } = setup();
    expect(readAgent(p, "helper")!.soulText).toBeNull();
    writeFileSync(join(p.agentsDir, "helper", "soul.md"), "Warm.");
    expect(readAgent(p, "helper")!.soulText).toBe("Warm.");
  });

  it("source own needs a soul file on disk or in the same request", () => {
    const { p, root } = setup();
    expect(validateAgent(p, "helper", own, root).issues).toEqual([expect.stringMatching(/^soul: no soul.md yet/)]);
    expect(validateAgent(p, "helper", own, root, { soulText: "Warm." }).issues).toEqual([]);
    expect(validateAgent(p, "helper", { ...base, soul: { source: "shared" } }, root).issues).toEqual([]);
    expect(writeAgent(p, root, "helper", { config: own }).status).toBe(400);

    const w = writeAgent(p, root, "helper", { config: own, soulText: "Warm.", etag: etag(p) });
    expect(w).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(join(p.agentsDir, "helper", "soul.md"), "utf8")).toBe("Warm.\n");
    expect(etag(p)).toBe((w.body as { etag: string }).etag);
    expect(validateAgent(p, "helper", own, root).issues).toEqual([]);
  });

  it("refuses a github-pr repo whose owner or name is a dot segment", () => {
    const { p, root } = setup();
    const pr = (repo: string) => ({ ...base, triggers: [{ id: "prs", type: "github-pr", repo, tokenEnv: "GITHUB_TOKEN", prompt: "Review." }] });
    expect(validateAgent(p, "helper", pr("acme/web.app"), root).issues).toEqual([]);
    for (const repo of ["../x", "acme/..", "./x"]) expect(validateAgent(p, "helper", pr(repo), root).issues, repo).toEqual(["triggers.0.repo: owner/name"]);
  });

  it("a skill named in skills.inherit that is not in the library is not an issue", () => {
    const { p, root } = setup();
    expect(validateAgent(p, "helper", { ...base, skills: { inherit: ["not-installed"] } }, root).issues).toEqual([]);
  });

  it("the etag covers the soul, so a concurrent soul edit is a 409", () => {
    const { p, root, dir } = setup("One.");
    const before = etag(p);
    writeFileSync(join(dir, "soul.md"), "Two.");
    expect(etag(p)).not.toBe(before);
    const stale = writeAgent(p, root, "helper", { config: base, soulText: "Mine.", etag: before });
    expect(stale).toMatchObject({ status: 409, body: { ok: false, etag: etag(p) } });
    expect(readFileSync(join(dir, "soul.md"), "utf8")).toBe("Two.");
  });

  it("writes the soul before the config, so a failed config write never names a missing soul", () => {
    const { p, root, dir } = setup();
    const cfg = readFileSync(join(dir, "config.json"), "utf8");
    // A directory where config.json's temp file goes makes exactly that write fail.
    mkdirSync(join(dir, `config.json.${process.pid}.tmp`));
    expect(() => writeAgent(p, root, "helper", { config: { ...base, soul: { source: "own", file: "persona.md" } }, soulText: "Warm." })).toThrow();
    expect(readFileSync(join(dir, "persona.md"), "utf8")).toBe("Warm.\n");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(cfg);
  });

  it("keeps the soul file inside the agent folder, also through symlinks", () => {
    const { p, root, dir } = setup();
    expect(soulPath(dir, "soul.md")).toBe(join(dir, "soul.md"));
    expect(soulPath(dir, "notes/persona.md")).toBe(join(dir, "notes", "persona.md"));
    for (const bad of ["../other/soul.md", "../../SOUL.md", "../../prompts/system.md", "/etc/soul.md", "soul.txt", "../../.env"]) expect(soulPath(dir, bad), bad).toBeUndefined();

    const target = join(p.memoryDir, "profile.md");
    const before = readFileSync(target, "utf8");
    symlinkSync(target, join(dir, "linked.md"));
    symlinkSync(p.memoryDir, join(dir, "notes"));
    expect(soulPath(dir, "linked.md")).toBeUndefined();
    expect(soulPath(dir, "notes/x.md")).toBeUndefined();
    for (const file of ["linked.md", "notes/x.md", "../../SOUL.md"]) {
      const r = writeAgent(p, root, "helper", { config: { ...base, soul: { source: "own", file } }, soulText: "pwned" });
      expect(r.status, file).toBe(400);
      expect(r.body).toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/^soul.file:/)]) });
    }
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(join(p.memoryDir, "x.md"))).toBe(false);
    // Reading never follows an escaping soul file either.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...base, soul: { file: "linked.md" } }));
    expect(readAgent(p, "helper")!.soulText).toBeNull();
  });

  it("createAgent can write the first soul in the same step", () => {
    const p = tmpHome();
    const root = loadConfig(p.configFile);
    expect(createAgent(p, root, own, "Help.").status).toBe(400);
    expect(existsSync(join(p.agentsDir, "helper"))).toBe(false);
    const made = createAgent(p, root, own, "Help.", "Warm.");
    expect(made.status).toBe(200);
    expect(readAgent(p, "helper")).toMatchObject({ soulText: "Warm.\n", etag: (made.body as { etag: string }).etag });
  });

  it("trashing an agent moves its soul with the folder", () => {
    const { p } = setup("Warm.");
    const t = trashAgent(p, "helper");
    expect(t.status).toBe(200);
    expect(readdirSync(t.trashedTo!).sort()).toEqual(["config.json", "instructions.md", "soul.md"]);
    expect(readFileSync(join(t.trashedTo!, "soul.md"), "utf8")).toBe("Warm.");
  });
});
