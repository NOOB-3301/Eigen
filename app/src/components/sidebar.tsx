'use client';

import { motion } from 'motion/react';
import { Plus, Settings, Trash2, Play, Pause } from 'lucide-react';
import { useOrchestrator } from '@/context/orchestrator';
import { AgentCard } from './agent-card';
import clsx from 'clsx';

export function Sidebar() {
  const { agents, loading, error, selectedAgent, refreshAgents } = useOrchestrator();

  return (
    <motion.aside
      initial={{ x: -300, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="w-80 bg-slate-900 border-r border-slate-700 flex flex-col shadow-lg"
    >
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-bold text-slate-100">Agents</h1>
          <button className="p-2 hover:bg-slate-800 rounded-lg transition-colors" title="Add new agent">
            <Plus className="w-5 h-5 text-slate-400" />
          </button>
        </div>
        <p className="text-xs text-slate-500">{agents.length} agent{agents.length !== 1 ? 's' : ''}</p>
      </div>

      {/* Error State */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-3 mt-3 p-3 bg-red-950 border border-red-700 rounded-lg"
        >
          <p className="text-sm text-red-300">{error}</p>
        </motion.div>
      )}

      {/* Loading State */}
      {loading && agents.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin">
            <div className="w-8 h-8 border-2 border-slate-600 border-t-blue-500 rounded-full" />
          </div>
        </div>
      )}

      {/* Agents List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} isSelected={selectedAgent === agent.id} />
        ))}
      </div>

      {/* Footer Controls */}
      <div className="p-3 border-t border-slate-700 space-y-2">
        <button
          onClick={refreshAgents}
          className="w-full px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          <Play className="w-4 h-4" />
          Refresh
        </button>
        <button className="w-full px-3 py-2 rounded-lg bg-blue-900 hover:bg-blue-800 text-blue-200 text-sm font-medium transition-colors flex items-center justify-center gap-2">
          <Settings className="w-4 h-4" />
          Config
        </button>
      </div>
    </motion.aside>
  );
}
