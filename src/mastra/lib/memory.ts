import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { LibSQLVector } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { toMastraModel, type Config } from "./config.ts";
import type { HomePaths } from "./home.ts";

export const WORKING_MEMORY_TEMPLATE = `# About the user
- Name:
- Timezone:
- Preferences:
- Current focus:
- Standing instructions:
`;

/** Working memory (profile, all threads) + semantic recall over past messages. Storage comes from storage.ts. */
export function makeMemory(p: HomePaths, cfg: Config) {
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
    },
  });
}
