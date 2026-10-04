import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverAgents, type DiscoveredAgent, type HomePaths } from './agent-discovery.ts';
import { parseAgentConfig } from './agent-schema.ts';

/**
 * API handlers for agent discovery, config read/write, and management.
 * Called by the Next.js app via http://localhost:4111/api/agents/...
 */

export function createAgentApiHandlers(p: HomePaths) {
  return {
    /**
     * GET /api/agents
     * Return metadata for all discovered agents
     */
    listAgents: (): Record<string, unknown>[] => {
      const agents = discoverAgents(p);
      return agents.map((a) => a.metadata);
    },

    /**
     * GET /api/agents/:id
     * Return full config for one agent
     */
    getAgent: (id: string): Record<string, unknown> => {
      const agents = discoverAgents(p);
      const found = agents.find((a) => a.config.id === id);
      if (!found) throw new Error(`Agent ${id} not found`);
      return found.config;
    },

    /**
     * PUT /api/agents/:id/config
     * Update agent config and reload from disk
     */
    updateAgentConfig: (id: string, newConfig: Record<string, unknown>): Record<string, unknown> => {
      const agents = discoverAgents(p);
      const found = agents.find((a) => a.config.id === id);
      if (!found) throw new Error(`Agent ${id} not found`);

      // Validate and parse the new config
      const config = parseAgentConfig({ id, ...newConfig });

      // Write back to disk
      writeFileSync(found.configPath, JSON.stringify(config, null, 2) + '\n');

      return config;
    },

    /**
     * DELETE /api/agents/:id
     * Remove agent (delete its config directory)
     */
    deleteAgent: (id: string): void => {
      const agents = discoverAgents(p);
      const found = agents.find((a) => a.config.id === id);
      if (!found) throw new Error(`Agent ${id} not found`);

      const agentDir = join(p.home, '.agents', id);
      rmSync(agentDir, { recursive: true, force: true });
    },

    /**
     * POST /api/agents
     * Create a new agent from a template
     */
    createAgent: (id: string, name: string, role: string): Record<string, unknown> => {
      const agentDir = join(p.home, '.agents', id);
      mkdirSync(agentDir, { recursive: true });

      const defaultConfig = {
        id,
        name,
        role,
        description: '',
        enabled: true,
        model: 'anthropic/claude-sonnet-5-5',
        channels: ['telegram'],
        tools: [],
      };

      const configPath = join(agentDir, 'config.json');
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');

      return defaultConfig;
    },
  };
}

export type AgentApiHandlers = ReturnType<typeof createAgentApiHandlers>;
