/**
 * ~/.eigen/.env on behalf of the studio (`@eigen/engine/envfile`, server-side only).
 *
 * WRITE-ONLY by design: the studio can set or remove a value and can ask whether a name is set, but nothing here hands a
 * value back to a caller outside the engine (`parseEnv` is for the engine's own reload). Config files hold only the NAME of a
 * variable, never the secret. Other lines in the file (comments, variables this module does not manage) are left as they are.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HomePaths } from "./home.ts";
import { ENV_NAME, type SecretStatus } from "./schema.ts";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
const MAX_VALUE = 4096;

/** One-way fingerprint of an env value, so "did it change?" can be asked (and hashed into an agent's version) without a value ever being held, logged or sent. */
export const valueFingerprint = (value: string | undefined) => (value === undefined ? "" : createHash("sha256").update(value).digest("hex").slice(0, 16));

/** dotenv-compatible for what this module writes: bare, 'single quoted' or "double quoted"; later lines win; ` # comment` after a bare value is dropped. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if (v.length >= 2 && (q === '"' || q === "'" || q === "`") && v.endsWith(q!)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.set(m[1]!, v);
  }
  return out;
}

/** The text to put after `NAME=`. Throws for values that cannot be stored without ambiguity (newlines, NUL, both kinds of quote). */
export function formatValue(value: string): string {
  if (!value) throw new Error("value is empty");
  if (value.length > MAX_VALUE) throw new Error(`value is longer than ${MAX_VALUE} characters`);
  if (/[\r\n\0]/.test(value)) throw new Error("value must be a single line");
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error("value has a single quote and other special characters; it cannot be stored safely in .env");
}

function assertName(name: string) {
  if (!ENV_NAME.test(name)) throw new Error(`invalid variable name "${name}" (upper-case letters, digits and "_", starting with a letter)`);
}

const readText = (p: HomePaths) => (existsSync(p.envFile) ? readFileSync(p.envFile, "utf8") : "");

function writeText(p: HomePaths, text: string) {
  mkdirSync(dirname(p.envFile), { recursive: true });
  const tmp = `${p.envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p.envFile);
}

const keyOf = (line: string) => LINE.exec(line)?.[1];

/** Sets NAME to value. Replaces the last existing line for NAME (and drops earlier duplicates), else appends. The file stays 0600. */
export function setSecret(p: HomePaths, name: string, value: string) {
  assertName(name);
  const entry = `${name}=${formatValue(value)}`;
  const lines = readText(p).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const last = lines.findLastIndex((l) => keyOf(l) === name);
  const next = last === -1 ? [...lines, entry] : lines.flatMap((l, i) => (i === last ? [entry] : keyOf(l) === name ? [] : [l]));
  writeText(p, `${next.join("\n")}\n`);
}

/** Removes every line for NAME. Returns false when there was none. */
export function unsetSecret(p: HomePaths, name: string): boolean {
  assertName(name);
  const lines = readText(p).split("\n");
  const kept = lines.filter((l) => keyOf(l) !== name);
  if (kept.length === lines.length) return false;
  writeText(p, kept.join("\n"));
  return true;
}

/** For the studio: is each referenced name set (non-empty) in .env? Never returns a value. */
export function secretStatuses(p: HomePaths, referenced: Map<string, string[]>): SecretStatus[] {
  const file = parseEnv(readText(p));
  return [...referenced].map(([name, usedBy]) => ({ name, set: !!file.get(name), usedBy })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Engine side: mirrors .env into `env` after the file changed, so a key added in the studio works without a restart.
 * `owned` remembers what we applied. A variable that came from somewhere else (the shell) and differs from the file is left
 * alone, and a variable we applied is removed again when its line disappears. Returns the names whose value changed.
 */
export function syncEnv(p: HomePaths, owned: Map<string, string>, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = parseEnv(readText(p));
  const changed: string[] = [];
  for (const [k, v] of file) {
    const cur = env[k];
    const mine = owned.get(k);
    const first = mine === undefined && cur === v; // the CLI already loaded it: adopt it
    if (cur === undefined || cur === mine || first) {
      if (cur !== v) changed.push(k);
      env[k] = v;
      owned.set(k, v);
    }
  }
  for (const [k, v] of [...owned]) {
    if (file.has(k)) continue;
    if (env[k] === v) {
      delete env[k];
      changed.push(k);
    }
    owned.delete(k);
  }
  return changed;
}
