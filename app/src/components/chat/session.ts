"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The studio chat session per agent: the engine turns it into the Mastra thread `studio:<agent>:<session>`.
 * Kept in localStorage so a reopened panel continues the same thread; when storage is blocked (private mode, policy)
 * it lives in memory for this page instead, and every reload starts a fresh chat.
 */
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const key = (agentId: string) => `eigen:chat-session:${agentId}`;
const fallback = new Map<string, string>();
const listeners = new Set<() => void>();
/** Sessions created on this page: they cannot have history yet, so the panel skips asking for it. */
const fresh = new Set<string>();

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function read(agentId: string): string | undefined {
  try {
    const v = localStorage.getItem(key(agentId));
    if (v && SESSION_RE.test(v)) return v;
  } catch {
    /* storage blocked: fall back to memory */
  }
  return fallback.get(agentId);
}

function store(agentId: string, id: string) {
  fallback.set(agentId, id);
  try {
    localStorage.setItem(key(agentId), id);
  } catch {
    /* storage blocked: the in-memory copy is enough for this page */
  }
}

/** Reads the session, creating one on first use (idempotent, so it is safe as a snapshot getter). */
function current(agentId: string) {
  const existing = read(agentId);
  if (existing) return existing;
  const id = newId();
  fresh.add(id);
  store(agentId, id);
  return id;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const isFreshSession = (id: string) => fresh.has(id);

/** [session id (null while server rendering), start a new chat]. */
export function useChatSession(agentId: string): [string | null, () => void] {
  const session = useSyncExternalStore(
    subscribe,
    () => current(agentId),
    () => null,
  );
  const renew = useCallback(() => {
    const id = newId();
    fresh.add(id);
    store(agentId, id);
    listeners.forEach((fn) => fn());
  }, [agentId]);
  return [session, renew];
}
