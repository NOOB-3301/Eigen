import type { AgentSchedule, Schedules } from "@mastra/core/schedules";
import { createTool } from "@mastra/core/tools";
import { filter, map, truncate } from "lodash-es";
import { z } from "zod";
import { getConfig } from "../config.ts";
import { dayjs } from "../time.ts";

const SOURCE = "reminder";
const fail = (error: string) => ({ error });

const Input = z.object({
  action: z.enum(["create", "list", "pause", "resume", "delete"]),
  id: z.string().optional().describe("schedule id (pause, resume, delete)"),
  cron: z.string().optional().describe("five-field cron in the user's timezone (create)"),
  prompt: z.string().optional().describe("what to do when it fires, worded as an instruction to yourself (create)"),
  once: z.boolean().optional().describe("true for a one-time reminder; it is removed after it fires (create)"),
});

const ours = (s: unknown): s is AgentSchedule => (s as AgentSchedule)?.metadata?.source === SOURCE;

export const listReminders = async (schedules: Schedules, agentId: string) => filter((await schedules.list({ agentId })) as AgentSchedule[], ours);

/** One-shot reminders are cron rows underneath, so they are deleted once they have fired. */
export async function pruneOneShots(schedules: Schedules) {
  const fired = filter((await schedules.list()) as AgentSchedule[], (s) => ours(s) && s.metadata?.once === true && !!s.lastFireAt);
  await Promise.all(map(fired, (s) => schedules.delete(s.id)));
  return fired.length;
}

const view = (zone: string) => (s: AgentSchedule) => ({
  id: s.id,
  prompt: s.prompt,
  cron: s.cron,
  once: s.metadata?.once === true,
  status: s.status,
  next: dayjs(s.nextFireAt).tz(zone).format("ddd D MMM YYYY HH:mm"),
});

export const makeScheduleTool = (zone: () => string = () => getConfig().timezone) =>
  createTool({
    id: "schedule",
    description:
      "Set reminders and recurring jobs that message the user in this chat. Actions: create (needs cron and prompt), list, pause, resume, delete (need id). Cron is evaluated in the user's timezone; for a one-time reminder use a cron for that exact time with once=true.",
    inputSchema: Input,
    requireApproval: (input) => input.action !== "list",
    execute: async ({ action, id, cron, prompt, once }, context) => {
      const mastra = context?.mastra;
      const { threadId, resourceId, agentId } = context?.agent ?? {};
      if (!mastra || !agentId) return fail("schedules are not available here");
      const { schedules } = mastra;
      const show = view(zone());

      if (action === "list") {
        await pruneOneShots(schedules);
        return { schedules: map(await listReminders(schedules, agentId), show) };
      }
      if (action === "create") {
        if (!cron || !prompt) return fail("create needs cron and prompt");
        if (!threadId || !resourceId) return fail("a reminder must be created from the chat it should message");
        const made = await schedules
          .create({ agentId, cron, prompt, timezone: zone(), threadId, resourceId, name: truncate(prompt, { length: 60 }), metadata: { source: SOURCE, once: !!once } })
          .catch((e: unknown) => fail(`could not create the schedule: ${(e as Error).message}`));
        return "error" in made ? made : show(made);
      }
      const found = id && (await schedules.get(id));
      if (!found || !ours(found)) return fail(`no reminder with id ${id}`);
      if (action === "delete") return (await schedules.delete(found.id), { deleted: found.id });
      return show((await schedules.update(found.id, { status: action === "pause" ? "paused" : "active" })) as AgentSchedule);
    },
  });
