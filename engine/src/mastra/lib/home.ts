/**
 * Where things live on disk (`@eigen/engine/home`, Node only).
 *
 *   ~/.eigen/agents/<id>/      one standalone agent: everything it uses is inside (schema.ts lists what)
 *   ~/.eigen/engine/           the engine's own files, never an agent's: Mastra's internal database, logs, canvas positions
 *   ~/.eigen/backup/v1-<time>/ a copy of the text files of the layout before standalone agents, made once on the first start. The old files stay
 *                              where they were and are never read again.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AGENT_CONFIG_FILE, AGENT_ENV_FILE } from "./schema.ts";

export type HomePaths = ReturnType<typeof homePaths>;
export type AgentPaths = ReturnType<typeof agentPaths>;

export const eigenHome = (env: NodeJS.ProcessEnv = process.env) => (env.EIGEN_HOME ? resolve(env.EIGEN_HOME) : join(homedir(), ".eigen"));

export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const machineTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function homePaths(home = eigenHome()) {
  const engineDir = join(home, "engine");
  const logsDir = join(engineDir, "logs");
  return {
    home,
    /** One folder per agent. Folders starting with "." or "_" are not agents (`.trash/`, `_drafts/`). */
    agentsDir: join(home, "agents"),
    engineDir,
    /** Mastra's own storage (workflow snapshots, traces, the chat adapter's subscriptions). No agent memory lives here: each agent has its own storage. */
    engineDbFile: join(engineDir, "mastra.db"),
    logsDir,
    logFile: join(logsDir, "eigen.log"),
    auditFile: join(logsDir, "audit.jsonl"),
    /** Canvas node positions (fleet and builders), kept out of agent configs so dragging a node never reloads an agent. */
    layoutFile: join(engineDir, "layout.json"),
    /** Where a trashed agent folder goes (`<id>-<time>`). */
    trashDir: join(home, "agents", ".trash"),
    backupDir: join(home, "backup"),
  };
}

/** Every path of one agent. `id` must already be a valid AgentId (schema.ts); nothing here checks it. */
export function agentPaths(p: Pick<HomePaths, "agentsDir">, id: string) {
  const dir = join(p.agentsDir, id);
  const sandboxDir = join(dir, "sandbox");
  const dataDir = join(dir, "data");
  return {
    id,
    dir,
    configFile: join(dir, AGENT_CONFIG_FILE),
    /** This agent's secrets. 0600, write-only from the studio, never visible to its sandbox. */
    envFile: join(dir, AGENT_ENV_FILE),
    /** Its skill library: skills/<slug>/SKILL.md (ClawHub installs under skills/@owner/slug/). Read-only to its sandbox. */
    skillsDir: join(dir, "skills"),
    /** Where a deleted skill goes. */
    trashDir: join(dir, ".trash"),
    /** Its workspace: the only place its shell and file tools may write. */
    sandboxDir,
    /** Skills the agent writes for itself, and the ones it fetched that still wait for review. */
    sandboxSkillsDir: join(sandboxDir, "skills"),
    sandboxQuarantineDir: join(sandboxDir, "skills-quarantine"),
    sandboxHomeDir: join(sandboxDir, ".home"),
    groundRulesFile: join(sandboxDir, "groundrules.md"),
    /** Default storage (LibSQL file) when memory.storage has no remote url. */
    memoryDbFile: join(dir, "memory.db"),
    dataDir,
    /** Chat state that is not config: the /model choice, verbose mode. */
    stateFile: join(dataDir, "state.json"),
    /** Trigger state: runs.jsonl (history) and <trigger>.seen.json (pull requests already seen). */
    triggersDir: join(dataDir, "triggers"),
    /** Reminders the agent set for itself with the schedule tool. */
    schedulesFile: join(dataDir, "schedules.json"),
    groundRulesHistoryDir: join(dataDir, "groundrules-history"),
  };
}

/** The folders an agent needs before it runs. The .env is created empty (0600) so the studio and the engine always have a file to read. */
export function ensureAgentDirs(a: AgentPaths) {
  for (const d of [a.dir, a.skillsDir, a.sandboxSkillsDir, join(a.sandboxHomeDir, "tmp"), a.dataDir]) mkdirSync(d, { recursive: true });
  if (!existsSync(a.envFile)) writeFileSync(a.envFile, "# This agent's secrets. config.json refers to them by name.\n", { mode: 0o600, flag: "wx" });
  chmodSync(a.envFile, 0o600);
}

/**
 * A markdown file named in config.json (instructions.file, soul.file), resolved inside the agent folder. Undefined when the name would leave
 * the folder or is not a plain .md file name, so a config can never point the engine or the studio at .env, another agent, or anything else.
 */
export function agentMdFile(dir: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return undefined;
  const file = resolve(dir, name);
  return dirname(file) === resolve(dir) && basename(file) === name ? file : undefined;
}

export function ensureHome(p: HomePaths) {
  for (const d of [p.home, p.agentsDir, p.engineDir, p.logsDir]) mkdirSync(d, { recursive: true });
}

/** The text files of the layout before standalone agents. Databases, sandboxes and logs are not copied (they stay where they are). */
const OLD_LAYOUT = ["config.json", ".env", "SOUL.md", "prompts", "memory", "skills", ".agents"];

/**
 * Once: copies what the old layout had to backup/v1-<time>/ so nothing of it is lost, and leaves the originals untouched. Returns the backup
 * folder, or undefined when there was nothing to back up or a v1 backup already exists.
 */
export function backupOldLayout(p: HomePaths, now = new Date()): string | undefined {
  const present = OLD_LAYOUT.filter((n) => existsSync(join(p.home, n)));
  if (!present.length) return undefined;
  if (existsSync(p.backupDir) && readdirSync(p.backupDir).some((n) => n.startsWith("v1-"))) return undefined;
  const dest = join(p.backupDir, `v1-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const n of present) cpSync(join(p.home, n), join(dest, n), { recursive: true, preserveTimestamps: true });
  if (existsSync(join(dest, ".env"))) chmodSync(join(dest, ".env"), 0o600);
  return dest;
}

/** Engine boot: the home folders exist, and the old layout (if any) has been backed up. */
export function readyHome(home = eigenHome()) {
  const p = homePaths(home);
  ensureHome(p);
  backupOldLayout(p);
  return p;
}
