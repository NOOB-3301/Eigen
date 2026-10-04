'use client';

import { Handle, Position } from '@xyflow/react';
import { motion } from 'motion/react';
import { Cpu, AlertCircle, CheckCircle } from 'lucide-react';
import { useOrchestrator } from '@/context/orchestrator';
import clsx from 'clsx';

interface AgentNodeProps {
  id: string;
  data: {
    label: string;
    role: string;
    status: 'running' | 'idle' | 'error';
  };
  isConnectable: boolean;
  selected: boolean;
}

export function AgentNode({ id, data, isConnectable, selected }: AgentNodeProps) {
  const { selectAgent, selectedAgent } = useOrchestrator();

  const statusIcon = {
    running: <CheckCircle className="w-4 h-4 text-green-500" />,
    idle: <Cpu className="w-4 h-4 text-yellow-500" />,
    error: <AlertCircle className="w-4 h-4 text-red-500" />,
  }[data.status];

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      onClick={() => selectAgent(id)}
      className={clsx(
        'px-4 py-3 rounded-lg border-2 shadow-lg cursor-pointer transition-colors',
        selected && selectedAgent === id
          ? 'border-blue-500 bg-blue-950'
          : 'border-slate-600 bg-slate-800 hover:border-slate-500',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />

      <div className="flex items-center gap-2 mb-1">
        {statusIcon}
        <span className="font-semibold text-sm text-slate-100">{data.label}</span>
      </div>
      <span className="text-xs text-slate-400">{data.role}</span>

      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </motion.div>
  );
}
