import { AgentConfigSchema, TRIGGER_PLACEHOLDERS, agentProblems, type AgentConfig } from "@eigen/engine/schema";

/*
 * The studio's own check of an agent draft, run in the browser on every keystroke so Apply is blocked with readable messages before the
 * server refuses. Same rules as the server: AgentConfigSchema, then agentProblems. Pure (no `@/` imports) so it is tested directly.
 */

export type Validation = { ok: boolean; issues: string[]; byPath: Record<string, string> };

/** zod's wording for the common cases, in the words a form uses. */
function humanize(message: string): string {
  if (/^Too small: expected string to have >=1 characters?$/.test(message)) return "required";
  if (/^Invalid input: expected \w+, received undefined$/.test(message)) return "required";
  if (/^Too small: expected number to be >0$/.test(message)) return "must be a positive whole number";
  if (/^Invalid input: expected int, received number$/.test(message)) return "must be a whole number";
  return message;
}

/** agentProblems speaks of triggers by id and of the bot as a whole; the forms key their fields by index and by field. */
function problemPath(config: AgentConfig, path: string): string {
  if (path === "telegram") return "telegram.allowedUserIds";
  const m = /^triggers\.([^.]+)\.(.+)$/.exec(path);
  if (m) {
    const i = config.triggers.findIndex((t) => t.id === m[1]);
    if (i >= 0) return `triggers.${i}.${m[2]}`;
  }
  return path;
}

export function validateDraft(id: string, config: unknown): Validation {
  const byPath: Record<string, string> = {};
  const issues: string[] = [];
  const add = (path: string, msg: string) => {
    issues.push(`${path || "config"}: ${msg}`);
    byPath[path] ??= msg;
  };
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) {
    for (const i of r.error.issues) add(i.path.join("."), humanize(i.message));
    return { ok: false, issues, byPath };
  }
  const a = r.data;
  if (a.id !== id) add("id", `must equal the folder name "${id}"`);
  for (const p of agentProblems(a)) {
    const m = /^([\w.-]+): (.*)$/.exec(p);
    if (m) add(problemPath(a, m[1]!), m[2]!);
    else add("", p);
  }
  return { ok: issues.length === 0, issues, byPath };
}

/**
 * Things that save fine but probably do not do what the user means, as "path: message" strings (feed them to issuesByPath).
 * Never blocks a save. Empty for a draft that does not parse: validateDraft reports those.
 */
export function warnings(config: unknown): string[] {
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) return [];
  const a = r.data;
  const out: string[] = [];
  const someSkills = a.skills.enabled === "all" || a.skills.enabled.length > 0;
  if (someSkills && !a.tools.builtin.includes("workspace")) out.push("skills.enabled: skills load through the workspace tool; connect it or this agent cannot use them");
  a.triggers.forEach((t, i) => {
    const known = new Set<string>(TRIGGER_PLACEHOLDERS[t.type]);
    const unknown = [...t.prompt.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!).filter((n) => !known.has(n));
    if (unknown.length) out.push(`triggers.${i}.prompt: {{${unknown[0]}}} is not filled in for a ${t.type} trigger (use ${[...known].map((n) => `{{${n}}}`).join(", ")})`);
    if (t.enabled && t.deliverToTelegram && !a.telegram.enabled) out.push(`triggers.${i}.deliverToTelegram: this agent has no Telegram bot, so replies stay in the run log`);
  });
  return out;
}

/** Server issues come back as "path: message"; split them so fields can show their own. */
export function issuesByPath(issues: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const m = /^([\w.-]+): (.*)$/.exec(i);
    if (m) out[m[1]!] ??= m[2]!;
  }
  return out;
}
