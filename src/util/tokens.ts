import type { Message, Part, ToolDef } from "../core/types.ts";

// chars/4 is crude but provider-neutral; swap this module for a real tokenizer later.
export function estimateText(text: string): number {
  return Math.ceil(text.length / 4);
}

const MESSAGE_OVERHEAD = 4;

export function estimateParts(parts: Part[], imageTokens: number): number {
  let n = 0;
  for (const p of parts) {
    if (p.type === "text") n += estimateText(p.text);
    else if (p.type === "image") n += imageTokens;
    else if (p.type === "tool_call") n += estimateText(p.name) + estimateText(JSON.stringify(p.args)) + MESSAGE_OVERHEAD;
    else n += estimateParts(p.content, imageTokens) + MESSAGE_OVERHEAD;
  }
  return n;
}

export function estimateMessage(m: Message, imageTokens: number): number {
  return estimateParts(m.parts, imageTokens) + MESSAGE_OVERHEAD;
}

export function estimateMessages(ms: Message[], imageTokens: number): number {
  let n = 0;
  for (const m of ms) n += estimateMessage(m, imageTokens);
  return n;
}

export function estimateTools(tools: ToolDef[]): number {
  return tools.length === 0 ? 0 : estimateText(JSON.stringify(tools));
}
