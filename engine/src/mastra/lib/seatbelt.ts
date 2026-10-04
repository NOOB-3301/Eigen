import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { uniq } from "lodash-es";

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

/**
 * What one agent's sandbox may touch, with every path already expanded and resolved (lib/sandbox.ts sandboxReach builds it).
 * `home` is the whole EIGEN_HOME; `readOnly` and `readWrite` never overlap it, except the agent's own skills folder in `readOnly`.
 */
export type Reach = { home: string; sandboxDir: string; readOnly: string[]; readWrite: string[]; denyRead: string[]; allowNetwork: boolean };

const q = (path: string) => JSON.stringify(path);
const sub = (path: string) => `(subpath ${q(path)})`;

/**
 * Mastra's own macOS profile allows reading every file. This is the same profile plus read denials, written after the broad allow so they win,
 * in this order: the user's personal folders (denyRead), then the paths the agent's config opens again, then the whole EIGEN_HOME (every agent's
 * .env, config.json, memory.db and data/), then the only parts of it this agent may see: its sandbox and its skills. Only file contents are
 * denied (file-read-data); stat still works, so paths resolve normally. Writes: the sandbox, temp dirs and readWrite paths, never EIGEN_HOME
 * outside the sandbox (temp dirs can contain it, as in tests).
 */
export function seatbeltProfile(r: Reach) {
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
    "; hide personal files, then re-open what the config names",
    ...uniq(r.denyRead).map((d) => `(deny file-read-data ${sub(d)})`),
    ...uniq([...r.readOnly, ...r.readWrite]).map((d) => `(allow file-read-data ${sub(d)})`),
    "; hide all of eigen's home, then re-open this agent's sandbox and skills",
    `(deny file-read-data ${sub(r.home)})`,
    ...uniq([r.sandboxDir, ...r.readOnly, ...r.readWrite]).map((d) => `(allow file-read-data ${sub(d)})`),
    ...TEMP_DIRS.map((d) => `(allow file-write* ${sub(d)})`),
    `(deny file-write* ${sub(r.home)})`,
    ...uniq([r.sandboxDir, ...r.readWrite]).map((d) => `(allow file-write* ${sub(d)})`),
    r.allowNetwork ? "(allow network*)" : '(deny network* (with message "eigen-sandbox-network"))',
  ].join("\n");
}

/** A profile without Mastra's marker comment is used exactly as written. */
export function writeSeatbeltProfile(file: string, r: Reach) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, seatbeltProfile(r));
  return file;
}
