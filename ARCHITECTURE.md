# eigen architecture

Reference for how the pieces fit together, with the code that enforces each rule.
File sizes are lines of source (2,286 in `src/`, 1,300 in `test/`).

---

## 1. Layers

```
┌───────────────────────────────────────────────────────────────┐
│ gateway/telegram   458 lines                                  │
│ receiver → fastpath → {commands, dispatcher} → outbox         │
└───────────────────────────┬───────────────────────────────────┘
                            │  agent.submit / cancel / status  +  events
┌───────────────────────────▼───────────────────────────────────┐
│ core   654 lines                                              │
│ agent · session(queue) · loop · context · trim · events       │
└──────┬──────────────┬──────────────┬──────────────┬───────────┘
       │              │              │              │
┌──────▼─────┐ ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼─────┐
│ models 410 │ │ tools   590 │ │ prompts 54 │ │ config 141│
│ AI SDK     │ │ gateway +   │ │ SOUL.md /  │ │ zod       │
│ adapter    │ │ builtins +  │ │ system.md  │ │ schema    │
│ errors     │ │ mcp client  │ │            │ │ ~/.eigen  │
└────────────┘ └─────────────┘ └────────────┘ └───────────┘
                    util 97   logger · tokens · backoff · abort
```

**Direction:** `gateway → core → {models, tools, prompts, config, util}`.
`core` never imports `gateway`. `models` and `tools` may import **only types** from
`core/types.ts` (erased at runtime, so no real cycle). Provider wire formats appear
only under `src/models/adapters/`.

Enforced by `test/architecture.test.ts`, which parses every import in `src/`:

```ts
const ALLOWED: Record<string, string[]> = {
  gateway: ["gateway", "core", "config", "util"],
  core:    ["core", "models", "tools", "prompts", "config", "util"],
  models:  ["models", "config", "util"],
  tools:   ["tools", "config", "util"],
  prompts: ["prompts", "util"],
  config:  ["config", "util"],
  util:    ["util"],
};
// plus: any layer may `import type` from core/types.ts, and markers like
// "tool_calls" / "cache_control" / "x-api-key" may appear only under models/adapters/.
```

---

## 2. The data model — `src/core/types.ts`

Everything the system passes around is one of these. History is stored in this form,
never in a provider's format.

```ts
export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; callId: string; content: Part[]; isError?: boolean }
  | { type: "image"; mediaType: string; data: string };          // base64

export type Message = {
  role: "user" | "assistant" | "tool";
  parts: Part[];
  // Opaque blob an adapter needs echoed back unchanged (e.g. Anthropic thinking
  // blocks). Core stores it, never reads it, drops it when the provider changes.
  providerData?: unknown;
};

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";
export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
```

Why it matters: `/model cloud` mid-conversation works because nothing in history is
provider-shaped. The adapter translates at send time, both ways.

---

## 3. Startup

```
node main.ts
 │
 ├─ Node ≥ 22.18 check                                   main.ts
 ├─ eigenHome()                    ~/.eigen or $EIGEN_HOME        config/home.ts
 ├─ ensureHome()                   copy packaged defaults for any missing file
 │     └─ if config.json was just created → print instructions, exit 0
 ├─ initLogger(~/.eigen/logs/eigen.log)                   util/logger.ts
 ├─ loadConfig(home)                                      config/load.ts
 │     ├─ process.loadEnvFile(~/.eigen/.env)              (secrets never in config.json)
 │     ├─ JSON.parse
 │     └─ ConfigSchema.safeParse   ← defaults applied; invalid → print + exit 1
 ├─ new Agent({ config, home })                           core/agent.ts
 │     ├─ ModelRegistry(config)               named entries → providers (lazy)
 │     ├─ createBuiltinTools()                shell_exec, run_code, read_file,
 │     │                                      http_fetch, current_time
 │     ├─ McpManager(tools, config.mcp)
 │     ├─ loadPrompts({home, defaultsDir})    SOUL.md + prompts/system.md (+fallback)
 │     └─ configureShellEnv([...apiKeyEnv, telegram.tokenEnv])   secret scrubbing
 ├─ await agent.startMcp()          connect servers, register mcp__server__tool
 ├─ await telegram.start()          getMe → deleteWebhook → receiver.run()
 └─ SIGINT/SIGTERM → shutdown()
```

---

## 4. A message, end to end

```
Telegram
   │ getUpdates (long poll, 30s)
   ▼
receiver.ts ── Receiver.run()
   │   409 Conflict → fatal (another poller)   401 → fatal
   │   other errors → log + backoff, continue
   │   offset = update_id + 1 per update
   ▼ (synchronous — never awaits a run)
fastpath.ts ── createFastPath()
   │   duplicate update id?        → "duplicate"
   │   no message / edited?        → "ignored"
   │   chat.type !== "private"?    → "ignored"
   │   from.id not allowlisted?    → "rejected"   (silent)
   │   no text?                    → onUnsupported (≤1 notice/min)
   │   text starts with "/"        → commands(chatId, text)
   └── else                        → dispatcher.onText(chatId, text)
                                          │
                                          ▼
                              agent.submit({ sessionId: "tg:<chat>", text, channel })
                                          │
                              SessionStore.enqueue  ── FIFO, one active run
                                          │
                                          ▼
                                    runLoop(...)   ← section 5
                                          │ events
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
            dispatcher.ts                                  logger (JSON)
   run_start        → outbox.startTyping
   assistant_message→ outbox.send            (interim only when verbose)
   tool_start/end   → outbox.send            (verbose only)
   error            → outbox.send "⚠ …"
   done             → outbox.stopTyping ( + "Stopped." when cancelled)
                    │
                    ▼
              outbox.ts ── the ONLY code that sends to Telegram
   splitMessage(text, chunkSize)        paragraph → line → word → hard cut
   queue + rate limit (sendRatePerSec)
   sendMessage(HTML)  → 400 "can't parse entities" → resend as plain text
                      → 429 → wait retry_after     → 5xx/network → backoff
```

The fast path stays synchronous on purpose — polling must never wait on a run:

```ts
// fastpath.ts
return (u) => {
  const started = performance.now();
  const action = route(u);                       // routes, never awaits
  logger.info({ evt: "update", id: u.update_id, action, latencyMs: … });
  return action;
};
```

Queueing lives in one place:

```ts
// session.ts
async #pump(s: Session): Promise<void> {
  if (s.runState === "running") return;          // one active run per session
  const job = s.queue.shift();
  if (!job) return;
  s.runState = "running";
  const controller = new AbortController();      // what /stop aborts
  s.controller = controller;
  try { await job.run(controller.signal); }
  finally { s.runState = "idle"; s.controller = undefined; void this.#pump(s); }
}
```

---

## 5. The agent loop — `src/core/loop.ts`

```
runLoop(session, {text, runId, channel}, signal, deps)
  runSignal = AbortSignal.any([ /stop signal , timeout(runTimeoutMs) ])
  daily cap check → push user message → emit run_start
  │
  ├─ while (step < maxSteps) ──────────────────────────────────────────────┐
  │   buildContext()                                        context.ts     │
  │     system  = <operating_instructions> + <soul> (+memory/skills slots)  │
  │     tools   = toolCalling ? registry.defs() : []                        │
  │     history = trimHistory(copy, budget − fixed)          trim.ts        │
  │        1. blank oldest tool-result bodies                               │
  │        2. drop oldest whole turns                                       │
  │        3. latest turn alone too big → ContextTooLargeError              │
  │     log { evt: "prompt_size", estTokens, budget, contextWindow }        │
  │                                                                         │
  │   withRetry(provider.chat(...))         errors.ts (single retry place)  │
  │     └─ adapters/ai-sdk.ts → generateText → provider HTTP                │
  │     transient | rate_limited → backoff / Retry-After                    │
  │     auth | bad_request | context_overflow → fail fast                   │
  │     log { evt: "model_call", provider, model, step, est vs real tokens, │
  │           cachedTokens, latencyMs, stopReason }                         │
  │                                                                         │
  │   stopReason === "max_tokens" → keep text, DROP the truncated tool call │
  │                                  → error + done(limit)                  │
  │   no tool calls → empty? retry once : append + assistant_message        │
  │                                  → done(end)                            │
  │   tool calls → append assistant msg (with providerData)                 │
  │                runTools() sequentially                                  │
  │                append {role:"tool", parts:[tool_result…]}               │
  │                aborted? → done(cancelled|limit)                         │
  │                badStreak > toolArgRetryMax → error                      │
  │                tokens ≥ runTokenBudget → done(limit)                    │
  └─ loop exhausted → "Run stopped after N steps (maxSteps)" → done(limit) ─┘
```

The two rules most worth knowing, verbatim:

```ts
// never execute a tool call the model didn't finish writing
if (res.stopReason === "max_tokens") {
  if (text) { session.messages.push({ role: "assistant", parts: [{ type: "text", text }] });
              emit({ type: "assistant_message", …, interim: false }); }
  const dropped = res.toolCalls.length ? " A tool call in it was cut off and was not executed." : "";
  return fail(`The reply hit the output token limit (maxOutputTokens=${e.maxOutputTokens}).${dropped}`, "limit");
}

// every call gets a result, even when cancelled, so history never holds an orphan call
const results = await runTools(res.toolCalls, runSignal, ctx);
session.messages.push({ role: "tool", parts: results.parts });
```

Limits, and which config key controls each:

| Stop | Key | Default | Message |
|---|---|---|---|
| steps | `limits.maxSteps` | 25 | "Run stopped after 25 steps (maxSteps)." |
| wall clock | `limits.runTimeoutMs` | 30 min | "exceeded the 1800s time limit" |
| tokens/run | `limits.runTokenBudget` | 400k | "over the per-run budget" |
| tokens/day | `models.<name>.dailyTokenCap` | unset | refuses new runs |
| bad tool calls | `limits.toolArgRetryMax` | 2 | "3 invalid tool calls in a row" |
| user | `/stop` | — | "Stopped." |

---

## 6. Context assembly and trimming

```
buildContext(input)                                      core/context.ts
  renderSystem(prompts)      fixed order, nothing volatile (no dates, no counters)
      <operating_instructions>…</operating_instructions>
      <soul>…</soul>
      [memory]   reserved, renders nothing
      [skills]   reserved, renders nothing
  fixed  = estimate(system) + estimate(tools)
  budget = entry.contextWindow − entry.replyReserve
  trimHistory(messages, budget − fixed, imageTokenEstimate)
```

```ts
// trim.ts — a turn is a user message plus everything up to the next user message,
// so a tool call and its results can never be separated.
export function splitTurns(messages: Message[]): Message[][] { … }

// 1) blank oldest tool-result bodies (never the latest turn)
parts = m.parts.map(p => p.type === "tool_result"
  ? { ...p, content: [{ type: "text", text: TRIMMED_NOTE }] } : p);

// 2) drop whole oldest turns
while (total > budget && start < latest) { … start++; droppedTurns++; }

// after any edit, drop provider blobs from completed turns: signed thinking
// blocks are bound to the exact earlier transcript
for (let t = 0; t < kept.length - 1; t++)
  kept[t] = kept[t]!.map(({ providerData: _, ...m }) => m);
```

Token estimate is deliberately swappable (`util/tokens.ts`): `chars / 4`, plus a fixed
`imageTokenEstimate` per image and 4 tokens of per-message overhead. Measured drift on
a real run: 3,156 estimated vs 3,131 reported.

---

## 7. Model layer

```
loop ──▶ withRetry ──▶ ModelProvider.chat(ChatRequest) ──▶ ChatResult
                            │
                   adapters/ai-sdk.ts
                            ├─ modelFor(entry)   anthropic | openai-compatible
                            ├─ toModelMessages() eigen Message[] → SDK ModelMessage[]
                            ├─ toToolSet()       ToolDef[] → SDK tool() WITHOUT execute
                            └─ generateText()    maxRetries: 0, abortSignal
```

The single most important line in the migration — tools have **no `execute`**, so the
SDK returns the calls instead of running them (its documented "manual agent loop"):

```ts
// adapters/ai-sdk.ts
function toToolSet(req: ChatRequest): ToolSet {
  return Object.fromEntries(req.tools.map((t, i) => [
    t.name,
    tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      ...(req.entry.promptCaching && i === req.tools.length - 1
        ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
    }),
  ]));
}

r = await generateText({
  model: modelFor(entry, wrapped), system: req.system, messages, tools,
  maxOutputTokens: entry.maxOutputTokens,
  abortSignal: req.signal,
  maxRetries: 0,                    // eigen's withRetry is the single retry place
});
```

Provider blobs round-trip through `providerData`, which is how Anthropic thinking
blocks keep their signatures inside a tool loop:

```ts
const assistants = r.responseMessages.filter(m => m.role === "assistant");
return { message: { role: "assistant", parts, providerData: { aiSdk: assistants } }, … };

// …and on the way back in:
const stash = readStash(m.providerData);
if (stash) { out.push(...stash); return; }        // byte-identical replay
```

Errors normalize to five kinds, and only two of them retry:

```ts
export type ErrorKind = "transient" | "rate_limited" | "auth" | "bad_request" | "context_overflow";

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (isAbortError(e) || !isRetryable(e) || attempt >= opts.maxRetries) throw e;
      const delay = Math.min(e.retryAfterMs ?? backoffDelay(attempt, 1000), 60_000);
      opts.onRetry?.(e, attempt + 1, delay);
      await sleep(delay, opts.signal);
    }
  }
}
```

Vision degrading happens at send time only, so history keeps the image:

```ts
export function degradeImages(messages: Message[], vision: boolean): Message[] {
  if (vision) return messages;
  return messages.map(m => … { type: "text", text: IMAGE_PLACEHOLDER } …);
}
```

---

## 8. Tools

```
Tool authoring                     Execution                          Wire
─────────────                      ─────────                          ────
defineTool({ name, description,    executeTool(call, ctx)             ToolDef
  inputSchema: zod, execute })       ├─ validate                      { name,
        │                            │    unknown → closest names       description,
        │                            │    zod error → prettifyError      inputSchema }
defineRawTool({ …, inputSchema:      ├─ hooks[]   ← approval seam            │
  { jsonSchema } })   ← MCP          ├─ run  race(execute, abort|timeout)    ▼
        │                            └─ post-process truncate          adapter → SDK
        ▼
   ToolRegistry  (register / unregisterPrefix / defs / closest)
```

```ts
// gateway.ts — the one entry point for running any tool
export async function executeTool(call: ToolCall, ctx: ExecContext): Promise<ToolExecResult> {
  const v = validate(call, ctx);
  if (!v.ok) return done(v.kind, text(v.message), true);      // fed back to the model

  for (const hook of hooks) await hook(call, v.input, ctx);   // empty in v0

  const timeoutMs = effectiveTimeout(tool.timeoutMs?.(v.input), ctx);   // clamp [1s, toolMaxTimeoutMs]
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  try {
    // race so a tool that ignores its signal still can't hold the run hostage
    const out = await Promise.race([tool.execute(v.input, { signal, sessionId: ctx.sessionId }),
                                    whenAborted(signal)]);
    …
  } catch (e) {
    if (ctx.signal.aborted) return done("aborted", text("Cancelled by user."), true);
    if (timeout.aborted)    return done("timeout", text(`Tool timed out after ${timeoutMs} ms.`), true);
    …
  }
}
```

Built-ins:

| Tool | Notes |
|---|---|
| `shell_exec` | one persistent bash **per session**; `cd`/exports persist |
| `run_code` | python / js / ts / bash, `code` or `path`, runs in that same shell |
| `read_file` | file or directory listing |
| `http_fetch` | GET/POST, 512 KB cap |
| `current_time` | keeps dates out of the system prompt |

The persistent shell, with the three tricks that keep it from hanging:

```ts
// shell-session.ts
proc.stdin.write("exec 2>&1\n");                  // stdout/stderr in real order
// base64+eval: a syntax error stays an ordinary bash error and the marker still prints
// </dev/null: prompts (sudo, [y/N]) fail fast and nothing can eat the marker line
sh.proc.stdin.write(`eval "$(printf %s '${b64}' | base64 -d)" </dev/null; printf '\\n${marker}%s\\n' "$?"\n`);

const onAbort = () => { process.kill(-sh.proc.pid!, "SIGKILL");   // whole process group
                        finish({ exitCode: null, output: output(buf), reset: true }); };
```

Secrets are removed from the child environment (though **not** from the filesystem —
`~/.eigen/.env` is still readable, which is the open gap):

```ts
const SECRET_RE = /(TOKEN|SECRET|API_?KEY|PASSWORD)/i;
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!secretNames.has(k) && !SECRET_RE.test(k)) env[k] = v;
  return env;
}
```

---

## 9. MCP

```
startup / reload
   McpManager.connectAll(config.mcpServers)              tools/mcp/client.ts
      per server, in parallel, with startupTimeoutMs:
        stdio  → createMCPClient({ transport: Experimental_StdioMCPTransport({…}) })
        remote → createMCPClient({ transport: { type: "http"|"sse", url, headers } })
        client.listTools()
        → registry.register(defineRawTool({ name: "mcp__<server>__<tool>", … }))
      failures → ServerStatus{ ok:false, error }, never fatal

call
   executeTool → runMcpTool → client.callTool({ name, arguments, options:{ signal } })
      result.content → eigen Part[]   (text | image | resource | JSON)
      result.isError → isError
```

```ts
// the wrapper is what keeps MCP inside eigen's guarantees
defineRawTool({
  name: local,
  description: t.description ?? `${t.name} (MCP server ${name})`,
  inputSchema: { jsonSchema: t.inputSchema ?? { type: "object" } },   // server validates
  timeoutMs: () => this.#toolTimeoutMs,
  execute: (input, ctx) => this.#call(name, t.name, input, ctx),
});
```

Never `generateText({ tools: mcpTools })`: a tool the SDK executes skips the gateway
(timeout, `/stop`, truncation, events, hooks) and is recorded outside eigen's history,
which trimming and `/model` switching read.

`/reload_mcp` → `loadConfig` → `manager.close()` → `registry.unregisterPrefix("mcp__")`
→ `connectAll()`. `loop.ts` reads `registry.defs()` per step, so a reload affects the
next step; in-flight calls finish.

---

## 9b. Skills (self-improving procedures)

```
src/skills/
├── store.ts     load / validate / write / version SKILL.md       (no model calls)
├── capture.ts   post-run pipeline: gates 1-5                     (own queue + signal)
├── eval.ts      deterministic validation + judged critique       (gatekeeper)
├── tools.ts     skill_read · skill_update · skill_save
└── watch.ts     fs.watch → reload                                (hot pickup)
src/models/judge.ts   Jev → provider evaluationModel → local JSON judge
```

Capture is a **subscriber, not a loop stage** — `loop.ts` knows nothing about skills:
```ts
// core/agent.ts
this.#bus.on((e) => {
  if (e.type !== "done") return;
  const snapshot = snapshotForCapture(session.messages);   // providerData dropped: not always cloneable
  if (e.reason !== "end") return;                          // gate 1: only successful runs
  this.#lastRun.set(e.sessionId, snapshot);                // powers /save_skill
  this.#capture.schedule({ sessionId, runId, messages: snapshot, entryName: session.model });
});
```
```
done(end) ─▶ queue ─▶ setImmediate (let the session flip to idle)
   gate 2 triage   judge: worthCapturing / taskSucceeded / alreadyCovered
   gate 3 draft    one chat call → SKILL.md
   gate 4 eval     validateDraft (secrets, size, duplicate, script paths) → judged critique
   gate 5 save     store.write → refresh index → "notice" event → Telegram
```
The index fills the `skills` block reserved in `context.ts`; bodies stay out of the prompt and arrive through `skill_read`. Judge calls are time-boxed and output-capped (`skills.eval.timeoutMs`, `maxOutputTokens`), because a local thinking model will otherwise spend its whole budget reasoning and return nothing — the retry escalates to the entry's full budget.

## 10. Invariants

1. History is provider-neutral; only `models/adapters/` knows wire formats.
2. The polling handler is synchronous and never awaits a run.
3. Exactly one place does each of these:
   - `outbox.ts` sends to Telegram
   - `executeTool` runs a tool
   - `buildContext` assembles a prompt
   - `withRetry` retries a model call
4. Nothing volatile enters the system prompt, so the cache prefix stays byte-stable.
5. A tool call and its result are never separated — in history or in trimming.
6. Every tool call gets a result, even on cancel, so history never holds an orphan.

---

## 11. Seams

| To add | Where |
|---|---|
| a tool | `defineTool` + `createBuiltinTools()` in `core/agent.ts` |
| a provider | one SDK package + one line in `models/registry.ts` + a config entry |
| a channel | implement `gateway/channel.ts`, subscribe to events, map chat → session |
| approval / policy / audit | the empty `hooks[]` in `tools/gateway.ts` |
| memory | the empty block already ordered in `context.ts` |
| summarizing instead of dropping turns | `defaults/prompts/compact.md` + a step in `trim.ts` |
| sending files | `ToolOutput.attachments` → new `attachment` event → `outbox.sendDocument` |

## 12. Not built

Persistence (sessions are memory-only), streaming, memory/skills layers, inbound
Telegram files, parallel tool execution, sandboxing, an approval gate.
