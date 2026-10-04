'use client';

import { Handle, Position } from '@xyflow/react';
import { motion } from 'motion/react';
import { MessageCircle, Send } from 'lucide-react';

interface ChannelNodeProps {
  id: string;
  data: {
    label: string;
    platform: string;
  };
  isConnectable: boolean;
}

export function ChannelNode({ id, data, isConnectable }: ChannelNodeProps) {
  const icons = {
    telegram: <Send className="w-5 h-5 text-blue-400" />,
    slack: <MessageCircle className="w-5 h-5 text-purple-400" />,
  } as const;

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.05 }}
      className="px-4 py-3 rounded-lg border-2 border-slate-600 bg-slate-900 shadow-lg"
    >
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />

      <div className="flex flex-col items-center gap-2">
        {icons[data.platform as keyof typeof icons] || <MessageCircle className="w-5 h-5 text-slate-400" />}
        <span className="font-semibold text-sm text-slate-100">{data.label}</span>
      </div>
    </motion.div>
  );
}
