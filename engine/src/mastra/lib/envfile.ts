/**
 * One agent's .env (~/.eigen/agents/<id>/.env), on behalf of the studio and the engine (`@eigen/engine/envfile`, server-side only).
 * Every function takes the path of that file: there is no shared .env.
 *
 * WRITE-ONLY by design: the studio can set or remove a value and can ask whether a name is set, but nothing here hands a
 * value back to a caller outside the engine (`readEnvFile` is for the engine, which gives each agent its own values). Config files
 * hold only the NAME of a variable, never the secret. Other lines in the file (comments, unknown variables) are left as they are.
 * Nothing is ever copied into process.env: one agent's key must never reach another agent, a sandbox command, or an MCP server it did not name.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const keyOf = (line: string) => LINE.exec(line)?.[1];

/** Sets NAME to value. Replaces the last existing line for NAME (and drops earlier duplicates), else appends. The file stays 0600. */
export function setSecret(file: string, name: string, value: string) {
  assertName(name);
  const entry = `${name}=${formatValue(value)}`;
  const lines = readText(file).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const last = lines.findLastIndex((l) => keyOf(l) === name);
  const next = last === -1 ? [...lines, entry] : lines.flatMap((l, i) => (i === last ? [entry] : keyOf(l) === name ? [] : [l]));
  writeText(file, `${next.join("\n")}\n`);
}

/** Removes every line for NAME. Returns false when there was none. */
export function unsetSecret(file: string, name: string): boolean {
  assertName(name);
  const lines = readText(file).split("\n");
  const kept = lines.filter((l) => keyOf(l) !== name);
  if (kept.length === lines.length) return false;
  writeText(file, kept.join("\n"));
  return true;
}

/**
 * For the studio: is each referenced name set (non-empty) in the agent's .env? Names set in the file but referenced by nothing are listed too
 * (usedBy: []), so a stale key can be seen and removed. Never returns a value.
 */
export function secretStatuses(file: string, referenced: Map<string, string[]>): SecretStatus[] {
  const values = parseEnv(readText(file));
  const names = new Set([...referenced.keys(), ...[...values.keys()].filter((n) => ENV_NAME.test(n))]);
  return [...names].map((name) => ({ name, set: !!values.get(name), usedBy: referenced.get(name) ?? [] })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Engine side: the agent's variables, read fresh. Empty when the file is missing. The caller keeps them to that agent. */
export const readEnvFile = (file: string): ReadonlyMap<string, string> => parseEnv(readText(file));
