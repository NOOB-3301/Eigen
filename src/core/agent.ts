import { randomBytes } from "node:crypto";
import type { Config, ModelEntry } from "../config/schema.ts";
import { DEFAULTS_DIR } from "../config/home.ts";
import { ModelRegistry } from "../models/registry.ts";
import type { FetchFn } from "../models/provider.ts";
import { UsageTracker } from "../models/usage.ts";
import { loadPrompts } from "../prompts/loader.ts";
import type { PromptPaths, PromptSet } from "../prompts/loader.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { currentTime } from "../tools/builtin/current-time.ts";
import { httpFetch } from "../tools/builtin/http-fetch.ts";
import { readFileTool } from "../tools/builtin/read-file.ts";
import { shellExec } from "../tools/builtin/shell.ts";
import { EventBus } from "./events.ts";
import type { Listener } from "./events.ts";
import { runLoop } from "./loop.ts";
import { SessionStore } from "./session.ts";
import type { Session } from "./session.ts";
import { logger } from "../util/logger.ts";

export function createBuiltinTools(): ToolRegistry {
  return new ToolRegistry().register(shellExec).register(readFileTool).register(httpFetch).register(currentTime);
}

export type AgentDeps = {
  config: Config;
  home: string;
  defaultsDir?: string;
  tools?: ToolRegistry;
  models?: ModelRegistry;
  fetch?: FetchFn;
};

export type SubmitInput = { sessionId: string; text: string; channel: string };

export type Status = {
  model: string;
  provider: ModelEntry["provider"];
  providerModel: string;
  running: boolean;
  queueLength: number;
  tokensToday: number;
  dailyTokenCap?: number;
  toolCalling: boolean;
  verbose: boolean;
  messages: number;
};

export type ModelInfo = { name: string; entry: ModelEntry; isDefault: boolean };

export type Result = { ok: boolean; message: string };

export class Agent {
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly usage = new UsageTracker();
  #config: Config;
  #paths: PromptPaths;
  #prompts: PromptSet; // what the next new session gets
  #sessions = new SessionStore();
  #bus = new EventBus();

  constructor(deps: AgentDeps) {
    this.#config = deps.config;
    this.#paths = { home: deps.home, defaultsDir: deps.defaultsDir ?? DEFAULTS_DIR };
    this.models = deps.models ?? new ModelRegistry(deps.config, deps.fetch);
    this.tools = deps.tools ?? createBuiltinTools();
    this.#prompts = loadPrompts(this.#paths);
  }

  on(fn: Listener): () => void {
    return this.#bus.on(fn);
  }

  #session(id: string): Session {
    return this.#sessions.get(id) ?? this.#sessions.create({ id, model: this.models.defaultName, prompts: this.#prompts });
  }

  // Never blocks on the run: returns immediately with the number of runs ahead of it.
  submit({ sessionId, text, channel }: SubmitInput): { runId: string; ahead: number } {
    const s = this.#session(sessionId);
    const runId = randomBytes(4).toString("hex");
    const deps = { models: this.models, tools: this.tools, limits: this.#config.limits, usage: this.usage, emit: (e: Parameters<Listener>[0]) => this.#bus.emit(e) };
    const ahead = this.#sessions.enqueue(s, { runId, run: (signal) => runLoop(s, { text, runId, channel }, signal, deps).then(() => {}) });
    logger.info({ evt: "submit", session: sessionId, runId, ahead, chars: text.length });
    return { runId, ahead };
  }

  cancel(sessionId: string): { cancelled: boolean; dropped: number } {
    const s = this.#sessions.get(sessionId);
    return s ? this.#sessions.cancel(s) : { cancelled: false, dropped: 0 };
  }

  // Re-reads prompts for future sessions. On failure the previous prompts stay in force.
  reload(): Result {
    try {
      this.#prompts = loadPrompts(this.#paths);
    } catch (e) {
      logger.error({ evt: "reload_failed", err: (e as Error).message });
      return { ok: false, message: `Reload failed, keeping the previous prompts: ${(e as Error).message}` };
    }
    const notes = this.#prompts.notes.length ? `\n${this.#prompts.notes.join("\n")}` : "";
    return { ok: true, message: `Prompts reloaded; they apply from the next /new.${notes}` };
  }

  newSession(sessionId: string): Result {
    const old = this.#sessions.get(sessionId);
    if (old) this.#sessions.cancel(old);
    const r = this.reload();
    this.#sessions.create({ id: sessionId, model: old?.model ?? this.models.defaultName, verbose: old?.verbose, prompts: this.#prompts });
    return { ok: r.ok, message: r.ok ? `New session started.${this.#prompts.notes.length ? `\n${this.#prompts.notes.join("\n")}` : ""}` : `New session started. ${r.message}` };
  }

  status(sessionId: string): Status {
    const s = this.#session(sessionId);
    const e = this.models.entry(s.model);
    return {
      model: s.model,
      provider: e.provider,
      providerModel: e.model,
      running: s.runState === "running",
      queueLength: s.queue.length,
      tokensToday: this.usage.today(s.model),
      dailyTokenCap: e.dailyTokenCap,
      toolCalling: e.toolCalling,
      verbose: s.verbose,
      messages: s.messages.length,
    };
  }

  listModels(): ModelInfo[] {
    return this.models.names().map((name) => ({ name, entry: this.models.entry(name), isDefault: name === this.models.defaultName }));
  }

  getModel(sessionId: string): string {
    return this.#session(sessionId).model;
  }

  setModel(sessionId: string, name: string): Result {
    if (!this.models.has(name)) return { ok: false, message: `Unknown model "${name}". Available: ${this.models.names().join(", ")}` };
    const s = this.#session(sessionId);
    const from = this.models.entry(s.model).provider;
    const to = this.models.entry(name).provider;
    if (from !== to) {
      // Provider blobs only mean something to the adapter that produced them.
      s.messages = s.messages.map(({ providerData: _, ...m }) => m);
    }
    s.model = name;
    logger.info({ evt: "model_switch", session: sessionId, model: name, provider: to });
    return { ok: true, message: `Switched to ${name} (${to}, ${this.models.entry(name).model}).` };
  }

  getVerbose(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.verbose ?? false;
  }

  toggleVerbose(sessionId: string): boolean {
    const s = this.#session(sessionId);
    s.verbose = !s.verbose;
    return s.verbose;
  }

  shutdown(): void {
    for (const s of this.#sessions.all()) this.#sessions.cancel(s);
  }
}
