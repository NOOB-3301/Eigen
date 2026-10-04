/**
 * One agent's system prompt, re-read from its folder on every turn so edits apply to the next message with no reload. Everything comes from
 * that agent's own folder: its role (instructions.inline or instructions.file), its soul, its ground rules and skill notes in its sandbox.
 */
import { readFileSync } from "node:fs";
import { compact, truncate } from "lodash-es";
import type { AgentPaths } from "./home.ts";
import type { ResolvedAgent } from "./schema.ts";
import { reportFile } from "./skills.ts";
import { readAgentMd, soulText } from "./soul.ts";
import { clockLine } from "./time.ts";

const SECRETS_RULE = [
  "API keys and tokens for skills go in .env in your working directory (the sandbox root), one NAME=value per line. Skills read them as environment variables, so the next command sees a new key with no restart.",
  "To add one: run `printf '\\n%s=%s\\n' NAME 'value' >> .env` (the leading newline stops it joining the previous line), or use the write tool with every variable on its own line, ending in a newline. To change one, edit its line; do not append a duplicate.",
  "Never put a key in working memory, notes or scripts, and never repeat one back to the user: say only its name. In scripts, read it from the environment.",
].join("\n");
const MEMORY_RULE = [
  "Working memory holds small, stable facts about the user. Before updating it, read the current <working_memory_data> block and change only what changed: keep every other section and line as it is. Never rebuild it from scratch and never replace content with a placeholder such as \"unchanged\" or \"other rules\".",
  "Do not put logs, per-task progress or copied web text in working memory. Older conversation is not lost: use the recall tool, when you have one, to look it up instead of guessing.",
].join("\n");
const GROUND_RULES_MAX_CHARS = 6000;
const GROUND_RULES_INTRO = [
  "Standing rules the user marked as critical or as ground rules. They apply in every conversation, including scheduled runs, and take priority over the rest of this prompt except safety.",
  "When the user says something is a ground rule or critical, or states a standing always/never rule, record it right away: add one short bullet with today's date to groundrules.md in your working directory (create it with the write tool if it does not exist, otherwise use the edit tool so the other rules stay untouched), merge it into an existing rule on the same topic instead of duplicating it, then confirm in one line. Never remove or reword a rule unless the user asks. Never put secrets in it. Standing rules go here, not in working memory.",
].join("\n");
const FINISH_RULE = [
  "Finish what you start. Never end a turn by saying you will do something: if you write \"I'll check\", \"I'll reply\", \"let me\" or \"I'll continue\", make that tool call in the same turn instead of writing the sentence.",
  "Keep calling tools until every question in the message is answered and every task you were given is complete. If there are several items (notifications, comments, files, steps), work through all of them, one after another, before you reply. A text-only reply ends your turn, so send one only when the work is done or you are blocked and need the user.",
  "In your final reply, say what you did and what the results were. If something could not be done, say exactly what failed and why.",
].join("\n");

export const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

const tag = (name: string, body: string) => (body ? `<${name}>\n${body}\n</${name}>` : "");

/** The role prompt: `instructions.inline` when set, else the agent's instructions file (confined to its folder). */
export function roleText(r: Pick<ResolvedAgent, "instructions">, agentDir: string): string {
  if (r.instructions.inline !== undefined) return r.instructions.inline.trim();
  const read = readAgentMd(agentDir, r.instructions.file);
  return "text" in read ? read.text : "";
}

type PromptAgent = Pick<ResolvedAgent, "name" | "instructions" | "soul" | "timezone" | "tools" | "memory">;
type PromptPaths = Pick<AgentPaths, "dir" | "groundRulesFile" | "sandboxQuarantineDir">;

/** The whole system prompt for this turn. The clock goes last to keep the cacheable prefix stable. */
export function buildInstructions(r: PromptAgent, p: PromptPaths, at?: Date): string {
  const workspace = r.tools.builtin.includes("workspace");
  const groundRules = truncate(readText(p.groundRulesFile), { length: GROUND_RULES_MAX_CHARS, omission: "\n[rules truncated]" });
  return compact([
    tag("operating_instructions", roleText(r, p.dir) || `You are ${r.name}. Be concise.`),
    tag("soul", soulText(r.soul, p.dir)),
    // The agent keeps its ground rules in its sandbox, so they exist only with the workspace tool (or when it had one before).
    (workspace || groundRules) && tag("ground_rules", `${GROUND_RULES_INTRO}\n\n${groundRules || "(none yet)"}`),
    workspace && tag("skill_notes", readText(reportFile(p))),
    workspace && tag("secrets", SECRETS_RULE),
    r.memory.storage.enabled && r.memory.workingMemory.enabled && tag("memory_rules", MEMORY_RULE),
    tag("finishing", FINISH_RULE),
    clockLine(r.timezone, at),
  ]).join("\n\n");
}
