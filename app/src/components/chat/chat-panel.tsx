"use client";

/** Chat with one agent from the studio (Mastra chatRoute + AI SDK useChat). INTERFACE ONLY: the chat worker builds it. */
export function ChatPanel({ agentId, onClose }: { agentId: string; onClose?: () => void }) {
  void onClose;
  return <div>Chat with {agentId}</div>;
}
