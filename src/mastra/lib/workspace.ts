import { isAbsolute, relative, resolve } from "node:path";
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { needsApproval } from "./approval.ts";
import { appendAudit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import { makeSandbox, resolveIsolation } from "./sandbox.ts";

const { FILESYSTEM: FS, SANDBOX } = WORKSPACE_TOOLS;

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

type Call = { workspaceToolName: string; input: Record<string, unknown> };

/** Returns a reason to refuse a bash call, or undefined to allow it. */
export function vetCall(p: HomePaths, cfg: Config, { workspaceToolName, input }: Call) {
  if (workspaceToolName !== SANDBOX.EXECUTE_COMMAND) return undefined;
  if (input.background) return "Background processes are not available; run the command in the foreground.";
  if (Number(input.timeout) > cfg.sandbox.maxTimeoutSec) return `timeout is capped at ${cfg.sandbox.maxTimeoutSec} seconds.`;
  if (typeof input.cwd === "string" && !inside(p.sandboxDir, resolve(p.sandboxDir, input.cwd))) return "cwd must stay inside the sandbox.";
  return undefined;
}

export function makeWorkspace(p: HomePaths, cfg: Config, isolation = resolveIsolation(cfg.sandbox.isolation)) {
  const audit = (entry: Record<string, unknown>) => appendAudit(p.auditFile, entry);
  return new Workspace({
    id: "eigen",
    name: "eigen",
    filesystem: new LocalFilesystem({ basePath: p.sandboxDir }),
    sandbox: makeSandbox(p, cfg, isolation),
    tools: {
      enabled: false,
      [FS.READ_FILE]: { enabled: true, name: "read" },
      [FS.WRITE_FILE]: { enabled: true, name: "write", requireReadBeforeWrite: true },
      [FS.EDIT_FILE]: { enabled: true, name: "edit", requireReadBeforeWrite: true },
      [SANDBOX.EXECUTE_COMMAND]: {
        enabled: true,
        name: "bash",
        requireDescription: true,
        requireApproval: ({ args }) => needsApproval(String(args.command ?? "")),
      },
      hooks: {
        beforeToolCall: ({ toolName, workspaceToolName, input }) => {
          const reason = vetCall(p, cfg, { workspaceToolName, input: input as Record<string, unknown> });
          if (!reason) return;
          audit({ tool: toolName, input, outcome: "refused", reason });
          return { proceed: false, output: reason };
        },
        afterToolCall: ({ toolName, input, error }) => audit({ tool: toolName, input, outcome: error ? "error" : "ok", error: error && String(error) }),
      },
    },
  });
}
