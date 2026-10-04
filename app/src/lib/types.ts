import type { ListAgentsResponse } from "@eigen/engine/schema";

/** GET /api/agents: the engine snapshot (or a disk-computed one) plus whether the engine answered. */
export type FleetResponse = ListAgentsResponse & {
  engine: "online" | "offline";
  /** Per agent: inheritable fields the agent file overrides (e.g. "model", "memory.lastMessages"). */
  overrides: Record<string, string[]>;
  rootError?: boolean;
};

/** GET /api/root: what the editor needs from the root config. Never contains URLs, env names or secret values. */
export type RootInfo = {
  defaultModel: string;
  models: Array<{ key: string; id: string; contextWindow?: number }>;
  mcpServers: Array<{ name: string; enabled: boolean; trusted: boolean }>;
  defaults: {
    maxSteps: number;
    lastMessages: number;
    semanticRecall: { enabled: boolean; topK: number; messageRange: number };
    observational: { enabled: boolean };
  };
};

export type Layout = Record<string, { x: number; y: number }>;
