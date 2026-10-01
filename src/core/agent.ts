import { randomBytes } from "node:crypto";
import type { Config, ModelEntry } from "../config/schema.ts";
import { DEFAULTS_DIR } from "../config/home.ts";
import { ModelRegistry } from "../models/registry.ts";
import type { FetchFn } from "../models/provider.ts";
import { UsageTracker } from "../models/usage.ts";
import { loadConfig } from "../config/load.ts";
import { loadPrompts } from "../prompts/loader.ts";
import type { PromptPaths, PromptSet } from "../prompts/loader.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { McpManager } from "../tools/mcp/client.ts";
import { createSkillTools } from "../skills/tools.ts";
import { SkillStore } from "../skills/store.ts";
import type { Skill, SkillDraft } from "../skills/store.ts";
import { SkillCapture, transcriptOf } from "../skills/capture.ts";
import { evaluateDraft, validateDraft } from "../skills/eval.ts";
import { watchSkills } from "../skills/watch.ts";
import type { ServerStatus } from "../tools/mcp/client.ts";
import { currentTime } from "../tools/builtin/current-time.ts";
import { httpFetch } from "../tools/builtin/http-fetch.ts";
import { readFileTool } from "../tools/builtin/read-file.ts";
import { shellExec } from "../tools/builtin/shell.ts";
import { runCode } from "../tools/builtin/run-code.ts";
import { configureShellEnv, killAll, resetSession } from "../tools/builtin/shell-session.ts";
import { EventBus } from "./events.ts";
import type { Message } from "./types.ts";
import type { Listener } from "./events.ts";
import { runLoop } from "./loop.ts";
import { SessionStore } from "./session.ts";
import type { Session } from "./session.ts";
import { logger } from "../util/logger.ts";

function validateOnly(draft: SkillDraft, store: SkillStore): string[] {
  return validateDraft(draft, store);
}

// Capture only needs the conversation, and provider blobs (SDK message objects) are
// not always structured-cloneable, so they are dropped here rather than copied.
function snapshotForCapture(messages: Message[]): Message[] {
  return messages.map((m) => ({ role: m.role, parts: structuredClone(m.parts) }));
}

function transcriptFor(messages: Message[]): string {
  return transcriptOf(messages);
}

export function createBuiltinTools(): ToolRegistry {
  return new ToolRegistry().register(shellExec).register(runCode).register(readFileTool).register(httpFetch).register(currentTime);
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
  tools: number;
  mcpServers: ServerStatus[];
  skills: { total: number; custom: number };
};

export type ModelInfo = { name: string; entry: ModelEntry; isDefault: boolean };

export type Result = { ok: boolean; message: string };

export class Agent {
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly usage = new UsageTracker();
  readonly mcp: McpManager;
  readonly skills: SkillStore;
  #capture: SkillCapture;
  #watcher?: { close(): void };
  // Last completed run per session, for /save-skill.
  #lastRun = new Map<string, Message[]>();
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
    this.mcp = new McpManager(this.tools, deps.config.mcp, deps.config.limits.toolTimeoutMs);
    
    this.skills = new SkillStore(this.#paths.home, deps.config.skills);
    if (deps.config.skills.enabled) {
      this.skills.load();
      for (const t of createSkillTools({ store: this.skills, save: (d) => this.saveSkill(d) })) this.tools.register(t);
      if (deps.config.skills.watch) this.#watcher = watchSkills(this.skills, () => this.#refreshSkillIndex());
    }
    this.#capture = new SkillCapture({
      store: this.skills,
      cfg: deps.config.skills,
      entryFor: (n) => this.models.entry(n),
      providerFor: (n) => this.models.provider(n),
      isBusy: (id) => this.#sessions.get(id)?.runState === "running",
      overCap: (n) => this.usage.overCap(n, this.models.entry(n).dailyTokenCap),
      onUsage: (n, tokens) => this.usage.add(n, tokens),
      onSaved: (sessionId, skill) => {
        this.#refreshSkillIndex();
        this.#bus.emit({ type: "notice", sessionId, text: `📎 learned skill: ${skill.slug} — ${skill.description}` });
      },
    });
    // Capture runs strictly after a run is done and its reply is already outbound.
    this.#bus.on((e) => {
      if (e.type !== "done") return;
      const session = this.#sessions.get(e.sessionId);
      if (!session) return;
      const snapshot = snapshotForCapture(session.messages);
      if (e.reason !== "end") return; // gate 1: only successful runs are captured
      this.#lastRun.set(e.sessionId, snapshot);
      // Enqueued synchronously so a caller awaiting skillsIdle() always sees the job;
      // the pipeline itself yields a tick before checking whether the session is busy.
      this.#capture.schedule({ sessionId: e.sessionId, runId: e.runId, messages: snapshot, entryName: session.model });
    });
    const secretEnv = Object.values(deps.config.models).flatMap((e) => (e.apiKeyEnv ? [e.apiKeyEnv] : []));
    configureShellEnv([...secretEnv, deps.config.telegram.tokenEnv]);
  }

  // Connects the configured MCP servers and registers their tools. Never throws:
  // a server that fails is reported through status().
  async startMcp(): Promise<ServerStatus[]> {
    return this.mcp.connectAll(this.#config.mcpServers);
  }

  // /reload-mcp: re-read config.json, then reconnect every server.
  async reloadMcp(): Promise<Result> {
    let servers = this.#config.mcpServers;
    try {
      const fresh = loadConfig(this.#paths.home);
      this.#config = { ...this.#config, mcpServers: fresh.mcpServers, mcp: fresh.mcp };
      servers = fresh.mcpServers;
    } catch (e) {
      logger.error({ evt: "mcp_reload_config_failed", err: (e as Error).message });
      return { ok: false, message: `config.json is invalid, keeping the current MCP servers:\n${(e as Error).message}` };
    }
    const status = await this.mcp.reload(servers);
    if (!status.length) return { ok: true, message: "MCP reloaded: no servers configured." };
    const lines = status.map((s) => (s.ok ? `▸ ${s.name}: ${s.tools} tools (${s.transport})` : `✗ ${s.name}: ${s.error}`));
    return { ok: status.every((s) => s.ok), message: `MCP reloaded.\n${lines.join("\n")}` };
  }

  #skillIndex(): string {
    return this.#config.skills.enabled ? this.skills.indexText() : "";
  }

  // New sessions get the new index; existing ones keep their frozen prompt (cache stability).
  #refreshSkillIndex(): void {
    this.#prompts = { ...this.#prompts, skills: this.#skillIndex() };
  }

  // The one path that writes a skill: used by skill_save, /save-skill and capture.
  async saveSkill(draft: SkillDraft, opts: { force?: boolean; entryName?: string } = {}): Promise<{ ok: boolean; slug?: string; reasons: string[] }> {
    const entryName = opts.entryName ?? this.models.defaultName;
    const deps = { entry: this.models.entry(entryName), entryName, provider: this.models.provider(entryName) };
    const verdict = opts.force
      ? { ok: !validateOnly(draft, this.skills).length, reasons: validateOnly(draft, this.skills), score: undefined }
      : await evaluateDraft(draft, this.skills, this.#config.skills, deps);
    if (!verdict.ok) return { ok: false, reasons: verdict.reasons };
    const skill = this.skills.write(draft, "agent-created", verdict.score);
    this.#refreshSkillIndex();
    return { ok: true, slug: skill.slug, reasons: [] };
  }

  // /save-skill: draft from the last completed run, then the same gate.
  async saveSkillFromLastRun(sessionId: string, opts: { name?: string; force?: boolean } = {}): Promise<Result> {
    if (!this.#config.skills.enabled) return { ok: false, message: "Skills are disabled in config." };
    const messages = this.#lastRun.get(sessionId);
    if (!messages?.length) return { ok: false, message: "No completed run to save yet. Ask me to do something first." };
    const session = this.#session(sessionId);
    const entryName = this.#config.skills.capture.model ?? session.model;
    const draft = await this.#capture.draft(transcriptFor(messages), {
      entry: this.models.entry(entryName),
      entryName,
      provider: this.models.provider(entryName),
      timeoutMs: this.#config.skills.capture.timeoutMs,
    });
    if (!draft) return { ok: false, message: "Could not turn that run into a skill draft." };
    if (opts.name) draft.name = opts.name;
    const r = await this.saveSkill(draft, { force: opts.force, entryName });
    return r.ok ? { ok: true, message: `Saved skill "${r.slug}".` } : { ok: false, message: `Not saved:\n- ${r.reasons.join("\n- ")}` };
  }

  // Lets a caller (smoke script, tests) wait for post-run skill capture to settle.
  async skillsIdle(): Promise<void> {
    await this.#capture.idle();
  }

  reloadSkills(): Result {
    if (!this.#config.skills.enabled) return { ok: false, message: "Skills are disabled in config." };
    const { loaded, invalid } = this.skills.load();
    this.#refreshSkillIndex();
    const { custom } = this.skills.count();
    const problems = invalid.map((i) => `✗ ${i.path.split("/").slice(-2).join("/")}: ${i.reason}`);
    return { ok: !invalid.length, message: [`Skills reloaded: ${loaded} (${custom} custom).`, ...problems].join("\n") };
  }

  forgetSkill(slug: string): Result {
    try {
      const removed = this.skills.remove(slug);
      this.#refreshSkillIndex();
      return removed ? { ok: true, message: `Deleted skill "${slug}".` } : { ok: false, message: `No skill "${slug}".` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
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
      // Keep the skill index: it is part of the prompt set but has its own lifecycle.
      this.#prompts = { ...loadPrompts(this.#paths), skills: this.#skillIndex() };
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
    resetSession(sessionId); // fresh session, fresh shell
    this.#lastRun.delete(sessionId);
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
      tools: this.tools.names().length,
      mcpServers: this.mcp.status(),
      skills: this.skills.count(),
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

  async shutdown(): Promise<void> {
    for (const s of this.#sessions.all()) this.#sessions.cancel(s);
    killAll();
    this.#capture.stop();
    this.#watcher?.close();
    await this.mcp.close();
  }
}
