import { z } from "zod";
import { defineTool } from "../registry.ts";

export const currentTime = defineTool({
  name: "current_time",
  description: "Get the current date, time and timezone of the host machine.",
  inputSchema: z.object({}),
  async execute() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
    return `${local}\nISO: ${now.toISOString()}\nTimezone: ${tz}`;
  },
});
