import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../tools/registry.ts";
import type { Tool } from "../tools/registry.ts";
import type { SkillStore } from "./store.ts";

export type SkillToolDeps = {
  store: SkillStore;
  // Provided by the agent: runs the same eval pipeline the capture stage uses.
  save: (draft: { name: string; description: string; when?: string; body: string }) => Promise<{ ok: boolean; slug?: string; reasons: string[] }>;
};

export function createSkillTools(deps: SkillToolDeps): Tool[] {
  const read = defineTool({
    name: "skill_read",
    description: "Load the full steps of a skill from the skill index. Do this before working out a procedure the index already covers.",
    inputSchema: z.object({ slug: z.string().min(1).describe("Slug from the skill index") }),
    async execute({ slug }) {
      const skill = deps.store.get(slug);
      if (!skill) {
        const known = deps.store.slugs();
        return { content: [{ type: "text", text: `No skill "${slug}".${known.length ? ` Available: ${known.join(", ")}` : ""}` }], isError: true };
      }
      deps.store.recordUse(slug);
      return [
        `# ${skill.name} (v${skill.meta.version}, ${skill.source})`,
        skill.when ? `Use when: ${skill.when}` : "",
        skill.scripts.length ? `Scripts: ${skill.scripts.map((p) => join(skill.dir, p)).join(", ")}` : "",
        "",
        skill.body,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const update = defineTool({
    name: "skill_update",
    description: "Fix a skill whose steps were wrong or incomplete while you followed it. Keeps the previous version.",
    inputSchema: z.object({
      slug: z.string().min(1),
      body: z.string().min(50).describe("The full corrected body (markdown, without frontmatter)"),
      note: z.string().max(200).optional().describe("What changed and why"),
    }),
    async execute({ slug, body, note }) {
      try {
        const skill = deps.store.update(slug, body, note);
        return `Updated ${slug} to v${skill.meta.version}.`;
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  });

  const save = defineTool({
    name: "skill_save",
    description: "Save a reusable procedure as a skill. Use when the user asks you to remember how to do something. It is checked before being stored.",
    inputSchema: z.object({
      name: z.string().min(2).max(64),
      description: z.string().min(10).max(120).describe("One line: what it does and for what"),
      when: z.string().max(200).optional(),
      body: z.string().min(200).describe("Markdown: preconditions, numbered steps with real commands, pitfalls"),
    }),
    async execute(draft) {
      const r = await deps.save(draft);
      if (r.ok) return `Saved skill "${r.slug}".`;
      return { content: [{ type: "text", text: `Not saved:\n- ${r.reasons.join("\n- ")}` }], isError: true };
    },
  });

  return [read, update, save];
}
