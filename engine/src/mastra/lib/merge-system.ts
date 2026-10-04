import type { Processor } from "@mastra/core/processors";
import { filter, isString, join, map, reject } from "lodash-es";

type Prompt = Parameters<NonNullable<Processor["processLLMRequest"]>>[0]["prompt"];

/** Fold every system message into one at the front. Local chat templates (Qwen-style Jinja) raise "System message must be at the beginning" on a second one, and Mastra sends instructions, workspace, skills and working memory separately. */
export const mergeSystemMessages = (prompt: Prompt): Prompt => {
  const system = filter(prompt, { role: "system" });
  if (system.length < 2) return prompt;
  const content = join(filter(map(system, "content"), isString), "\n\n");
  return [{ role: "system", content }, ...reject(prompt, { role: "system" })];
};

export const mergeSystemProcessor = {
  id: "merge-system-messages",
  name: "Merge system messages",
  processLLMRequest: ({ prompt }) => ({ prompt: mergeSystemMessages(prompt) }),
  processLLMResponse: () => undefined,
} satisfies Processor;
