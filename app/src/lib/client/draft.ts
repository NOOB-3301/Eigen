/**
 * The pure core of an agent draft: what an editor holds between "open" and "save".
 * No React and no `@/` imports, so the builder's tests can import it from plain vitest.
 */

export type Obj = Record<string, unknown>;

/** What is staged for one agent: its config.json as parsed JSON, plus the two markdown files that ride along with it. */
export type Draft = { config: Obj; instructionsText: string; soulText: string };
export type Base = Draft & { etag: string };

export function getPath(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Obj)[k] : undefined), o);
}

/** Immutable set; `undefined` deletes the key (that is how a field goes back to its schema default) and prunes emptied objects. */
export function setPath(o: Obj, path: string, value: unknown): Obj {
  const [k, ...rest] = path.split(".") as [string, ...string[]];
  const copy: Obj = { ...o };
  if (!rest.length) {
    if (value === undefined) delete copy[k];
    else copy[k] = value;
    return copy;
  }
  const child = copy[k] && typeof copy[k] === "object" && !Array.isArray(copy[k]) ? (copy[k] as Obj) : {};
  const next = setPath(child, rest.join("."), value);
  if (Object.keys(next).length === 0 && value === undefined) delete copy[k];
  else copy[k] = next;
  return copy;
}

/** Key-order-independent JSON, so "dirty" means a real change. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const sameDraft = (a: Draft, b: Draft) => stable(a.config) === stable(b.config) && a.instructionsText === b.instructionsText && a.soulText === b.soulText;
