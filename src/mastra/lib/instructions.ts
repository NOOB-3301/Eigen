import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compact, truncate } from "lodash-es";
import type { HomePaths } from "./home.ts";
import { reportFile } from "./skills.ts";
import { clockLine } from "./time.ts";

export const MEMORY_FILES = ["MEMORY.md", "profile.md", "projects.md", "people.md", "lessons.md"];
const MEMORY_MAX_CHARS = 24_000;
const FALLBACK = "You are eigen, a personal assistant. Be concise.";

export const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

const tag = (name: string, body: string) => (body ? `<${name}>\n${body}\n</${name}>` : "");

export const memoryBlock = (memoryDir: string) =>
  truncate(
    compact(MEMORY_FILES.map((name) => ((text) => text && `## ${name}\n${text}`)(readText(join(memoryDir, name))))).join("\n\n"),
    { length: MEMORY_MAX_CHARS, omission: "\n[memory truncated]" },
  );

/** Re-read from disk on every turn, so edits apply to the next message. The clock goes last to keep the cacheable prefix stable. */
export const buildInstructions = (p: HomePaths, zone: string, at?: Date) =>
  compact([
    tag("operating_instructions", readText(p.systemPromptFile) || FALLBACK),
    tag("soul", readText(p.soulFile)),
    tag("memory", memoryBlock(p.memoryDir)),
    tag("skill_notes", readText(reportFile(p))),
    clockLine(zone, at),
  ]).join("\n\n");
