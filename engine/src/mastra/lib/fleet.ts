/**
 * The process-wide agent registry and root MCP client, shared by the primary (agents/eigen) and the HTTP routes (server.ts).
 * Mastra's file router has no boot hook with a Mastra handle, so the registry is attached from the first place one appears:
 * server.ts route setup (at boot, when the HTTP server is built) or, failing that, the primary's first `agents` resolution.
 */
import logger from "../logger.ts";
import { createAgentRegistry } from "./agents.ts";
import { readyPaths, seedAgents } from "./home.ts";
import { makeMcp } from "./tools/mcp.ts";

export const PRIMARY_ID = "eigen";

export const paths = readyPaths();
seedAgents(paths);

export const mcp = makeMcp();

export const registry = createAgentRegistry({
  paths,
  rootMcp: mcp,
  fsAgentIds: [PRIMARY_ID],
  log: (msg, extra) => logger.warn(`agents: ${msg}`, { error: extra instanceof Error ? extra.message : extra }),
});

await registry.start();
registry.watch();
