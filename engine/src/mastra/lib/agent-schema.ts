import { z } from 'zod';

const Model = z.object({
  id: z.string().regex(/^[^/\s]+\/\S+$/, 'use "provider/model"'),
  url: z.url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  replyReserve: z.number().int().positive().default(4096),
});

export const AgentConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    model: z.union([z.string(), Model]),
    channels: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        type: z.enum(['working', 'semantic', 'observational']).default('working'),
      })
      .optional(),
    instructions: z.string().optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function parseAgentConfig(raw: unknown): AgentConfig {
  const r = AgentConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`agent config is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export const AgentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  channels: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  memory: z.object({
    enabled: z.boolean(),
    type: z.enum(['working', 'semantic', 'observational']),
  }).optional(),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

export function configToMetadata(config: AgentConfig): AgentMetadata {
  return {
    id: config.id,
    name: config.name,
    role: config.role,
    description: config.description,
    enabled: config.enabled,
    channels: config.channels,
    tools: config.tools,
    memory: config.memory,
  };
}
