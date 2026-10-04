"use client";
import { useEffect, useState } from "react";
import { telegramNodeId, type AgentEvent, type GetAgentResponse, type TelegramRuntime } from "@eigen/engine/schema";
import type { FleetResponse } from "@/lib/types";

type Listener = (e: AgentEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to AgentEvents from the single page-wide EventSource. */
export function onAgentEvent(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Agent ids an inspector is waiting on after a save; it reports the reload itself, so the global toast stays quiet. */
export const awaitingReload = new Set<string>();

export type StreamState = { engine: "online" | "offline" | "unknown"; connected: boolean };

/** Opens /api/agents/events once and fans events out. EventSource reconnects by itself (server sets retry). */
export function useEventStream(initial: "online" | "offline"): StreamState {
  const [state, setState] = useState<StreamState>({ engine: initial, connected: false });
  useEffect(() => {
    const es = new EventSource("/api/agents/events");
    const onMode = (e: MessageEvent) => {
      try {
        const { engine } = JSON.parse(e.data) as { engine: "online" | "offline" };
        setState({ engine, connected: true });
      } catch {
        /* ignore malformed */
      }
    };
    es.addEventListener("eigen.mode", onMode);
    es.onmessage = (e) => {
      let ev: AgentEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev && typeof ev === "object" && "type" in ev) listeners.forEach((l) => l(ev));
    };
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    return () => {
      es.removeEventListener("eigen.mode", onMode);
      es.close();
    };
  }, []);
  return state;
}

/* `agent.telegram` carries the whole new TelegramRuntime, so the caches are patched in place (no refetch) and chips and bot nodes move at once. */

/** Does the cached topology already have a bot node for this agent? If not, the bot was just enabled and the fleet must be refetched. */
export const fleetHasBot = (f: FleetResponse, id: string) => f.topology.nodes.some((n) => n.id === telegramNodeId(id));

export function applyTelegramToFleet(f: FleetResponse, id: string, t: TelegramRuntime): FleetResponse {
  const bot = telegramNodeId(id);
  return {
    ...f,
    agents: f.agents.map((a) => (a.id === id ? { ...a, runtime: { ...a.runtime, telegram: t } } : a)),
    topology: {
      ...f.topology,
      nodes: f.topology.nodes.map((n) => {
        if (n.type === "channel" && n.id === bot) return { ...n, data: { ...n.data, state: t.state, username: t.username } };
        if (n.type === "agent" && n.data.id === id) return { ...n, data: { ...n.data, runtime: { ...n.data.runtime, telegram: t } } };
        return n;
      }),
    },
  };
}

export const applyTelegramToAgent = (a: GetAgentResponse, t: TelegramRuntime): GetAgentResponse => ({ ...a, runtime: { ...a.runtime, telegram: t } });
