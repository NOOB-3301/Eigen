# eigen

A personal, always-on agent that runs in the foreground on your Mac and talks to you only through Telegram. Models are provider-agnostic (local Ollama, any OpenAI-compatible API, Anthropic's native API) and switchable per session at runtime.

v0 is the skeleton: config, in-memory sessions, prompt assembly from `SOUL.md` + prompt files, the agent loop, a tool gateway with four built-in tools, two model adapters, and the Telegram gateway. No database: history lives in memory and is gone on restart.

## Requirements

- Node **22.18+** (or 24). eigen runs TypeScript directly via Node's type stripping, so there is no build step.
- A Telegram account.
- Ollama for local models, and/or an Anthropic API key.

Dependencies: `grammy`, `zod`, `pino`, and the Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`). Adding another provider is one SDK package plus one config entry.

```sh
npm install
node main.ts        # first run creates ~/.eigen and tells you what to fill in
```

## Setup

### 1. Create the bot (BotFather)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a display name and a username ending in `bot`.
3. BotFather replies with a token like `123456789:AA...`. Keep it secret.

### 2. Find your Telegram user ID

Message **@userinfobot** (or **@RawDataBot**). It replies with your numeric `Id`. This is the only account eigen will answer. Messages from any other account, and from groups, are ignored silently.

### 3. Configure Ollama

1. Pick a model that **supports tool calling**. Check with `ollama show <model>`: the Capabilities list must include `tools`. For example:
   ```sh
   ollama pull gemma4:e4b        # tools + vision + thinking
   ```
   Models without `tools` (many community GGUFs) can chat but can't use eigen's tools. If you use one anyway, set `"toolCalling": false` on its entry.
2. **Set the context length on the Ollama side.** Ollama's OpenAI-compatible endpoint can't set `num_ctx` per request. When a prompt is longer than Ollama's context, Ollama **silently drops the start of the prompt** and returns no error. Pick one:
   ```sh
   OLLAMA_CONTEXT_LENGTH=32768 ollama serve          # global
   ```
   or bake it into a model with a Modelfile:
   ```
   FROM gemma4:e4b
   PARAMETER num_ctx 32768
   ```
   ```sh
   ollama create gemma4-32k -f Modelfile
   ```
3. In eigen's config, keep the entry's `contextWindow` **safely below** that number (e.g. 28000 for 32768). eigen's trimming is the only thing that stops a prompt from being silently truncated.

### 4. Anthropic API key (optional, for the `cloud` entry)

Create a key at console.anthropic.com and put it in `~/.eigen/.env`.

### 5. Fill in `~/.eigen`

The first `node main.ts` creates:

```
~/.eigen/
├── config.json        # models, telegram, limits
├── .env               # secrets only
├── SOUL.md            # voice / working style
├── prompts/system.md  # operating instructions
└── logs/eigen.log
```

Set `EIGEN_HOME` to use a different directory.

`.env`:
```sh
TELEGRAM_BOT_TOKEN=123456789:AA...
ANTHROPIC_API_KEY=sk-ant-...
```

`config.json` (see `defaults/config.example.json` for the full file):
```jsonc
{
  "defaultModel": "local",
  "models": {
    "local": {
      "provider": "openai-compat",
      "baseUrl": "http://localhost:11434/v1",
      "model": "gemma4:e4b",
      "contextWindow": 28000,      // below Ollama's num_ctx
      "replyReserve": 4096,        // kept free for the reply
      "maxOutputTokens": 4096,
      "toolCalling": true, "vision": false, "promptCaching": false
    },
    "cloud": {
      "provider": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "model": "claude-sonnet-5",
      "contextWindow": 200000, "replyReserve": 16000, "maxOutputTokens": 16000,
      "dailyTokenCap": 2000000,
      "toolCalling": true, "vision": true, "promptCaching": true
    }
  },
  "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN", "allowedUserIds": [123456789] }
}
```

- `openai-compat` works with anything that speaks chat completions: Ollama, OpenAI, OpenRouter, LM Studio, and so on. For hosted APIs, set `apiKeyEnv`.
- `baseUrl` is the API root; the SDK appends the endpoint (`/chat/completions`, `/messages`).
- Model IDs are config only. Nothing in the code hard-codes one.
- `mcpServers` / `mcp` are validated but not used yet.

### 6. Run

```sh
npm start           # node main.ts
npm run dev         # restart on file changes
```

Only one poller may run per bot token. If another instance is polling, eigen logs the 409 conflict and exits.

## Telegram commands

| Command | Effect |
|---|---|
| `/new` | Fresh session. Re-reads `SOUL.md` and `prompts/system.md`. |
| `/stop` | Cancels the current run (model request and running tool) and clears the queue. |
| `/status` | Model, provider, running/idle, queue length, tokens used today. |
| `/model [name]` | No argument: list entries with capability flags. With a name: switch this session. History carries over. |
| `/reload` | Re-read prompts for the **next** session (use `/new` to apply). A failed reload keeps the old prompts. |
| `/reload_mcp` | Reconnect the MCP servers from config.json (alias `/reload-mcp`). |
| `/verbose` | Toggle short progress notes per tool call. |

Commands run immediately and never wait behind a run. If you send text while a run is busy, it queues FIFO.

## Execution tools

| Tool | What it does |
|---|---|
| `shell_exec` | Persistent bash per chat session: `cd`, `export`, activated venvs carry over between calls. Starts in `~`. Non-interactive (stdin closed), so `sudo` password prompts and `[y/N]` questions fail fast instead of hanging. Optional `timeoutSec` for slow commands (capped by `limits.toolMaxTimeoutMs`, default 15 min). A timeout or `/stop` kills the shell and its children; the next call gets a fresh shell and is told so. `/new` also resets it. |
| `run_code` | Runs `python` / `javascript` / `typescript` / `bash`, either a `code` snippet (saved to `~/.eigen/workspace/snippets/` so you can inspect or re-run it) or an existing `path`, with `args`. Runs inside the session shell, so it uses that shell's cwd and virtualenv. |
| `read_file`, `http_fetch`, `current_time` | As before. |

Commands run **as you, with full access to your files**. Secrets are removed from the shell's environment: the env vars named in config (API keys, bot token) and any variable whose name contains `TOKEN`, `SECRET`, `API_KEY`/`APIKEY` or `PASSWORD`. Beyond that there is no sandbox or approval step yet, so a prompt-injected model could run anything you can. The `executeTool` hooks stage is where an approval gate goes.

## MCP servers

Declare servers under `mcpServers` in `~/.eigen/config.json`. Their tools are registered as `mcp__<server>__<tool>` and run through the same gateway as the built-ins (timeout, `/stop`, truncation, verbose notes).

```jsonc
"mcpServers": {
  "filesystem": {                                  // stdio
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Projects"]
  },
  "github": {                                      // stdio with a secret
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "env:GITHUB_TOKEN" }
  },
  "remote": {                                      // HTTP or SSE
    "url": "https://example.com/mcp",
    "transport": "http",
    "headers": { "Authorization": "env:MY_MCP_TOKEN" }
  }
},
"mcp": { "enabled": true, "startupTimeoutMs": 20000 }
```

- **Secrets stay out of config.json**: any `env`/`headers` value written as `env:NAME` is read from `~/.eigen/.env` at connect time. stdio servers also get eigen's environment with secrets scrubbed.
- `"enabled": false` skips a server; `"mcp": { "enabled": false }` skips all of them.
- A server that fails to start is reported and skipped; the daemon still starts. `/status` shows connected servers and tool counts.
- After editing `mcpServers`, run `/reload_mcp` in Telegram — no restart needed. It closes the old clients, re-reads config.json and reconnects, reporting each server.
- Tool names are namespaced, sanitized and capped at 64 characters, so two servers can expose the same tool name.
- Security: MCP tools are ordinary tools here, so anything they can do, the model can trigger. Content they return is untrusted input — a tool that reads mail or web pages can carry prompt injection. The `executeTool` hooks stage is where an approval gate belongs before connecting anything that sends or deletes.

## Development

```sh
npm run typecheck     # tsc --noEmit (Node strips types but doesn't check them)
npm test              # vitest, fully offline (scripted fake provider + recorded fixtures)
npm run smoke -- cloud   # stdin chat against a real configured model entry, no Telegram
```

## Layout

```
src/config    home dir bootstrap, zod schema, loading
src/core      agent API, loop, sessions/queue, context assembly, trimming, events, types
src/prompts   SOUL.md / system.md loading with fallback
src/models    provider interface, error normalization + the single retry wrapper,
              registry, daily usage, adapters/ai-sdk.ts (Vercel AI SDK)
src/tools     registry, gateway (executeTool pipeline), builtin tools, mcp/ (stub)
src/gateway   channel interface, telegram/ (receiver, fastpath, commands, dispatcher, outbox, format)
src/util      logger, token estimate, backoff, abort helpers
```

Dependency rule: `gateway -> core -> {models, tools, prompts, config, util}`. `models` and `tools` may import only **types** from `core/types.ts`. Type imports are erased at runtime, so this creates no real cycle. Provider wire formats (`tool_calls`, `tool_use_id`, `cache_control`, ...) may appear only under `src/models/adapters/`. `test/architecture.test.ts` enforces all of this.

## Design notes

- **Provider-neutral history.** Messages are stored as `{ role, parts, providerData? }`. The adapter translates them at send time. That's why `/model` can switch between Ollama and Anthropic mid-conversation.
- **The model layer is the Vercel AI SDK; the loop is eigen's.** `src/models/adapters/ai-sdk.ts` calls `generateText` once per step with tools declared **without** an `execute` function, which makes the SDK return tool calls instead of running them (the SDK's "manual agent loop"). Every tool then runs through eigen's own gateway, so timeouts, `/stop`, output truncation, events and the hooks stage still apply. `maxRetries: 0` keeps eigen's `withRetry` the single retry place.
- **Seeing the wire.** Since the SDK builds the request body, run with `EIGEN_LOG_LEVEL=debug` to log every outgoing request (`evt: "model_request"`).
- **Tool-call IDs come from the provider/SDK** and round-trip through `providerData`, which holds the SDK's own assistant messages (Anthropic thinking blocks and their signatures included) and replays them unchanged inside a tool loop. Switching provider drops `providerData`; an ID minted by one provider may still travel with the history, which is harmless because both APIs treat IDs as opaque strings.
- **Prompt caching (Anthropic).** `cache_control` markers on the last tool definition and the last message (a rolling cache of the conversation), applied only when the entry sets `promptCaching`. The system prompt contains nothing volatile; time comes from the `current_time` tool. Prefixes below the model's cache minimum (1024 tokens on Sonnet 5) silently won't cache.
- **Trimming.** Trimming works on a copy of history. It first blanks old tool-result bodies, then drops whole old turns. It never separates a tool call from its result and never touches the latest turn. After an edit, `providerData` is dropped from completed turns, because signed thinking blocks are bound to the exact earlier transcript.
- **Model calls are logged** one JSON line each, with provider, model, session, step, estimated vs reported prompt tokens, completion and cached tokens, latency, and stop reason.

## Known limits (v0)

- No persistence. A run in flight when the daemon stops is lost, and counters reset on restart.
- Text only on Telegram. Other message types get a one-line notice.
- No streaming responses.
