import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "../registry.ts";
import { expandHome } from "../../config/home.ts";

const MAX_CAPTURE = 1_000_000;

export const shellExec = defineTool({
  name: "shell_exec",
  description: "Run a shell command with /bin/sh on the host Mac. Returns exit code, stdout and stderr.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell command to run"),
    cwd: z.string().optional().describe("Working directory; ~ is expanded. Defaults to the home directory."),
  }),
  execute({ command, cwd }, { signal }) {
    return new Promise((resolve, reject) => {
      // detached => own process group, so cancel kills the whole pipeline, not just sh.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: expandHome(cwd ?? "~"),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
      child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
      const kill = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      };
      signal.addEventListener("abort", kill, { once: true });
      child.on("error", (e) => {
        signal.removeEventListener("abort", kill);
        reject(e);
      });
      child.on("close", (code, sig) => {
        signal.removeEventListener("abort", kill);
        const status = code === null ? `killed by ${sig}` : `exit code ${code}`;
        const body = `${status}\n--- stdout ---\n${stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}`;
        resolve({ content: [{ type: "text", text: body }], isError: code !== 0 });
      });
    });
  },
});
