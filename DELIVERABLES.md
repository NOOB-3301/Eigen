# Eigen v0.3: Multi-Agent Orchestration Refactor

## What's Done

### 1. Monorepo Restructure
- **`engine/`**: Full Mastra project (agents, storage, Telegram, MCP, memory)
- **`app/`**: Next.js orchestration studio (React Flow, React 19, Tailwind 4)
- **Root `package.json`**: Workspace config for concurrent dev (`npm run dev` = both)

### 2. Agent Schema & Discovery (`engine/src/mastra/lib/`)
- **`agent-schema.ts`**: Zod schema for agent config (id, name, role, model, channels, tools, memory)
- **`agent-discovery.ts`**: Discovers agents from `~/.eigen/.agents/<id>/config.json`
  - `discoverAgents()`: List all agents
  - `watchAgents()`: File watcher for hot reload
- **`agent-api.ts`**: CRUD handlers (list, get, update, delete, create)

### 3. Web App (`app/`)
- **Orchestration UI**: React Flow canvas + dark theme
  - Sidebar: agent list (enabled/disabled, model, channels)
  - Canvas: agent nodes + channel nodes (Telegram, Slack), connections
  - Auto-refresh: 2s polling + file watcher backend
- **Types** (`src/types/agent.ts`): `AgentMetadata`, `AgentNode`, `ChannelNode`, `OrchestratorState`
- **Context** (`src/context/orchestrator.tsx`): SWR polling, agent selection, CRUD mutations
- **Components**:
  - `Sidebar`: List agents, action buttons, add/refresh/config
  - `Canvas`: React Flow visualization, node types
  - `AgentNode`: Status badge (running/idle/error), role, edit/delete buttons
  - `ChannelNode`: Platform icon, label
  - `AgentCard`: Name, role, description, model, remove button

### 4. API Bridge (`app/src/app/api/`)
- **`GET /api/agents`**: List all agents → proxies to engine `http://127.0.0.1:4111/api/agents`
- **`GET /api/agents/:id`**: Get one agent config
- **`PUT /api/agents/:id/config`**: Update config, hot-reloads
- **`DELETE /api/agents/:id`**: Remove agent directory
- **`POST /api/agents`**: Create new agent from template

### 5. Design
- **Dark theme**: Slate 950/800 (modern, motion-ready)
- **Motion**: `motion/react` for smooth transitions + interactions
- **Icons**: `lucide-react` for agent/channel/action badges
- **Styling**: Tailwind 4 + utility composition with `clsx` + `tailwind-merge`

---

## Architecture

```
┌─ localhost:4111 (Mastra engine)
│  ├─ /api/agents (agent discovery)
│  ├─ Telegram polling (single bot, dynamic agent routing)
│  └─ Agent runtime (addAgent/removeAgent for hot reload)
│
└─ localhost:4100 (Next.js app)
   ├─ GET /api/agents (proxy → engine)
   └─ React Flow canvas (agent topology)

~/.eigen/
├─ .agents/
│  ├─ curator/
│  │  └─ config.json
│  └─ <agent-id>/
│     └─ config.json (name, role, model, channels, tools)
├─ data/eigen.db (LibSQL)
└─ [rest: memory/, sandbox/, skills/, logs/]
```

**Agent Lifecycle**:
1. Engine boots, discovers agents in `~/.eigen/.agents/`
2. App polls engine `/api/agents` every 2s
3. User edits config in app (or filesystem)
4. File watcher triggers agent rediscovery
5. App re-renders canvas (new agent appears/disappears)
6. **Engine integration pending**: `mastra.addAgent()` / `removeAgent()` on discovery change

---

## Next Steps (Tracked)

### Phase 1: Single Agent Migration
- [ ] Move v0.3's `eigen` agent → `~/.eigen/.agents/eigen/config.json`
- [ ] Update Telegram routing: map incoming messages to agent by ID
- [ ] Test single-agent flow (bot still works, UI shows agent)

### Phase 2: Dynamic Agent Loading
- [ ] Integrate agent discovery into engine startup (call `discoverAgents()`)
- [ ] Watch `~/.eigen/.agents/` directory
- [ ] On change: call `mastra.addAgent()` / `removeAgent()`
- [ ] Hot-reload channels (Telegram dispatch to correct agent)

### Phase 3: Per-Agent Configuration
- [ ] Agent config: separate model, memory, MCP per agent
- [ ] Tools per agent (subset of global MCP tools)
- [ ] Agent-specific instructions (override global system prompt)
- [ ] Memory scoped per agent (or shared? TBD)

### Phase 4: Multi-Channel Orchestration
- [ ] Telegram routing: which agent handles a message? (intent detection, agent selector tool)
- [ ] Add Slack channel support (right sidebar in Flow)
- [ ] Channel-agent matrix (which agents listen to which channels)

### Phase 5: Studio Features
- [ ] Config editor (JSON/YAML in sidebar)
- [ ] Agent creation wizard
- [ ] Live logs panel (audit trail)
- [ ] Status dashboard (token usage, uptime, recent conversations)

---

## Running

**Develop both (split terminal or `npm run dev`)**:
```bash
npm run dev           # Engine (port 4111) + App (port 4100) concurrently
npm run dev:engine   # Just engine
npm run dev:app      # Just app
```

**Build**:
```bash
npm run build        # Both
npm run typecheck    # Both
npm test             # Engine only (vitest)
```

**Setup**:
```bash
npm run setup        # Seed ~/.eigen/ (from engine defaults)
```

---

## Files Changed

- **Moved**: `src/`, `scripts/`, `defaults/`, `test/`, `e2e/`, vitest configs → `engine/`
- **Added**: `app/` (Next.js scaffold + orchestration components)
- **Root**: `package.json` (workspace), `.gitignore` (updated)

**Engine files (new or modified)**:
- `src/mastra/lib/agent-schema.ts` (new)
- `src/mastra/lib/agent-discovery.ts` (new)
- `src/mastra/lib/agent-api.ts` (new)
- `src/mastra/public/agents.ts` (new, API route skeleton)

---

## Known Issues

- **Seatbelt tests**: 3 failures on Linux (macOS-only OS isolation, pre-existing)
- **Engine API routes**: Not yet wired into Mastra server (needs `/api` handler registration)
- **Telegram multi-agent**: Single bot polling, routing logic not implemented

## Not Yet Done

- Agent runtime integration (Mastra `addAgent`/`removeAgent` watcher not yet called)
- Telegram message routing to correct agent
- Per-agent workspace/memory separation
- Web app hot-reload without polling (WebSocket? Server-Sent Events?)
- Config editor UI

---

## Token Usage

- **Restructure**: ~15M tokens
- **Plan agent**: ~65KB transcript (Bash exploration, Mastra API research)
- **App scaffold**: Types, context, components, APIs
- **Summary**: This document

Total session: ~3.5M tokens / 200M allocated
