import type { ListAgentsResponse } from "@eigen/engine/schema";

/** GET /api/agents: the engine snapshot (or one computed from the agent folders while the engine is offline) plus whether the engine answered. */
export type FleetResponse = ListAgentsResponse & {
  engine: "online" | "offline";
};

/** Canvas node positions by node id (fleet view and builders), stored in ~/.eigen/engine/layout.json. */
export type Layout = Record<string, { x: number; y: number }>;
