import { ModelRouterEmbeddingModel, ModelRouterLanguageModel } from "@mastra/core/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_PROVIDER_URL, MissingKeyError, toMastraModel } from "../src/mastra/lib/models.ts";
import { fakeLlm } from "./helpers/fake-llm.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe("toMastraModel: every model handed to Mastra has a url or a key", () => {
  it("gives a keyless local provider its usual url, so Mastra's router never looks for a key in process.env", () => {
    expect(toMastraModel({ id: "ollama/llama3.2" }, new Map())).toEqual({ id: "ollama/llama3.2", url: LOCAL_PROVIDER_URL.ollama });
    expect(toMastraModel({ id: "lmstudio/qwen" }, new Map())).toEqual({ id: "lmstudio/qwen", url: LOCAL_PROVIDER_URL.lmstudio });
  });

  it("keeps an explicit url, and an explicit key for a local provider", () => {
    expect(toMastraModel({ id: "ollama/x", url: "http://gpu.lan:11434/v1" }, new Map())).toEqual({ id: "ollama/x", url: "http://gpu.lan:11434/v1" });
    expect(toMastraModel({ id: "lmstudio/x", apiKeyEnv: "LM_KEY" }, new Map([["LM_KEY", "k"]]))).toEqual({ id: "lmstudio/x", apiKey: "k" });
  });

  it("refuses a cloud model without the key, whatever the shell has", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-shell");
    expect(() => toMastraModel({ id: "openrouter/x" }, new Map())).toThrow(MissingKeyError);
  });
});

describe("what Mastra's router does with it (checked against @mastra/core)", () => {
  it("a url model with no key sends no Authorization, even with the provider's key in process.env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shell-openai");
    const llm = await fakeLlm([{ text: "hi" }]);
    closers.push(llm.close);
    const model = new ModelRouterLanguageModel(toMastraModel({ id: "openai/gpt-x", url: llm.url }, new Map()));
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never);
    expect(llm.authorizations.at(-1)).not.toContain("sk-shell-openai");
  });

  it("an embedder with a url and the agent's key sends that key, not the shell's", async () => {
    vi.stubEnv("EMBED_KEY", "from-the-shell");
    const llm = await fakeLlm([]);
    closers.push(llm.close);
    const model = new ModelRouterEmbeddingModel(toMastraModel({ id: "fake/embed", url: llm.url, apiKeyEnv: "EMBED_KEY" }, new Map([["EMBED_KEY", "from-the-agent"]])));
    await model.doEmbed({ values: ["hello"] } as never);
    expect(llm.authorizations.at(-1)).toBe("Bearer from-the-agent");
  });
});
