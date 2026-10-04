export interface AgentMetadata {
  id: string;
  name: string;
  role: string;
  description: string;
  model: string;
  enabled: boolean;
  channels?: string[];
  tools?: string[];
  memory?: {
    enabled: boolean;
    type: 'working' | 'semantic' | 'observational';
  };
}

export interface AgentConfig {
  id: string;
  config: Record<string, unknown>;
  lastModified: string;
}

export interface AgentNode {
  id: string;
  type: 'agent';
  data: {
    label: string;
    role: string;
    status: 'running' | 'idle' | 'error';
  };
  position: { x: number; y: number };
}

export interface ChannelNode {
  id: string;
  type: 'channel';
  data: {
    label: string;
    platform: string;
  };
  position: { x: number; y: number };
}

export interface OrchestratorState {
  agents: AgentMetadata[];
  selectedAgent?: string;
  loading: boolean;
  error?: string;
}
