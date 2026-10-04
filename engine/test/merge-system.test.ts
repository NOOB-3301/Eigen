import { describe, expect, it } from "vitest";
import { mergeSystemMessages } from "../src/mastra/lib/merge-system.ts";

const user = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };

describe("mergeSystemMessages", () => {
  it("folds several system messages into one at the front", () => {
    const out = mergeSystemMessages([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      user,
      { role: "system", content: "c" },
    ]);
    expect(out).toEqual([{ role: "system", content: "a\n\nb\n\nc" }, user]);
  });

  it("leaves a prompt with one system message alone", () => {
    const prompt = [{ role: "system" as const, content: "a" }, user];
    expect(mergeSystemMessages(prompt)).toBe(prompt);
  });
});
