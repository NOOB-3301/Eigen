import type { SlashCommandChannelHandler } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import { compact, map, size, toPairs } from "lodash-es";
import { getConfig, reloadConfig } from "./config.ts";
import { lastRunAt, runConsolidation } from "./consolidate.ts";
import type { HomePaths } from "./home.ts";
import type { ChatQueue } from "./chat-queue.ts";
import type { Mcp, McpState } from "./mcp.ts";
import { listReminders } from "./reminders.ts";
import { reconcileSkills } from "./skills.ts";
import { activeModel, patchState, readState } from "./state.ts";
import { dayjs } from "./time.ts";

export type Deps = { paths: HomePaths; mcp: Mcp; queue: ChatQueue; agentId: string };
type Ctx = Deps & { mastra: Mastra; args: string; chatId: string };
type Command = { help: string; run: (c: Ctx) => Promise<string> | string };

const lines = (...xs: Array<string | false | undefined>) => compact(xs).join("\n");

const mcpLine = ({ servers, errors, tools }: McpState) =>
  servers.length ? `MCP: ${map(servers, (s) => (errors[s] ? `${s} ✗ (${errors[s]})` : `${s} ✓`)).join(", ")} · ${size(tools)} tools` : "MCP: none";

/** The Mastra thread behind this Telegram chat. */
async function chatThread(mastra: Mastra, chatId: string) {
  const store = await mastra.getStorage()?.getStore("memory");
  const filter = { metadata: { channel_platform: "telegram", channel_externalThreadId: chatId } };
  const { threads } = (await store?.listThreads({ filter, perPage: 1, orderBy: { field: "createdAt", direction: "DESC" } })) ?? { threads: [] };
  return { store, thread: threads[0] };
}

const stop = async ({ mastra, agentId, chatId, queue }: Ctx) => {
  queue.clear(chatId);
  const { thread } = await chatThread(mastra, chatId);
  return !!thread && mastra.getAgent(agentId).abortThreadStream({ threadId: thread.id, resourceId: thread.resourceId, clearPendingSignals: true });
};

const COMMANDS: Record<string, Command> = {
  status: {
    help: "model, skills, MCP, reminders, memory",
    run: async (c) => {
      const { paths, mastra, agentId } = c;
      const cfg = getConfig();
      const name = activeModel(cfg, readState(paths));
      const last = lastRunAt(paths);
      const skills = await (await mastra.getAgent(agentId).getWorkspace())?.skills?.list();
      return lines(
        `Model: ${name} (${cfg.models[name]!.id})`,
        `Skills installed: ${size(skills)}`,
        mcpLine(c.mcp.state()),
        `Reminders: ${size(await listReminders(mastra.schedules, agentId))}`,
        `Memory notes updated: ${last.getTime() ? dayjs(last).tz(cfg.timezone).format("ddd D MMM HH:mm") : "never"}`,
        readState(paths).verbose && "Verbose: on",
      );
    },
  },
  stop: { help: "stop what I'm doing", run: async (c) => ((await stop(c)) ? "Stopped." : "Nothing is running.") },
  new: {
    help: "start a fresh conversation (memory is kept)",
    run: async (c) => {
      await stop(c);
      const { store, thread } = await chatThread(c.mastra, c.chatId);
      if (!store || !thread) return "Already fresh.";
      await store.updateThreadMetadata({ id: thread.id, update: (t) => ({ ...t.metadata, channel_externalThreadId: `${c.chatId}#archived-${Date.now()}` }) });
      return "Fresh conversation. I still have my memory and notes.";
    },
  },
  model: {
    help: "/model to list, /model <name> to switch",
    run: ({ paths, args }) => {
      const cfg = getConfig();
      const current = activeModel(cfg, readState(paths));
      const choice = args.trim();
      if (!choice) return lines("Models:", ...map(toPairs(cfg.models), ([k, m]) => `${k === current ? "•" : "-"} ${k} (${m.id})`));
      if (!(choice in cfg.models)) return `No model called "${choice}". Try /model.`;
      patchState(paths, { model: choice });
      return `Now using ${choice} (${cfg.models[choice]!.id}).`;
    },
  },
  reload: {
    help: "re-read config.json and skills",
    run: async ({ paths, mastra, agentId }) => {
      reloadConfig();
      const { fixed, quarantined } = reconcileSkills(paths);
      const workspace = await mastra.getAgent(agentId).getWorkspace();
      await workspace?.skills?.refresh();
      return lines(
        `Reloaded. Skills: ${size(await workspace?.skills?.list())}.`,
        ...map(fixed, (f) => `Adjusted ${f}`),
        ...map(quarantined, (q) => `Rejected ${q.skill}: ${q.reason}`),
        "Telegram settings need a restart.",
      );
    },
  },
  reload_mcp: {
    help: "reconnect MCP servers",
    run: async ({ mcp }) => mcpLine(await mcp.load(reloadConfig())),
  },
  verbose: {
    help: "/verbose on|off: show tool calls",
    run: ({ paths, args }) => {
      const on = /^(on|true|1)$/i.test(args.trim()) || (!args.trim() && !readState(paths).verbose);
      patchState(paths, { verbose: on });
      return `Verbose ${on ? "on" : "off"}.`;
    },
  },
  consolidate: {
    help: "fold recent chats into the memory notes now",
    run: async ({ mastra }) => {
      const r = await runConsolidation(mastra);
      return { nothing: "Nothing new to add.", updated: `Memory notes updated (${r.chunks} batch${r.chunks === 1 ? "" : "es"}).`, rejected: "The update was rejected; nothing changed." }[r.status];
    },
  },
};

const helpText = () => lines("Commands:", ...map(toPairs(COMMANDS), ([k, c]) => `/${k} · ${c.help}`), "/help · this list");

/** Telegram `/cmd@bot args` -> `cmd`. Only DMs are served; the adapter already limits who can reach this. (A slash event's `channel.isDM` is always false, so ask the adapter.) */
export const slashHandler = (deps: Deps): SlashCommandChannelHandler => async (event, _default, { mastra }) => {
  if (!mastra || !event.adapter.isDM?.(event.channel.id)) return;
  const name = event.command.replace(/^\//, "").split("@")[0]!.toLowerCase();
  const cmd = COMMANDS[name];
  const reply =
    name === "help" || name === "start"
      ? helpText()
      : cmd
        ? await Promise.resolve(cmd.run({ ...deps, mastra, args: event.text, chatId: event.channel.id })).catch((e: Error) => `/${name} failed: ${e.message}`)
        : `Unknown command /${name}. Try /help.`;
  await event.channel.post(reply);
};
