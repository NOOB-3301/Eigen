'use client';

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import useSWR from 'swr';
import type { AgentMetadata, OrchestratorState } from '@/types/agent';

interface OrchestratorContextType extends OrchestratorState {
  refreshAgents: () => void;
  selectAgent: (id: string) => void;
  updateAgentConfig: (id: string, config: Record<string, unknown>) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
}

const OrchestratorContext = createContext<OrchestratorContextType | undefined>(undefined);

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const [selectedAgent, setSelectedAgent] = useState<string>();
  const { data: agents = [], isLoading, error, mutate } = useSWR<AgentMetadata[]>(
    '/api/agents',
    fetcher,
    { refreshInterval: 2000 }
  );

  const refreshAgents = useCallback(() => {
    mutate();
  }, [mutate]);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgent(id);
  }, []);

  const updateAgentConfig = useCallback(
    async (id: string, config: Record<string, unknown>) => {
      const res = await fetch(`/api/agents/${id}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`Failed to update agent ${id}`);
      mutate();
    },
    [mutate]
  );

  const removeAgent = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Failed to remove agent ${id}`);
      mutate();
    },
    [mutate]
  );

  const value: OrchestratorContextType = {
    agents,
    selectedAgent,
    loading: isLoading,
    error: error?.message,
    refreshAgents,
    selectAgent,
    updateAgentConfig,
    removeAgent,
  };

  return <OrchestratorContext.Provider value={value}>{children}</OrchestratorContext.Provider>;
}

export function useOrchestrator() {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error('useOrchestrator outside OrchestratorProvider');
  return ctx;
}
