/**
 * Builds one standalone agent: ResolvedAgent -> a Mastra Agent with its own model clients, memory and storage, tools, skills, sandbox,
 * MCP servers and Telegram bot. Everything it uses comes from `ctx`: its folder (`ctx.paths`) and its .env (`ctx.env`). Nothing comes
 * from another agent, a root config, or process.env.
 *
 * The registry (lib/agents.ts) owns WHEN an agent is built, replaced and disposed; this file owns WHAT an agent is made of.
 */
import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor } from "@mastra/core/processors";
import { makeChatQueue } from "./chat-queue.ts";
import { slashHandler } from "./commands.ts";
import { ensureAgentDirs, type AgentPaths } from "./home.ts";
import { buildInstructions } from "./instructions.ts";
import { makeAgentMemory } from "./memory.ts";
import { mergeSystemProcessor } from "./merge-system.ts";
import { toMastraModel, tokenBudget, type MastraModel } from "./models.ts";
import { orgScopeProcessor } from "./org-scope.ts";
import type { ModelEntry, ResolvedAgent } from "./schema.ts";
import { reconcileSkills } from "./skills.ts";
import { activeModelKey, readState } from "./state.ts";
import { createBot, telegramChannels, type TelegramBot } from "./telegram.ts";
import { startMcp } from "./tools/mcp.ts";
import { makeScheduleTool } from "./tools/schedule.ts";
import { makeWorkspace, refreshSkills, type WorkspaceOptions } from "./tools/workspace.ts";

export type BuiltAgent = {
  agent: Agent;
  /** Closes what this version opened: MCP clients, storage connections, its bot. The registry stops the bot itself before adding a replacement. */
  dispose: () => Promise<void>;
  /** MCP server name -> why it failed to start. */
  mcpErrors?: Record<string, string>;
  /** This agent's Telegram bot, built but not polling yet (Mastra starts polling when the agent is added). Undefined: no bot. */
  telegram?: TelegramBot;
  /** Re-reads the agent's skill folders (the registry calls it when something under skills/ or sandbox/skills changes). Absent without the workspace tool. */
  refreshSkills?: () => Promise<void>;
};

export type FactoryContext = {
  paths: AgentPaths;
  /** The agent's .env as read when this version was built. Its keys come from here and nowhere else. */
  env: ReadonlyMap<string, string>;
  /** The token to start its bot with. Undefined: no bot (Telegram off, token not set, or another agent's .env holds the same token). */
  telegramToken?: string;
  /** Asks the registry to re-read this agent's folder now (the /reload chat command). */
  reload: () => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
};

export type AgentFactory = (r: ResolvedAgent, ctx: FactoryContext) => Promise<BuiltAgent>;

/** Test seams: the sandbox isolation (tests use "none") and where the built-in skills live. */
export type FactoryOptions = Pick<WorkspaceOptions, "isolation" | "builtinSkills">;

/**
 * Builds the agent. Throws (MissingKeyError, or the sandbox's "no OS isolation") when it cannot be built; whatever it opened before that is
 * closed again, so a failed build leaks no database handle, MCP process or bot.
 */
export function makeAgentFactory(opts: FactoryOptions = {}): AgentFactory {
  return async (r, ctx) => {
    const { paths, env, log } = ctx;
    ensureAgentDirs(paths);
    // The model the agent was configured with must work now: a missing key fails the build with the variable's name.
    const base = toMastraModel(r.model, env);
    const memory = makeAgentMemory(r, paths, env);
    const closers: Array<() => Promise<unknown>> = [];
    if (memory) closers.push(memory.close);
    const closeAll = async () => {
      for (const close of closers.splice(0).reverse()) await close().catch((e) => log(`${r.id}: closing failed`, e));
    };
    try {
      const workspace = r.tools.builtin.includes("workspace") ? makeWorkspace(r, paths, { ...opts, log: (msg) => log(msg) }) : undefined;
      if (workspace) reconcileSkills(paths);
      const mcp = await startMcp(r.id, r.tools.mcp, env, r.tools.mcpStartupTimeoutMs);
      closers.push(mcp.close);
      const schedule = r.tools.builtin.includes("schedule") ? makeScheduleTool(() => r.timezone) : undefined;

      // The model chosen with /model, read every turn. Its key was checked when it was chosen; if it has gone since, the configured model answers.
      const current = (): { entry: ModelEntry; model: MastraModel } => {
        const key = activeModelKey(r, paths.stateFile);
        if (key === r.modelKey) return { entry: r.model, model: base };
        try {
          return { entry: r.models[key]!, model: toMastraModel(r.models[key]!, env) };
        } catch (e) {
          log(`${r.id}: model ${key} cannot be used (${(e as Error).message}); using ${r.modelKey}`);
          return { entry: r.model, model: base };
        }
      };

      // The bot is only created here (no polling yet); Mastra starts polling when the registry adds the agent.
      const bot = ctx.telegramToken && r.telegram.enabled ? createBot({ token: ctx.telegramToken, allowedUserIds: r.telegram.allowedUserIds }) : undefined;
      if (bot) closers.push(() => bot.stop());
      const queue = makeChatQueue((e) => log(`${r.id}: chat run failed`, e));
      const channels = bot && telegramChannels(bot, { queue, verbose: () => !!readState(paths.stateFile).verbose, slash: slashHandler({ r, paths, env, queue, mcp: () => mcp.state, reload: ctx.reload }) });

      const agent = new Agent({
        id: r.id,
        name: r.name,
        description: r.description,
        // Re-read every turn: role, soul and ground-rule edits apply on the next message without a reload.
        instructions: () => buildInstructions(r, paths),
        model: () => current().model,
        ...(memory && { memory: memory.memory }),
        ...(workspace && { workspace }),
        tools: () => ({ ...mcp.tools(), ...(schedule && { schedule }) }),
        inputProcessors: () => {
          const { entry, model } = current();
          const budget = tokenBudget(entry);
          // Subconscious knowledge is filed under an organization; local chat templates reject a second system message.
          return [orgScopeProcessor, ...(budget ? [new TokenLimiterProcessor({ limit: budget })] : []), ...(model.url ? [mergeSystemProcessor] : [])];
        },
        defaultOptions: { maxSteps: r.maxSteps },
        ...(channels && { channels }),
      });

      return {
        agent,
        telegram: bot,
        mcpErrors: Object.keys(mcp.state.errors).length ? mcp.state.errors : undefined,
        refreshSkills: workspace && (() => refreshSkills(workspace)),
        dispose: closeAll,
      };
    } catch (e) {
      await closeAll();
      throw e;
    }
  };
}

export const defaultAgentFactory: AgentFactory = makeAgentFactory();
