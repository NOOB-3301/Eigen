import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { appendAudit } from "../audit.ts";
import { snapshotGroundRules } from "../ground-rules.ts";
import type { Config } from "../config.ts";
import type { HomePaths } from "../home.ts";
import { SkillSlug } from "../schema.ts";
import { makeSandbox, refreshSkillEnv, resolveIsolation } from "../sandbox.ts";
import { reconcileSkills } from "../skills.ts";
import { needsApproval } from "./approval.ts";

const { FILESYSTEM: FS, SANDBOX } = WORKSPACE_TOOLS;

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

type Call = { workspaceToolName: string; input: Record<string, unknown> };

/** Commands and writes that can add, change or remove skills. */
export const touchesSkills = ({ workspaceToolName, input }: Call) =>
  workspaceToolName === SANDBOX.EXECUTE_COMMAND
    ? /\bclawhub\b/.test(String(input.command ?? ""))
    : ([FS.WRITE_FILE, FS.EDIT_FILE] as string[]).includes(workspaceToolName) && /^\/?skills\//.test(String(input.path ?? ""));

/** Writes and shell commands that can change the sandbox's .env, where the agent keeps its skills' keys. */
export const touchesSkillEnv = ({ workspaceToolName, input }: Call) =>
  workspaceToolName === SANDBOX.EXECUTE_COMMAND
    ? /(^|[\s>/])\.env\b/.test(String(input.command ?? ""))
    : ([FS.WRITE_FILE, FS.EDIT_FILE] as string[]).includes(workspaceToolName) && /^\/?\.env$/.test(String(input.path ?? ""));

/** Writes and shell commands that can change groundrules.md. */
export const touchesGroundRules = ({ workspaceToolName, input }: Call) =>
  workspaceToolName === SANDBOX.EXECUTE_COMMAND
    ? /\bgroundrules\.md\b/.test(String(input.command ?? ""))
    : ([FS.WRITE_FILE, FS.EDIT_FILE] as string[]).includes(workspaceToolName) && /^\/?groundrules\.md$/.test(String(input.path ?? ""));

/** Returns a reason to refuse a bash call, or undefined to allow it. */
export function vetCall(p: HomePaths, cfg: Config, { workspaceToolName, input }: Call) {
  if (workspaceToolName !== SANDBOX.EXECUTE_COMMAND) return undefined;
  if (input.background) return "Background processes are not available; run the command in the foreground.";
  if (Number(input.timeout) > cfg.sandbox.maxTimeoutSec) return `timeout is capped at ${cfg.sandbox.maxTimeoutSec} seconds.`;
  if (typeof input.cwd === "string" && !inside(p.sandboxDir, resolve(p.sandboxDir, input.cwd))) return "cwd must stay inside the sandbox.";
  return undefined;
}

/** Which skills from ~/.eigen/skills an agent can load: all, none, or exactly the named ones ("pdf", "@owner/slug"). Its own sandbox/skills are visible in every case. */
export type SkillSelection = "all" | "none" | string[];

const posix = (path: string) => path.split(sep).join("/");

/**
 * The paths, relative to ~/.eigen, that Mastra scans for skills. A path ending in SKILL.md is read as that one skill; "**" also finds
 * ClawHub's skills/@owner/slug layout. A name that is not a slug is dropped: in a path it would be a glob or a "..".
 * The sandbox part follows `p`, so an agent with its own sandbox sees ITS sandbox/skills, not the shared one.
 */
export function skillPaths(p: HomePaths, selection: SkillSelection): string[] {
  const library = posix(relative(p.home, p.userSkillsDir));
  const own = posix(relative(p.home, p.sandboxSkillsDir));
  const shared = selection === "all" ? [`${library}/**/SKILL.md`] : Array.isArray(selection) ? selection.filter((n) => SkillSlug.safeParse(n).success).map((n) => `${library}/${n}/SKILL.md`) : [];
  return [...shared, `${own}/**/SKILL.md`];
}

/**
 * Re-reads the skill folders now instead of at Mastra's 30 s staleness check. A dynamic path list gives every distinct list its own
 * view, so the one in use is refreshed; list() comes first because refresh() on a view that was never read would leave it empty.
 */
export async function refreshSkills(workspace: Workspace) {
  const root = workspace.skills;
  const view = (await root?.getScoped?.()) ?? root;
  await view?.list();
  await view?.refresh();
}

export type WorkspaceOptions = {
  /** A function is read on every turn (the primary follows edits to its config without a rebuild); a value is fixed for this workspace. */
  skills?: SkillSelection | (() => SkillSelection);
  log?: (msg: string) => void;
};

export function makeWorkspace(p: HomePaths, cfg: Config, isolation = resolveIsolation(cfg.sandbox.isolation), id = "eigen", { skills = "all", log = () => undefined }: WorkspaceOptions = {}) {
  const audit = (entry: Record<string, unknown>) => appendAudit(p.auditFile, entry);
  const sandbox = makeSandbox(p, cfg, isolation);
  const reported = new Set<string>(); // named skills already logged as missing
  const workspace: Workspace = new Workspace({
    id,
    name: id,
    filesystem: new LocalFilesystem({ basePath: p.sandboxDir }),
    sandbox,
    // The skills this agent selected from skills/ plus its own sandbox/skills/, read-only.
    skillSource: new LocalFilesystem({ basePath: p.home, readOnly: true }),
    skills: () => {
      const wanted = typeof skills === "function" ? skills() : skills;
      if (!Array.isArray(wanted)) return skillPaths(p, wanted);
      // A named skill can be deleted in the studio at any time: ignore it, say so once, and pick it up again if it comes back.
      const present = wanted.filter((n) => existsSync(join(p.userSkillsDir, n, "SKILL.md")));
      const gone = wanted.filter((n) => !present.includes(n));
      gone.filter((n) => !reported.has(n)).forEach((n) => log(`${id}: skill "${n}" is not in the skills folder, ignored`));
      reported.clear();
      gone.forEach((n) => reported.add(n));
      return skillPaths(p, present);
    },
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
        afterToolCall: async ({ toolName, workspaceToolName, input, error }) => {
          audit({ tool: toolName, input, outcome: error ? "error" : "ok", error: error && String(error) });
          if (error) return;
          const call = { workspaceToolName, input: input as Record<string, unknown> };
          if (touchesSkillEnv(call)) refreshSkillEnv(sandbox, p);
          if (touchesGroundRules(call)) snapshotGroundRules(p);
          if (!touchesSkills(call)) return;
          reconcileSkills(p);
          await refreshSkills(workspace);
          refreshSkillEnv(sandbox, p);
        },
      },
    },
  });
  return workspace;
}
