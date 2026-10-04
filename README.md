# Eigen

A personal assistant that lives on your Mac and talks to you only through Telegram. Built on [Mastra](https://mastra.ai) file-based agents.

- Four tools: `read`, `write`, `edit`, `bash` (plus `schedule` for reminders). All of its file, `curl` and `npx` work happens in one sandbox folder, under OS isolation.
- Installs skills from [ClawHub](https://clawhub.ai) after you approve, and uses yours too.
- Remembers you: Mastra working memory and semantic recall, plus a few short markdown notes that a nightly job keeps up to date.
- MCP servers, reminders, and nightly memory upkeep run in the background.

Requires Node 22.18+. The old hand-built version is tagged `legacy-v0`.

## Quick start

```sh
npm install
npm run setup        # creates ~/.eigen with defaults
```

1. Create a bot with [@BotFather](https://t.me/BotFather) and put the token in `~/.eigen/.env` (`TELEGRAM_BOT_TOKEN`). Add `ANTHROPIC_API_KEY` if you use the cloud model.
2. Message [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram id, and put it in `~/.eigen/config.json` under `telegram.allowedUserIds`. Eigen refuses to start with an empty list.
3. For the default local model: `ollama pull gemma4:e4b` and `ollama pull nomic-embed-text`, and run Ollama with a context length of at least `models.local.contextWindow` (28000).
4. `npm start` (builds the engine, then runs it on `127.0.0.1:4111`).
5. Optional, the studio: `npm run dev` runs the engine and the studio together; open http://127.0.0.1:4100. Or run just the studio with `npm run dev:app`.

To run it as a background service: `npm run build && npm run service`, then run the `launchctl bootstrap` line it prints. The build bundles Mastra Studio, served at http://127.0.0.1:4111 (localhost only, no auth).

## The team of agents

`~/.eigen/.agents/<id>/` holds one folder per agent: `config.json` plus an `instructions.md`. Exactly one enabled agent is the **primary** (`eigen` by default): it answers on the root Telegram bot and delegates to the others. Shared things (the model list, Telegram, sandbox rules, MCP server list, memory defaults) stay in `~/.eigen/config.json`; an agent only names what it uses and overrides what it must, and the studio marks every value as inherited or overridden.

The studio (`app/`, http://127.0.0.1:4100) shows the team as a graph and edits those files. The engine watches the folder and reloads only the agent that changed, so there is no restart. A file that becomes invalid never takes a running agent down; it keeps its last good version and shows as `stale`. Removing an agent in the studio moves its folder to `.agents/.trash/`.

**One bot per agent.** Any agent can have a Telegram bot of its own: create it with [@BotFather](https://t.me/BotFather), give the agent a `telegram.tokenEnv` (the name of a `.env` variable, e.g. `TELEGRAM_BOT_TOKEN_RESEARCHER`) and switch `telegram.enabled` on, in the studio or in its `config.json`. One token serves one agent; a second agent naming the same token is refused. It answers in its own chat, with its own instructions and memory, and only to `telegram.allowedUserIds` (default: the root list). A specialist bot supports `/help`, `/status`, `/stop` and `/new`; commands that act on the whole install (`/model`, `/verbose`, `/reload`, `/reload_mcp`, `/consolidate`) work only on the primary's bot. The primary's own bot is built once at boot, so changing the root token or allow-list shows "restart required".

**Settings and secrets.** The studio's Settings window edits the shared `~/.eigen/config.json`: models (add your own, with a Test button), the root bot, memory defaults, sandbox policy, the MCP server catalog. Removing a model or MCP server that an agent still uses is refused. API keys and bot tokens are written to `~/.eigen/.env` from the studio and are **write-only**: it can say whether a variable is set and replace or remove it, and no endpoint returns a value. Config files hold only the variable's name (`apiKeyEnv`, `tokenEnv`, `env:NAME`). A key saved in the studio works without a restart, and only the agents that use it are rebuilt.

### The builder

Open an agent in the builder: double-click it on the team canvas, press **Open builder**, or use the command palette. The address is `/?agent=<id>&view=builder`. The agent sits in the middle and its components are nodes around it: Model, Instructions, Soul and the three memory kinds on the left ("Thinks with"); the Workspace tool, MCP servers and Skills on the right ("Can use"); the Telegram bot and Triggers above ("Reaches it, wakes it"). A connected component has a cable to the agent.

- **Connect** a component with its Connect button, from **Add component**, or by dragging a ghost node onto the agent. **Disconnect** it from its panel, or select it and press Delete. Disconnecting memory keeps its data on disk; disconnecting the soul keeps an own `soul.md`.
- Changes are **staged**. The bar at the bottom counts them and shows the diff; **Apply** (Cmd/Ctrl+S) writes `config.json`, the engine reloads only that agent and the bar says "Live"; **Discard** throws them away. If the file changed on disk meanwhile you are told and can overwrite or load theirs.
- Click a node for its editor: a model picker with a Test button, the soul editor, the skill editor (skills are a shared library: an edit reaches every agent that uses the skill), the trigger form with its run history and a Run now button, the MCP form, the Telegram settings. **Chat** opens a side panel to talk to the agent. Enter opens a focused node, Escape closes a panel.
- The table of which node writes which config key is at the top of `app/src/components/builder/model.ts`.

### What an agent is made of

Each part below is a block in the agent's `config.json` and changes apply without a restart.

- **Soul.** `soul.source` is `shared` (the file `~/.eigen/SOUL.md`, read by every agent that picks it), `own` (a `soul.md` next to the agent's `config.json`; `soul.file` is a plain file name in that folder) or `none`. The file is re-read on every message, so an edit is live on the next one.
- **Skills.** `skills.inherit` is `"all"` (default), `"none"`, or a list of names from `~/.eigen/skills/<slug>/SKILL.md` (`@owner/slug` for ClawHub installs). Skills load through the workspace tool, so an agent without it has none. Mastra silently skips a skill whose frontmatter is invalid or whose `name` differs from its folder; the studio shows the reason. ClawHub skills are read-only in the studio.
- **Memory.** `memory.lastMessages` (0 means stateless: nothing is saved, so recall has nothing to find), `memory.semanticRecall.enabled`, `memory.observational.enabled`, and `memory.scope`: `shared` agents use the user's memory (the same as Telegram), `isolated` ones their own, on Telegram and in the studio chat alike.
- **Triggers.** `triggers` is a list of things that wake the agent up. `cron` runs the prompt on a five-field schedule in a time zone. `github-pr` polls one repo's pull requests with a token from a `.env` variable (`tokenEnv`; the token goes only to GitHub, as a Bearer header). The first poll only records the PRs already open; a restart does not re-fire old ones. Each run's reply goes to the agent's Telegram chat and to a run history in the studio (`data/triggers/<agent>/runs.jsonl`, newest 200). Nobody is there to approve tool calls in a triggered run, so every approval is declined and the reply says what was not done. The text of a pull request is written by other people: the engine puts it in a block the agent is told is untrusted data, but that is a mitigation, not a guarantee. Do not point a GitHub trigger at an agent that has the workspace tool or trusted MCP servers unless you accept that.
- **Telegram bot.** Described above: one bot per agent, token from `.env`.

**Chat in the studio.** Any enabled agent can be chatted with from the studio. The primary shares its memory with your Telegram chat but uses a thread of its own; an isolated agent keeps its own. Tool calls that need approval show Approve / Deny.

`npm run migrate` creates `.agents/eigen/` for an existing install (it never moves or deletes anything; the first engine start does the same when `.agents/` is empty). The studio only accepts requests from its own origin on loopback (`EIGEN_APP_ORIGINS` adds more); `npm run test:security` checks that against a running studio.

## Talking to it

| Command | Does |
|---|---|
| `/status` | model, sandbox mode and whether secrets are hidden, skills, MCP, reminders, last memory update |
| `/stop` | stop the current run and drop queued messages |
| `/new` | fresh conversation (memory is kept) |
| `/model [name]` | list models, or switch (`local`, `cloud`) |
| `/verbose [on\|off]` | show tool calls |
| `/reload` | re-read models and timezone from `config.json`, and skills |
| `/reload_mcp` | reconnect MCP servers |
| `/consolidate` | fold recent chats into the memory notes now |

Messages sent while it is working are queued and answered in order. Risky actions show **Approve / Deny** buttons: `rm -r`, `sudo`, `curl | sh`, any ClawHub install/update/remove, tools from MCP servers you have not marked `trusted`, and any change to a reminder.

## Where things live

```
~/.eigen/
  config.json  .env  SOUL.md  prompts/system.md   edit freely; prompts apply on the next message
  skills/        your skills (<name>/SKILL.md); the agent can read them, never write them
  sandbox/       the agent's whole world: shell cwd and file-tool root
    skills/        skills the agent installed from ClawHub
    skills-quarantine/   rejected skills, with REPORT.md saying why
  memory/        MEMORY.md profile.md projects.md people.md lessons.md timeline/YYYY-MM.md  (a git repo)
  data/          eigen.db (conversations, schedules), state.json (/model, /verbose)
  logs/          eigen.log  audit.jsonl (every tool call, secrets redacted)
```

**Skills.** The agent sees both skill folders. Ask it to find one ("is there a skill for X on ClawHub?"): it searches, reads the skill's files, tells you what it does and anything suspicious, and installs only after you tap Approve. A skill with a name you already use is rejected, and so is one Mastra could not load. Drop your own skills into `~/.eigen/skills` and run `/reload`.

**Memory.** Working memory is the instant "remember this" path. `~/.eigen/memory` is written only by a nightly job (03:30 in your timezone, `memory.consolidationCron`) and by you: it reads the day's conversations, checks size and secrets, writes the notes, and commits. No agent tool can reach that folder. Notes are loaded into every prompt; the timeline is searched through semantic recall.

**Growing memory (optional, off by default).** Mastra can also learn in the background. `memory.observational.enabled` turns on Observational Memory: when a chat passes `messageTokens`, an Observer agent condenses old turns into notes and a Reflector keeps them short; with `retrieval` the agent gets a `recall` tool to look up older messages. `memory.knowledge.enabled` (needs observational, experimental in Mastra) adds a curate agent that keeps durable facts and a few pinned lines delivered every turn. Pick the background model with `memory.observational.model` (a name from `models`; default is `curatorModel`). Skill text, scheduled runs (Moltbook, Zomato) and anything that looks like a key are removed before the Observer sees them. `memory.knowledge.model` can name a stronger model for the knowledge agents (they call tools with strict schemas; `gpt-oss:120b` failed them in my test, `ling-3.1-flash` worked), and `knowledge` also needs `semanticRecall` on, because its index uses the vector store. Eigen sets a fixed `organizationId` for Mastra's knowledge scope. Everything is stored in `eigen.db`; look at it in Studio's Memory tab. Turn it off again by setting the flags to `false` and restarting.

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
| `curatorModel` | `cloud` | model for the nightly notes; small local models are unreliable at this |
| `timezone` | system | used for the clock line and schedules |
| `limits.maxSteps` | 25 | tool steps per message |
| `sandbox.*` | see above | `isolation`, `allowNetwork`, `readWritePaths`, `readOnlyPaths`, `denyReadPaths`, `commandTimeoutMs`, `maxTimeoutSec` |
| `memory.*` | | `lastMessages`, `semanticRecall`, `embedder`, `consolidationCron`, `observational`, `knowledge` |
| `mcpServers`, `mcp` | none | see above |

`/reload` picks up `models`, `defaultModel` and `timezone`; MCP has `/reload_mcp`. Anything else in `config.json`, and `.env`, needs a restart.

## Development

```sh
npm run typecheck
npm test            # unit tests, offline
npm run test:e2e    # builds, then drives the built server through a fake Telegram and a fake model
npm run test:live   # real ClawHub install through the agent (needs network)
npm run dev         # engine (Mastra Studio on 4111, hot reload) + agent studio (4100), using ~/.eigen/.env
```

Layout: `engine/` is the Mastra project, `app/` the Next.js studio (React Flow); both are npm workspaces. In `engine/`, `src/mastra/agents/eigen` is the agent (`config.ts`, `instructions.ts`, `workspace.ts`, `schedules/`, built-in `skills/`); `agents/curator` writes the notes; `lib/` holds the small modules behind them, and `lib/tools/` holds the tools (`schedule.ts`, `mcp.ts`, `approval.ts`, and `workspace.ts` for `read`/`write`/`edit`/`bash`). Tools live there, not in `agents/eigen/tools/`, because Mastra ignores discovered tool files when `config.tools` is a function (MCP tools load at runtime). `lib/tools/workspace.ts` (with `lib/sandbox.ts`) is the only place that names the sandbox provider, so swapping to a remote desktop sandbox later is a small change.

## Known limits

- File-based agents and schedules are Beta in Mastra, so versions are pinned exactly.
- The `schedule` (reminder) tool works only for the primary agent; a specialist that lists it gets nothing. Use triggers to schedule a specialist.
- The primary's own bot is built once at boot, so changing the root token or allow-list needs an engine restart. Specialist bots change live.
- GitHub triggers, Telegram against the real API, and chat against a real model have only been exercised against fakes.
- A reminder that fires within a second or two of the end of a conversation turn can be handed to that finishing run and lost.
- The macOS profile, Telegram against the real API, and Ollama tool calling have only been exercised with fakes; try them on your Mac.
