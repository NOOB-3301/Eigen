"use client";
import { Plus, Unplug } from "lucide-react";
import type { AgentRuntime } from "@eigen/engine/schema";
import type { Draft } from "@/lib/client/draft";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";
import { liveError, type Live } from "../live";
import type { Item, Ref } from "../model";

/** Everything a panel needs; the Builder builds one of these and the panels never touch the draft hook directly. */
export type PanelCtx = {
  agentId: string;
  agentName: string;
  draft: Draft;
  /** The applied version (what the engine runs), for "changed since apply" checks such as Test and the storage warning. */
  base: Draft | null;
  /** Validation messages by config path. */
  errors: Record<string, string>;
  hasInstructionsFile: boolean;
  runtime?: AgentRuntime;
  live: Live;
  engineOnline: boolean;
  items: Item[];
  /** Validation and engine problems by node id. */
  issues: Record<string, string[]>;
  set: (path: string, value: unknown) => void;
  /** One edit that touches several paths at once (a model rename, a cascade). */
  update: (fn: (d: Draft) => Draft) => void;
  setInstructions: (text: string) => void;
  setSoul: (text: string) => void;
  connect: (ref: Ref) => void;
  /** Disconnect, asking first when it takes more with it (storage). */
  disconnect: (ref: Ref) => void;
  /** Delete a trigger entry (asks first). */
  removeTrigger: (id: string) => void;
  /** Delete an MCP server entry (asks first). */
  removeMcp: (name: string) => void;
  renameMcp: (from: string, to: string) => void;
  open: (nodeId: string) => void;
  /** Ask to move the whole agent to the trash. */
  trash: () => void;
};

/** The connect / disconnect row every component panel starts with, and the one honest sentence about what the component does. */
export function Connection({ item, ctx, blurb, verbs }: { item: Item; ctx: PanelCtx; blurb: string; verbs?: { on: string; off: string } }) {
  // The Telegram panel shows its own error, with the state chip.
  const err = item.ref.kind === "telegram" ? undefined : liveError(item, ctx.live);
  const switches = item.ref.kind === "trigger" || item.ref.kind === "mcp";
  return (
    <section className="border-b border-line px-5 py-4">
      <div className="flex items-center gap-3">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]", item.connected ? "border-ok/40 text-ok" : "border-line text-ink-3")}>
          <span className={cn("size-1.5 rounded-full", item.connected ? "bg-ok" : "bg-off")} aria-hidden />
          {item.connected ? (verbs?.on ?? (switches ? "On" : "Connected")) : (verbs?.off ?? (switches ? "Off" : "Not connected"))}
        </span>
        <div className="ml-auto">
          {item.locked ? null : item.connected ? (
            <Button onClick={() => ctx.disconnect(item.ref)}>
              <Unplug size={13} /> {switches ? "Switch off" : "Disconnect"}
            </Button>
          ) : (
            <Button variant="primary" disabled={!!item.blocked} onClick={() => ctx.connect(item.ref)}>
              <Plus size={13} /> {switches ? "Switch on" : "Connect"}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{blurb}</p>
      {item.locked && <p className="mt-2 text-[12.5px] text-ink-3">{item.locked}</p>}
      {item.note && !item.connected && <p className="mt-2 text-[12.5px] text-warn">{item.note}</p>}
      {item.blocked && <p className="mt-2 text-[12.5px] text-warn">{item.blocked}</p>}
      {item.inactive && item.connected && <p className="mt-2 text-[12.5px] text-warn">{item.inactive}</p>}
      {err && (
        <p role="alert" className="mt-2 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] break-words text-bad">
          {err}
        </p>
      )}
    </section>
  );
}

/** An env var name as typed: upper-cased, no spaces; empty removes the key. */
export const envInput = (v: string) => v.toUpperCase().replace(/\s+/g, "") || undefined;
