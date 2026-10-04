/**
 * The workspace tool of one agent: read/write/edit files and run bash in its sandbox, and load its skills. Skills come from three places,
 * all read-only to the agent's tools: its library (skills/, filtered by `skills.enabled`), the ones it installed or wrote in its sandbox
 * (sandbox/skills/), and the engine's built-in skills (engine/defaults/skills).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { appendAudit } from "../audit.ts";
import { snapshotGroundRules } from "../ground-rules.ts";
import type { AgentPaths } from "../home.ts";
import { SkillSlug, type ResolvedAgent } from "../schema.ts";
import { makeSandbox, refreshSkillEnv, resolveIsolation } from "../sandbox.ts";
import { builtinSkillsDir, reconcileSkills } from "../skills.ts";
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
export function vetCall(p: Pick<AgentPaths, "sandboxDir">, policy: Pick<ResolvedAgent["sandbox"], "maxTimeoutSec">, { workspaceToolName, input }: Call) {
  if (workspaceToolName !== SANDBOX.EXECUTE_COMMAND) return undefined;
  if (input.background) return "Background processes are not available; run the command in the foreground.";
  if (Number(input.timeout) > policy.maxTimeoutSec) return `timeout is capped at ${policy.maxTimeoutSec} seconds.`;
  if (typeof input.cwd === "string" && !inside(p.sandboxDir, resolve(p.sandboxDir, input.cwd))) return "cwd must stay inside the sandbox.";
  return undefined;
}

/** Which of its library skills an agent loads: all, or exactly the named ones ("pdf", "@owner/slug"). */
export type SkillSelection = ResolvedAgent["skills"]["enabled"];

const posix = (path: string) => path.split(sep).join("/");

/**
 * The absolute globs Mastra scans for skills. A path ending in SKILL.md is read as that one skill; "**" also finds ClawHub's @owner/slug layout.
 * A name that is not a slug is dropped: in a path it would be a glob or a "..".
 */
export function skillPaths(p: Pick<AgentPaths, "skillsDir" | "sandboxSkillsDir">, selection: SkillSelection, builtin: string | undefined): string[] {
  const library = posix(p.skillsDir);
  const own = selection === "all" ? [`${library}/**/SKILL.md`] : selection.filter((n) => SkillSlug.safeParse(n).success).map((n) => `${library}/${n}/SKILL.md`);
  return [...own, `${posix(p.sandboxSkillsDir)}/**/SKILL.md`, ...(builtin ? [`${posix(builtin)}/**/SKILL.md`] : [])];
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

export type WorkspaceAgent = Pick<ResolvedAgent, "id" | "sandbox" | "skills">;
export type WorkspaceOptions = {
  /** Overrides the isolation the policy resolves to (tests use "none"). */
  isolation?: ReturnType<typeof resolveIsolation>;
  log?: (msg: string) => void;
  /** The built-in skills folder; null: none; undefined: found from the engine's install. */
  builtinSkills?: string | null;
};

export function makeWorkspace(r: WorkspaceAgent, p: AgentPaths, { isolation = resolveIsolation(r.sandbox.isolation), log = () => undefined, builtinSkills: found }: WorkspaceOptions = {}) {
  const builtinSkills = found === null ? undefined : (found ?? builtinSkillsDir());
  const audit = (entry: Record<string, unknown>) => appendAudit(join(p.dataDir, "audit.jsonl"), entry);
  const sandbox = makeSandbox(p, r.sandbox, isolation, log, builtinSkills ?? null);
  const reported = new Set<string>(); // named skills already logged as missing
  const workspace: Workspace = new Workspace({
    id: `agent-${r.id}`,
    name: r.id,
    filesystem: new LocalFilesystem({ basePath: p.sandboxDir }),
    sandbox,
    // Read-only, and confined to the three skill folders: the skill loader can never read the agent's .env or another agent's folder.
    skillSource: new LocalFilesystem({ basePath: p.skillsDir, readOnly: true, allowedPaths: [p.sandboxSkillsDir, ...(builtinSkills ? [builtinSkills] : [])] }),
    skills: () => {
      const wanted = r.skills.enabled;
      if (wanted === "all") return skillPaths(p, wanted, builtinSkills);
      // A named skill can be deleted in the studio at any time: ignore it, say so once, and pick it up again if it comes back.
      const present = wanted.filter((n) => existsSync(join(p.skillsDir, n, "SKILL.md")));
      const gone = wanted.filter((n) => !present.includes(n));
      gone.filter((n) => !reported.has(n)).forEach((n) => log(`${r.id}: skill "${n}" is not in its skills folder, ignored`));
      reported.clear();
      gone.forEach((n) => reported.add(n));
      return skillPaths(p, present, builtinSkills);
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
          const reason = vetCall(p, r.sandbox, { workspaceToolName, input: input as Record<string, unknown> });
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
