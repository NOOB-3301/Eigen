import type { Limits, ModelEntry } from "../config/schema.ts";
import type { PromptSet } from "../prompts/loader.ts";
import type { Message, ToolDef } from "./types.ts";
import { trimHistory } from "./trim.ts";
import { estimateText, estimateTools } from "../util/tokens.ts";

export type BlockName = "system" | "soul" | "memory" | "skills";
export type BlockInfo = { name: BlockName; tokens: number };

// Fixed order, stable-first. memory is still a reserved seam.
export const BLOCK_ORDER: readonly BlockName[] = ["system", "soul", "memory", "skills"];

const TAG: Record<BlockName, string> = {
  system: "operating_instructions",
  soul: "soul",
  memory: "memory",
  skills: "skill_index",
};

export function renderSystem(prompts: PromptSet): { system: string; blocks: BlockInfo[] } {
  const bodies: Record<BlockName, string> = { system: prompts.system, soul: prompts.soul, memory: "", skills: prompts.skills ?? "" };
  const blocks: BlockInfo[] = [];
  const rendered: string[] = [];
  for (const name of BLOCK_ORDER) {
    const body = bodies[name].trim();
    if (!body) continue;
    const text = `<${TAG[name]}>\n${body}\n</${TAG[name]}>`;
    rendered.push(text);
    blocks.push({ name, tokens: estimateText(text) });
  }
  return { system: rendered.join("\n\n"), blocks };
}

export type BuiltContext = {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  estimatedTokens: number;
  budget: number;
  blocks: BlockInfo[];
  trimmedResults: number;
  droppedTurns: number;
};

export class ContextTooLargeError extends Error {
  override name = "ContextTooLargeError";
}

export type ContextInput = {
  prompts: PromptSet;
  messages: Message[];
  entry: ModelEntry;
  tools: ToolDef[];
  limits: Pick<Limits, "imageTokenEstimate">;
};

// The only place a model prompt is assembled.
export function buildContext(input: ContextInput): BuiltContext {
  const { system, blocks } = renderSystem(input.prompts);
  const tools = input.entry.toolCalling ? input.tools : [];
  const fixed = estimateText(system) + estimateTools(tools);
  const budget = input.entry.contextWindow - input.entry.replyReserve;
  const trim = trimHistory(input.messages, budget - fixed, input.limits.imageTokenEstimate);
  const estimatedTokens = fixed + trim.historyTokens;
  if (!trim.fits) {
    throw new ContextTooLargeError(
      `The latest message plus its tool results (~${estimatedTokens} tokens) does not fit the model's budget (${budget} = contextWindow - replyReserve). Send something shorter, or /new.`,
    );
  }
  return { system, messages: trim.messages, tools, estimatedTokens, budget, blocks, trimmedResults: trim.trimmedResults, droppedTurns: trim.droppedTurns };
}
