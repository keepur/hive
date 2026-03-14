# Hive — Claude Code Instructions

## Development Process

All repos under **[dodi-hq](https://github.com/dodi-hq)** use the same plugin-driven workflow via the `dodi-dev` plugin (`dodi-hq/dodi-skills`).

### Workflow

| Step | Skill | What Happens |
|------|-------|-------------|
| 1 | `dodi-dev:brainstorm` | Explore intent, constraints, approaches → write design spec |
| 2 | `dodi-dev:file-ticket` | Create tracker ticket with context from design session |
| 3 | `dodi-dev:pickup` | Take a ticket, create isolated worktree |
| 4 | `dodi-dev:write-plan` | Step-by-step implementation plan |
| 5 | `dodi-dev:implement` | Execute plan — subagent per task, tests along the way, commits as you go |
| 6 | `/quality-gate` | Repo-specific: typecheck + lint + format + test (stops on failure) |
| 7 | `dodi-dev:review` | Agent code review: spec compliance, quality, security, regression risk |
| 8 | `dodi-dev:submit` | Create PR → wait for CI → merge when green → cleanup |

`dodi-dev:verify` is active throughout — enforces "evidence before claims" at every step.

**Skip steps 1-2** for trivial fixes (typos, one-liners, obvious config changes). **Skip step 4** if the change is small enough to implement directly.

### Specs and Plans

- Design specs: `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: `docs/plans/YYYY-MM-DD-<feature-name>.md`
- Read relevant specs before modifying related code

### PR & Merge

- All changes go through PRs into `main`
- `npm run check` must pass before submitting
- Deploy: `/deploy` pushes `main` → `deploy` with pre-flight checks

## Project Overview

- TypeScript, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Slack Socket Mode + Web API
- Runtime: Node 24 on Mac Mini, runs as launchd service (`com.dodi.hive`)
- Config: `hive.yaml` (instance config, gitignored) + `.env` (secrets, gitignored)
- Agents: `agents/` (gitignored, per-instance) generated from `agents-templates/` via `npm run setup:agents`
- Plugins: `plugins/<name>/` — business-specific MCP servers + agent templates (e.g., `plugins/dodi/`)

## Architecture

```
Message (Slack/SMS/WebSocket/Scheduler)
  → Channel Adapter (slack, sms, ws)
  → Dispatcher (routing, dedup, status interception)
  → Triage (fast Haiku for simple queries, interactive channels only)
  → Model Router (Haiku/Sonnet classification, respects agent ceiling)
  → Agent Manager (concurrency limits, per-thread serialization)
  → Agent Runner (spawns Claude session + MCP servers)
  → Response → Channel Adapter → delivery
```

### Key Files
- `src/index.ts` — entry point, wires all subsystems
- `src/config.ts` — loads env + hive.yaml into typed config
- `src/agents/agent-runner.ts` — spawns Claude sessions, assembles system prompts, configures MCP servers
- `src/agents/agent-manager.ts` — concurrency, thread queues, agent state
- `src/agents/agent-registry.ts` — loads agent definitions from `agents/`, applies MongoDB overrides
- `src/agents/session-store.ts` — manages agent session state in MongoDB
- `src/agents/triage.ts` — fast Haiku classifier (done/continue)
- `src/agents/model-router.ts` — complexity classifier for model selection
- `src/channels/dispatcher.ts` — main routing logic, agent resolution, retry queue
- `src/channels/slack-adapter.ts` — Slack events → WorkItems → delivery
- `src/channels/sms-adapter.ts` — SMS message adapter via Quo/OpenPhone
- `src/slack/slack-gateway.ts` — Socket Mode listener, message filtering

### MCP Servers (stdio subprocesses per agent session)
All in `src/` — each agent only gets servers listed in its `agent.yaml` `servers` field:
- `memory-mcp-server.ts` — read/write/list/history/rollback agent memory (MongoDB)
- `google-mcp-server.ts` — Gmail + Calendar via `gog` CLI
- `drive/drive-mcp-server.ts` — Google Drive via `gws` CLI
- `keychain-mcp-server.ts` — macOS Keychain read-only
- `contacts-mcp-server.ts` — contact lookups (MongoDB)
- `github/github-issues-mcp-server.ts` — GitHub Issues tracking via `gh` CLI
- `linear-mcp-server.ts` — Linear issue tracking (being removed)
- `search/crm-search-mcp-server.ts` — vector search over CRM data
- `search/product-search-mcp-server.ts` — vector search over product catalog
- `search/ops-search-mcp-server.ts` — vector search over ops data
- `tasks/task-mcp-server.ts` — dodi_v2 task CRUD
- `background/background-task-mcp-server.ts` — spawn detached long-running commands
- `recall/recall-mcp-server.ts` — meeting participation via Recall.ai
- `quo-mcp-server.ts` — SMS via Quo/OpenPhone
- `resend/resend-mcp-server.ts` — outbound email via Resend
- `callback-mcp-server.ts` — timer callbacks for delayed responses
- `admin-mcp-server.ts` — model/config overrides (authorized agents only)
- `clickup/clickup-mcp-server.ts` — ClickUp task management

Slack MCP uses the official Slack HTTP MCP server (`https://mcp.slack.com/mcp`), not a local stdio server.

### Plugin MCP Servers (`plugins/dodi/`)
- `dodi-ops-mcp-server.ts` — dodi_v2 REST API (persons, projects, designs, jobs, cases, comments, attachments, cutlists)
- `hubspot-crm-mcp-server.ts` — HubSpot CRM read/write
- `catalog-mcp-server.ts` — read-only product catalog access
- `permit-mcp-server.ts` — permit management

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit, test, commit, push
- **Deploy**: `~/services/hive` — separate clone, compiled JS, launchd points here
- **Deploy script**: `~/services/hive/deploy.sh` — pulls, builds, syncs agents, restarts. Supports `--rollback`.
- Editing source in dev does NOT affect the running service
- Service restart: `launchctl kickstart -k "gui/$(id -u)/com.dodi.hive"`

## Commands

```bash
npm run dev            # Development mode (tsx, live reload)
npm run build          # Compile TypeScript (core + plugins)
npm run setup:agents   # Regenerate agents/ from templates
npm run typecheck      # TypeScript strict check
npm run lint           # ESLint
npm run format         # Prettier
npm run test           # Vitest
npm run check          # All checks (typecheck + lint + format + test)
npm run embed:hubspot  # Run HubSpot → Qdrant embed pipeline
npm run embed:dodi     # Run dodi_v2 → Qdrant embed pipeline
```

## Agent Anatomy

```
agents-templates/<agent-id>/
├── agent.yaml            # name, model ceiling, channels, keywords, schedule, servers, budget
├── soul.md               # personality, voice, values
└── system-prompt.md.tpl  # role definition, guardrails, tool instructions (template variables)
```

**System prompt assembly order**: date/time → soul.md → system-prompt.md → constitution (shared/constitution.md) → agent memory

**Template variables**: `{{agent.name}}`, `{{business.name}}`, `{{#if condition}}`, `{{sms_channels}}`, etc. Rendered by `setup/generate-agents.ts`.

**Agent templates** (10 total):

| Template | Model | Role |
|----------|-------|------|
| chief-of-staff | Sonnet | Default agent, delegation, coordination |
| vp-engineering | Haiku | Code, builds, engineering backlog |
| devops | Sonnet | Deploy, CI, monitoring |
| product-manager | Haiku | Specs, user stories, backlog |
| marketing-manager | Sonnet | Lead gen, content, market research |
| customer-success | Sonnet | CRM, customer emails, follow-ups |
| executive-assistant | Haiku | Email, calendar, scheduling |
| product-specialist | Sonnet | Catalog, pricing, product knowledge |
| production-support | Sonnet | Jobs, orders, manufacturing ops |
| sdr | Haiku | Outbound outreach, lead qualification |

## Conventions

- **Logging**: `import { createLogger } from "./logging/logger.js"` → `const log = createLogger("module-name")`
- **Agent IDs**: lowercase with hyphens (`chief-of-staff`, not `chief_of_staff`)
- **MCP servers**: stdio subprocesses of agent sessions — each gets env vars (AGENT_ID, CHANNEL_ID, etc.)
- **Agent identity**: `soul.md` (personality) + `system-prompt.md` (role) + memory (MongoDB)
- **WorkItem**: channel-agnostic message abstraction (text, source, sender, thread, metadata)
- **Hot reload**: file watch on `agents/` (500ms debounce) + SIGUSR1 signal. No restart for agent config changes.
- **Error handling**: catch + log, don't rethrow unless critical. Exit code 1 with valid response = warning, response still delivered.
- **No `any`** without justification. Strict TypeScript.

## Security (DOD-212)

- **No shell execution**: Use `execFileSync(binary, argsArray)`, never `execSync(shellString)`
- **Agent permissions**: `bypassPermissions` + `disallowedTools` — MCP tools work, SDK built-ins (Bash, Read, Write, Edit, etc.) blocked. Do NOT use `dontAsk` mode — it blocks MCP tools too.
- **Background task API**: Bearer token auth on all endpoints (`BG_TASK_AUTH_TOKEN`)
- **Webhook secrets**: Recall webhooks use secret path token (`RECALL_WEBHOOK_SECRET`). Fail-closed if missing.
- **Per-agent MCP whitelist**: `servers` array in agent.yaml — agents only get servers they need
- **Log redaction**: No sensitive data in logs (no pairing codes, prompt previews, input previews, message text)

## Common Gotchas

- After editing MCP server source: must `npm run build` AND restart Hive (compiled JS in `dist/`)
- After editing agent templates: must run `npm run setup:agents` to regenerate `agents/`
- `hive.yaml` and `.env` are gitignored — exist separately in dev and deploy dirs
- Slack file downloads: auth header stripped on redirect — must follow redirects manually
- Thread deduplication: 60s window prevents double-processing
- Triage is disabled in threads (no context available for classification)
- Agent concurrency default: 3 threads. Excess messages deferred and retried on sweep.
- MongoDB collections: `memory`, `memory_versions`, `agent_sessions`, `model_overrides`, `agent_config_overrides`, `devices`, `agent_callbacks`, `contacts`, `prompt_overrides`, `schedule_overrides`
