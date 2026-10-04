'use client';

import { useCallback, useMemo } from 'react';
import ReactFlow, { Node, Edge, Controls, Background, useNodesState, useEdgesState, Position } from '@xyflow/react';
import { motion } from 'motion/react';
import { useOrchestrator } from '@/context/orchestrator';
import { AgentNode } from './nodes/agent-node';
import { ChannelNode } from './nodes/channel-node';

const nodeTypes = { agent: AgentNode, channel: ChannelNode };

export function AgentCanvas() {
  const { agents } = useOrchestrator();

  const initialNodes: Node[] = useMemo(() => {
    if (!agents.length) return [];

    // Agents in center column, channels on sides
    const agentNodes = agents.map((agent, idx) => ({
      id: agent.id,
      type: 'agent',
      data: { label: agent.name, role: agent.role, status: 'running' as const },
      position: { x: 512, y: idx * 150 + 50 },
    }));

    const channelNodes = [
      { id: 'telegram', type: 'channel' as const, data: { label: 'Telegram', platform: 'telegram' }, position: { x: 50, y: 100 } },
      { id: 'slack', type: 'channel' as const, data: { label: 'Slack', platform: 'slack' }, position: { x: 50, y: 250 } },
    ];

    return [...agentNodes, ...channelNodes];
  }, [agents]);

  const initialEdges: Edge[] = useMemo(() => {
    if (!agents.length) return [];
    // Connect all agents to telegram channel
    return agents.map((agent) => ({
      id: `telegram-${agent.id}`,
      source: 'telegram',
      target: agent.id,
    }));
  }, [agents]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  return (
    <motion.div className="flex-1 relative overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background color="#1e293b" gap={16} />
        <Controls />
      </ReactFlow>
    </motion.div>
  );
}
