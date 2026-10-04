/* One agent's .env through the store: write-only, per agent, never a value back, never another agent's file. */
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths } from "../src/mastra/lib/home.ts";
import { agentSecrets, setAgentSecret, unsetAgentSecret } from "../src/mastra/lib/store.ts";
import { addAgent, emptyHome } from "./helpers/agent-home.ts";

const VALUE = "sk-ant-secret-value-1234567890";

describe("agent secrets", () => {
  it("lists the names the config uses, unknown names in .env with usedBy [], and extras; never a value", () => {
    const p = emptyHome();
    addAgent(p, "helper", { telegram: { enabled: true, allowedUserIds: [1] } });
    expect(setAgentSecret(p, "helper", "STRAY_KEY", VALUE).status).toBe(200);
    const list = agentSecrets(p, "helper", ["TYPED_NAME", "lower-case"])!;
    expect(list).toEqual([
      { name: "ANTHROPIC_API_KEY", set: false, usedBy: ["models.main"] },
      { name: "STRAY_KEY", set: true, usedBy: [] },
      { name: "TELEGRAM_BOT_TOKEN", set: false, usedBy: ["telegram"] },
      { name: "TYPED_NAME", set: false, usedBy: [] },
    ]);
    expect(JSON.stringify(list)).not.toContain(VALUE);
  });

  it("writes only this agent's .env (0600) and never another agent's", () => {
    const p = emptyHome();
    addAgent(p, "helper");
    addAgent(p, "other");
    expect(setAgentSecret(p, "helper", "ANTHROPIC_API_KEY", VALUE).status).toBe(200);
    expect(readFileSync(agentPaths(p, "helper").envFile, "utf8")).toContain(`ANTHROPIC_API_KEY=${VALUE}`);
    expect(statSync(agentPaths(p, "helper").envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(agentPaths(p, "other").envFile, "utf8")).not.toContain(VALUE);
    expect(agentSecrets(p, "other")!.find((s) => s.name === "ANTHROPIC_API_KEY")!.set).toBe(false);
    expect(unsetAgentSecret(p, "helper", "ANTHROPIC_API_KEY")).toEqual({ status: 200, removed: true });
    expect(unsetAgentSecret(p, "helper", "ANTHROPIC_API_KEY")).toEqual({ status: 200, removed: false });
  });

  it("an unknown agent is a 404 and no folder is created for it", () => {
    const p = emptyHome();
    expect(setAgentSecret(p, "ghost", "X", "v").status).toBe(404);
    expect(unsetAgentSecret(p, "ghost", "X").status).toBe(404);
    expect(agentSecrets(p, "ghost")).toBeUndefined();
    expect(existsSync(join(p.agentsDir, "ghost"))).toBe(false);
    expect(() => setAgentSecret(p, "../ghost", "X", "v")).toThrow(/invalid agent id/);
  });

  it("refuses a .env that is a symlink (it could be another agent's)", () => {
    const p = emptyHome();
    addAgent(p, "other");
    const a = addAgent(p, "helper");
    unlinkSync(a.envFile);
    symlinkSync(agentPaths(p, "other").envFile, a.envFile);
    expect(() => setAgentSecret(p, "helper", "ANTHROPIC_API_KEY", VALUE)).toThrow(/symlink/);
    expect(() => agentSecrets(p, "helper")).toThrow(/symlink/);
    expect(readFileSync(agentPaths(p, "other").envFile, "utf8")).not.toContain(VALUE);
  });

  it("rejects a bad name or an unstorable value without echoing it", () => {
    const p = emptyHome();
    addAgent(p, "helper");
    expect(() => setAgentSecret(p, "helper", "lower", "v")).toThrow(/invalid variable name/);
    let msg = "";
    try {
      setAgentSecret(p, "helper", "KEY", "two\nlines");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/single line/);
    expect(msg).not.toContain("two");
  });
});
