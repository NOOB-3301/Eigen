import type { AgentRuntime, AgentStatus, ResolvedAgent, TelegramRuntime, TriggerRuntime } from "@eigen/engine/schema";
import type { FleetResponse } from "@/lib/types";
import { telegramView, type TgView } from "@/components/canvas/telegram-state";
import type { Item } from "./model";

/** What the engine says about this agent right now: the part of the canvas that is not config. */
export type Live = {
  status: AgentStatus;
  problems: string[];
  telegram?: TelegramRuntime;
  triggers: Map<string, TriggerRuntime>;
  /** Connection errors by server: private ones as the engine reports them, root ones from the fleet topology. */
  mcpErrors: Record<string, string>;
  /** The version of the agent that is loaded has this bot / these triggers (so a node that is only in the draft says "not applied yet"). */
  appliedTelegram: boolean;
  appliedTriggers: Set<string>;
  engineOnline: boolean;
};

export function liveOf(agentId: string, runtime: AgentRuntime | undefined, resolved: ResolvedAgent | null | undefined, fleet: FleetResponse, engineOnline: boolean): Live {
  const mcpErrors: Record<string, string> = {};
  for (const n of fleet.topology.nodes) if (n.type === "mcp" && n.data.owner === "root" && n.data.error) mcpErrors[n.data.name] = n.data.error;
  for (const [k, v] of Object.entries(runtime?.mcpErrors ?? {})) if (k.startsWith(`${agentId}/`)) mcpErrors[`private:${k.slice(agentId.length + 1)}`] = v;
  return {
    status: runtime?.status ?? "offline",
    problems: runtime?.problems ?? [],
    telegram: runtime?.telegram,
    triggers: new Map((runtime?.triggers ?? []).map((t) => [t.id, t])),
    mcpErrors,
    appliedTelegram: resolved?.telegram.enabled === true,
    appliedTriggers: new Set((resolved?.triggers ?? []).map((t) => t.id)),
    engineOnline,
  };
}

export type Tone = "ok" | "warn" | "bad" | "muted";

/** "in 2 h", "5 min ago": short, for a node. */
export function ago(iso: string, now = Date.now()): string {
  const sec = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(sec);
  const [n, unit] = abs < 90 ? [0, ""] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86_400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86_400), "d"];
  if (!unit) return sec > 0 ? "in a moment" : "just now";
  return sec > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

export type LiveLine = { text: string; tone: Tone; tg?: TgView };

/** The one line of live state a node shows under its title, or null when its own detail is the better line. */
export function liveLine(item: Item, live: Live): LiveLine | null {
  if (item.ref.kind === "telegram") {
    if (!item.connected) return null;
    // Turned on in the draft, not in the loaded version: the engine cannot know about it yet.
    if (!live.appliedTelegram && !item.locked) return { text: "Not applied yet", tone: "muted" };
    const tg = telegramView(live.telegram, { enabled: true, engineOffline: !live.engineOnline });
    return { text: tg.label, tone: tg.tone === "error" ? "bad" : tg.tone === "missing" ? "warn" : tg.tone === "polling" ? "ok" : "muted", tg };
  }
  if (item.ref.kind === "trigger") {
    const id = item.ref.id;
    if (!live.appliedTriggers.has(id)) return { text: "Not applied yet", tone: "muted" };
    const t = live.triggers.get(id);
    if (!t) return live.engineOnline ? { text: "Waiting for the engine", tone: "muted" } : { text: "Engine offline", tone: "muted" };
    const last = t.lastRun ? `last run ${t.lastRun.status === "ok" ? "ok" : t.lastRun.status} ${ago(t.lastRun.finishedAt ?? t.lastRun.startedAt)}` : "never run";
    switch (t.state) {
      case "running":
        return { text: "Running now", tone: "ok" };
      case "error":
        return { text: t.error ?? "Failed", tone: "bad" };
      case "missing-token":
        return { text: "Token missing in .env", tone: "warn" };
      case "disabled":
        return { text: "Off", tone: "muted" };
      case "idle":
        return { text: `${t.nextRunAt ? `Next ${ago(t.nextRunAt)}` : "Polling"} · ${last}`, tone: t.lastRun?.status === "error" ? "warn" : "muted" };
    }
  }
  if (item.ref.kind === "mcp" || item.ref.kind === "private-mcp") {
    const err = live.mcpErrors[item.ref.kind === "mcp" ? item.ref.name : `private:${item.ref.name}`];
    if (item.connected && err) return { text: "Failed to connect", tone: "bad" };
  }
  return null;
}

/** The message behind a node's live line, for a tooltip and the panel. */
export function liveError(item: Item, live: Live): string | undefined {
  if (item.ref.kind === "mcp") return live.mcpErrors[item.ref.name];
  if (item.ref.kind === "private-mcp") return live.mcpErrors[`private:${item.ref.name}`];
  if (item.ref.kind === "telegram") return live.telegram?.state === "error" ? live.telegram.error : undefined;
  if (item.ref.kind === "trigger") return live.triggers.get(item.ref.id)?.error;
  return undefined;
}
