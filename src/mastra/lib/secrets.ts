export const SECRET_RE = /(TOKEN|SECRET|API_?KEY|PASSWORD)\s*[:=]\s*\S+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}/gi;

export const hasSecret = (text: string) => new RegExp(SECRET_RE.source, "i").test(text);

export const redact = (text: string) => text.replace(SECRET_RE, "[redacted]");
