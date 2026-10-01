const RISKY: RegExp[] = [
  /\brm\s+-\w*[rR]/,
  /\brm\s+--recursive\b/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\bmkfs\b|\bdd\s+if=/,
  /\bchmod\s+(-\w*R|--recursive)\b/,
  /\bclawhub\b[^;&|]*\b(install|update|uninstall|pin|unpin|publish|delete|login|sync)\b/,
];

/** Commands that need a Telegram tap. A speed bump, not a boundary: containment is the real control. */
export const needsApproval = (command: string) => RISKY.some((re) => re.test(command));
