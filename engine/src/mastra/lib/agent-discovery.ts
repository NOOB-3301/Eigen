import { readFileSync, existsSync, readdirSync, watch, FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homePaths, type HomePaths } from './home.ts';
import { parseAgentConfig, configToMetadata, type AgentConfig, type AgentMetadata } from './agent-schema.ts';

export interface DiscoveredAgent {
  config: AgentConfig;
  metadata: AgentMetadata;
  configPath: string;
}

/**
 * Discover all agents in ~/.eigen/.agents/ directories.
 * Each agent has a config.json file.
 */
export function discoverAgents(p: HomePaths = homePaths()): DiscoveredAgent[] {
  const agentsDir = join(p.home, '.agents');
  const agents: DiscoveredAgent[] = [];

  if (!existsSync(agentsDir)) return agents;

  for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const configPath = join(agentsDir, dir.name, 'config.json');
    if (!existsSync(configPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      const config = parseAgentConfig(raw);
      const metadata = configToMetadata(config);

      agents.push({ config, metadata, configPath });
    } catch (e) {
      console.error(`Failed to load agent ${dir.name}:`, e);
    }
  }

  return agents;
}

/**
 * Watch for agent config changes and call the callback on changes.
 * Returns an unwatch function.
 */
export function watchAgents(
  onChange: (agents: DiscoveredAgent[]) => void,
  p: HomePaths = homePaths(),
): () => void {
  const agentsDir = join(p.home, '.agents');

  let debounceTimeout: NodeJS.Timeout;
  const notifyChange = () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      onChange(discoverAgents(p));
    }, 500);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(agentsDir, { recursive: true }, notifyChange);
  } catch {
    // If agents dir doesn't exist yet, return a no-op unwatcher
    return () => {};
  }

  return () => {
    watcher.close();
    clearTimeout(debounceTimeout);
  };
}
