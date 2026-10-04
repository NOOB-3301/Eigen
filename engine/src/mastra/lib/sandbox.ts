/**
 * One agent's sandbox: where its shell runs and what it can see. It works in the agent's sandbox/ folder and never sees the rest of
 * EIGEN_HOME: not its own .env, config.json, memory.db or data/, and not any other agent. Only its skills (read-only) are visible besides.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import { pick, uniq } from "lodash-es";
import { expandHome, type AgentPaths } from "./home.ts";
import type { ResolvedAgent } from "./schema.ts";
import { builtinSkillsDir } from "./skills.ts";
import { writeSeatbeltProfile, type Reach } from "./seatbelt.ts";

export type SandboxPolicy = ResolvedAgent["sandbox"];
export type SandboxPaths = Pick<AgentPaths, "dir" | "sandboxDir" | "sandboxHomeDir" | "skillsDir" | "dataDir" | "envFile">;

const PASSTHROUGH = ["LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];

/** The only environment a sandboxed command sees: no API keys, no bot token; HOME and caches stay inside the sandbox. */
export const sandboxEnv = (p: Pick<AgentPaths, "sandboxDir" | "sandboxHomeDir">, base: NodeJS.ProcessEnv = process.env) => ({
  ...pick(base, PASSTHROUGH),
  PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: p.sandboxHomeDir,
  TMPDIR: join(p.sandboxHomeDir, "tmp"),
  TERM: "dumb",
  CLAWHUB_WORKDIR: p.sandboxDir,
  CLAWHUB_CONFIG_PATH: join(p.sandboxHomeDir, "clawhub.json"),
  CLAWHUB_DISABLE_TELEMETRY: "1",
  npm_config_cache: join(p.sandboxHomeDir, ".npm"),
});

/** Names a skill's .env may not set: they change how the shell or interpreters start, or what the sandbox treats as its own. */
const PROTECTED = /^(PATH|HOME|TMPDIR|TERM|SHELL|PWD|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|PYTHON\w*|LD_\w+|DYLD_\w+|CLAWHUB_\w+|npm_config_\w+)$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=value lines, optionally with `export` and quotes; comments and anything else are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([^=\s#]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !NAME.test(m[1]!) || PROTECTED.test(m[1]!)) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Keys the agent saved for its skills in its sandbox's own .env (not the agent's .env); the sandbox's own variables always win. */
export const readSkillEnv = (p: Pick<AgentPaths, "sandboxDir">) => {
  try {
    return parseEnvFile(readFileSync(join(p.sandboxDir, ".env"), "utf8"));
  } catch {
    return {};
  }
};

const liveEnv = new WeakMap<object, NodeJS.ProcessEnv>();

/** LocalSandbox builds each command's environment from this object, so updating it in place applies to the next command with no restart. Returns the variable names now loaded. */
export function refreshSkillEnv(sandbox: object, p: Pick<AgentPaths, "sandboxDir" | "sandboxHomeDir">) {
  const env = liveEnv.get(sandbox);
  if (!env) return [];
  const skill = readSkillEnv(p);
  Object.keys(env).forEach((k) => delete env[k]);
  Object.assign(env, skill, sandboxEnv(p));
  return Object.keys(skill);
}

type Detect = () => { backend: string; available: boolean; message: string };

/** "auto" must find a real backend; it never silently falls back to running unisolated. */
export function resolveIsolation(mode: SandboxPolicy["isolation"], detect: Detect = () => LocalSandbox.detectIsolation()) {
  if (mode !== "auto") return mode;
  const found = detect();
  if (!found.available) throw new Error(`no OS isolation available: ${found.message}\nInstall it, or set sandbox.isolation to "none" in this agent's config.`);
  return found.backend as "seatbelt" | "bwrap";
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** EIGEN_HOME, from an agent folder (<home>/agents/<id>). */
export const eigenHomeOf = (p: Pick<AgentPaths, "dir">) => dirname(dirname(resolve(p.dir)));

/**
 * Every path the sandbox may reach, resolved. A path from the config that is inside EIGEN_HOME, or that contains it ("~", "/"), is dropped:
 * it would open another agent's folder or this agent's .env, and bwrap cannot hide a part of a folder it binds. `dropped` lists them for the log.
 */
/** `builtin`: the built-in skills folder; null for none. */
export function sandboxReach(p: SandboxPaths, policy: SandboxPolicy, builtin: string | null = builtinSkillsDir() ?? null): Reach & { dropped: string[] } {
  const home = real(eigenHomeOf(p));
  const dropped: string[] = [];
  const confine = (list: string[]) =>
    uniq(list.map((x) => real(expandHome(x)))).filter((x) => (within(home, x) || within(x, home) ? (dropped.push(x), false) : true));
  const readWrite = confine(policy.readWritePaths);
  const readOnly = uniq([real(p.skillsDir), ...(builtin && existsSync(builtin) ? [real(builtin)] : []), ...confine(policy.readOnlyPaths)]);
  return {
    home,
    sandboxDir: real(p.sandboxDir),
    readOnly,
    readWrite,
    denyRead: policy.denyReadPaths.map((d) => real(expandHome(d))),
    allowNetwork: policy.allowNetwork,
    dropped,
  };
}

export function makeSandbox(p: SandboxPaths, policy: SandboxPolicy, isolation = resolveIsolation(policy.isolation), log: (msg: string) => void = () => undefined, builtin: string | null = builtinSkillsDir() ?? null) {
  const env: NodeJS.ProcessEnv = { ...readSkillEnv(p), ...sandboxEnv(p) };
  const reach = sandboxReach(p, policy, builtin);
  if (reach.dropped.length) log(`sandbox: ignored paths that would expose eigen's home: ${reach.dropped.join(", ")}`);
  const sandbox = new LocalSandbox({
    workingDirectory: p.sandboxDir,
    env,
    timeout: policy.commandTimeoutMs,
    isolation,
    nativeSandbox: {
      allowNetwork: policy.allowNetwork,
      readWritePaths: reach.readWrite,
      readOnlyPaths: reach.readOnly,
      ...(isolation === "seatbelt" && { seatbeltProfilePath: writeSeatbeltProfile(join(p.dataDir, "seatbelt.sb"), reach) }),
    },
  });
  liveEnv.set(sandbox, env);
  return sandbox;
}

/** Can a sandboxed command read the file holding this agent's keys? Run on /status, because the macOS rules can't be tested off a Mac. */
export async function secretsHidden(sandbox: LocalSandbox, p: Pick<AgentPaths, "envFile">) {
  const r = await sandbox.executeCommand?.("cat", [p.envFile]).catch(() => undefined);
  return r ? r.exitCode !== 0 : undefined;
}
