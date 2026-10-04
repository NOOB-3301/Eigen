import { ENV_NAME } from "@eigen/engine/schema";

/** `?names=A,B`: names typed into a form but not saved yet, so their status shows too. Only valid names, at most 50. */
export const extraNames = (url: string): string[] =>
  (new URL(url).searchParams.get("names") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((n) => ENV_NAME.test(n))
    .slice(0, 50);

/** The message of a refused write, with the value cut out in case a rule ever quoted it. */
export function refusalOf(e: unknown, value: string) {
  const msg = e instanceof Error ? e.message : "could not store the value";
  // A very short value would match ordinary words; the envfile rules never quote a value anyway.
  return (value.length >= 6 ? msg.replaceAll(value, "[value]") : msg).slice(0, 200);
}
