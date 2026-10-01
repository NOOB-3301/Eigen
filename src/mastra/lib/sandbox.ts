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

type Detect = () => { backend: string; available: boolean; message: string };

/** "auto" must find a real backend; it never silently falls back to running unisolated. */
export function resolveIsolation(mode: Config["sandbox"]["isolation"], detect: Detect = () => LocalSandbox.detectIsolation()) {
  if (mode !== "auto") return mode;
  const found = detect();
  if (!found.available) throw new Error(`no OS isolation available: ${found.message}\nInstall it, or set sandbox.isolation to "none" in config.json.`);
  return found.backend as "seatbelt" | "bwrap";
}

export const makeSandbox = (p: HomePaths, cfg: Config, isolation = resolveIsolation(cfg.sandbox.isolation)) =>
  new LocalSandbox({
    workingDirectory: p.sandboxDir,
    env: sandboxEnv(p),
    timeout: cfg.sandbox.commandTimeoutMs,
    isolation,
    nativeSandbox: {
      allowNetwork: cfg.sandbox.allowNetwork,
      readWritePaths: cfg.sandbox.readWritePaths.map(expandHome),
      readOnlyPaths: cfg.sandbox.readOnlyPaths.map(expandHome),
      ...(isolation === "seatbelt" && { seatbeltProfilePath: writeSeatbeltProfile(p, cfg) }),
    },
  });

/** Can a sandboxed command read the file holding your tokens? Run on /status, because the macOS rules can't be tested off a Mac. */
export async function secretsHidden(sandbox: LocalSandbox, p: HomePaths) {
  const r = await sandbox.executeCommand?.("cat", [p.envFile]).catch(() => undefined);
  return r ? r.exitCode !== 0 : undefined;
}
