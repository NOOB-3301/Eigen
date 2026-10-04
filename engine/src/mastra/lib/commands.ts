import type { SlashCommandChannelHandler } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import type { LocalSandbox } from "@mastra/core/workspace";
import { compact, map, pick, size, toPairs } from "lodash-es";
import { getConfig, reloadConfig } from "./config.ts";
import { lastRunAt, runConsolidation } from "./consolidate.ts";
import type { HomePaths } from "./home.ts";
import type { ChatQueue } from "./chat-queue.ts";
import type { Mcp, McpState } from "./tools/mcp.ts";
import { listReminders } from "./tools/schedule.ts";
import { secretsHidden } from "./sandbox.ts";
import { refreshSkillEnv } from "./sandbox.ts";
import { reconcileSkills } from "./skills.ts";
import { activeModel, patchState, readState } from "./state.ts";
import { dayjs } from "./time.ts";

/**
 * `baseModel`: the agent's own model key, used when no /model choice is set. `rescan`: re-resolve the agent fleet after config.json was re-read.
 * `restricted`: a specialist's own bot. It gets only /help /status /stop /new: everything else acts on the whole install (global model choice,
 * root config, MCP connections, the memory notes) and must not be reachable by whoever a specialist bot's allow-list names.
 */
export type Deps = { paths: HomePaths; mcp: Mcp; queue: ChatQueue; agentId: string; baseModel?: () => string | undefined; rescan?: () => Promise<void>; restricted?: boolean };
type Ctx = Deps & { mastra: Mastra; args: string; chatId: string };
type Command = { help: string; run: (c: Ctx) => Promise<string> | string };

const lines = (...xs: Array<string | false | undefined>) => compact(xs).join("\n");

const mcpLine = ({ servers, errors, tools }: McpState) =>
  servers.length ? `MCP: ${map(servers, (s) => (errors[s] ? `${s} ✗ (${errors[s]})` : `${s} ✓`)).join(", ")} · ${size(tools)} tools` : "MCP: none";

/**
 * The Mastra thread behind this Telegram chat, for THIS agent. Every bot talks to the same user in the same Telegram chat id, and Mastra
 * stamps each channel thread with `channel_ownerId` (the agent), so without that scope a specialist's /new would archive the primary's thread.
 * Threads from before the stamp existed (no owner at all) still count, as they do in Mastra's own lookup.
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

const stop = async ({ mastra, agentId, chatId, queue }: Ctx) => {
  queue.clear(chatId);
  const { thread } = await chatThread(mastra, chatId, agentId);
  return !!thread && mastra.getAgent(agentId).abortThreadStream({ threadId: thread.id, resourceId: thread.resourceId, clearPendingSignals: true });
};

const COMMANDS: Record<string, Command> = {
  status: {
    help: "model, skills, MCP, reminders, memory",
    run: async (c) => {
      const { paths, mastra, agentId } = c;
      const cfg = getConfig();
      const state = c.restricted ? {} : readState(paths);
      const name = activeModel(cfg, state, c.baseModel?.());
      const last = lastRunAt(paths);
      const workspace = await mastra.getAgent(agentId).getWorkspace();
      const skills = await workspace?.skills?.list();
      const sandbox = workspace?.sandbox as LocalSandbox | undefined;
      const hidden = sandbox && (await secretsHidden(sandbox, paths));
      return lines(
        `Model: ${name} (${cfg.models[name]!.id})`,
        `Sandbox: ${sandbox?.isolation ?? "none"}, secrets ${hidden === undefined ? "unchecked" : hidden ? "hidden" : "READABLE"}`,
        `Skills installed: ${size(skills)}`,
        mcpLine(c.mcp.state()),
        `Reminders: ${size(await listReminders(mastra.schedules, agentId))}`,
        `Memory notes updated: ${last.getTime() ? dayjs(last).tz(cfg.timezone).format("ddd D MMM HH:mm") : "never"}`,
        state.verbose && "Verbose: on",
      );
    },
  },
  stop: { help: "stop what I'm doing", run: async (c) => ((await stop(c)) ? "Stopped." : "Nothing is running.") },
  new: {
    help: "start a fresh conversation (memory is kept)",
    run: async (c) => {
      await stop(c);
      const { store, thread } = await chatThread(c.mastra, c.chatId, c.agentId);
      if (!store || !thread) return "Already fresh.";
      await store.updateThreadMetadata({ id: thread.id, update: (t) => ({ ...t.metadata, channel_externalThreadId: `${c.chatId}#archived-${Date.now()}` }) });
      return "Fresh conversation. I still have my memory and notes.";
    },
  },
  model: {
    help: "/model to list, /model <name> to switch",
    run: ({ paths, args, baseModel }) => {
      const cfg = getConfig();
      const current = activeModel(cfg, readState(paths), baseModel?.());
      const choice = args.trim();
      if (!choice) return lines("Models:", ...map(toPairs(cfg.models), ([k, m]) => `${k === current ? "•" : "-"} ${k} (${m.id})`));
      if (!(choice in cfg.models)) return `No model called "${choice}". Try /model.`;
      patchState(paths, { model: choice });
      return `Now using ${choice} (${cfg.models[choice]!.id}).`;
    },
  },
  reload: {
    help: "re-read models, timezone and skills",
    run: async ({ paths, mastra, agentId, rescan }) => {
      reloadConfig();
      await rescan?.();
      const { fixed, quarantined } = reconcileSkills(paths);
      const workspace = await mastra.getAgent(agentId).getWorkspace();
      await workspace?.skills?.refresh();
      const keys = workspace?.sandbox ? refreshSkillEnv(workspace.sandbox, paths) : [];
      return lines(
        `Reloaded. Skills: ${size(await workspace?.skills?.list())}. Skill env vars: ${keys.length}.`,
        ...map(fixed, (f) => `Adjusted ${f}`),
        ...map(quarantined, (q) => `Rejected ${q.skill}: ${q.reason}`),
        "Sandbox, memory, limits and Telegram settings need a restart.",
      );
    },
  },
  reload_mcp: {
    help: "reconnect MCP servers",
    run: async ({ mcp, rescan }) => {
      const state = await mcp.load(reloadConfig());
      await rescan?.();
      return mcpLine(state);
    },
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

/** What a specialist's own bot may run. */
export const RESTRICTED_COMMANDS = ["status", "stop", "new"];

const helpText = (restricted?: boolean) =>
  lines("Commands:", ...map(restricted ? pick(COMMANDS, RESTRICTED_COMMANDS) : COMMANDS, (c, k) => `/${k} · ${c.help}`), "/help · this list");

/** Telegram `/cmd@bot args` -> `cmd`. Only DMs are served; the adapter already limits who can reach this. (A slash event's `channel.isDM` is always false, so ask the adapter.) */
export const slashHandler = (deps: Deps): SlashCommandChannelHandler => async (event, _default, { mastra }) => {
  if (!mastra || !event.adapter.isDM?.(event.channel.id)) return;
  const name = event.command.replace(/^\//, "").split("@")[0]!.toLowerCase();
  const cmd = COMMANDS[name];
  const run = () => Promise.resolve(cmd!.run({ ...deps, mastra, args: event.text, chatId: event.channel.id })).catch((e: Error) => `/${name} failed: ${e.message}`);
  const reply =
    name === "help" || name === "start"
      ? helpText(deps.restricted)
      : !cmd
        ? `Unknown command /${name}. Try /help.`
        : deps.restricted && !RESTRICTED_COMMANDS.includes(name)
          ? `/${name} is only available on the main bot.`
          : await run();
  await event.channel.post(reply);
};
