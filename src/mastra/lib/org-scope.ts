import type { Processor } from "@mastra/core/processors";

/** Mastra's knowledge layer (Subconscious curate/remind and the knowledge tools) files everything under org → resource → thread and throws without an organization. Eigen has one owner, so it is a constant. */
export const ORGANIZATION_ID = "eigen";

export const orgScopeProcessor = {
  id: "org-scope",
  name: "Set the knowledge organization",
  processInput: ({ messages, requestContext }) => {
    requestContext?.set("organizationId", ORGANIZATION_ID);
    return messages;
  },
} satisfies Processor;
