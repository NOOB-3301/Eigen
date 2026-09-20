import { z } from "zod";
import { defineTool } from "../registry.ts";
import { formatResult, run } from "./shell-session.ts";

export const shellExec = defineTool({
  name: "shell_exec",
  description:
    "Run a command in your persistent bash shell on the host Mac. cd, exported variables and activated virtualenvs persist between calls; the shell starts in the home directory. " +
    "Commands run non-interactively with stdin closed: anything that prompts (sudo password, [y/N]) fails, so pass flags like -y / --yes or NONINTERACTIVE=1. " +
    "Returns the exit code and combined stdout+stderr. For slow commands such as package installs, set timeoutSec (up to 900). A timeout or cancel kills the shell and resets its state.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Bash command line"),
    timeoutSec: z.number().int().positive().optional().describe("Raise for slow commands, e.g. 600 for brew install. Default is short."),
  }),
  timeoutMs: ({ timeoutSec }) => (timeoutSec ? timeoutSec * 1000 : undefined),
  async execute({ command }, { sessionId, signal }) {
    return formatResult(await run(sessionId, command, signal));
  },
});
