import { describe, expect, it } from "vitest";
import type { AgentSummary } from "@eigen/engine/schema";
import { byAttention, chatAvailability, headline, splitProblems } from "./summary";
import { keyFor, MODEL_PRESETS, slugify, toCreateRequest, type NewAgentForm } from "./new-agent";

const agent = (patch: Partial<AgentSummary> = {}, runtime: Partial<AgentSummary["runtime"]> = {}): AgentSummary => ({
  id: "helper",
  name: "Helper",
  role: "researcher",
  description: "",
  enabled: true,
  modelKey: "main",
  telegram: { enabled: false, allowedUserIds: [] },
  ...patch,
  runtime: { status: "loaded", problems: [], ...runtime },
});

describe("fleet summary", () => {
  it("pulls missing keys out of the problems as names", () => {
    const r = splitProblems([
      "ANTHROPIC_API_KEY is not set in this agent's keys (models.main)",
      "telegram: add at least one allowed user id; without one the bot would answer anyone",
      "ANTHROPIC_API_KEY is not set in this agent's keys (models.main)",
    ]);
    expect(r).toEqual({ keys: ["ANTHROPIC_API_KEY"], other: ["telegram: add at least one allowed user id; without one the bot would answer anyone"] });
  });

  it("chat needs the engine and a loaded (or stale) agent", () => {
    expect(chatAvailability(agent(), "online")).toEqual({ ok: true });
    expect(chatAvailability(agent({}, { status: "stale" }), "online").ok).toBe(true);
    expect(chatAvailability(agent(), "offline")).toMatchObject({ ok: false, reason: expect.stringMatching(/engine is not running/) });
    expect(chatAvailability(agent({}, { status: "disabled" }), "online").reason).toMatch(/Helper is turned off/);
    expect(chatAvailability(agent({}, { status: "invalid" }), "online").reason).toMatch(/has not loaded/);
  });

  it("the headline says what the agent waits for", () => {
    expect(headline(agent(), "online")).toBe("researcher");
    expect(headline(agent({ enabled: false }), "online")).toBe("researcher, turned off");
    expect(headline(agent(), "offline")).toBe("researcher, engine offline");
    expect(headline(agent({}, { status: "invalid", problems: ["X_KEY is not set in this agent's keys (models.main)"] }), "online")).toBe("researcher, needs a key");
    expect(headline(agent({ role: "" }, { status: "invalid", problems: ["a", "b"] }), "online")).toBe("assistant, 2 problems");
  });

  it("orders agents with problems first, then by name", () => {
    const list = [agent({ name: "B" }), agent({ name: "A" }), agent({ name: "C" }, { problems: ["x"] })];
    expect(byAttention(list).map((a) => a.name)).toEqual(["C", "A", "B"]);
  });
});

describe("new agent form", () => {
  const form = (patch: Partial<NewAgentForm> = {}): NewAgentForm => ({ name: "Researcher", id: "researcher", role: "", description: "", modelId: MODEL_PRESETS[0]!.id, modelUrl: "", instructions: "", ...patch });

  it("suggests an id from the name", () => {
    expect(slugify("Research Bot 2")).toBe("research-bot-2");
    expect(slugify("  Écrivain!  ")).toBe("ecrivain");
    expect(slugify("42 Answers")).toBe("answers");
    expect(slugify("x".repeat(40) + " y")).toHaveLength(32);
    expect(slugify("!!!")).toBe("");
  });

  it("builds a CreateAgentRequest with only what was filled in", () => {
    expect(toCreateRequest(form({ role: " planner ", instructions: "Plan." }))).toEqual({
      req: { id: "researcher", name: "Researcher", role: "planner", model: { id: "anthropic/claude-sonnet-5-5" }, instructionsText: "Plan." },
      errors: {},
    });
    const ollama = MODEL_PRESETS.find((p) => p.key === "ollama")!;
    expect(toCreateRequest(form({ modelId: ollama.id, modelUrl: ollama.url! })).req?.model).toEqual({ id: "ollama/llama3.2", url: "http://localhost:11434/v1" });
  });

  it("reports errors per field, including a taken id", () => {
    const r = toCreateRequest(form({ name: " ", id: "Bad Id", modelId: "no-slash", modelUrl: "not a url" }));
    expect(r.req).toBeUndefined();
    expect(Object.keys(r.errors).sort()).toEqual(["id", "model", "name", "url"]);
    expect(r.errors.name).toBe("give it a name");
    expect(toCreateRequest(form(), ["researcher"]).errors).toEqual({ id: "an agent with this id already exists" });
  });

  it("names the key the model will need, or none for a local server", () => {
    expect(keyFor("anthropic/claude-sonnet-5-5", "")).toBe("ANTHROPIC_API_KEY");
    expect(keyFor("openrouter/x/y", "")).toBe("OPENROUTER_API_KEY");
    expect(keyFor("ollama-cloud/gpt-oss:120b", "")).toBe("OLLAMA_API_KEY");
    expect(keyFor("ollama/llama3.2", "http://localhost:11434/v1")).toBeUndefined();
    expect(keyFor("half", "")).toBeUndefined();
  });
});
