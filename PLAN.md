# Eigen v1: rewrite on Mastra (file-based agent)

## Context

Eigen v0 is a hand-built agent harness (~2.6k lines): its own agent loop, history trimming, retry layer,
tool gateway, MCP manager, Telegram receiver/outbox and a skill-capture pipeline. The owner wants all of
it replaced by Mastra's file-based agent framework (https://mastra.ai/reference/file-based-agents/config)
and to keep only what makes Eigen *Eigen*:

- Telegram is the only way to talk to it (owner-only).
- Four tools: `read`, `write`, `edit`, `bash` (plus one small approval-gated `schedule` tool for reminders).
  All of the agent's file, `curl` and `npx` work happens inside its sandbox, `~/.eigen/sandbox`.
- It extends itself: the agent installs skills from ClawHub into its sandbox; the owner installs their own
  into `~/.eigen/skills`; the agent sees the sum of both, and a skill manager reloads as soon as one lands.
- It evolves with the user: Mastra working memory + semantic recall, plus a few concise markdown files in
  `~/.eigen/memory/` that distill every conversation.
- MCP servers configured the way v0 did it; Mastra schedules for background work.
- Later, the local sandbox can be swapped for Mastra computer use (a remote desktop sandbox). The design
  keeps that swap to one file.

The v0 implementation is deleted on branch `main-mastra`. The Mastra skills already installed under
`.claude/skills/` stay. Net effect: ~10 small config files instead of ~2.6k lines of framework code.

Nothing below has been implemented. This is the plan only.

## What was verified (read from the installed packages, not from memory)

Pinned versions (all current on npm today): `@mastra/core 1.73.0`, `@mastra/memory 1.34.0`,
`@mastra/libsql 1.24.1`, `@mastra/mcp 2.1.2`, `mastra` CLI `1.32.0`, `@mastra/loggers 1.3.4`,
`@chat-adapter/telegram 4.41.1`, `clawhub 0.23.3` (run through `npx`). Node >= 22.13 (v0 already needs
22.18). File-based agents and schedules are **Beta**, so versions are pinned exactly, not with `^`.

| Need | Mastra primitive | Verified detail |
|---|---|---|
| Agent definition | `src/mastra/agents/eigen/` with `config.ts`, `instructions.ts`, `memory.ts`, `workspace.ts`, `schedules/`, `skills/` | `agentConfig()` accepts every `Agent` option (so `channels`, `workspace`, `memory`, `tools` can live in `config.ts`). Discovery runs only through `mastra dev` / `mastra build`. |
| Telegram | `channels.adapters.telegram = createTelegramAdapter({ mode: "polling", allowedUserIds })` | Polling needs no public URL (right for a Mac daemon). `allowedUserIds` is enforced before anything else, but **empty means allow everyone**, so startup must fail closed. Streams by post+edit. `requireApproval` tools render as Approve/Deny buttons. Channels require storage. |
| 4 tools | Workspace tools: global `tools.enabled:false`, then enable and rename `READ_FILE`/`WRITE_FILE`/`EDIT_FILE`/`EXECUTE_COMMAND` | Per-tool `name`, `requireApproval` (can be a function of the args), `requireReadBeforeWrite`, `requireDescription`, and `hooks.beforeToolCall/afterToolCall` (can veto a call). |
| Sandbox | `LocalFilesystem({ basePath, contained })` + `LocalSandbox({ workingDirectory, env, isolation, nativeSandbox })` | Sandbox env is `PATH` only by default (secrets not inherited). `isolation: "seatbelt"` (macOS) / `"bwrap"` (Linux) restricts writes and, by default, network. **Reads are allowed everywhere**, so secrets files need an explicit deny rule. |
| Runtime skills | Workspace `skills: [...]` + `skillSource`, tools `skill`, `skill_read`, `skill_search` | `maybeRefresh()` runs at the start of every run and between skill-tool calls (mtime check, **30 s cooldown**); `workspace.skills.refresh()` is immediate. An invalid SKILL.md (name != folder, uppercase, description > 1024 chars) is **skipped with only a console error**. `skillSource` needs only `exists/stat/readFile/readdir`, so a read-only `LocalFilesystem` fits. Two skills with the same name in the same source type make name lookup **throw**. The file-based `skills/` folder is bundled at build time, so it is only for built-in skills. |
| Memory | `memory.ts` -> `Memory` | Working memory (markdown template, `scope: "resource"` persists across threads), semantic recall (libSQL vector store + embedder), optional Observational Memory. All supported on libSQL. |
| Persistence | `storage.ts` -> `LibSQLStore("file:...")` | Needed by channels, memory, schedules. Closes v0's "no persistence" gap. |
| Schedules | `agents/eigen/schedules/*.ts\|.md` via `defineSchedule`, plus `mastra.schedules.create()` and `/api/schedules` at runtime | Needs storage and a long-running process (we have one). `handler` mode can do the work itself and return `null` to skip the agent run. Root agents only. |
| MCP | `@mastra/mcp` `MCPClient` fed into `config.tools` as a function | `listToolsWithErrors()` reports per-server failures. `requireToolApproval`, `allowedHosts`, `inheritDefaultEnv:false`. Tool names become `server_tool`. |
| Models | `"anthropic/claude-sonnet-5-5"` or `{ id: "ollama/gemma4:e4b", url: "http://localhost:11434/v1", apiKey: "ollama" }` | Ids are validated against the model-router registry (`.claude/skills/mastra/scripts/provider-registry.mjs`). Ollama is not a registry provider, so it uses the OpenAI-compatible object form. |
| Computer use (later) | Swap `LocalSandbox` for `E2BDesktopSandbox` / `DaytonaSandbox` | Adds `computer_screenshot/click/type/...` tools with the same per-tool `enabled` / `requireApproval` config. Only desktop sandboxes provide them. |
| Server / logs / env | `server.ts`, `logger.ts` (Pino), `mastra build` then `mastra start --env ~/.eigen/.env` | Relative paths resolve differently under `dev` and `start`, so every path is absolute from `EIGEN_HOME`. |

## Target layout

```
eigen/  (branch main-mastra)
├── package.json  tsconfig.json  .gitignore            new, pinned deps
├── .claude/skills/  .agents/skills/  skills-lock.json  KEEP (Mastra skills)
├── defaults/                      seeds copied into ~/.eigen on first run
│   ├── config.example.json  env.example  SOUL.md  system.md
│   └── memory/{MEMORY,profile,projects,people,lessons}.md
├── src/mastra/
│   ├── index.ts        Mastra instance: startup guards, command wiring, schedule hooks
│   ├── storage.ts      LibSQLStore -> ~/.eigen/data/eigen.db
│   ├── server.ts       host 127.0.0.1, port 4111, Studio bundled in the build
│   ├── logger.ts       PinoLogger -> ~/.eigen/logs/eigen.log
│   ├── lib/            home.ts  config.ts  mcp.ts  skill-manager.ts  skill-validate.ts  sandbox.ts
│   │                   memory-delta.ts  curate.ts  audit.ts  schedule-tool.ts
│   └── agents/
│       ├── eigen/
│       │   ├── config.ts        model (function), channels (Telegram), defaultOptions, tools (MCP + schedule)
│       │   ├── instructions.ts  function: SOUL + system + memory files + clock, read per turn
│       │   ├── memory.ts        working memory + semantic recall
│       │   ├── workspace.ts     THE sandbox seam: filesystem + sandbox + skill roots + 4 tools
│       │   ├── skills/          built-in skills bundled at build: clawhub, memory-curation notes
│       │   └── schedules/       consolidate-memory.ts
│       └── curator/             no tools, no workspace, no memory: turns a chat delta into new memory files
└── test/                        vitest, fully offline (mock model, fake MCP server, tmp EIGEN_HOME)

~/.eigen/  (EIGEN_HOME, created on first run)
├── config.json  .env  SOUL.md  prompts/system.md
├── skills/        YOUR skills (you install here). The agent can read them, never write them.
├── sandbox/       the agent's whole world: shell cwd and file-tool root. Every file / curl / npx op happens here.
│   ├── skills/        skills the AGENT installs from ClawHub: <slug>/SKILL.md
│   └── .clawhub/      lock.json = ClawHub CLI bookkeeping (installed versions, fingerprints, pins);
│                      written by `clawhub install`, needed by `clawhub list/update/pin`, never edited by hand
├── memory/        MEMORY.md (index)  profile.md  projects.md  people.md  lessons.md  timeline/YYYY-MM.md
│                  (own git repo; written only by the nightly curator job and by you; no agent tool can reach it)
├── data/eigen.db
└── logs/          eigen.log  audit.jsonl
```

## Design by area

**Agent and prompt.** `instructions.ts` is a function (instructions are otherwise baked in at build time),
so editing `~/.eigen/SOUL.md`, `prompts/system.md` or any memory file takes effect on the next message with
no rebuild. It injects SOUL, the system prompt, the core memory files (`MEMORY.md`, `profile.md`,
`projects.md`, `people.md`, `lessons.md`, hard-capped at ~6k tokens total; `timeline/` is not injected and
is reached through semantic recall), and a one-line clock as the **last** line (keeps most of the Anthropic
prompt-cache prefix stable). There is no `current_time` tool any more, so the clock line plus `bash date`
replace it. The prompt is updated for Telegram markdown (the adapter converts it) and the new tool names.

**Telegram.** Adapter in `config.ts` with `mode: "polling"`, `allowedUserIds` from config, `onMention: false`
and `onSubscribedMessage: false` (groups ignored, as in v0). A startup guard in `index.ts` refuses to boot
if the allowlist is empty or the bot token is missing. Streaming and typing indicator on. Inbound photos
work via `inlineMedia` (a v0 gap closed for free).

**Tools and sandbox (`workspace.ts`, the only file that names the sandbox provider).**
- `LocalFilesystem(basePath ~/.eigen/sandbox, contained: true)` with no `allowedPaths`: the file tools cannot
  see `config.json`, `.env`, `memory/` or your `skills/`.
- `LocalSandbox(workingDirectory ~/.eigen/sandbox, isolation: "seatbelt" on macOS / "bwrap" on Linux, network on)`
  with an explicit env whitelist: `PATH`, `HOME=<sandbox>/.home`, `CLAWHUB_WORKDIR`, `CLAWHUB_CONFIG_PATH`
  (both inside the sandbox), `CLAWHUB_DISABLE_TELEMETRY=1`, `npm_config_cache` (inside the sandbox). No API
  keys, no bot token.
- Only `read`, `write`, `edit`, `bash` are exposed. `write`/`edit` use `requireReadBeforeWrite`; `bash` uses
  `requireDescription` so approval cards and logs are readable. A `beforeToolCall` hook appends `audit.jsonl`
  and can veto. `requireApproval` is a function: skill installs/updates and risky commands (`rm -rf`,
  `sudo`, `curl|sh`) ask for a Telegram tap; everything else runs.
- Extra access beyond the sandbox is opt-in through `config.json` (`sandbox.readWritePaths`, `readOnlyPaths`).
- **Computer-use seam.** Swapping to a desktop sandbox later changes `workspace.ts` only; the computer tools
  appear and get `requireApproval`. Memory and your skills stay on the Mac and are read by the Mastra server
  process (not by the sandbox), which is why they sit outside it. Agent-installed skills and the lockfile
  would need a path decision at that point. Because of this, macOS hardening beyond default isolation plus a
  small deny-read list is deliberately not gold-plated.

**Skills and the skill manager.** Mastra loads the sum of two roots through one read-only source:
`skillSource: new LocalFilesystem({ basePath: ~/.eigen, readOnly: true })` and
`skills: ["skills", "sandbox/skills"]`. So the agent can use both folders but its tools cannot write yours.
Install flow, taught by a built-in `clawhub` skill: `npx clawhub@0.23.3 search` / `inspect <slug> --files`
-> agent reads SKILL.md and scripts and reports the risk -> you approve in Telegram ->
`install <slug> --workdir ~/.eigen/sandbox --dir skills` -> `clawhub pin <slug>`. The skill manager
(`lib/skill-manager.ts`, ~100 lines) does four things:
1. a workspace `afterToolCall` hook calls `workspace.skills.refresh()` right after any `clawhub` command,
   so the skill is usable in the same run (Mastra's own refresh has a 30 s cooldown);
2. a validator applies Mastra's rules (name == folder, charset, description <= 1024) and either normalizes
   the frontmatter or moves the skill to `sandbox/skills-quarantine/` and tells you why, because Mastra would
   silently skip it;
3. it refuses an agent install whose name already exists in `~/.eigen/skills` (yours wins), because same-name
   skills in both roots make Mastra's name lookup throw;
4. `/reload` and Mastra's built-in `maybeRefresh()` pick up skills you drop into `~/.eigen/skills` by hand.
The lockfile sits inside the agent-writable sandbox, so it is bookkeeping, not a trust anchor; trust comes
from the approval step and `audit.jsonl`. Dropped: v0's judge/eval/capture pipeline (can return as a scorer).

**Memory (layered).**
- Working memory: small markdown profile template, resource scope, always in context. This is the instant
  "remember this" path.
- Semantic recall: libSQL vector store, `scope: "resource"`, topK ~4, messageRange 2. Embedder: Ollama
  embeddings via the OpenAI-compatible route (reuses the Ollama already running), with `@mastra/fastembed`
  as the zero-config alternative. Decided in Phase 3.
- `~/.eigen/memory/*.md`: `MEMORY.md` is an index (one line per file); `profile.md`, `projects.md`,
  `people.md`, `lessons.md` hold current facts; `timeline/YYYY-MM.md` holds a compressed digest of the
  conversations, one short section per day. Every file has a hard size cap; the curator merges and prunes
  rather than appending forever. The directory is a git repo, committed after each run, so every change is
  auditable and revertable. You can edit any file by hand.
- Consolidation is **code-driven, not agent-tool-driven**. `schedules/consolidate-memory.ts` runs nightly
  in the owner's timezone as a `handler`: (1) `lib/memory-delta.ts` reads messages since `lastRunAt` from
  Mastra storage and returns early with `null` if there are none; (2) it reads the current memory files;
  (3) it calls the `curator` agent with structured output (`{ files: {name: content}, timelineEntry }`);
  (4) `lib/curate.ts` validates (size caps, secret regexes, markdown only, no path escapes) and writes
  atomically, updates `lastRunAt`, and commits; (5) the handler returns `null` so no agent run is started.
  The same function backs `/consolidate`. Because no agent tool can reach `memory/`, a prompt-injected skill
  or web page cannot rewrite your memory; it can only influence what the curator sees, and the validators
  and git history bound the damage.
- Context guard for the local model: a token-limiter processor sized below Ollama's `num_ctx` (v0's trimming
  existed for exactly this silent-truncation problem).

**MCP.** `lib/config.ts` keeps v0's `mcpServers` shape and `env:NAME` secret references (read from `.env`);
`lib/mcp.ts` builds an `MCPClient`, `config.tools` is a function returning `listToolsWithErrors()` merged
with the `schedule` tool. Failed servers are logged and shown in `/status` but never block startup.
`requireToolApproval` defaults to true unless a server is marked `"trusted": true`; stdio servers get
`inheritDefaultEnv:false`. `/reload_mcp` disconnects and rebuilds the client.

**Commands.** `/status /stop /model /reload /reload_mcp /verbose /help /consolidate` via the Chat SDK
`onSlashCommand` (Telegram routes bot commands there, after the allowlist check). `/model` becomes a model
*function* reading a per-chat choice. `/new` and `/stop` depend on Mastra thread/abort behaviour (Phase 0).

**Schedules.** File-defined: memory consolidation. Runtime reminders: `lib/schedule-tool.ts` is a
`createTool` with an `action` (create / list / pause / resume / delete) that calls `mastra.schedules`,
threaded to the owner's Telegram thread so the reminder lands in the chat. Its `requireApproval` is a
function of the input (`action !== "list"`), so only changes ask for a tap. Because `config.tools` is a
function (for MCP), Mastra ignores a `tools/` folder, so this tool is merged in inside that function.

**Ops.** `npm run dev` = `mastra dev --env ~/.eigen/.env`; `npm start` = `mastra build && mastra start --env
~/.eigen/.env`; optional launchd plist for the Mac daemon. First run creates `~/.eigen/{skills,sandbox,memory,
data,logs}` and seeds config/prompts/memory from `defaults/` (reusing v0's `ensureHome` idea).

## v0 -> v1 mapping (nothing silently lost)

| v0 | v1 |
|---|---|
| provider-neutral history + trimming | Mastra memory (`lastMessages`, token limiter, semantic recall) |
| retry / error normalization | Mastra `maxRetries` + model fallbacks |
| tool gateway (timeouts, truncation, hooks) | Workspace tool config (`maxOutputTokens`, hooks, approvals) |
| MCP manager, `/reload_mcp` | `@mastra/mcp`, same config shape, same command |
| Telegram receiver / fastpath / outbox | Chat SDK Telegram adapter (polling, `allowedUserIds`, streaming) |
| `/new /stop /status /model /reload /verbose` | `onSlashCommand` handlers (some need Phase 0 confirmation) |
| SOUL.md / system.md + `/reload` | `instructions.ts` function reading `~/.eigen` per turn |
| `~/.eigen/skills` (custom) + agent-created skills | `~/.eigen/skills` (yours) + `sandbox/skills` (ClawHub installs), union loaded |
| skills capture/eval/judge | **dropped** (revisit as a scorer) |
| `dailyTokenCap`, `runTokenBudget` | **dropped** (revisit as a processor) |
| architecture import-rule test | **dropped** (Mastra owns the layering) |
| `current_time`, `http_fetch`, `run_code` tools | `bash` (`date`, `curl`, interpreters) |
| no approval gate | native Telegram Approve/Deny (new) |
| no persistence | LibSQL (new) |

v0 stays reachable: tag `legacy-v0` on the current `main-mastra` HEAD before deleting anything. Pieces worth
copying from that tag: `resolveEnvRefs` (`src/tools/mcp/client.ts`), the zod MCP/config schemas
(`src/config/schema.ts`), `ensureHome` (`src/config/home.ts`), the secret regexes (`src/skills/eval.ts`),
and the prompt text in `defaults/`.

## Security model

ClawHub has had hundreds of malicious skills; VirusTotal scanning is "not a silver bullet", and many
malicious skills contain no code, only instructions that make the agent download and run something. The
agent has `bash` and is driven from a chat app, so:

1. Owner-only bot: `allowedUserIds`, fail-closed startup, groups disabled.
2. The agent's file tools reach only `~/.eigen/sandbox`; `config.json`, `.env`, `memory/` and your `skills/`
   are out of reach. `bash` runs under OS isolation (writes only in the sandbox). The remaining gap is that
   isolation allows reads everywhere, so a deny-read rule covers `~/.eigen/.env`, `~/.ssh`, `~/.aws`, Keychains.
3. Sandbox env is a whitelist; API keys and the bot token never enter it.
4. Skill installs/updates are approval-gated after an inspect-and-summarize step; installed skills are pinned.
5. Memory is written only by the curator job (validated, size-capped, git-committed) and by you.
6. MCP tools require approval unless the server is marked trusted; tool output is treated as untrusted.
7. Mastra API server binds to 127.0.0.1 only (file-based `server.ts` has no auth by default).
8. Every tool call is appended to `audit.jsonl`.

## Phases and verification

Verification split: this cloud session is Linux with no Telegram access, no Ollama and no macOS, so
everything automated runs here; the Telegram, seatbelt and Ollama checks run on the owner's Mac.

**Phase 0: spikes** (throwaway project, no repo changes). Each ends pass/fail and amends this plan.
1. Telegram polling + allowlist + groups ignored (Mac). 2. Slash commands, `/stop` abort, `/new` thread
semantics. 3. `tools.enabled:false` + 4 renamed tools; `execute_command` timeout vs slow installs; hook
fires. 4. Read-only `LocalFilesystem` as `skillSource` with `skills: ["skills", "sandbox/skills"]`; real
ClawHub install + `refresh()`; name-mismatch and same-name-in-both-roots behaviour. 5. Seatbelt with network
on and secrets hidden; npm cache / `HOME` / clawhub config redirected into the sandbox (Mac). 6. Threaded
schedule actually posts into Telegram; a `handler` that does its own work and returns `null` starts no run;
runtime `schedules.create`. 7. Message-delta query for consolidation; embedder choice on LibSQLVector.
8. Ollama object-form model does tool calls; token limiter below `num_ctx`.

**Phase 1: clean slate + skeleton.** Tag `legacy-v0`; delete `src/`, `test/`, `main.ts`, `scripts/`,
`ARCHITECTURE.md`; new `package.json`/`tsconfig`; `storage/server/logger/index`, `lib/home` + `lib/config`;
agent with instructions, Telegram adapter and allowlist guard, no tools yet.
*Verify:* `npm run typecheck`, `npm test` (config/home/guard), `npm run build` produces `.mastra/output`,
`mastra dev` Studio chat answers using a mock model; Mac: Telegram round trip, stranger ignored, empty
allowlist refuses to boot.

**Phase 2: tools, sandbox, approvals, audit.** *Verify:* offline tests drive the agent with a mock model
through read/write/edit/bash in a tmp `EIGEN_HOME`; read-before-write enforced; `read` of
`~/.eigen/memory/profile.md` and `~/.eigen/.env` is rejected by containment; approval-required path
suspends; audit lines written; sandbox env contains no secrets; Mac: seatbelt blocks a write to `~/Desktop`
and a read of `~/.eigen/.env`.

**Phase 3: memory.** Working memory, semantic recall, `memory/` files, `instructions.ts` injection, curator
agent, `consolidate-memory` schedule, `/consolidate`. *Verify:* unit tests for `memory-delta` and
`curate` (size caps, secret rejection, path escape rejection, atomic write, git commit); run the schedule
via `POST /api/schedules/<id>/run` against fixture messages with a mock curator and diff the md files;
`mastra api` thread inspection; restart keeps memory; editing a memory file by hand shows up in the next
prompt.

**Phase 4: skills.** Built-in `clawhub` skill, `skillSource` with both roots, skill manager, validator,
approval flow. *Verify:* unit tests for the validator; integration test with a skill in `~/.eigen/skills`
and one in `sandbox/skills` asserts both are listed; a fixture install is usable in the same run after
`refresh()`; a malformed fixture is quarantined with a reason; a same-name collision is refused; one real
ClawHub install on the Mac.

**Phase 5: MCP, commands, reminders.** `lib/mcp.ts`, `/reload_mcp`, `/model`, `/status`, `/verbose`,
`lib/schedule-tool.ts`. *Verify:* port v0's fake MCP server test (`test/helpers/mcp-server.ts` from the tag);
failing server does not block boot; approval required by default; `schedule` tool: `list` runs without
approval, `create` asks, a created schedule fires via `/api/schedules/<id>/run` and survives a restart;
commands work from Telegram on the Mac.

**Phase 6: hardening and ops.** Minimal seatbelt deny-read rule (no bespoke profile unless the computer-use
swap is far off), launchd plist, README rewrite (replacing the v0 README and `ARCHITECTURE.md`), `defaults/`
finalized. *Verify:* clean-machine run from an empty `EIGEN_HOME`; 24 h soak including one nightly
consolidation.

## Risks

- File-based agents and schedules are Beta; pin exact versions and re-run Phase 0 checks on upgrades.
- Command wiring and `/stop`/`/new` depend on Chat SDK/Mastra behaviour not documented for file-based
  projects (Phase 0 spike 2). Fallback: handle commands in the `onDirectMessage` handler.
- Seatbelt cannot be verified in this Linux session; "contained" is best-effort until checked on the Mac.
- Small local models are unreliable at working-memory updates, structured output and tool use; the curator
  and skill work should run on the cloud entry.
- Using a read-only `LocalFilesystem` as `skillSource` is untested; fallback is `LocalSkillSource` with
  absolute paths (Phase 0 spike 4).
- `@mastra/fastembed` pulls a native ONNX runtime; Ollama embeddings avoid that.
- Mastra's SKILL.md validation is stricter than ClawHub's; the validator must cope with real-world skills.
- A future remote computer-use sandbox moves the agent's filesystem off the Mac; skill and lockfile paths
  are revisited then.

## Decisions

Settled with the owner:
1. **Shell scope: contained** to the sandbox with OS isolation; wider access is opt-in via config paths.
2. **Skill installs: inspect, summarize, then Telegram approval**; installed skills are pinned.
3. **Memory: layered.** Working memory (tiny profile) + semantic recall + nightly-distilled md files.
4. **Reminders: yes**, via one approval-gated `schedule` tool (five tools total).
5. **Skills: two roots.** You install into `~/.eigen/skills`; the agent installs into `~/.eigen/sandbox/skills`;
   the agent sees the sum. All the agent's file/curl/npx work happens in the sandbox.
6. **Computer use later:** sandbox provider stays behind `workspace.ts`.

Design choices made from your feedback (change at approval if wrong):
- `~/.eigen/memory` is written only by the nightly curator job and by you; no agent tool can reach it
  (instant "remember this" goes through Mastra working memory).
- A skill name already in `~/.eigen/skills` blocks an agent install of the same name (yours wins).

Defaults assumed: keep both model entries from v0 (Ollama `local` default, Anthropic `cloud`); tag
`legacy-v0` before deleting; Ollama embeddings (fastembed as the alternative); Observational Memory off in
v1 (revisit once the md layer exists); Studio bundled in the production build (localhost only).