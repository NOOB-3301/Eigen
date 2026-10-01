import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { evaluateDraft, validateDraft } from "../../src/skills/eval.ts";
import { judge } from "../../src/models/judge.ts";
import { SkillStore } from "../../src/skills/store.ts";
import type { SkillDraft } from "../../src/skills/store.ts";
import { FakeProvider, testConfig } from "../helpers/fake-provider.ts";

const config = testConfig();
const entry = config.models.fake!;
const goodDraft: SkillDraft = {
  name: "directus query",
  description: "Query a Directus API for collections and items",
  when: "user asks to read data from Directus",
  body: ["## Preconditions", "- DIRECTUS_URL and DIRECTUS_TOKEN in the environment", "", "## Steps", "1. GET {url}/collections with Authorization: Bearer $DIRECTUS_TOKEN", "2. Users live at /users, not /items/users", "3. Custom collections live at /items/<name>", "", "## Notes", "- A 403 usually means the wrong collection name, not a bad token"].join("\n"),
};

function freshStore() {
  const s = new SkillStore(mkdtempSync(join(tmpdir(), "eigen-eval-")), config.skills);
  s.load();
  return s;
}

// A judge that answers whatever we tell it to, through the real evaluate() path.
function mockJudge(answers: Record<string, unknown>) {
  return new Experimental_EvaluationMockModelV4({
    supportedQuestionTypes: ["score", "boolean", "choice"],
    doEvaluate: async () => ({ answers, usage: { inputTokens: 10, outputTokens: 0 } }) as never,
  });
}

const PASSING = {
  reusable: { type: "score", score: 3 },
  specific: { type: "boolean", probability: 0.95 },
  preconditions: { type: "boolean", probability: 0.9 },
  redundant: { type: "boolean", probability: 0.05 },
  verdict: { type: "choice", choice: "keep" },
};

function depsWith(provider: FakeProvider) {
  return { entry, entryName: "fake", provider };
}

describe("validateDraft", () => {
  const cases: Array<[string, Partial<SkillDraft>, RegExp]> = [
    ["a body that is too thin", { body: "do the thing" }, /too thin/],
    ["a secret in the body", { body: `${goodDraft.body}\nexport DIRECTUS_TOKEN=sk-abc123456789012345` }, /secret/],
    ["a credential path", { body: `${goodDraft.body}\ncat ~/.ssh/id_rsa` }, /credential path/],
    ["an over-long description", { description: "x".repeat(130) }, /under 120/],
    ["a missing name", { name: "" }, /missing name/],
  ];
  for (const [label, patch, re] of cases) {
    it(`rejects ${label}`, () => {
      expect(validateDraft({ ...goodDraft, ...patch }, freshStore()).join(" ")).toMatch(re);
    });
  }

  it("rejects a script path that escapes the skill directory", () => {
    expect(validateDraft({ ...goodDraft, scripts: [{ path: "../evil.sh", content: "x" }] }, freshStore()).join(" ")).toMatch(/stay inside/);
  });

  it("rejects a near-duplicate of an existing skill", () => {
    const store = freshStore();
    store.write(goodDraft, "agent-created");
    expect(validateDraft(goodDraft, store).join(" ")).toMatch(/duplicates existing skill/);
  });

  it("accepts a good draft", () => {
    expect(validateDraft(goodDraft, freshStore())).toEqual([]);
  });
});

describe("evaluateDraft", () => {
  it("passes a good draft judged positively", async () => {
    const provider = new FakeProvider([{ text: JSON.stringify({ reusable: 3, specific: 0.9, preconditions: 0.9, redundant: 0.1, verdict: "keep" }) }]);
    const ok = await evaluateDraft(goodDraft, freshStore(), config.skills, depsWith(provider));
    expect(ok).toMatchObject({ ok: true, score: 3, reasons: [] });
  });

  it("fails a draft the judge scores low, with reasons", async () => {
    const provider = new FakeProvider([{ text: JSON.stringify({ reusable: 0, specific: 0.2, preconditions: 0.1, redundant: 0.9, verdict: "discard" }) }]);
    const v = await evaluateDraft(goodDraft, freshStore(), config.skills, depsWith(provider));
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not reusable enough.*too generic.*preconditions.*already covered.*discard/s);
  });

  it("flags a revise verdict so the model can fix the draft", async () => {
    const provider = new FakeProvider([{ text: JSON.stringify({ reusable: 3, specific: 0.2, preconditions: 0.9, redundant: 0.1, verdict: "revise" }) }]);
    const v = await evaluateDraft(goodDraft, freshStore(), config.skills, depsWith(provider));
    expect(v).toMatchObject({ ok: false, revise: true });
  });

  it("never calls the judge when validation already failed", async () => {
    const provider = new FakeProvider([{ text: "{}" }]);
    const v = await evaluateDraft({ ...goodDraft, body: "too short" }, freshStore(), config.skills, depsWith(provider));
    expect(v.ok).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("judge backends", () => {
  const questions = {
    reusable: { type: "score" as const, instructions: "?", criteria: ["no", "meh", "yes", "very"] },
    specific: { type: "boolean" as const, instructions: "?" },
    verdict: { type: "choice" as const, instructions: "?", criteria: { keep: "k", discard: "d" } },
  };

  it("uses the entry backend when the provider implements evaluate()", async () => {
    const provider = Object.assign(new FakeProvider([]), {
      evaluate: async () => ({ answers: PASSING, usage: { inputTokens: 5 } }),
    });
    const r = await judge("state", questions, { cfg: { ...config.skills.eval, provider: "entry" }, entry, entryName: "fake", provider: provider as never });
    expect(r.backend).toBe("entry");
    expect(r.answers.reusable).toEqual({ type: "score", score: 3 });
    expect(r.answers.verdict).toEqual({ type: "choice", choice: "keep" });
  });

  it("falls back to the local judge when the entry cannot evaluate", async () => {
    const provider = new FakeProvider([{ text: 'noise {"reusable": 2, "specific": true, "verdict": "keep"} trailing' }]);
    const r = await judge("state", questions, { cfg: { ...config.skills.eval, provider: "auto" }, entry, entryName: "fake", provider });
    expect(r.backend).toBe("local");
    expect(r.answers).toEqual({ reusable: { type: "score", score: 2 }, specific: { type: "boolean", probability: 1 }, verdict: { type: "choice", choice: "keep" } });
  });

  it("clamps out-of-range local answers and retries an unparseable reply", async () => {
    const provider = new FakeProvider([{ text: "no json here" }, { text: JSON.stringify({ reusable: 99, specific: -3, verdict: "nonsense" }) }]);
    const r = await judge("state", questions, { cfg: { ...config.skills.eval, provider: "local" }, entry, entryName: "fake", provider });
    expect(r.answers.reusable).toEqual({ type: "score", score: 3 });
    expect(r.answers.specific).toEqual({ type: "boolean", probability: 0 });
    expect(r.answers.verdict).toEqual({ type: "choice", choice: "keep" }); // first option, not invented
    expect(provider.requests).toHaveLength(2);
  });

  it("throws when even the local judge cannot produce JSON", async () => {
    const provider = new FakeProvider([{ text: "still no json" }]);
    await expect(judge("state", questions, { cfg: { ...config.skills.eval, provider: "local" }, entry, entryName: "fake", provider })).rejects.toThrow(/no judge backend/);
  });

  it("evaluation mock model is wired through the entry path", async () => {
    const model = mockJudge(PASSING);
    expect(model.supportedQuestionTypes).toContain("score");
    const provider = Object.assign(new FakeProvider([]), {
      evaluate: async () => {
        const r = await model.doEvaluate({ state: "s", questions: {} } as never);
        return { answers: (r as { answers: Record<string, unknown> }).answers };
      },
    });
    const r = await judge("s", questions, { cfg: { ...config.skills.eval, provider: "entry" }, entry, entryName: "fake", provider: provider as never });
    expect(r.answers.specific).toEqual({ type: "boolean", probability: 0.95 });
  });
});
