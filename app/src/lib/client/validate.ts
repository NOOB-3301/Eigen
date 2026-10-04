import { AgentConfigSchema } from "@eigen/engine/schema";
import type { RootInfo } from "@/lib/types";

export type Validation = { ok: boolean; issues: string[]; byPath: Record<string, string> };

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
    for (const i of r.error.issues) add(i.path.join("."), i.message);
    return { ok: false, issues, byPath };
  }
  const a = r.data;
  if (a.id !== id) add("id", `must equal the folder name "${id}"`);
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

/** Server issues come back as "path: message"; split them so fields can show their own. */
export function issuesByPath(issues: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const m = /^([\w.]+): (.*)$/.exec(i);
    if (m) out[m[1]!] ??= m[2]!;
  }
  return out;
}
