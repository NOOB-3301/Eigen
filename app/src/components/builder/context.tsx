"use client";
import { createContext, useContext } from "react";
import type { Live } from "./live";
import type { Adder } from "./layout";
import type { Item, Ref } from "./model";

/** What every node and edge on the canvas can read and do. One object, so a node never needs its own wiring. */
export type BuilderApi = {
  live: Live;
  /** Node ids with something staged (connected, disconnected or edited since the last apply). */
  changed: Set<string>;
  issues: Record<string, string[]>;
  selectedId: string | null;
  /** The node the pointer or focus is on, so its cable can show its disconnect button. */
  hovered: string | null;
  /** How many changes are staged (the Apply bar's count). */
  pending: number;
  /** Select a node and show its panel. */
  open: (nodeId: string) => void;
  connect: (ref: Ref) => void;
  /** Disconnect, asking first when it deletes something the user typed. */
  disconnect: (ref: Ref) => void;
  /** An adder node was used: add a private server directly, or open the palette on the right group. */
  adder: (kind: Adder) => void;
  agent: { id: string; name: string; role: string; description: string; primary: boolean; enabled: boolean; modelKey: string; memoryScope: string; sandbox: string };
  /** Connected items by id, for edges and overflow lists. */
  itemsById: Map<string, Item>;
};

const Ctx = createContext<BuilderApi | null>(null);
export const BuilderProvider = Ctx.Provider;
export function useBuilder() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useBuilder outside <BuilderProvider>");
  return c;
}
