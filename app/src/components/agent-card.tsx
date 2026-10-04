'use client';

import { motion } from 'motion/react';
import { CheckCircle, AlertCircle, Trash2 } from 'lucide-react';
import { useOrchestrator } from '@/context/orchestrator';
import type { AgentMetadata } from '@/types/agent';
import clsx from 'clsx';

interface AgentCardProps {
  agent: AgentMetadata;
  isSelected: boolean;
}

export function AgentCard({ agent, isSelected }: AgentCardProps) {
  const { selectAgent, removeAgent } = useOrchestrator();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.02 }}
      onClick={() => selectAgent(agent.id)}
      className={clsx(
        'p-3 rounded-lg border-2 cursor-pointer transition-all group',
        isSelected ? 'border-blue-500 bg-blue-950' : 'border-slate-700 bg-slate-800 hover:border-slate-600',
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-slate-100 truncate">{agent.name}</h3>
          <p className="text-xs text-slate-500 truncate">{agent.role}</p>
        </div>
        {agent.enabled ? (
          <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
        ) : (
          <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
        )}
      </div>

      {agent.description && <p className="text-xs text-slate-400 line-clamp-2 mb-2">{agent.description}</p>}

      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
        <span>{agent.model}</span>
        {agent.channels?.length && <span>{agent.channels.length} channel(s)</span>}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          removeAgent(agent.id);
        }}
        className="w-full px-2 py-1 rounded text-xs font-medium text-red-300 bg-red-900/30 hover:bg-red-900/50 transition-colors opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1"
      >
        <Trash2 className="w-3 h-3" />
        Remove
      </button>
    </motion.div>
  );
}
