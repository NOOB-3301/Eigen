export const SECRET_RE =
  /(TOKEN|SECRET|API_?KEY|API_TOKEN|PASSWORD)\s*[:=]\s*\S+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|moltbook_sk_[A-Za-z0-9_-]{16,}|fc-[0-9a-f]{24,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi;

export const hasSecret = (text: string) => new RegExp(SECRET_RE.source, "i").test(text);

export const redact = (text: string) => text.replace(SECRET_RE, "[redacted]");

/** Redacts every string inside a structure (message parts, tool args and results) without touching its shape, so JSON stays valid. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}
