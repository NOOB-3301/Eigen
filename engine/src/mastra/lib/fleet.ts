/**
 * The process-wide agent registry, shared by the HTTP routes (server.ts). Mastra has no boot hook with a Mastra handle, so the registry is
 * attached from route setup, which runs while Mastra builds the HTTP server at boot. The engine starts with zero agents and serves; every
 * agent is a folder under ~/.eigen/agents/ that the registry builds, replaces and removes while it runs.
 */
import logger from "../logger.ts";
import { createAgentRegistry } from "./agents.ts";
import { readyHome } from "./home.ts";
import { tuneNetwork } from "./network.ts";

tuneNetwork(); // before anything connects: the bots, the model APIs, MCP

export const paths = readyHome();

export const registry = createAgentRegistry({
  paths,
  log: (msg, extra) => logger.warn(`agents: ${msg}`, { error: extra instanceof Error ? extra.message : extra }),
});

registry.watch();
