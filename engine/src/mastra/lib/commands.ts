/**
 * Slash commands on one agent's Telegram bot. Every command acts on that agent only: its model choice and verbose mode (its data/state.json),
 * its conversation, its folder (/reload). Nothing here reaches another agent or anything engine-wide.
 */
import type { SlashCommandChannelHandler } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import type { LocalSandbox } from "@mastra/core/workspace";
import { compact, map, size, toPairs } from "lodash-es";
import type { ChatQueue } from "./chat-queue.ts";
import type { AgentPaths } from "./home.ts";
import { MEMORY_BLOCKS, type ResolvedAgent } from "./schema.ts";
import { secretsHidden } from "./sandbox.ts";
import { toMastraModel } from "./models.ts";
import { reconcileSkills } from "./skills.ts";
import { activeModelKey, patchState, readState } from "./state.ts";
import type { McpState } from "./tools/mcp.ts";
import { listReminders } from "./tools/schedule.ts";

export type Deps = {
  r: ResolvedAgent;
  paths: AgentPaths;
  /** The agent's .env as this version was built with: /model refuses a model whose key is not set. */
  env: ReadonlyMap<string, string>;
  queue: ChatQueue;
  mcp: () => McpState;
  /** Asks the registry to re-read this agent's folder now. */
  reload: () => Promise<void>;
};
type Ctx = Deps & { mastra: Mastra; args: string; chatId: string };
type Command = { help: string; run: (c: Ctx) => Promise<string> | string };

const lines = (...xs: Array<string | false | undefined>) => compact(xs).join("\n");

const mcpLine = ({ servers, errors, tools }: McpState) =>
  servers.length ? `MCP: ${map(servers, (s) => (errors[s] ? `${s} failed (${errors[s]})` : `${s} ok`)).join(", ")} · ${size(tools)} tools` : "MCP: none";

/**
 * The Mastra thread behind this Telegram chat, for THIS agent. Mastra keeps the chat-to-thread mapping of every bot in the engine's storage and
 * stamps each thread with `channel_ownerId` (the agent), so the lookup is scoped by it. Threads from before the stamp existed (no owner at all)
 * still count, as they do in Mastra's own lookup.
 */
async function chatThread(mastra: Mastra, chatId: string, agentId: string) {
  const store = await mastra.getStorage()?.getStore("memory");
  const base = { channel_platform: "telegram", channel_externalThreadId: chatId };
  const newest = { perPage: 1, orderBy: { field: "createdAt", direction: "DESC" } } as const;
  const scoped = (await store?.listThreads({ filter: { metadata: { ...base, channel_ownerId: agentId } }, ...newest }))?.threads[0];
  if (scoped) return { store, thread: scoped };
  const legacy = (await store?.listThreads({ filter: { metadata: base }, perPage: 10, orderBy: newest.orderBy }))?.threads.find((t) => !("channel_ownerId" in (t.metadata ?? {})));
  return { store, thread: legacy };
}

const stop = async ({ mastra, r, chatId, queue }: Ctx) => {
  queue.clear(chatId);
  const { thread } = await chatThread(mastra, chatId, r.id);
  return !!thread && mastra.getAgent(r.id).abortThreadStream({ threadId: thread.id, resourceId: thread.resourceId, clearPendingSignals: true });
};

const memoryLine = (r: ResolvedAgent) => {
  if (!r.memory.storage.enabled) return "Memory: off (I keep nothing between messages)";
  const on = MEMORY_BLOCKS.filter((b) => r.memory[b].enabled);
  return `Memory: ${on.length ? on.join(", ") : "storage only"}`;
};

const COMMANDS: Record<string, Command> = {
  status: {
    help: "model, skills, MCP, reminders, memory",
    run: async (c) => {
      const { r, paths, mastra } = c;
      const key = activeModelKey(r, paths.stateFile);
      const workspace = await mastra.getAgent(r.id).getWorkspace();
      const skills = await workspace?.skills?.list();
      const sandbox = workspace?.sandbox as LocalSandbox | undefined;
      const hidden = sandbox && (await secretsHidden(sandbox, paths));
      const reminders = r.tools.builtin.includes("schedule") && size(await listReminders(mastra.schedules, r.id).catch(() => []));
      return lines(
        `Model: ${key} (${r.models[key]!.id})`,
        workspace ? `Sandbox: ${sandbox?.isolation ?? "none"}, keys ${hidden === undefined ? "unchecked" : hidden ? "hidden" : "READABLE"}` : "Sandbox: no workspace tool",
        workspace && `Skills: ${size(skills)}`,
        mcpLine(c.mcp()),
        reminders !== false && `Reminders: ${reminders}`,
        memoryLine(r),
        readState(paths.stateFile).verbose && "Verbose: on",
      );
    },
  },
  stop: { help: "stop what I'm doing", run: async (c) => ((await stop(c)) ? "Stopped." : "Nothing is running.") },
  new: {
    help: "start a fresh conversation (memory is kept)",
    run: async (c) => {
      await stop(c);
      const { store, thread } = await chatThread(c.mastra, c.chatId, c.r.id);
      if (!store || !thread) return "Already fresh.";
      await store.updateThreadMetadata({ id: thread.id, update: (t) => ({ ...t.metadata, channel_externalThreadId: `${c.chatId}#archived-${Date.now()}` }) });
      return "Fresh conversation. I still have my memory.";
    },
  },
  model: {
    help: "/model to list, /model <name> to switch",
    run: ({ r, paths, env, args }) => {
      const current = activeModelKey(r, paths.stateFile);
      const choice = args.trim();
      if (!choice) return lines("Models:", ...map(toPairs(r.models), ([k, m]) => `${k === current ? "•" : "-"} ${k} (${m.id})`));
      if (!Object.hasOwn(r.models, choice)) return `No model called "${choice}". Try /model.`;
      try {
        toMastraModel(r.models[choice]!, env);
      } catch (e) {
        return `Cannot use ${choice}: ${(e as Error).message}.`;
      }
      patchState(paths.stateFile, { model: choice });
      return `Now using ${choice} (${r.models[choice]!.id}).`;
    },
  },
  reload: {
    help: "re-read my config, keys and skills",
    run: async ({ paths, reload }) => {
      const { fixed, quarantined } = reconcileSkills(paths);
      await reload();
      return lines("Reloaded.", ...map(fixed, (f) => `Adjusted ${f}`), ...map(quarantined, (q) => `Rejected ${q.skill}: ${q.reason}`));
    },
  },
  verbose: {
    help: "/verbose on|off: show tool calls",
    run: ({ paths, args }) => {
      const on = /^(on|true|1)$/i.test(args.trim()) || (!args.trim() && !readState(paths.stateFile).verbose);
      patchState(paths.stateFile, { verbose: on });
      return `Verbose ${on ? "on" : "off"}.`;
    },
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

const helpText = () => lines("Commands:", ...map(COMMANDS, (c, k) => `/${k} · ${c.help}`), "/help · this list");

/** Telegram `/cmd@bot args` -> `cmd`. Only DMs are served; the adapter already limits who can reach this. (A slash event's `channel.isDM` is always false, so ask the adapter.) */
export const slashHandler = (deps: Deps): SlashCommandChannelHandler => async (event, _default, { mastra }) => {
  if (!mastra || !event.adapter.isDM?.(event.channel.id)) return;
  const name = event.command.replace(/^\//, "").split("@")[0]!.toLowerCase();
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  const reply =
    name === "help" || name === "start"
      ? helpText()
      : !cmd
        ? `Unknown command /${name}. Try /help.`
        : await Promise.resolve(cmd.run({ ...deps, mastra, args: event.text, chatId: event.channel.id })).catch((e: Error) => `/${name} failed: ${e.message}`);
  await event.channel.post(reply);
};
