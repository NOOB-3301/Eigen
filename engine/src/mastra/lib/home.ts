import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_CONFIG_FILE, DEFAULT_PRIMARY } from "./schema.ts";

export type HomePaths = ReturnType<typeof homePaths>;

export const eigenHome = (env: NodeJS.ProcessEnv = process.env) => (env.EIGEN_HOME ? resolve(env.EIGEN_HOME) : join(homedir(), ".eigen"));

export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function homePaths(home = eigenHome()) {
  const sandboxDir = join(home, "sandbox");
  const dataDir = join(home, "data");
  const logsDir = join(home, "logs");
  return {
    home,
    configFile: join(home, "config.json"),
    /** One folder per agent: .agents/<id>/{config.json, instructions.md, sandbox/?}. */
    agentsDir: join(home, ".agents"),
    /** React Flow node positions; kept out of agent configs so dragging a node never reloads an agent. */
    topologyLayoutFile: join(dataDir, "topology-layout.json"),
    envFile: join(home, ".env"),
    soulFile: join(home, "SOUL.md"),
    systemPromptFile: join(home, "prompts", "system.md"),
    userSkillsDir: join(home, "skills"),
    sandboxDir,
    sandboxSkillsDir: join(sandboxDir, "skills"),
    sandboxQuarantineDir: join(sandboxDir, "skills-quarantine"),
    sandboxHomeDir: join(sandboxDir, ".home"),
    groundRulesFile: join(sandboxDir, "groundrules.md"),
    groundRulesHistoryDir: join(dataDir, "groundrules-history"),
    memoryDir: join(home, "memory"),
    dataDir,
    dbFile: join(dataDir, "eigen.db"),
    logsDir,
    logFile: join(logsDir, "eigen.log"),
    auditFile: join(logsDir, "audit.jsonl"),
  };
}

export function ensureDirs(p: HomePaths) {
  const dirs = [p.home, p.agentsDir, p.userSkillsDir, p.sandboxSkillsDir, join(p.sandboxHomeDir, "tmp"), p.memoryDir, p.dataDir, p.logsDir, dirname(p.systemPromptFile)];
  dirs.forEach((d) => mkdirSync(d, { recursive: true }));
}

export function readyPaths(home = eigenHome()) {
  const p = homePaths(home);
  ensureDirs(p);
  return p;
}

const SEEDS: Array<[dest: string, src: string]> = [
  ["config.json", "config.example.json"],
  [".env", "env.example"],
  ["SOUL.md", "SOUL.md"],
  ["prompts/system.md", "prompts/system.md"],
  ...["MEMORY", "profile", "projects", "people", "lessons"].map((n): [string, string] => [`memory/${n}.md`, `memory/${n}.md`]),
];

/**
 * Writes the primary's .agents/eigen/config.json when .agents/ holds no agent folder at all (fresh install, or a home from
 * before multi-agent). Never touches an existing folder, and leaves data/, memory/, sandbox/ and skills/ where they are.
 */
export function seedAgents(p: HomePaths) {
  const any = existsSync(p.agentsDir) && readdirSync(p.agentsDir, { withFileTypes: true }).some((e) => e.isDirectory() && !/^[._]/.test(e.name));
  if (any) return [];
  const rel = join(".agents", String(DEFAULT_PRIMARY.id), AGENT_CONFIG_FILE);
  mkdirSync(dirname(join(p.home, rel)), { recursive: true });
  writeFileSync(join(p.home, rel), `${JSON.stringify(DEFAULT_PRIMARY, null, 2)}\n`, { flag: "wx" });
  return [rel];
}

/** Copies missing defaults into the home dir; never overwrites. */
export function seedHome(p: HomePaths, defaultsDir: string) {
  ensureDirs(p);
  const created: string[] = [];
  for (const [dest, src] of SEEDS) {
    const to = join(p.home, dest);
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(defaultsDir, src), to);
    if (dest === ".env") chmodSync(to, 0o600);
    created.push(dest);
  }
  return [...created, ...seedAgents(p)];
}
