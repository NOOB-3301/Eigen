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

/** What the Observer is allowed to see and keep: no skill text, no scheduled turns, no secrets (before and after it runs). */
export function observerHooks() {
  const withoutSkills = skillResultRedactor();
  return {
    beforeObservation: async (input: Parameters<typeof withoutSkills>[0]) => {
      const messages = (await withoutSkills(input))?.messages ?? input.messages;
      return { messages: redactDeep(dropScheduledTurns(messages)) };
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
  return {
    model,
    scope: "thread" as const,
    observation: { messageTokens: om.messageTokens },
    reflection: { observationTokens: om.reflectionTokens },
    activateAfterIdle: om.activateAfterIdle,
    retrieval: om.retrieval && (semanticRecall.enabled ? { vector: true } : true),
    hooks: observerHooks(),
    ...(kn.enabled && {
      experimental_subconscious: new Subconscious({
        observation: ["remind", "curate"],
        model,
        defaultScope: "resource",
        tools: kn.tools,
        pins: kn.pins && { maxPins: kn.maxPins, maxCharacters: kn.maxCharacters },
      }),
    }),
  };
}

/** Working memory (profile, all threads) + semantic recall over past messages, and optionally Mastra's Observational Memory. Storage comes from storage.ts. Pass a config getter to let the observer model follow `/reload`; the rest is fixed when this runs. */
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
      lastMessages,
      workingMemory: { enabled: true, scope: "resource", template: WORKING_MEMORY_TEMPLATE },
      semanticRecall: sr.enabled && { topK: sr.topK, messageRange: sr.messageRange, scope: "resource" },
      observationalMemory: observationalOptions(getCfg),
    },
  });
}
