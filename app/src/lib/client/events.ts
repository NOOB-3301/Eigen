"use client";
import { useEffect, useState } from "react";
import { mutate } from "swr";
import { telegramNodeId, type AgentEvent, type AgentRuntime, type GetAgentResponse, type TelegramRuntime, type TriggerRuntime } from "@eigen/engine/schema";
import { keys } from "@/lib/client/api";
import { SKILLS_KEY } from "@/lib/client/library";
import { refreshTriggerRuns } from "@/lib/client/triggers";
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
      if (!ev || typeof ev !== "object" || !("type" in ev)) return;
      patchCaches(ev);
      listeners.forEach((l) => l(ev));
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

/* `agent.trigger` carries one trigger's whole new TriggerRuntime: it replaces that entry (or is added) in runtime.triggers, in place. */

const withTrigger = (r: AgentRuntime, t: TriggerRuntime): AgentRuntime => {
  const list = r.triggers ?? [];
  return { ...r, triggers: list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t] };
};

export function applyTriggerToFleet(f: FleetResponse, id: string, t: TriggerRuntime): FleetResponse {
  return {
    ...f,
    agents: f.agents.map((a) => (a.id === id ? { ...a, runtime: withTrigger(a.runtime, t) } : a)),
    topology: { ...f.topology, nodes: f.topology.nodes.map((n) => (n.type === "agent" && n.data.id === id ? { ...n, data: { ...n.data, runtime: withTrigger(n.data.runtime, t) } } : n)) },
  };
}

export const applyTriggerToAgent = (a: GetAgentResponse, t: TriggerRuntime): GetAgentResponse => ({ ...a, runtime: withTrigger(a.runtime, t) });

/**
 * Cache work that belongs to the data layer, done once per event before listeners run, so it holds whichever components are mounted:
 * a trigger patches the fleet and agent caches and refetches that agent's run log (a finished run is the newest entry); anything that
 * can change an agent's skills.inherit refreshes the skill list's usedBy.
 */
function patchCaches(ev: AgentEvent) {
  if (ev.type === "agent.trigger") {
    void mutate(keys.fleet, (f?: FleetResponse) => f && applyTriggerToFleet(f, ev.id, ev.trigger), { revalidate: false });
    void mutate(keys.agent(ev.id), (a?: GetAgentResponse) => a && applyTriggerToAgent(a, ev.trigger), { revalidate: false });
    void refreshTriggerRuns(ev.id);
  } else if (ev.type === "agent.loaded" || ev.type === "agent.removed" || ev.type === "fleet.changed") void mutate(SKILLS_KEY);
}
