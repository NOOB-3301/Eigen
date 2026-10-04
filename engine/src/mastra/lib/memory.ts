import type { MastraDBMessage } from "@mastra/core/agent";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { LibSQLVector } from "@mastra/libsql";
import { Memory, Subconscious } from "@mastra/memory";
import { skillResultRedactor } from "@mastra/memory/hooks";
import { toMastraModel, type Config } from "./config.ts";
import type { HomePaths } from "./home.ts";
import { redact, redactDeep } from "./secrets.ts";

export const WORKING_MEMORY_TEMPLATE = `# About the user
- Name:
- Timezone:
- Preferences:
- Current focus:
- Standing instructions:
`;

/** Thread ids of trigger runs (lib/triggers.ts names them `trigger-<agent>-<trigger>`). */
export const TRIGGER_THREAD_PREFIX = "trigger-";

/** Turns started by a schedule (Moltbook heartbeat, Zomato checks) and the replies to them. Observing those would fill memory with bot chatter instead of what the user said. */
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

/**
 * Mastra's Observational Memory (background Observer/Reflector, plus the `recall` tool) and, optionally, the experimental
 * Subconscious (a curate agent that keeps durable knowledge and pins). Both are off until `memory.observational.enabled`.
 * The model is resolved on every call, so `/reload` can switch it.
 */
export function observationalOptions(getCfg: () => Config) {
  const { observational: om, knowledge: kn, semanticRecall } = getCfg().memory;
  if (!om.enabled) return undefined;
  const model = () => {
    const c = getCfg();
    return toMastraModel(c.models[c.memory.observational.model ?? c.curatorModel ?? c.defaultModel]!);
  };
  const knowledgeModel = () => {
    const c = getCfg();
    return c.memory.knowledge.model ? toMastraModel(c.models[c.memory.knowledge.model]!) : model();
  };
  return {
    model,
    scope: "thread" as const,
    // A failing Observer must never block the chat (the default 'abort' cancels the user's turn); the input stays pending for the next cycle.
    observation: { messageTokens: om.messageTokens, maxRetries: 2, failurePolicy: "continue" as const },
    reflection: { observationTokens: om.reflectionTokens, maxRetries: 2, failurePolicy: "continue" as const },
    activateAfterIdle: om.activateAfterIdle,
    retrieval: om.retrieval && (semanticRecall.enabled ? { vector: true } : true),
    hooks: observerHooks(),
    // Knowledge indexes into the vector store, which an agent that turned semantic recall off does not have (Memory refuses to build without it).
    ...(kn.enabled && semanticRecall.enabled && {
      experimental_subconscious: new Subconscious({
        observation: ["remind", "curate"],
        model: knowledgeModel,
        defaultScope: "resource",
        tools: kn.tools,
        pins: kn.pins && { maxPins: kn.maxPins, maxCharacters: kn.maxCharacters },
      }),
    }),
  };
}

/**
 * Working memory (profile, all threads) + semantic recall over past messages, and optionally Mastra's Observational Memory. Storage comes from storage.ts.
 * Each of the three switches is real: lastMessages 0 turns the recent-message history off (Mastra spells that `false`), semanticRecall.enabled false
 * builds no vector store or embedder, observational.enabled false builds no Observer. Pass a config getter to let the observer model follow `/reload`; the rest is fixed when this runs.
 */
export function makeMemory(p: HomePaths, source: Config | (() => Config)) {
  const getCfg = typeof source === "function" ? source : () => source;
  const cfg = getCfg();
  const { semanticRecall: sr, embedder, lastMessages } = cfg.memory;
  return new Memory({
    ...(sr.enabled && {
      vector: new LibSQLVector({ id: "eigen-vector", url: `file:${p.dbFile}` }),
      embedder: new ModelRouterEmbeddingModel(toMastraModel(embedder)),
    }),
    options: {
      lastMessages: lastMessages > 0 && lastMessages,
      workingMemory: { enabled: true, scope: "resource", template: WORKING_MEMORY_TEMPLATE },
      semanticRecall: sr.enabled && { topK: sr.topK, messageRange: sr.messageRange, scope: "resource" },
      observationalMemory: observationalOptions(getCfg),
    },
  });
}

/**
 * A memory that follows the config: it is rebuilt when a memory setting changes, and reused otherwise. For an agent Mastra builds once
 * (the primary), this is what lets lastMessages, semantic recall and observation switch on or off without a restart.
 */
export function liveMemory(p: HomePaths, getCfg: () => Config) {
  let built: { key: string; memory: Memory } | undefined;
  return () => {
    const key = JSON.stringify(getCfg().memory);
    if (built?.key !== key) built = { key, memory: makeMemory(p, getCfg) };
    return built.memory;
  };
}
