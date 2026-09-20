import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineTool } from "../registry.ts";
import { eigenHome, expandHome } from "../../config/home.ts";
import { formatResult, run } from "./shell-session.ts";

const LANGS = {
  python: { ext: "py", cmd: "python3" },
  javascript: { ext: "mjs", cmd: "node" },
  typescript: { ext: "ts", cmd: "node" }, // Node strips types natively
  bash: { ext: "sh", cmd: "bash" },
} as const;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export const runCode = defineTool({
  name: "run_code",
  description:
    "Run a program and return its exit code and output. Give either `code` (saved to a snippet file, then run) or `path` to an existing file. " +
    "Runs in your persistent shell, so it uses that shell's current directory, env and virtualenv. Print results explicitly. Set timeoutSec for long jobs.",
  inputSchema: z
    .object({
      language: z.enum(["python", "javascript", "typescript", "bash"]),
      code: z.string().min(1).optional().describe("Source code to run"),
      path: z.string().min(1).optional().describe("Existing file to run instead of code; ~ is expanded"),
      args: z.array(z.string()).default([]).describe("Command-line arguments"),
      timeoutSec: z.number().int().positive().optional(),
    })
    .refine((i) => (i.code === undefined) !== (i.path === undefined), { message: "Provide exactly one of `code` or `path`." }),
  timeoutMs: ({ timeoutSec }) => (timeoutSec ? timeoutSec * 1000 : undefined),
  async execute({ language, code, path, args }, { sessionId, signal }) {
    const lang = LANGS[language];
    let file: string;
    let saved = "";
    if (code !== undefined) {
      // Kept (not temp) so the user and the model can inspect, edit or re-run it later.
      const dir = join(eigenHome(), "workspace", "snippets");
      await mkdir(dir, { recursive: true });
      file = join(dir, `${stamp()}-${randomBytes(3).toString("hex")}.${lang.ext}`);
      await writeFile(file, code);
      saved = `saved to ${file}\n`;
    } else {
      file = expandHome(path!);
      // Relative paths resolve against the shell's cwd, which only the shell knows.
      if (isAbsolute(file) && !existsSync(file)) throw new Error(`file not found: ${file}`);
    }
    const cmd = [lang.cmd, quote(file), ...args.map(quote)].join(" ");
    return formatResult(await run(sessionId, cmd, signal), `${saved}$ ${cmd}\n`);
  },
});
