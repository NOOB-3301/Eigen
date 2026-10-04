/** Small display helpers for the editors. Pure (no React, no imports) so a node script can check them. */

/** "just now", "5 min ago", "in 2 h", "3 d ago"; older than two weeks falls back to the date. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return sec > 0 ? "in a few seconds" : "just now";
  const [n, unit] = abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86_400 ? [Math.round(abs / 3600), "h"] : abs < 14 * 86_400 ? [Math.round(abs / 86_400), "d"] : [0, ""];
  if (!unit) return new Date(t).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
  return sec > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/** The exact time, in the viewer's locale, for a tooltip. */
export const absoluteTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en", { dateStyle: "medium", timeStyle: "medium" });
};

/** "850 ms", "12 s", "3 min 4 s"; undefined when either end is missing or the clock went backwards. */
export function duration(startIso: string, endIso?: string): string | undefined {
  if (!endIso) return undefined;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** Cuts text at `max` characters without splitting a surrogate pair, and says how much was left out. */
export function clip(text: string, max: number): { text: string; hidden: number } {
  if (text.length <= max) return { text, hidden: 0 };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), hidden: text.length - end };
}

/** A polling interval for people: 60 -> "1 min", 300 -> "5 min", 3600 -> "1 h", 5400 -> "1 h 30 min". */
export function intervalLabel(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
}

/** Number of lines as an editor counts them: an empty text has none, a trailing newline does not add one. */
export const countLines = (text: string) => (text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length);
