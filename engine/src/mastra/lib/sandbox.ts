import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import { pick } from "lodash-es";
import type { Config } from "./config.ts";
import { expandHome, type HomePaths } from "./home.ts";
import { writeSeatbeltProfile } from "./seatbelt.ts";

const PASSTHROUGH = ["LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];

/** The only environment a sandboxed command sees: no API keys, no bot token; HOME and caches stay inside the sandbox. */
export const sandboxEnv = (p: HomePaths, base: NodeJS.ProcessEnv = process.env) => ({
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

/** Keys the agent saved for its skills in the sandbox root .env; the sandbox's own variables always win. */
export const readSkillEnv = (p: HomePaths) => {
  try {
    return parseEnvFile(readFileSync(join(p.sandboxDir, ".env"), "utf8"));
  } catch {
    return {};
  }
};

const liveEnv = new WeakMap<object, NodeJS.ProcessEnv>();

/** LocalSandbox builds each command's environment from this object, so updating it in place applies to the next command with no restart. Returns the variable names now loaded. */
export function refreshSkillEnv(sandbox: object, p: HomePaths) {
  const env = liveEnv.get(sandbox);
  if (!env) return [];
  const skill = readSkillEnv(p);
  Object.keys(env).forEach((k) => delete env[k]);
  Object.assign(env, skill, sandboxEnv(p));
  return Object.keys(skill);
}

type Detect = () => { backend: string; available: boolean; message: string };

/** "auto" must find a real backend; it never silently falls back to running unisolated. */
export function resolveIsolation(mode: Config["sandbox"]["isolation"], detect: Detect = () => LocalSandbox.detectIsolation()) {
  if (mode !== "auto") return mode;
  const found = detect();
  if (!found.available) throw new Error(`no OS isolation available: ${found.message}\nInstall it, or set sandbox.isolation to "none" in config.json.`);
  return found.backend as "seatbelt" | "bwrap";
}

export function makeSandbox(p: HomePaths, cfg: Config, isolation = resolveIsolation(cfg.sandbox.isolation)) {
  const env: NodeJS.ProcessEnv = { ...readSkillEnv(p), ...sandboxEnv(p) };
  const sandbox = new LocalSandbox({
    workingDirectory: p.sandboxDir,
    env,
    timeout: cfg.sandbox.commandTimeoutMs,
    isolation,
    nativeSandbox: {
      allowNetwork: cfg.sandbox.allowNetwork,
      readWritePaths: cfg.sandbox.readWritePaths.map(expandHome),
      readOnlyPaths: cfg.sandbox.readOnlyPaths.map(expandHome),
      ...(isolation === "seatbelt" && { seatbeltProfilePath: writeSeatbeltProfile(p, cfg) }),
    },
  });
  liveEnv.set(sandbox, env);
  return sandbox;
}

/** Can a sandboxed command read the file holding your tokens? Run on /status, because the macOS rules can't be tested off a Mac. */
export async function secretsHidden(sandbox: LocalSandbox, p: HomePaths) {
  const r = await sandbox.executeCommand?.("cat", [p.envFile]).catch(() => undefined);
  return r ? r.exitCode !== 0 : undefined;
}
