"use client";
import { useEffect, useState } from "react";
import type { AgentEvent } from "@eigen/engine/schema";

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
