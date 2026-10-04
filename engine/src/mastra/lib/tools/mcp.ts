import { MCPClient } from "@mastra/mcp";
import { isEmpty, mapValues, omitBy } from "lodash-es";
import { isRemote, resolveEnvRefs, type Config, type McpServer } from "../config.ts";

type Tools = Awaited<ReturnType<MCPClient["listTools"]>>;
export type McpState = { tools: Tools; errors: Record<string, string>; servers: string[] };

const EMPTY: McpState = { tools: {}, errors: {}, servers: [] };

/** Untrusted servers need a Telegram tap per call. Stdio servers get the SDK's small default env (no eigen secrets) plus their own. */
const definition = (s: McpServer, env: NodeJS.ProcessEnv) =>
  isRemote(s)
    ? {
        url: new URL(s.url),
        requestInit: s.headers ? { headers: resolveEnvRefs(s.headers, env) } : undefined,
        allowedHosts: [new URL(s.url).host],
        requireToolApproval: !s.trusted,
      }
    : { command: s.command, args: s.args, env: resolveEnvRefs(s.env, env), stderr: "ignore" as const, requireToolApproval: !s.trusted };

/** A server that fails to start is reported in `errors`; the rest keep working. */
export function makeMcp(env: NodeJS.ProcessEnv = process.env) {
  let client: MCPClient | undefined;
  let state = EMPTY;
  let generation = 0;

  const close = async () => {
    const old = client;
    client = undefined;
    await old?.disconnect().catch(() => undefined);
  };

  const reload = async (cfg: Config): Promise<McpState> => {
    await close();
    const servers = omitBy(cfg.mcpServers, (s) => !s.enabled);
    if (!cfg.mcp.enabled || isEmpty(servers)) return (state = EMPTY);
    const next = new MCPClient({ id: `eigen-${++generation}`, servers: mapValues(servers, (s) => definition(s, env)), timeout: cfg.mcp.startupTimeoutMs });
    client = next;
    const { tools, errors } = await next.listToolsWithErrors({ perServerTimeoutMs: cfg.mcp.startupTimeoutMs }).catch((e) => ({ tools: {} as Tools, errors: { mcp: String(e) } }));
    return (state = { tools, errors, servers: Object.keys(servers) });
  };

  /** Serialized: the config watcher and /reload_mcp can overlap, and a reload must never close a client another is still listing. */
  let pending: Promise<unknown> = Promise.resolve();
  const load = (cfg: Config): Promise<McpState> => {
    const run = pending.then(() => reload(cfg), () => reload(cfg));
    pending = run.catch(() => undefined);
    return run;
  };

  return { load, close, state: () => state, tools: () => state.tools };
}

export type Mcp = ReturnType<typeof makeMcp>;
