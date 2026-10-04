/**
 * One agent's memory, built from its `memory` settings only: its own storage (memory.db in its folder, or its own remote LibSQL database) and the
 * memory blocks it switched on. Nothing is shared with another agent. Any change to these settings changes the agent's version, so the registry
 * builds a new Memory with the new agent and disposes the old one (closing its database handles).
 */
import type { MastraDBMessage } from "@mastra/core/agent";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Memory, Subconscious } from "@mastra/memory";
import { skillResultRedactor } from "@mastra/memory/hooks";
import type { AgentPaths } from "./home.ts";
import { toMastraModel } from "./models.ts";
import type { ResolvedAgent } from "./schema.ts";
import { redact, redactDeep } from "./secrets.ts";

/** Thread ids of trigger runs (lib/triggers.ts names them `trigger-<agent>-<trigger>`). */
export const TRIGGER_THREAD_PREFIX = "trigger-";

/** Turns started by a schedule (a reminder the agent set) and the replies to them. Observing those would fill memory with bot chatter instead of what the user said. */
export function dropScheduledTurns(messages: MastraDBMessage[]) {
  let skipping = false;
  return messages.filter((m) => {
    if (m.role === "signal" && (m as { type?: string }).type === "schedule") return (skipping = true), false;
    if (skipping && m.role !== "signal" && m.role !== "user") return false;
    skipping = false;
    return true;
  });
}

const MAX_OBSERVED_CHARS = 2000;

/** Long tool output (curl JSON, web pages) is what makes the Observer's prompt overflow its model; keep the start of each string. */
export function clipStrings<T>(value: T, max = MAX_OBSERVED_CHARS): T {
  if (typeof value === "string") return (value.length > max ? `${value.slice(0, max)}…[clipped ${value.length - max} chars]` : value) as T;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)])) as T;
  return value;
}

/** What the Observer is allowed to see and keep: no skill text, no scheduled turns, no secrets, nothing huge (before and after it runs). */
export function observerHooks() {
  const withoutSkills = skillResultRedactor();
  return {
    beforeObservation: async (input: Parameters<typeof withoutSkills>[0]) => {
      // A trigger run reads text other people wrote (a pull request). It must not be distilled into the agent's long-term observations, where it would outlive the run and be read back as fact.
      if (input.threadId?.startsWith(TRIGGER_THREAD_PREFIX)) return { messages: [] };
      const messages = (await withoutSkills(input))?.messages ?? input.messages;
      return { messages: clipStrings(redactDeep(dropScheduledTurns(messages))) };
    },
    afterObservation: ({ observations }: { observations: string }) => ({ observations: redact(observations) }),
  };
}

type MemoryInput = Pick<ResolvedAgent, "id" | "memory" | "models" | "modelKey">;

/** The model key the Observer runs on, and the one the Subconscious runs on (its own, else the Observer's). */
export const observerModelKey = (r: MemoryInput) => r.memory.observational.model ?? r.modelKey;
export const subconsciousModelKey = (r: MemoryInput) => r.memory.subconscious.model ?? observerModelKey(r);

/**
 * Mastra's Observational Memory (background Observer/Reflector, plus the `recall` tool) and, with `subconscious` on, the experimental
 * Subconscious (a curate agent that keeps durable knowledge and pins). Models come from this agent's catalog and keys from its .env.
 */
export function observationalOptions(r: MemoryInput, env: ReadonlyMap<string, string>) {
  const { observational: om, subconscious: sc, semanticRecall } = r.memory;
  if (!om.enabled) return undefined;
  const model = toMastraModel(r.models[observerModelKey(r)]!, env);
  return {
    model,
    scope: "thread" as const,
    // A failing Observer must never block the chat (the default 'abort' cancels the user's turn); the input stays pending for the next cycle.
    observation: { messageTokens: om.messageTokens, maxRetries: 2, failurePolicy: "continue" as const },
    reflection: { observationTokens: om.reflectionTokens, maxRetries: 2, failurePolicy: "continue" as const },
    activateAfterIdle: om.activateAfterIdle,
    retrieval: om.retrieval && (semanticRecall.enabled ? { vector: true } : true),
    hooks: observerHooks(),
    // The knowledge index lives in the vector store, so the schema only lets subconscious on with semantic recall; checked again here because Memory refuses to build without it.
    ...(sc.enabled &&
      semanticRecall.enabled && {
        experimental_subconscious: new Subconscious({
          observation: ["remind", "curate"],
          model: toMastraModel(r.models[subconsciousModelKey(r)]!, env),
          defaultScope: "resource",
          tools: sc.tools,
          pins: sc.pins && { maxPins: sc.maxPins, maxCharacters: sc.maxCharacters },
        }),
      }),
  };
}

export type AgentMemory = {
  memory: Memory;
  /** Closes the storage and vector connections this memory opened. Safe to call twice. */
  close: () => Promise<void>;
};

/**
 * The agent's Memory, or undefined when its storage is off (a stateless agent that keeps nothing between messages).
 * Each block switch reaches Mastra as-is: lastMessages off is Mastra's `false`; semantic recall off builds no vector store or embedder;
 * observational off builds no Observer; the subconscious exists only with semantic recall and observational on.
 */
export function makeAgentMemory(r: MemoryInput, paths: Pick<AgentPaths, "memoryDbFile">, env: ReadonlyMap<string, string>): AgentMemory | undefined {
  const { storage: st, lastMessages, workingMemory: wm, semanticRecall: sr } = r.memory;
  if (!st.enabled) return undefined;
  const url = st.url ?? `file:${paths.memoryDbFile}`;
  const authToken = st.authTokenEnv ? env.get(st.authTokenEnv) : undefined;
  const conn = { url, ...(authToken && { authToken }) };
  // Built first: a missing model key throws here, before any database is opened that nobody would close.
  const observationalMemory = observationalOptions(r, env);
  const embedder = sr.enabled ? new ModelRouterEmbeddingModel(toMastraModel(sr.embedder, env)) : undefined;
  const storage = new LibSQLStore({ id: `${r.id}-memory`, ...conn });
  const vector = sr.enabled ? new LibSQLVector({ id: `${r.id}-vector`, ...conn }) : undefined;
  const memory = new Memory({
    storage,
    ...(vector && embedder && { vector, embedder }),
    options: {
      lastMessages: lastMessages.enabled && lastMessages.count,
      workingMemory: wm.enabled ? { enabled: true, scope: wm.scope, template: wm.template } : { enabled: false },
      semanticRecall: sr.enabled && { topK: sr.topK, messageRange: sr.messageRange, scope: sr.scope },
      ...(observationalMemory && { observationalMemory }),
    },
  });
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      await storage.close().catch(() => undefined);
      await vector?.close().catch(() => undefined);
    })());
  return { memory, close };
}
