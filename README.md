# eigen

A personal, always-on agent that runs in the foreground on your Mac and talks to you only through Telegram. Models are provider-agnostic (local Ollama, any OpenAI-compatible API, Anthropic's native API) and switchable per session at runtime.

v0 is the skeleton: config, in-memory sessions, prompt assembly from `SOUL.md` + prompt files, the agent loop, a tool gateway with four built-in tools, two model adapters, and the Telegram gateway. No database: history lives in memory and is gone on restart.

## Requirements

- Node **22.18+** (or 24). eigen runs TypeScript directly via Node's type stripping, so there is no build step.
- A Telegram account.
- Ollama for local models, and/or an Anthropic API key.

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
| `/verbose` | Toggle short progress notes per tool call. |

Commands run immediately and never wait behind a run. If you send text while a run is busy, it queues FIFO.

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
              registry, daily usage, adapters/{openai-compat,anthropic}.ts
src/tools     registry, gateway (executeTool pipeline), builtin tools, mcp/ (stub)
src/gateway   channel interface, telegram/ (receiver, fastpath, commands, dispatcher, outbox, format)
src/util      logger, token estimate, backoff, abort helpers
```

Dependency rule: `gateway -> core -> {models, tools, prompts, config, util}`. `models` and `tools` may import only **types** from `core/types.ts`. Type imports are erased at runtime, so this creates no real cycle. Provider wire formats (`tool_calls`, `tool_use_id`, `cache_control`, ...) may appear only under `src/models/adapters/`. `test/architecture.test.ts` enforces all of this.

## Design notes

- **Provider-neutral history.** Messages are stored as `{ role, parts, providerData? }`. The adapters translate them at send time. That's why `/model` can switch between Ollama and Anthropic mid-conversation.
- **Tool-call IDs are minted by eigen.** The Anthropic adapter keeps the original assistant content blocks, including thinking blocks, in `providerData` and replays them byte-for-byte within a tool loop. It also maps eigen IDs back to `toolu_...` IDs. Switching to a different provider drops `providerData`.
- **Prompt caching (Anthropic).** Up to three `cache_control` markers: on the last tool, the system block, and the last message block. The last marker gives a rolling cache of the conversation. The system prompt contains nothing volatile; time comes from the `current_time` tool. Prefixes below the model's cache minimum (1024 tokens on Sonnet 5) silently won't cache.
- **Trimming.** Trimming works on a copy of history. It first blanks old tool-result bodies, then drops whole old turns. It never separates a tool call from its result and never touches the latest turn. After an edit, `providerData` is dropped from completed turns, because signed thinking blocks are bound to the exact earlier transcript.
- **Model calls are logged** one JSON line each, with provider, model, session, step, estimated vs reported prompt tokens, completion and cached tokens, latency, and stop reason.

## Known limits (v0)

- No persistence. A run in flight when the daemon stops is lost, and counters reset on restart.
- Text only on Telegram. Other message types get a one-line notice.
- No streaming responses.
