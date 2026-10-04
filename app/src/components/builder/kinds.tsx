"use client";
import { CalendarClock, Cpu, Eye, Feather, FolderCog, GitPullRequest, MessagesSquare, Plug, ScrollText, Search, Send, Sparkles, Timer, type LucideIcon, type LucideProps } from "lucide-react";
import type { Group } from "./model";

const ICON: Record<string, LucideIcon> = {
  model: Cpu,
  instructions: ScrollText,
  soul: Feather,
  recent: MessagesSquare,
  semantic: Search,
  observational: Eye,
  workspace: FolderCog,
  schedule: CalendarClock,
  mcp: Plug,
  "private-mcp": Plug,
  skill: Sparkles,
  telegram: Send,
  trigger: Timer,
};

export const kindIcon = (kind: string, trigger?: "cron" | "github-pr"): LucideIcon => (kind === "trigger" && trigger === "github-pr" ? GitPullRequest : (ICON[kind] ?? Sparkles));

/** The icon of a component kind, as an element (a trigger is a clock, or a pull request for GitHub). */
export function KindIcon({ kind, github, ...props }: { kind: string; github?: boolean } & LucideProps) {
  const Icon = kind === "trigger" && github ? GitPullRequest : (ICON[kind] ?? Sparkles);
  return <Icon {...props} />;
}

/** Tailwind classes for the icon tile and the cable of each group, from the CSS tokens (both themes). */
export const TINT: Record<Group, { tile: string; text: string; cssVar: string }> = {
  think: { tile: "bg-think/15 text-think", text: "text-think", cssVar: "var(--cable-think)" },
  tools: { tile: "bg-uses/15 text-ink-2", text: "text-ink-2", cssVar: "var(--cable-uses)" },
  reach: { tile: "bg-routes/15 text-routes", text: "text-routes", cssVar: "var(--cable-routes)" },
};

/** One line on what connecting each component does, for the palette. */
export const BLURB: Record<string, string> = {
  soul: "A persona: how it sounds and what it will not do",
  recent: "Keep the latest messages in front of the model",
  semantic: "Recall older messages by what they mean",
  observational: "Compress old turns into short observations",
  workspace: "Run bash, read and write files, load skills",
  schedule: "Set reminders and recurring jobs",
  mcp: "A shared tool server from Settings",
  telegram: "Chat with it in its own Telegram chat",
};
