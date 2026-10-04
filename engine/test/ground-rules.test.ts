import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshotGroundRules } from "../src/mastra/lib/ground-rules.ts";
import { buildInstructions } from "../src/mastra/lib/instructions.ts";
import { orgScopeProcessor, ORGANIZATION_ID } from "../src/mastra/lib/org-scope.ts";
import { touchesGroundRules } from "../src/mastra/lib/tools/workspace.ts";
import type { AgentPaths } from "../src/mastra/lib/home.ts";
import { tmpAgent } from "./helpers/agent-folder.ts";

const at = new Date("2026-10-03T09:00:00Z");
const write = (p: AgentPaths, text: string) => (mkdirSync(p.sandboxDir, { recursive: true }), writeFileSync(p.groundRulesFile, text));

describe("ground rules in the prompt", () => {
  it("always tells the agent how to record a rule, and says (none yet) without a file", () => {
    const t = tmpAgent();
    const text = buildInstructions(t.r, t.paths, at);
    expect(text).toMatch(/<ground_rules>[\s\S]*groundrules\.md[\s\S]*\(none yet\)[\s\S]*<\/ground_rules>/);
  });

  it("loads the file on every call, after the soul", () => {
    const { r, paths: p } = tmpAgent({ soul: { enabled: true } });
    writeFileSync(`${p.dir}/soul.md`, "Voice: dry");
    write(p, "- Never reply to stashcubby (2026-10-03)");
    const text = buildInstructions(r, p, at);
    expect(text).toContain("- Never reply to stashcubby (2026-10-03)");
    expect(text).not.toContain("(none yet)");
    const order = ["<soul>", "<ground_rules>", "Current time:"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join()).toBe(true);
    write(p, "- Always answer in one line");
    expect(buildInstructions(r, p, at)).toContain("Always answer in one line");
  });

  it("caps a runaway rules file", () => {
    const { r, paths: p } = tmpAgent();
    write(p, "x".repeat(20_000));
    const text = buildInstructions(r, p, at);
    expect(text).toContain("[rules truncated]");
    expect(text.length).toBeLessThan(20_000);
  });
});

describe("ground rules history", () => {
  it("does nothing without a file, snapshots each changed version once, and keeps the newest 100", () => {
    const p = tmpAgent().paths;
    expect(snapshotGroundRules(p)).toBeUndefined();
    write(p, "- rule one");
    expect(snapshotGroundRules(p, new Date("2026-10-03T09:00:00Z"))).toBeDefined();
    expect(snapshotGroundRules(p, new Date("2026-10-03T09:00:01Z"))).toBeUndefined();
    write(p, "- rule one\n- rule two");
    expect(snapshotGroundRules(p, new Date("2026-10-03T09:00:02Z"))).toBeDefined();
    expect(readdirSync(p.groundRulesHistoryDir)).toHaveLength(2);
    for (let i = 0; i < 105; i++) {
      write(p, `- rule ${i}`);
      snapshotGroundRules(p, new Date(Date.UTC(2026, 9, 4, 0, 0, i)));
    }
    expect(readdirSync(p.groundRulesHistoryDir)).toHaveLength(100);
  });

  it.each([
    [{ workspaceToolName: "mastra_workspace_write_file", input: { path: "groundrules.md" } }, true],
    [{ workspaceToolName: "mastra_workspace_edit_file", input: { path: "/groundrules.md" } }, true],
    [{ workspaceToolName: "mastra_workspace_execute_command", input: { command: "echo '- rule' >> groundrules.md" } }, true],
    [{ workspaceToolName: "mastra_workspace_write_file", input: { path: "notes.md" } }, false],
    [{ workspaceToolName: "mastra_workspace_execute_command", input: { command: "ls" } }, false],
  ])("%j -> %s", (call, expected) => expect(touchesGroundRules(call)).toBe(expected));
});

describe("organization scope", () => {
  it("sets the organization the knowledge layer requires", () => {
    const seen: Record<string, unknown> = {};
    const requestContext = { set: (k: string, v: unknown) => void (seen[k] = v) };
    const messages = [{ id: "m" }];
    expect((orgScopeProcessor.processInput as (a: unknown) => unknown)({ messages, requestContext })).toBe(messages);
    expect(seen).toEqual({ organizationId: ORGANIZATION_ID });
  });
});
