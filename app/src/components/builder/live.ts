import type { AgentRuntime, AgentStatus, ResolvedAgent, TelegramRuntime, TriggerRuntime } from "@eigen/engine/schema";
import { telegramView, type TgView } from "@/components/canvas/telegram-state";
import type { Item } from "./model";

/** What the engine says about this agent right now: the part of the canvas that is not config. */
export type Live = {
  status: AgentStatus;
  problems: string[];
  telegram?: TelegramRuntime;
  triggers: Map<string, TriggerRuntime>;
  /** Why an MCP server of this agent failed to start, by name. */
  mcpErrors: Record<string, string>;
  /** The version of the agent that is loaded has this bot / these triggers (so a node that is only in the draft says "not applied yet"). */
  appliedTelegram: boolean;
  appliedTriggers: Set<string>;
  engineOnline: boolean;
};

export function liveOf(runtime: AgentRuntime | undefined, resolved: ResolvedAgent | null | undefined, engineOnline: boolean): Live {
  return {
    status: runtime?.status ?? "offline",
    problems: runtime?.problems ?? [],
    telegram: runtime?.telegram,
    triggers: new Map((runtime?.triggers ?? []).map((t) => [t.id, t])),
    mcpErrors: runtime?.mcpErrors ?? {},
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
    if (!live.appliedTelegram) return { text: "Not applied yet", tone: "muted" };
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
  if (item.ref.kind === "mcp" && item.connected && live.mcpErrors[item.ref.name]) return { text: "Failed to connect", tone: "bad" };
  return null;
}

/** The message behind a node's live line, for a tooltip and the panel. */
export function liveError(item: Item, live: Live): string | undefined {
  if (item.ref.kind === "mcp") return live.mcpErrors[item.ref.name];
  if (item.ref.kind === "telegram") return live.telegram?.state === "error" ? live.telegram.error : undefined;
  if (item.ref.kind === "trigger") return live.triggers.get(item.ref.id)?.error;
  return undefined;
}
