/**
 * One agent's MCP servers (`tools.mcp`), on one client that lives as long as that version of the agent. A server's "env:NAME" values come from
 * THIS agent's .env and nowhere else, and a stdio server starts with a clean environment: PATH, HOME and what its own `env` lists.
 */
import { MCPClient } from "@mastra/mcp";
import { isEmpty, mapValues, omitBy } from "lodash-es";
import { isRemoteMcp, type McpServer } from "../schema.ts";

type Tools = Awaited<ReturnType<MCPClient["listTools"]>>;
export type McpState = { tools: Tools; errors: Record<string, string>; servers: string[] };

const EMPTY: McpState = { tools: {}, errors: {}, servers: [] };
/** MCPClient refuses a second live client with the same id, and an old version of an agent can still be closing when the new one starts. */
let generation = 0;

/** "env:NAME" values are read from the agent's .env; a name it does not set becomes "". Other values pass through. */
export const resolveEnvRefs = (values: Record<string, string> | undefined, env: ReadonlyMap<string, string>) =>
  values && mapValues(values, (v) => (v.startsWith("env:") ? (env.get(v.slice(4)) ?? "") : v));

/** The environment a stdio server starts with. Not process.env: nothing of the engine or another agent leaks into it. */
export const stdioEnv = (s: { env?: Record<string, string> }, env: ReadonlyMap<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> => ({
  PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  ...(base.HOME && { HOME: base.HOME }),
  ...resolveEnvRefs(s.env, env),
});

/** Untrusted servers need a tap per call (Approve/Deny in Telegram). */
export const serverDefinition = (s: McpServer, env: ReadonlyMap<string, string>) =>
  isRemoteMcp(s)
    ? {
        url: new URL(s.url),
        requestInit: s.headers ? { headers: resolveEnvRefs(s.headers, env) } : undefined,
        allowedHosts: [new URL(s.url).host],
        requireToolApproval: !s.trusted,
      }
    : { command: s.command, args: s.args, env: stdioEnv(s, env), inheritDefaultEnv: false, stderr: "ignore" as const, requireToolApproval: !s.trusted };

export type AgentMcp = { state: McpState; tools: () => Tools; close: () => Promise<void> };

/** Starts the agent's enabled servers. A server that fails to start is reported in `errors`; the rest keep working. Never throws. */
export async function startMcp(id: string, servers: Record<string, McpServer>, env: ReadonlyMap<string, string>, timeoutMs: number): Promise<AgentMcp> {
  const enabled = omitBy(servers, (s) => !s.enabled);
  if (isEmpty(enabled)) return { state: EMPTY, tools: () => ({}), close: async () => undefined };
  const client = new MCPClient({ id: `agent-${id}-${++generation}`, servers: mapValues(enabled, (s) => serverDefinition(s, env)), timeout: timeoutMs });
  const { tools, errors } = await client
    .listToolsWithErrors({ perServerTimeoutMs: timeoutMs })
    .catch((e: unknown) => ({ tools: {} as Tools, errors: { mcp: String((e as Error)?.message ?? e) } as Record<string, string> }));
  const state = { tools, errors, servers: Object.keys(enabled) };
  return { state, tools: () => state.tools, close: () => client.disconnect().catch(() => undefined) };
}
