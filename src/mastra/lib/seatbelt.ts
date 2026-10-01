import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { uniq } from "lodash-es";
import type { Config } from "./config.ts";
import { expandHome, type HomePaths } from "./home.ts";

const MACH_SERVICES = [
  "com.apple.distributed_notifications@Uv3",
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.securityd.xpc",
  "com.apple.SecurityServer",
  "com.apple.trustd.agent",
];
const TEMP_DIRS = ["/private/tmp", "/var/folders", "/private/var/folders"];
const DEVICES = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"];

const q = (path: string) => JSON.stringify(path);
const sub = (path: string) => `(subpath ${q(path)})`;
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Mastra's own macOS profile allows reading every file. This is the same profile plus read denials,
 * written after the broad allow so they win. Only file contents are denied (file-read-data); stat still
 * works, so paths resolve normally. Needs checking on a Mac: /status reports whether the secrets are hidden.
 */
export function seatbeltProfile(p: HomePaths, cfg: Config, userHome = homedir()) {
  const { allowNetwork, readOnlyPaths, readWritePaths, denyReadPaths } = cfg.sandbox;
  const hidden = uniq([p.home, ...denyReadPaths.map((d) => expandHome(d.replace(/^~(?=\/|$)/, userHome)))]).map(real);
  const reachable = uniq([p.sandboxDir, p.userSkillsDir, ...readOnlyPaths.map(expandHome), ...readWritePaths.map(expandHome)]).map(real);
  return [
    "(version 1)",
    '(deny default (with message "eigen-sandbox"))',
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    `(allow mach-lookup\n${MACH_SERVICES.map((s) => `  (global-name "${s}")`).join("\n")}\n)`,
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "(allow user-preference-read)",
    "(allow sysctl-read)",
    ...DEVICES.flatMap((d) => [`(allow file-ioctl (literal ${q(d)}))`, `(allow file-write-data (literal ${q(d)}))`]),
    "(allow file-read*)",
    "; hide secrets and personal files, then re-open what the agent may use",
    ...hidden.map((d) => `(deny file-read-data ${sub(d)})`),
    ...reachable.map((d) => `(allow file-read-data ${sub(d)})`),
    ...[p.sandboxDir, ...TEMP_DIRS, ...readWritePaths.map(expandHome)].map((d) => `(allow file-write* ${sub(real(d))})`),
    allowNetwork ? "(allow network*)" : '(deny network* (with message "eigen-sandbox-network"))',
  ].join("\n");
}

/** A profile without Mastra's marker comment is used exactly as written. */
export function writeSeatbeltProfile(p: HomePaths, cfg: Config) {
  const file = join(p.dataDir, "seatbelt.sb");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, seatbeltProfile(p, cfg));
  return file;
}
