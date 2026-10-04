"use client";
import type { TelegramRuntime } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";

export type TgTone = "polling" | "starting" | "missing" | "error" | "off" | "unknown";
export type TgView = { tone: TgTone; label: string; detail?: string };

/**
 * One reading of a bot's state for every place that shows it (builder node, panel chip, agent list).
 * `enabled` is what the config says; `runtime` is what the engine reports. With the engine offline (or silent) only the config is known.
 */
export function telegramView(runtime: TelegramRuntime | undefined, o: { enabled: boolean; engineOffline?: boolean }): TgView {
  if (!o.enabled && (!runtime || runtime.state === "off")) return { tone: "off", label: "No bot", detail: "This agent has no Telegram bot." };
  if (o.engineOffline) return { tone: "unknown", label: "Engine offline", detail: "The bot's state is unknown while the engine is stopped." };
  if (!runtime) return { tone: "unknown", label: "Waiting for engine", detail: "The engine has not reported this bot yet." };
  switch (runtime.state) {
    case "polling":
      return { tone: "polling", label: runtime.username ? `@${runtime.username}` : "Live", detail: "Polling Telegram and answering messages." };
    case "starting":
      return { tone: "starting", label: "Starting…", detail: "Connecting to Telegram." };
    case "missing-token":
      return { tone: "missing", label: "Token missing", detail: "The token variable is not set in this agent's .env." };
    case "error":
      return { tone: "error", label: "Error", detail: runtime.error ?? "Telegram rejected the bot." };
    case "off":
      return { tone: "off", label: "Off", detail: "The bot is turned off." };
  }
}

const TONE: Record<TgTone, string> = {
  polling: "bg-tg-polling",
  starting: "bg-tg-starting",
  missing: "bg-tg-missing",
  error: "bg-tg-error",
  off: "bg-tg-off",
  unknown: "",
};

export function TelegramDot({ tone, className }: { tone: TgTone; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      {tone === "unknown" ? (
        <span className="size-2.5 rounded-full border-[1.5px] border-dashed border-tg-off" />
      ) : (
        <>
          {(tone === "polling" || tone === "starting") && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-50", TONE[tone])} />}
          <span className={cn("relative size-2.5 rounded-full", TONE[tone])} />
        </>
      )}
    </span>
  );
}

const TEXT: Record<TgTone, string> = {
  polling: "text-ink-2",
  starting: "text-ink-2",
  missing: "text-warn",
  error: "text-bad",
  off: "text-ink-3",
  unknown: "text-ink-3",
};

export function TelegramStateChip({ view, className }: { view: TgView; className?: string }) {
  return (
    <span title={view.detail} className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs", TEXT[view.tone], className)} role="status">
      <TelegramDot tone={view.tone} className="size-2" />
      <span className="truncate">{view.label}</span>
    </span>
  );
}
