'use client';

import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AgentCanvas } from '@/components/canvas';
import { Sidebar } from '@/components/sidebar';

export default function Home() {
  return (
    <div className="h-screen flex bg-slate-950">
      <ReactFlowProvider>
        <Sidebar />
        <AgentCanvas />
      </ReactFlowProvider>
    </div>
  );
}
