import { AgentConfigSchema, TRIGGER_PLACEHOLDERS, type AgentConfig } from "@eigen/engine/schema";
import type { RootInfo } from "@/lib/types";

export type Validation = { ok: boolean; issues: string[]; byPath: Record<string, string> };

const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Same checks as the store's validateAgent (schema + references), run in the browser on every keystroke. */
export function validateDraft(id: string, config: unknown, root?: RootInfo): Validation {
  const byPath: Record<string, string> = {};
  const issues: string[] = [];
  const add = (path: string, msg: string) => {
    issues.push(`${path || "config"}: ${msg}`);
    byPath[path] ??= msg;
  };
  const r = AgentConfigSchema.safeParse(config);
  if (!r.success) {
    // zod words an empty required string as "Too small: expected string to have >=1 characters"; say what is wrong instead.
    for (const i of r.error.issues) add(i.path.join("."), /^Too small: expected string to have >=1 characters?$/.test(i.message) ? "required" : i.message);
    return { ok: false, issues, byPath };
  }
  const a = r.data;
  if (a.id !== id) add("id", `must equal the folder name "${id}"`);
  const tg = a.telegram;
  if (tg.enabled && !a.primary && !tg.tokenEnv) add("telegram.tokenEnv", "name the .env variable that holds this bot's token");
  if (tg.enabled && !a.primary) {
    const ids = tg.allowedUserIds ?? root?.telegram?.allowedUserIds;
    if (ids && ids.length === 0) add("telegram.allowedUserIds", tg.allowedUserIds ? "add at least one Telegram user id, or reset to inherit the root list" : "the root list is empty: add user ids in Settings, or override them here");
  }
  // Same check as agentProblems: an unknown zone would make the cron trigger fail at load time.
  a.triggers.forEach((t, i) => {
    if (t.type === "cron" && t.timezone && !validTimezone(t.timezone)) add(`triggers.${i}.timezone`, `"${t.timezone}" is not a time zone`);
  });
  if (root) {
    const models = new Set(root.models.map((m) => m.key));
    const servers = new Set(root.mcpServers.map((s) => s.name));
    if (a.model && !models.has(a.model)) add("model", `"${a.model}" is not a root model`);
    const inherit = a.tools.mcp.inherit;
    if (Array.isArray(inherit)) inherit.filter((n) => !servers.has(n)).forEach((n) => add("tools.mcp.inherit", `"${n}" is not a root MCP server`));
    Object.keys(a.tools.mcp.servers)
      .filter((n) => servers.has(n))
      .forEach((n) => add(`tools.mcp.servers.${n}`, "shadows a root MCP server; rename it"));
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
  const a: AgentConfig = r.data;
  const out: string[] = [];
  if (Array.isArray(a.skills.inherit) && a.skills.inherit.length && !a.tools.builtin.includes("workspace"))
    out.push("skills.inherit: skills load through the workspace tool; turn it on or this agent cannot use them");
  const botOff = a.telegram.enabled === false || (a.telegram.enabled === undefined && !a.primary);
  a.triggers.forEach((t, i) => {
    const known = new Set<string>(TRIGGER_PLACEHOLDERS[t.type]);
    const unknown = [...t.prompt.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!).filter((n) => !known.has(n));
    if (unknown.length) out.push(`triggers.${i}.prompt: {{${unknown[0]}}} is not filled in for a ${t.type} trigger (use ${[...known].map((n) => `{{${n}}}`).join(", ")})`);
    if (t.enabled && t.deliverToTelegram && botOff) out.push(`triggers.${i}.deliverToTelegram: this agent has no Telegram bot, so replies stay in the run log`);
  });
  return out;
}

/** Server issues come back as "path: message"; split them so fields can show their own. */
export function issuesByPath(issues: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const m = /^([\w.]+): (.*)$/.exec(i);
    if (m) out[m[1]!] ??= m[2]!;
  }
  return out;
}
