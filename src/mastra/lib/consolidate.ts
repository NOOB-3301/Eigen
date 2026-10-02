import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mastra } from "@mastra/core/mastra";
import { getConfig } from "./config.ts";
import { applyUpdate, CAPS, commitMemory, UpdateSchema, validate, type Update } from "./curate.ts";
import { readyPaths, type HomePaths } from "./home.ts";
import { readText } from "./instructions.ts";
import { messagesSince, transcripts, type Row } from "./memory-delta.ts";

export type Deps = {
  paths: HomePaths;
  zone: string;
  rows: (since: Date) => Promise<Row[]>;
  curate: (prompt: string) => Promise<Update>;
};

const stateFile = (p: HomePaths) => join(p.dataDir, "consolidation.json");

export const lastRunAt = (p: HomePaths) => {
  try {
    return new Date(JSON.parse(readFileSync(stateFile(p), "utf8")).lastRunAt);
  } catch {
    return new Date(0);
  }
};

export function buildPrompt(p: HomePaths, transcript: string, problems: string[] = []) {
  const files = Object.entries(CAPS).map(([name, cap]) => `<file name="${name}" cap="${cap}">\n${readText(join(p.memoryDir, name))}\n</file>`);
  return [
    "Current memory files:",
    files.join("\n"),
    "New conversations since the last update:",
    `<conversations>\n${transcript}</conversations>`,
    "Update the memory files. Return only files that must change, each with its full new content, within its cap. Merge and prune instead of appending. Add a short timeline entry for what happened.",
    ...(problems.length ? ["Your previous answer was rejected:", ...problems.map((x) => `- ${x}`)] : []),
  ].join("\n\n");
}

async function curateChunk(d: Deps, transcript: string) {
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const update = await d.curate(buildPrompt(d.paths, transcript, problems));
    problems = validate(update);
    if (!problems.length) return update;
  }
  return undefined;
}

/** Folds new conversations into the memory files. Progress is saved per chunk, so a failure retries only what's left. */
export async function consolidate(d: Deps) {
  let chunks = 0;
  for (const c of transcripts(await d.rows(lastRunAt(d.paths)), d.zone)) {
    const update = await curateChunk(d, c.text);
    if (!update) return { status: "rejected" as const, chunks };
    applyUpdate(d.paths.memoryDir, update, c.until, d.zone);
    commitMemory(d.paths.memoryDir, `memory: through ${c.until.toISOString()}`);
    writeFileSync(stateFile(d.paths), JSON.stringify({ lastRunAt: c.until.toISOString() }));
    chunks++;
  }
  return { status: chunks ? ("updated" as const) : ("nothing" as const), chunks };
}

let inflight: ReturnType<typeof consolidate> | undefined;

/** The nightly schedule and /consolidate share this; overlapping calls join the run in progress. */
export const consolidateOnce = (d: Deps) => (inflight ??= consolidate(d).finally(() => (inflight = undefined)));

export const runConsolidation = (mastra: Mastra) =>
  consolidateOnce({
    paths: readyPaths(),
    zone: getConfig().timezone,
    rows: (since) => messagesSince(mastra.getStorage()!, since),
    // Prompt injection, not the provider's native JSON format: some hosted open models (gpt-oss on ollama-cloud) answer in prose when asked for a response schema.
    curate: async (prompt) => (await mastra.getAgent("curator").generate(prompt, { structuredOutput: { schema: UpdateSchema, jsonPromptInjection: true } })).object as Update,
  });
