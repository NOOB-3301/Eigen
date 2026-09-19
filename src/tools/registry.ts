import { z } from "zod";
import type { Part, ToolDef } from "../core/types.ts";

export type ToolContext = { signal: AbortSignal; sessionId: string };
export type ToolOutput = string | { content: Part[]; isError?: boolean };

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
};

// Erases the schema generic so tools with different inputs share one registry.
export function defineTool<S extends z.ZodType>(t: Tool<S>): Tool {
  return t as unknown as Tool;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();
  #defs?: ToolDef[];

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.#tools.set(tool.name, tool);
    this.#defs = undefined;
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  // Cached and in registration order, so the serialized tool list is byte-stable across
  // turns (a prompt-cache prefix requirement).
  defs(): ToolDef[] {
    this.#defs ??= [...this.#tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.inputSchema) }));
    return this.#defs;
  }

  closest(name: string, n = 3): string[] {
    const q = name.toLowerCase();
    return this.names()
      .map((t) => ({ t, d: t.includes(q) || q.includes(t) ? 0 : distance(q, t) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => x.t);
  }
}
