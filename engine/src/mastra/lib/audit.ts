import { appendFileSync } from "node:fs";
import { truncate } from "lodash-es";
import { redact } from "./secrets.ts";
import { dayjs } from "./time.ts";

const clean = (_key: string, v: unknown) => (typeof v === "string" ? truncate(redact(v), { length: 2000 }) : v);

/** One JSON line per event; secrets redacted, long strings cut. Never throws. */
export function appendAudit(file: string, entry: Record<string, unknown>) {
  try {
    appendFileSync(file, `${JSON.stringify({ ts: dayjs().toISOString(), ...entry }, clean)}\n`);
  } catch {}
}
