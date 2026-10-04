import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compact, uniq } from "lodash-es";
import { z } from "zod";
import { hasSecret } from "./secrets.ts";
import { dayjs } from "./time.ts";

export const CAPS = { "MEMORY.md": 1500, "profile.md": 4000, "projects.md": 5000, "people.md": 4000, "lessons.md": 3000 } as const;
type Name = keyof typeof CAPS;

export const UpdateSchema = z.object({
  files: z.array(z.object({ name: z.enum(Object.keys(CAPS) as [Name, ...Name[]]), content: z.string() })),
  timeline: z.string().max(3000).optional(),
});
export type Update = z.infer<typeof UpdateSchema>;

/** Reasons to reject a curator update. Anything returned here is fed back to the model for one retry. */
export const validate = (u: Update): string[] =>
  compact([
    uniq(u.files.map((f) => f.name)).length !== u.files.length && "each file may appear only once",
    ...u.files.flatMap((f) => [
      !f.content.trim() && `${f.name} is empty; return the full new content or omit the file`,
      f.content.length > CAPS[f.name] && `${f.name} is ${f.content.length} chars; the cap is ${CAPS[f.name]}. Condense it`,
      hasSecret(f.content) && `${f.name} contains something that looks like a secret; remove it`,
    ]),
    u.timeline && hasSecret(u.timeline) && "timeline contains something that looks like a secret; remove it",
  ]);

const writeAtomic = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  renameSync(tmp, file);
};

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** One "## YYYY-MM-DD" section per day in timeline/YYYY-MM.md; today's is replaced, not duplicated. */
export function writeTimeline(memoryDir: string, text: string, at: Date, zone: string) {
  const day = dayjs(at).tz(zone).format("YYYY-MM-DD");
  const file = join(memoryDir, "timeline", `${day.slice(0, 7)}.md`);
  const others = read(file).split(/\n(?=## )/).filter((s) => s.trim() && !s.startsWith(`## ${day}`));
  writeAtomic(file, [...(others.length ? others : [`# ${day.slice(0, 7)}`]), `## ${day}\n${text.trim()}`].join("\n\n"));
}

export function applyUpdate(memoryDir: string, u: Update, at: Date, zone: string) {
  u.files.forEach((f) => writeAtomic(join(memoryDir, f.name), f.content));
  if (u.timeline?.trim()) writeTimeline(memoryDir, u.timeline, at, zone);
}

/** Memory is a git repo so every change is auditable and revertable. Returns false if there was nothing to commit. */
export function commitMemory(dir: string, message: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=eigen", "-c", "user.email=eigen@localhost", ...args], { stdio: "pipe" });
  try {
    if (!existsSync(join(dir, ".git"))) git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return true;
  } catch {
    return false;
  }
}
