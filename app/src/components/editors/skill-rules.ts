/**
 * What the skill editor tells its author while they type. The rules that decide whether the engine loads a skill (frontmatter,
 * name equals folder, description) come from the engine's own validator, so the editor can never disagree with a save.
 * What is added here is advice that is not a rule: a short description, an empty body, the file size cap.
 * Pure (no React) so a node script can check it.
 */
import { MAX_SKILL_DESCRIPTION, parseSkillText, validateSkillText } from "@eigen/engine/skillspec";

export const MAX_SKILL_TEXT = 100_000;
export const MAX_DESCRIPTION = MAX_SKILL_DESCRIPTION;
/** Below this the model has little to decide with. A nudge, not an error. */
const SHORT_DESCRIPTION = 24;

export type SkillIssues = { errors: string[]; warnings: string[] };

export function validateSkillDraft(slug: string, text: string): SkillIssues {
  const errors = validateSkillText(slug, text);
  if (text.length > MAX_SKILL_TEXT) errors.unshift(`SKILL.md is over ${MAX_SKILL_TEXT.toLocaleString("en-US")} characters`);
  const warnings: string[] = [];
  const skill = parseSkillText(text);
  if (!skill.error) {
    const description = skill.description?.trim() ?? "";
    if (description && description.length < SHORT_DESCRIPTION) warnings.push("The description is very short. The model picks skills by it: say what the skill does and when to use it.");
    if (skill.body.trim() === "") warnings.push("The body is empty. Put the steps the model should follow after the frontmatter.");
  }
  return { errors, warnings };
}

/** Everything up to and including the frontmatter's closing line; empty when the text has no frontmatter. */
const headOf = (text: string) => text.slice(0, text.length - parseSkillText(text).body.length);

/** True when there is a frontmatter block and nothing after it. */
export const hasBlankBody = (text: string) => headOf(text) !== "" && parseSkillText(text).body.trim() === "";

const titleOf = (slug: string) => {
  const t = (slug.split("/").pop() ?? slug).replaceAll("-", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** A body worth starting from: when it applies, the steps, the rules. Every line is meant to be rewritten. */
export const starterBody = (slug: string) =>
  `# ${titleOf(slug)}

Use this skill when the user asks for ... (the situation, in their words).

## Steps

1. First, ...
2. Before moving on, check that ...
3. Finish by telling the user ...

## Rules

- Always ...
- Never ...
`;

/** Appends the starter body after the frontmatter. Text without frontmatter is left alone. */
export function withStarterBody(slug: string, text: string): string {
  const head = headOf(text);
  if (head === "") return text;
  return `${head}${head.endsWith("\n") ? "" : "\n"}\n${starterBody(slug)}`;
}
