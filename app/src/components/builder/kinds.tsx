"use client";
import { Brain, CalendarClock, Cpu, Database, Eye, Feather, FolderCog, GitPullRequest, MessagesSquare, NotebookPen, Plug, ScrollText, Search, Send, Sparkles, Timer, type LucideIcon, type LucideProps } from "lucide-react";
import type { Group } from "./model";

const ICON: Record<string, LucideIcon> = {
  llm: Cpu,
  storage: Database,
  lastMessages: MessagesSquare,
  workingMemory: NotebookPen,
  semanticRecall: Search,
  observational: Eye,
  subconscious: Brain,
  instructions: ScrollText,
  soul: Feather,
  workspace: FolderCog,
  schedule: CalendarClock,
  mcp: Plug,
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

/** Tailwind classes for the icon tile and the cable of each group, from the CSS tokens (both themes). Memory shares the thinking cable: it feeds the LLM. */
export const TINT: Record<Group, { tile: string; text: string; cssVar: string }> = {
  think: { tile: "bg-think/15 text-think", text: "text-think", cssVar: "var(--cable-think)" },
  memory: { tile: "bg-accent-soft text-accent", text: "text-accent", cssVar: "var(--cable-think)" },
  tools: { tile: "bg-uses/15 text-ink-2", text: "text-ink-2", cssVar: "var(--cable-uses)" },
  reach: { tile: "bg-routes/15 text-routes", text: "text-routes", cssVar: "var(--cable-routes)" },
};

/** One line on what connecting each component does, for the palette and the panels. */
export const BLURB: Record<string, string> = {
  storage: "The database the agent's memory lives in: its own memory.db, or a remote LibSQL",
  lastMessages: "Send the latest messages of the conversation with every turn",
  workingMemory: "A markdown page the agent keeps up to date about the person",
  semanticRecall: "Find older messages by what they mean, and bring them back",
  observational: "Compress old turns into short observations in the background",
  subconscious: "Keep durable knowledge and pins, delivered every turn (experimental)",
  soul: "A persona: how it sounds and what it will not do",
  workspace: "Run bash, read and write files, load skills, in its sandbox",
  schedule: "Set reminders and recurring jobs for itself",
  telegram: "Chat with it through its own Telegram bot",
};
