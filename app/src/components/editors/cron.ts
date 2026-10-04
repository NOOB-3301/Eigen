/**
 * Five-field cron expressions, for the trigger form. Pure (no React, no imports) so a node script can check it.
 *
 * The engine schedules with croner; checkCron follows croner's rules for the shapes people actually type (numbers, lists, ranges,
 * star-slash-n and a-b/n steps, JAN and MON names) so a mistake shows while typing instead of when the agent reloads. Syntax croner also
 * understands but this file does not model (L, W, #, ?) is accepted and described as a custom schedule rather than rejected.
 * The description only covers shapes it can state exactly; anything else is "Custom schedule", never a guess.
 */

export const CUSTOM_SCHEDULE = "Custom schedule";

export const CRON_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 08:00", cron: "0 8 * * 1" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
] as const;

export type CronCheck = { ok: true; description: string } | { ok: false; error: string };

/** `len` is croner's table size for the field: it bounds a step (a step larger than the field is an error). */
const FIELDS = [
  { name: "minute", min: 0, max: 59, len: 60 },
  { name: "hour", min: 0, max: 23, len: 24 },
  { name: "day of month", min: 1, max: 31, len: 31 },
  { name: "month", min: 1, max: 12, len: 12 },
  { name: "weekday", min: 0, max: 7, len: 7 },
] as const;
type Spec = (typeof FIELDS)[number];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

class CronError extends Error {}

type Field = {
  /** Every value the field matches (weekday 7 folded into 0). */
  set: Set<number>;
  /** Written as a bare "*", which cron treats differently from a field that merely covers everything (day of month vs weekday). */
  star: boolean;
  /** L, W, # or ?: valid for croner, but not modelled here. */
  special: boolean;
};

const monthNames = (s: string) => s.replace(/jan/gi, "1").replace(/feb/gi, "2").replace(/mar/gi, "3").replace(/apr/gi, "4").replace(/may/gi, "5").replace(/jun/gi, "6").replace(/jul/gi, "7").replace(/aug/gi, "8").replace(/sep/gi, "9").replace(/oct/gi, "10").replace(/nov/gi, "11").replace(/dec/gi, "12");
// "-SUN" ends a range (FRI-SUN is 5-7), a lone SUN is 0: the same order croner replaces them in.
const dayNames = (s: string) => s.replace(/-sun/gi, "-7").replace(/sun/gi, "0").replace(/mon/gi, "1").replace(/tue/gi, "2").replace(/wed/gi, "3").replace(/thu/gi, "4").replace(/fri/gi, "5").replace(/sat/gi, "6");

function parseField(raw: string, index: number): Field {
  const spec = FIELDS[index]!;
  let text = raw;
  if (index === 3 && text.length >= 3) text = monthNames(text);
  if (index === 4 && text.length >= 3) text = dayNames(text);

  // "?", a "+" in front of the weekday (day AND weekday) and the L, W and # forms below are valid for croner. They are accepted, just not described.
  let special = text === "?";
  if (special) return { set: new Set(), star: false, special };
  if (index === 4 && text.startsWith("+")) {
    special = true;
    text = text.slice(1);
  }

  // Weekday 7 is Sunday, same as 0.
  const fold = (v: number) => (index === 4 && v === 7 ? 0 : v);
  const set = new Set<number>();
  const num = (s: string) => {
    const n = Number(s);
    if (!/^\d+$/.test(s)) throw new CronError(`${spec.name}: "${s}" is not a number`);
    if (n < spec.min || n > spec.max) throw new CronError(`${spec.name}: ${n} is outside ${spec.min}-${spec.max}${index === 4 ? " (0 and 7 are both Sunday)" : ""}`);
    return n;
  };
  const step = (s: string) => {
    if (!/^\d+$/.test(s)) throw new CronError(`${spec.name}: "${s}" is not a valid step`);
    const n = Number(s);
    if (n === 0) throw new CronError(`${spec.name}: a step of 0 is not allowed`);
    if (n > spec.len) throw new CronError(`${spec.name}: a step of ${n} is larger than the field`);
    return n;
  };
  const part = (p: string) => {
    if (p === "") throw new CronError(`${spec.name}: empty entry, check for a stray comma`);
    // Last day (L, LW), nearest weekday (15W), nth weekday (5#2) and last weekday of the month (5L).
    const odd = index === 2 ? /^(?:LW?|(\d+)W)$/i.exec(p) : index === 4 ? /^(\d+)(?:#[1-5]|L)$/i.exec(p) : null;
    if (odd) {
      if (odd[1]) num(odd[1]);
      special = true;
      return;
    }
    if (!/^[/*0-9-]+$/.test(p)) throw new CronError(`${spec.name}: "${p}" has characters cron does not accept`);
    if (p === "*") {
      for (let v = spec.min; v < spec.min + spec.len; v++) set.add(fold(v));
      return;
    }
    const [body = "", stepText, ...extra] = p.split("/");
    if (extra.length) throw new CronError(`${spec.name}: "${p}" has more than one "/"`);
    let from: number;
    let to: number;
    if (body === "*") {
      from = spec.min;
      to = spec.min + spec.len - 1;
    } else if (body.includes("-")) {
      const [a = "", b = "", ...more] = body.split("-");
      if (more.length) throw new CronError(`${spec.name}: "${p}" is not a valid range`);
      from = num(a);
      to = num(b);
      if (from > to) throw new CronError(`${spec.name}: the range ${body} runs backwards`);
    } else {
      if (stepText !== undefined) throw new CronError(`${spec.name}: "${p}" needs */${stepText} or a range such as 0-30/${stepText}`);
      const v = num(body);
      set.add(fold(v));
      return;
    }
    const by = stepText === undefined ? 1 : step(stepText);
    for (let v = from; v <= to; v += by) set.add(fold(v));
  };
  for (const p of text.split(",")) part(p);
  return { set, star: text === "*", special };
}

type Parsed = Field[];

function parse(expr: string): Parsed {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError(`Five fields are needed (minute, hour, day of month, month, weekday); this has ${parts.length}`);
  return parts.map((p, i) => parseField(p, i));
}

/* ---------------------------------------------------------------------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const asc = (s: Iterable<number>) => [...s].sort((a, b) => a - b);
const join = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const ordinal = (n: number) => {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
};
const consecutive = (xs: number[]) => xs.length >= 2 && xs.every((x, i) => i === 0 || x === xs[i - 1]! + 1);
/** The N when the set is exactly {start, start+N, ...} up to `limit` (exclusive), N >= 2; otherwise 0. */
const stepOf = (xs: number[], start: number, limit: number) => {
  if (xs.length < 2 || xs[0] !== start) return 0;
  const n = xs[1]! - xs[0]!;
  const want: number[] = [];
  for (let v = start; v < limit; v += n) want.push(v);
  return n >= 2 && want.length === xs.length && want.every((v, i) => v === xs[i]) ? n : 0;
};
const full = (f: Field, spec: Spec) => f.set.size >= spec.len;

type TimePhrase = { kind: "clock" | "repeat"; text: string };

function describeTime(minute: Field, hour: Field): TimePhrase | undefined {
  const M = asc(minute.set);
  const H = asc(hour.set);
  const anyM = full(minute, FIELDS[0]);
  const anyH = full(hour, FIELDS[1]);
  const clock = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

  if (anyM && anyH) return { kind: "repeat", text: "Every minute" };
  if (anyM) return consecutive(H) || H.length === 1 ? { kind: "repeat", text: `Every minute from ${clock(H[0]!, 0)} to ${clock(H.at(-1)!, 59)}` } : undefined;

  const everyMinutes = stepOf(M, 0, 60);
  if (anyH) {
    if (everyMinutes && 60 % everyMinutes === 0) return { kind: "repeat", text: `Every ${everyMinutes} minutes` };
    if (M.length === 1) return { kind: "repeat", text: M[0] === 0 ? "Every hour, on the hour" : `Every hour at minute ${M[0]}` };
    return M.length <= 4 ? { kind: "repeat", text: `Every hour at minutes ${join(M.map(String))}` } : undefined;
  }

  const everyHours = stepOf(H, 0, 24);
  if (M.length === 1 && everyHours && 24 % everyHours === 0) return { kind: "repeat", text: `Every ${everyHours} hours${M[0] === 0 ? "" : ` at minute ${M[0]}`}` };
  if (M.length * H.length <= 6) return { kind: "clock", text: join(H.flatMap((h) => M.map((m) => clock(h, m)))) };
  if (consecutive(H) && M.length === 1) return { kind: "repeat", text: `Every hour from ${clock(H[0]!, M[0]!)} to ${clock(H.at(-1)!, M[0]!)}` };
  if (consecutive(H) && everyMinutes && 60 % everyMinutes === 0) return { kind: "repeat", text: `Every ${everyMinutes} minutes from ${clock(H[0]!, M[0]!)} to ${clock(H.at(-1)!, M.at(-1)!)}` };
  return undefined;
}

type DatePhrase = { every: string; on: string };

function describeDate(dom: Field, month: Field, dow: Field): DatePhrase | undefined {
  const anyDom = dom.star || full(dom, FIELDS[2]);
  const anyDow = dow.star || full(dow, FIELDS[4]);
  const anyMonth = full(month, FIELDS[3]);
  // Day of month and weekday both restricted means "either" in cron, which a plain sentence gets wrong. Left to the caller to call custom.
  if (!dom.star && !dow.star) return undefined;
  const M = asc(month.set);
  const monthText = anyMonth ? "" : consecutive(M) && M.length >= 3 ? `from ${MONTHS[M[0]! - 1]} to ${MONTHS[M.at(-1)! - 1]}` : `in ${join(M.map((m) => MONTHS[m - 1]!))}`;

  if (!anyDow) {
    // Monday first: that is how people read a week.
    const D = asc(dow.set).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const names = D.map((d) => DAYS[d]!);
    const run = D.every((d, i) => i === 0 || (d + 6) % 7 === ((D[i - 1]! + 6) % 7) + 1);
    let phrase: DatePhrase;
    if (D.length === 5 && D.join() === "1,2,3,4,5") phrase = { every: "Every weekday", on: "on weekdays" };
    else if (run && D.length >= 3) phrase = { every: `${names[0]} to ${names.at(-1)}`, on: `from ${names[0]} to ${names.at(-1)}` };
    else phrase = { every: `Every ${join(names)}`, on: `on ${join(names.map((n) => `${n}s`))}` };
    return monthText ? { every: `${phrase.every} ${monthText}`, on: `${phrase.on} ${monthText}` } : phrase;
  }

  if (!anyDom) {
    const days = asc(dom.set);
    const list = days.length <= 3 ? `the ${join(days.map(ordinal))}` : consecutive(days) ? `days ${days[0]} to ${days.at(-1)}` : days.length <= 5 ? `the ${join(days.map(ordinal))}` : undefined;
    if (!list) return undefined;
    const of = anyMonth ? "of every month" : consecutive(M) && M.length >= 3 ? `of every month ${monthText}` : `of ${join(M.map((m) => MONTHS[m - 1]!))}`;
    return { every: `On ${list} ${of}`, on: `on ${list} ${of}` };
  }

  return monthText ? { every: `Every day ${monthText}`, on: monthText } : { every: "Every day", on: "" };
}

/** Validates the expression and, when it can be stated exactly, describes it in English ("Every weekday at 09:00"). */
export function checkCron(expr: string): CronCheck {
  let fields: Parsed;
  try {
    fields = parse(expr);
  } catch (e) {
    if (e instanceof CronError) return { ok: false, error: e.message };
    throw e;
  }
  if (fields.some((f) => f.special)) return { ok: true, description: CUSTOM_SCHEDULE };
  const [minute, hour, dom, month, dow] = fields as [Field, Field, Field, Field, Field];
  const time = describeTime(minute, hour);
  const date = describeDate(dom, month, dow);
  if (!time || !date) return { ok: true, description: CUSTOM_SCHEDULE };
  return { ok: true, description: time.kind === "clock" ? `${date.every} at ${time.text}` : `${time.text}${date.on ? ` ${date.on}` : ""}` };
}

/** True when `zone` is an IANA time zone this runtime knows (the same test the engine applies). */
export function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
