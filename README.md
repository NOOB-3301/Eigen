# Eigen

A personal assistant that lives on your Mac and talks to you only through Telegram. Built on [Mastra](https://mastra.ai) file-based agents.

- Four tools: `read`, `write`, `edit`, `bash` (plus `schedule` for reminders). All of its file, `curl` and `npx` work happens in one sandbox folder, under OS isolation.
- Installs skills from [ClawHub](https://clawhub.ai) after you approve, and uses yours too.
- Remembers you: Mastra working memory and semantic recall, plus short markdown notes you keep by hand.
- MCP servers and reminders run in the background.

Requires Node 22.18+. The old hand-built version is tagged `legacy-v0`.

## Quick start

```sh
npm install
npm run setup        # creates ~/.eigen with defaults
```

1. Create a bot with [@BotFather](https://t.me/BotFather) and put the token in `~/.eigen/.env` (`TELEGRAM_BOT_TOKEN`). Add `ANTHROPIC_API_KEY` if you use the cloud model.
2. Message [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram id, and put it in `~/.eigen/config.json` under `telegram.allowedUserIds`. Eigen refuses to start with an empty list.
3. For the default local model: `ollama pull gemma4:e4b` and `ollama pull nomic-embed-text`, and run Ollama with a context length of at least `models.local.contextWindow` (28000).
4. `npm start` (builds, then runs on `127.0.0.1:4111`).

To run it as a background service: `npm run build && npm run service`, then run the `launchctl bootstrap` line it prints. The build bundles Mastra Studio, served at http://127.0.0.1:4111 (localhost only, no auth).

## Talking to it

| Command | Does |
|---|---|
| `/status` | model, sandbox mode and whether secrets are hidden, skills, MCP, reminders |
| `/stop` | stop the current run and drop queued messages |
| `/new` | fresh conversation (memory is kept) |
| `/model [name]` | list models, or switch (`local`, `cloud`) |
| `/verbose [on\|off]` | show tool calls |
| `/reload` | re-read models and timezone from `config.json`, and skills |
| `/reload_mcp` | reconnect MCP servers |

Messages sent while it is working are queued and answered in order. Risky actions show **Approve / Deny** buttons: `rm -r`, `sudo`, `curl | sh`, any ClawHub install/update/remove, tools from MCP servers you have not marked `trusted`, and any change to a reminder.

## Where things live

```
~/.eigen/
  config.json  .env  SOUL.md  prompts/system.md   edit freely; prompts apply on the next message
  skills/        your skills (<name>/SKILL.md); the agent can read them, never write them
  sandbox/       the agent's whole world: shell cwd and file-tool root
    skills/        skills the agent installed from ClawHub
    skills-quarantine/   rejected skills, with REPORT.md saying why
  memory/        MEMORY.md profile.md projects.md people.md lessons.md  (your notes, edited by hand)
  data/          eigen.db (conversations, schedules), state.json (/model, /verbose)
  logs/          eigen.log  audit.jsonl (every tool call, secrets redacted)
```

**Skills.** The agent sees both skill folders. Ask it to find one ("is there a skill for X on ClawHub?"): it searches, reads the skill's files, tells you what it does and anything suspicious, and installs only after you tap Approve. A skill with a name you already use is rejected, and so is one Mastra could not load. Drop your own skills into `~/.eigen/skills` and run `/reload`.

**Memory.** Working memory is the instant "remember this" path: the agent keeps a profile of you in its context on every turn. `~/.eigen/memory` holds the notes you keep by hand; nothing writes to it automatically.

**Growing memory (optional, off by default).** Mastra can also learn in the background. `memory.observational.enabled` turns on Observational Memory: when a chat passes `messageTokens`, an Observer agent condenses old turns into notes and a Reflector keeps them short; with `retrieval` the agent gets a `recall` tool to look up older messages. `memory.knowledge.enabled` (needs observational, experimental in Mastra) adds a curate agent that keeps durable facts and a few pinned lines delivered every turn. Pick the background model with `memory.observational.model` (a name from `models`; default is `defaultModel`). Skill text, scheduled runs (Moltbook, Zomato) and anything that looks like a key are removed before the Observer sees them. `memory.knowledge.model` can name a stronger model for the knowledge agents (they call tools with strict schemas; `gpt-oss:120b` failed them in my test, `ling-3.1-flash` worked), and `knowledge` also needs `semanticRecall` on, because its index uses the vector store. Eigen sets a fixed `organizationId` for Mastra's knowledge scope. Everything is stored in `eigen.db`; look at it in Studio's Memory tab. Turn it off again by setting the flags to `false` and restarting.

**MCP.** In `config.json`:

```json
"mcpServers": {
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "env:GITHUB_TOKEN" } },
  "docs":   { "url": "https://example.com/mcp", "headers": { "Authorization": "env:DOCS_TOKEN" }, "trusted": true }
}
```

`env:NAME` reads the value from `~/.eigen/.env`. Tools are called `<server>_<tool>` and ask for approval unless `"trusted": true`. A server that fails to start is reported in `/status` and does not stop the bot. Run `/reload_mcp` after editing.

**Ground rules.** Say "this is a ground rule" or "critical" and the agent adds a dated line to `~/.eigen/sandbox/groundrules.md` (it edits it with its normal file tools). That file is put into every prompt, including scheduled runs, so a rule survives `/new`, a restart and a model switch. Each changed version is also copied to `~/.eigen/data/groundrules-history/` (newest 100), where the agent cannot reach, so you can restore an older one. You can edit the file yourself too.

**Reminders.** "Remind me at 9 to call Sam", "every Monday 10:00 summarize my week". The agent shows what it is about to schedule and waits for approval. One-time reminders are removed after they fire.

## Security

- Only the Telegram ids in `allowedUserIds` get a response; groups are ignored.
- The file tools reach only `~/.eigen/sandbox`. `bash` runs under OS isolation (`bwrap` on Linux, `seatbelt` on macOS) with writes limited to the sandbox and an environment of its own: no API keys, no bot token.
- On Linux the sandbox never sees your home. On macOS, seatbelt can read everything unless told otherwise, so Eigen writes a profile that hides `~/.eigen`, `~/.ssh`, `~/.aws`, `~/.config`, Keychains, Documents, Desktop and Downloads (`sandbox.denyReadPaths`), and `/status` tests it. **That profile has not been run on a Mac yet**: check `/status` says `secrets hidden`.
- Wider access is opt-in: `sandbox.readOnlyPaths`, `sandbox.readWritePaths`; `sandbox.allowNetwork: false` cuts the network.
- `sandbox.isolation: "auto"` stops Eigen from starting if no isolation is available, rather than running without it.
- Skills, web pages and tool results are treated as untrusted input; ClawHub has hosted malicious skills, so installs are inspected first and approved by you.
- The Mastra API server binds to `127.0.0.1` only.

## Config

| Key | Default | |
|---|---|---|
| `defaultModel`, `models` | `local` (Ollama), `cloud` (Anthropic) | `id` is `provider/model`; `url` for OpenAI-compatible servers; `contextWindow` sets the prompt budget |
| `timezone` | system | used for the clock line and schedules |
| `limits.maxSteps` | 25 | tool steps per message |
| `sandbox.*` | see above | `isolation`, `allowNetwork`, `readWritePaths`, `readOnlyPaths`, `denyReadPaths`, `commandTimeoutMs`, `maxTimeoutSec` |
| `memory.*` | | `lastMessages`, `semanticRecall`, `embedder`, `observational`, `knowledge` |
| `mcpServers`, `mcp` | none | see above |

`/reload` picks up `models`, `defaultModel` and `timezone`; MCP has `/reload_mcp`. Anything else in `config.json`, and `.env`, needs a restart.

## Development

```sh
npm run typecheck
npm test            # unit tests, offline
npm run test:e2e    # builds, then drives the built server through a fake Telegram and a fake model
npm run test:live   # real ClawHub install through the agent (needs network)
npm run dev         # Mastra Studio (hot reload), using ~/.eigen/.env
```

Layout: `src/mastra/agents/eigen` is the agent (`config.ts`, `instructions.ts`, `memory.ts`, `workspace.ts`, built-in `skills/`); `lib/` holds the small modules behind it, and `lib/tools/` holds the tools (`schedule.ts`, `mcp.ts`, `approval.ts`, and `workspace.ts` for `read`/`write`/`edit`/`bash`). Tools live there, not in `agents/eigen/tools/`, because Mastra ignores discovered tool files when `config.tools` is a function (MCP tools load at runtime). `lib/tools/workspace.ts` (with `lib/sandbox.ts`) is the only place that names the sandbox provider, so swapping to a remote desktop sandbox later is a small change.

## Known limits

- File-based agents and schedules are Beta in Mastra, so versions are pinned exactly.
- A reminder that fires within a second or two of the end of a conversation turn can be handed to that finishing run and lost.
- The macOS profile, Telegram against the real API, and Ollama tool calling have only been exercised with fakes; try them on your Mac.
