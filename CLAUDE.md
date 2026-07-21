# Hive — Claude Code Instructions

## Development Process

> Hive is source-available under FSL-1.1-ALv2 (Functional Source License, Apache-2.0 Future License — each version converts to Apache-2.0 two years after release). External contributors should follow standard GitHub flow: fork, branch, PR. The workflow below is the maintainers' (Keepur Co.) internal flow using the [dodi-dev](https://github.com/dodi-hq/dodi-skills) plugin — useful context for AI sessions running this repo on a maintainer's machine, but not a requirement.

### Workflow (maintainers)

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

Design specs and implementation plans live in the **private** companion repo `keepur/hive-docs` under `internal/specs/` and `internal/plans/`. The public repo keeps only the **epic-workflow** specs and plans — under `docs/epics/<epic>/`, where each epic directory carries its children's specs and plans — plus public-facing engine docs under `keepur/hive/docs/`. (Standalone design specs and plans that previously lived under `docs/specs/` and `docs/plans/` were relocated to `keepur/hive-docs/internal/`; those public directories are no longer the home for design artifacts.)

### PR & Merge

- All changes go through PRs into `main`. `main` is `enforce_admins: true` + `required_linear_history: true` — no direct pushes, no merge commits (squash or rebase only).
- `npm run check` must pass before submitting.
- **CI**: GitHub Actions runs `npm run check` on every PR and push to `main` (self-hosted ARM64 runner on Mac Mini).

### Releases

`main` is locked, so the `npm version` flow that auto-pushes a tag won't work. Use:

1. `git checkout -b release/vX.Y.Z`
2. `npm version --no-git-tag-version <patch|minor|major>`
3. Stage + commit `package.json` + `package-lock.json`, push the branch, open a PR.
4. After CI green and merge: `git checkout main && git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z`
5. The tag push fires the publish workflow; it verifies `package.json` matches the tag, runs full CI, publishes `@keepur/hive` to npm.

## Project Overview

- TypeScript, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Slack Socket Mode + Web API
- Runtime: Node 22+ on Mac (Apple Silicon recommended), runs as a per-instance launchd service (`com.hive.<instance-id>.agent`)
- Config: `hive.yaml` (instance config, gitignored) + `.env` (secrets, gitignored), both per-instance under `~/services/hive/<id>/`
- Agents: stored in MongoDB (`agent_definitions` collection), managed via admin MCP tools or REST API
- Plugins: separately-published npm packages (`@keepur/hive-plugin-<name>`) installed via `hive plugin add`. Each plugin ships MCP servers + agent seeds for a specific business domain. Internal-only plugins (e.g. CRM integrations specific to one business) can live in private repos. The OSS engine repo carries no business-specific plugins.

## Architecture

```
Message (Slack/SMS/WebSocket/Scheduler)
  → Channel Adapter (slack, sms, ws)
  → Dispatcher (routing, dedup, status interception)
  → Model Router (effort-only classifier — every turn runs the agent's static model, KPR-338)
  → Agent Manager (spawn coordinator: per-thread lock + per-agent budget)
  → Agent Runner (spawns Claude session + MCP servers)
  → Response → Channel Adapter → delivery
```

### Key Files
- `src/index.ts` — entry point, wires all subsystems
- `src/config.ts` — loads env + hive.yaml into typed config
- `src/agents/agent-runner.ts` — per-spawn `AgentRunner` (fresh instance per turn); assembles system prompts, configures MCP servers, builds per-spawn hooks with current `WorkItemContext`
- `src/agents/agent-manager.ts` — spawn coordinator: per-thread lock + per-agent budget, ticket lifecycle, reflection scheduler, snapshot surface
- `src/agents/spawn-coordinator-heartbeat.ts` — 30s heartbeat that writes `getSnapshot()` to `db.telemetry` (`kind=spawn_coordinator_stats`) per agent
- `src/agents/provider-circuit-breaker.ts` — per-provider circuit breaker + Open-Circuit Contract (`ProviderCircuitOpenError`, snapshot API); heartbeated by `src/agents/circuit-breaker-heartbeat.ts` (`kind=circuit_breaker_stats`)
- `src/agents/agent-registry.ts` — loads agent definitions from MongoDB
- `src/agents/session-store.ts` — manages agent session state in MongoDB
- `src/agents/model-router.ts` — per-turn effort classifier (KPR-338: models are static per agent; the classifier tunes reasoning effort only)
- `src/channels/dispatcher.ts` — main routing logic, agent resolution, retry queue
- `src/channels/slack-adapter.ts` — Slack events → WorkItems → delivery
- `src/channels/sms-adapter.ts` — SMS message adapter via Quo/OpenPhone
- `src/slack/slack-gateway.ts` — Socket Mode listener, message filtering

### MCP Servers (in-process by default; stdio for tier-3)

**KPR-122**: engine-internal Mongo-backed MCPs are **in-process** SDK servers (`createSdkMcpServer`) — they share the engine's MongoClient pool, eliminating per-turn TIME_WAIT churn from stdio subprocess spawn/exit. Per-call context (`AGENT_ID` is constructor-stable; `CHANNEL_ID`/`THREAD_ID`/`WorkItemContext` metadata for context-sensitive servers) is threaded into tool handlers via a mutable `*ContextRef` the runner updates each turn before `query()`. **Crash isolation trade-off**: every in-process tool handler is wrapped in try/catch returning a structured error response, so a handler exception never crashes the hive — the SDK loop survives and the agent sees the error. If instability surfaces, individual MCPs can selectively revert to stdio. Stdio remains for tier-3 servers that require process boundaries (`code-task`, `background`, `keychain`) and tier-2 vendor-API stdio servers (`slack` local, `quo`, `resend`, `linear`, `github-issues`, `clickup`, `recall`, `google`, `voice`, `tasks`, `brave-search`, `browser`).

All in `src/` — each agent only gets servers listed in its `coreServers`/`delegateServers` fields in the agent definition:
- `memory-mcp-server.ts` — Anthropic native memory-tool six-command surface (view/create/str_replace/insert/delete/rename) over a `/memories` virtual mount, plus `memory_history`/`memory_rollback` extensions (MongoDB) [in-process]
- `google/google-mcp-server.ts` — Gmail + Calendar + Drive via `gog` CLI
- `keychain-mcp-server.ts` — macOS Keychain read-only
- `contacts-mcp-server.ts` — contact lookups (MongoDB) [in-process]
- `github/github-issues-mcp-server.ts` — GitHub Issues tracking via `gh` CLI
- `linear/linear-mcp-server.ts` — Linear issue tracking
- `search/crm-search-mcp-server.ts` — vector search over CRM data
- `search/product-search-mcp-server.ts` — vector search over product catalog
- `search/ops-search-mcp-server.ts` — vector search over ops data
- `search/conversation-search-mcp-server.ts` — semantic search over past conversations
- `tasks/task-mcp-server.ts` — generic task CRUD (used by agents to track work items)
- `background/background-task-mcp-server.ts` — spawn detached long-running commands
- `recall/recall-mcp-server.ts` — meeting participation via Recall.ai
- `quo-mcp-server.ts` — SMS via Quo/OpenPhone
- `resend/resend-mcp-server.ts` — outbound email via Resend
- `callback-mcp-server.ts` — timer callbacks for delayed responses [in-process]
- `admin-mcp-server.ts` — agent CRUD + version history, model overrides [in-process]
- `clickup/clickup-mcp-server.ts` — ClickUp task management
- `events/event-bus-mcp-server.ts` — cross-agent event bus (publish events, subscriber delivery) [in-process]
- `team/team-mcp-server.ts` — direct agent-to-agent messaging (auto-injected core server, no flag) [in-process]
- `schedule/schedule-mcp-server.ts` — self-service schedule management (cron) [in-process]
- `workflow/workflow-mcp-server.ts` — plan/task management (gated by `config.workflow.enabled`) [in-process]
- `code-index/code-search-mcp-server.ts` — semantic code search over file index [in-process]
- `code-task/code-task-mcp-server.ts` — delegate coding to Claude Code CLI sessions
- `memory/structured-memory-mcp-server.ts` — tiered memory with semantic recall (auto-paired with memory server) [in-process]

Slack MCP defaults to the official Slack HTTP MCP server (`https://mcp.slack.com/mcp`). The local-stdio implementation (`src/slack/slack-mcp-server.ts` — KPR-103) is opt-in via `slack.localMcpServer: true` in `hive.yaml`. Local stdio expects `chat:write.customize` on the bot token for identity-mode posts; if missing, the preflight warns (non-fatal) and posts silently fall back to plain bot identity.

Browser automation uses Playwright via CDP endpoint (`BROWSER_CDP_ENDPOINT` config) — not a local stdio server.

### Plugins

The OSS engine ships no business-specific plugins. Plugins are separately-published npm packages installed via `hive plugin add @keepur/hive-plugin-<name>`. Each plugin lives at `<instance>/plugins/<name>/` post-install and contains its own MCP servers + agent seeds + (optionally) operator skills.

**Manifest env vs. secret-env:** in `plugin.yaml`, list non-secret config (URLs without creds, flags, model names) under `env:` — pass-through from `process.env` only. List credentials (API keys, tokens, credentialed URIs) under `secret-env:` — resolved via `process.env` first, then macOS Keychain (Honeypot: `hive/<instanceId>/<KEY>`). Introspection and runtime injection agree: a `secret-env` var seeded only in Honeypot still works.

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit source, test, commit, push. Repo layout unchanged from 0.1.x.
- **Deploy**: `~/services/hive/<instance>/` — instance dir. Engine lives in `<instance>/.hive/` (wipe-and-replace on upgrade). Instance config, agent data, logs at instance root (survive upgrades).
- **Upgrade**: `hive update [--tag=X]` runs `deploy.sh`, which fetches the npm tarball and swaps `.hive/`. `hive rollback` restores `.hive.prev/`.
- **Deploy script location**: `<instance>/.hive/service/deploy.sh` (engine-shipped, not in the repo root at runtime).
- **CI runner**: self-hosted ARM64 runner on Mac Mini, unchanged.
- **Restart**: `launchctl kickstart -k gui/$(id -u)/<label>` — still the primitive for picking up engine or config changes.

## Commands

```bash
npm run dev            # Development mode (tsx, live reload)
npm run build          # Compile TypeScript (core + plugins)
npm run setup:seeds    # Import plugin agent seeds → MongoDB
npm run setup:constitution  # Render constitution template → MongoDB
npm run setup:plugins  # Sync Claude Code plugins from cache
npm run migrate:agents:legacy  # One-time migration from files to DB (legacy)
npm run typecheck      # TypeScript strict check
npm run lint           # ESLint
npm run format         # Prettier
npm run test           # Vitest
npm run check          # All checks (typecheck + lint + format + test)
npm run bundle         # Stage 2: esbuild → pkg/ (publish-ready); runs check:bundle gates

# Late-binding credentials (Honeypot, post-bootstrap)
hive credentials list           # Show curated keys + which are set
hive credentials add <KEY>      # Set or rotate one (uses curated registry)
hive credentials remove <KEY>   # Delete one

# Skill registry management
hive registry add               # Add a skill registry (Keepur, third-party, or local file)
hive registry list              # List configured registries
hive registry remove            # Remove a registry
```

## Agent Anatomy

Agent definitions live in MongoDB (`agent_definitions` collection). Each agent is a single document containing all fields: config (model, channels, servers, schedule, budget), soul (personality/voice), systemPrompt (role/guardrails), and delegatePrompts.

**System prompt assembly order**: soul → systemPrompt → constitution (shared/constitution.md) → team summary (KPR-139 — live roster from team-roster cache) → toolkit (KPR-87 — runtime tool inventory) → agent memory → date/time. Date/time goes last so the static prefix stays prompt-cache-friendly.

Admin MCP tools or the REST API manage agent CRUD. The engine ships one baseline seed at `seeds/chief-of-staff/` (installed during `hive init`). Plugins can ship additional agent seeds; `hive plugin add` runs the seed import (skips if an agent with the same id already exists in the DB). Version history is tracked in `agent_definition_versions`.

**`delegateServers` constraint (KPR-184):** the 10 KPR-122-ported MCPs (`memory`, `structured-memory`, `event-bus`, `callback`, `contacts`, `schedule`, `team`, `admin`, `code-search`, `workflow`) cannot appear in `delegateServers`. They're in-process post-KPR-122 and the SDK's `AgentDefinition.mcpServers` type doesn't accept in-process configs. Use `coreServers` instead. The admin tool (`agent_create` / `agent_update`) rejects malformed inputs; the registry sanitizes pre-existing data at load time and logs an error so the operator can clean up via `admin_agent_update`. Constant lives at `src/agents/in-process-servers.ts`.

## Conventions

- **Logging**: `import { createLogger } from "./logging/logger.js"` → `const log = createLogger("module-name")`
- **Agent IDs**: lowercase with hyphens (`chief-of-staff`, not `chief_of_staff`)
- **MCP servers**: in-process SDK servers (`createSdkMcpServer`) for engine Mongo-backed servers — share the engine's MongoClient pool; per-turn context flows through mutable `*ContextRef` updated by `AgentRunner.send()`. Stdio subprocesses remain for tier-3 (`code-task`, `background`, `keychain`) and vendor-API integrations.
- **Agent identity**: soul (personality) + systemPrompt (role) + memory (MongoDB) — all stored in `agent_definitions` collection
- **WorkItem**: channel-agnostic message abstraction (text, source, sender, thread, metadata)
- **Hot reload**: SIGUSR1 signal reloads agent definitions from MongoDB. No restart for agent config changes.
- **Error handling**: catch + log, don't rethrow unless critical. Exit code 1 with valid response = warning, response still delivered.
- **No `any`** without justification. Strict TypeScript.

## Security (DOD-212)

**Posture: agents are employees, not hangout partners you met at an overnight party.** Everything that runs on a hive — plugins, skills, MCP servers, agent seeds — is assumed to have access to sensitive business operations and (under the Honeypot + Keychain model) the legitimate path to credentials. There is no "trusted enough to try, too harmless to worry about." If it runs, it's an employee, and employees come through curated channels.

- **Curated distribution is the paved path.** Both plugins and skills are installed from registries (Keepur-hosted default, third-party registries configurable, local registry files supported). Raw git URL or raw file install exists only as a developer-mode escape hatch and is not how production hives get code. If you find yourself designing something where the user "just drops in a skill from a GitHub gist," stop — that's outside the framework. The full plugin-architecture contract lives in `keepur/hive-docs/internal/specs/` (private companion repo).
- **Credentials are never in cloud-model-facing context.** Honeypot is the live mechanism (KPR-73 — `hive credentials add/list/remove`, bootstrap collects third-party keys into Keychain). `secret-env` vars resolve from Keychain (`hive/<instanceId>/<KEY>`) at MCP server spawn, falling back to `process.env`. Cloud-model agents have no Keychain read entitlement; they invoke *capabilities*, never hold secrets. Do not add agent-visible paths that would let filesystem Read tools exfil `.env`.
- **Plugins carry more risk than skills.** A plugin ships an MCP server, and the MCP server is the legitimate credential holder. A malicious plugin can exfil secrets directly. A malicious skill can cause business-operational harm but cannot reach credentials under the architectural model. Registry curation matters more for plugins than for skills — not less.
- **No shell-string subprocess invocation**: pass argv as an array (`execFileSync(binary, [args])` / `spawnSync(binary, [args])`), never as a shell string. Prevents command injection from interpolated input.
- **Agent permissions**: `bypassPermissions` mode — all SDK tools (Bash, Read, Write, Edit, etc.) and MCP tools available to all agents. Per-agent guardrails are enforced via system prompts, not tool blocking.
- **Background task API**: Bearer token auth on all endpoints (`BG_TASK_AUTH_TOKEN`)
- **Webhook secrets**: Recall webhooks use secret path token (`RECALL_WEBHOOK_SECRET`). Fail-closed if missing.
- **Per-agent MCP whitelist**: `coreServers`/`delegateServers` arrays in agent definition — agents only get servers they need
- **Log redaction**: No sensitive data in logs (no pairing codes, prompt previews, input previews, message text)

## Skills distribution (KPR-82)

Customer-space skills (`<hiveHome>/skills/`) are kept in sync across an operator's hive instances by pulling from a single git repo declared in `hive.yaml`:

```yaml
operatorSkillsRepo:
  url: https://github.com/<operator>/<repo>
  branch: main   # optional, default: main
```

The operator repo has the same shape as a skill registry — a flat `skills/<skill-name>/` layout. Run `hive skill sync` to install/upgrade all skills from the repo into customer space; `hive update` runs sync automatically after a successful engine upgrade.

**Customer-modified skills are never overwritten.** If `origin.modified` is true on a local skill, sync skips it and reports the divergence.

**Authoring flow (until publish-back ships):** author or edit a skill on any instance, then commit it to the operator repo manually. Other instances pick it up on next `hive skill sync` (or next `hive update`).

## Skills layout (KPR-214)

Skills follow the SDK convention exactly — one directory level, no workflow grouping:

```
<root>/skills/<skill-name>/SKILL.md      ← canonical (KPR-214 onward)
<root>/skills/<workflow>/skills/<skill-name>/SKILL.md   ← legacy, still loadable, deprecation warning
```

Where `<root>` is one of: a seed directory (e.g. `seeds/chief-of-staff/`), a plugin directory (`<instance>/plugins/<name>/`), the customer space (`<hiveHome>/`), or an agent-private space (`<hiveHome>/agents/<id>/`). The same flat shape applies to all four.

**Why flat:** the SDK's plugin convention is `<plugin>/skills/<skill>/SKILL.md`. Hive's older double-`skills/` layout was an internal organizational sugar that diverged from SDK shape. Flat = a vanilla Claude Code skill drops into hive unchanged.

**Per-skill `agents:` scoping** is preserved as an SDK-compatible extension. The loader reads frontmatter `agents: [milo, river]` (or `agents: [all]`) and projects each scoped flat skill into a synthetic plugin tree under `<hiveHome>/.skill-projections/` (a symlink to the real skill dir, rebuilt every load). The SDK only sees skills the agent is scoped to.

**Migration:** `npx tsx scripts/flatten-skills.ts <root> [--dry]` lifts each `<root>/skills/<workflow>/skills/<skill>/SKILL.md` to `<root>/skills/<skill>/SKILL.md`. Idempotent. Engine seeds and in-repo plugins are already migrated; operator-skills repos (dodi, keepur) migrate under [KPR-215](https://linear.app/keepur/issue/KPR-215). The loader supports both layouts during the transition window, with a deprecation warning per source the first time legacy layout is detected.

## Spawn coordinator (KPR-220)

Per-turn `query()` with `options.resume = sessionId` is the **only** execution path post-KPR-220. The long-lived per-agent `query()` loop (`AgentRunner.send()` driven by `AgentManager.sendMessage`) is gone; every channel (Slack, SMS, WS, voice, scheduler) routes through `AgentManager.runWorkItemTurn(agentId, item)` which builds a `TurnContext` and calls `spawnTurn(ctx)`. Voice keeps a direct `spawnTurn` call so it can pass its own `systemPromptOverride`.

`AgentManager` is a thin spawn coordinator: per-thread lock (`agentId:threadId`), per-agent in-flight budget, ticket lifecycle for abort/stop, post-quiescence reflection scheduler, and the `getSnapshot()` observability surface. There is no longer any per-channel opt-in flag, no per-agent queue, no `AgentRunner` reuse.

**Budget:** per-agent `spawnBudget` field on the agent definition; falls back to legacy `maxConcurrent`, then the engine default (5). `maxConcurrent` is **deprecated** for spawn-coordinator purposes — set `spawnBudget` on new agents. Source of the resolved budget is surfaced in `hive doctor` ("Spawn coordinator" section) as `source=spawnBudget|maxConcurrent|default`.

**Reflection:** triggered by post-quiescence debounce (30s after the last non-reflection turn) instead of the legacy queue-drain trigger. `memory.reflectionMinTurns <= 0` disables reflection entirely (queue-drain semantics treated zero as "fire every turn" which was a bug under the new debounce model).

**Observability:** `getSnapshot()` returns per-agent `{ activeSpawns, activeThreadKeys, budget, budgetSource, saturationCount, lastSaturationAt, lastSpawnAt, lastError, stopped }`. `SpawnCoordinatorHeartbeat` upserts per-agent docs to `db.telemetry` (`kind=spawn_coordinator_stats`) every 30s; the doctor reads them.

**Migration notes:**
- `agentManager.perTurnSpawn.{sms,slack,ws,voice}` config keys are removed. Hive.yaml loader silently ignores them (KPR-225 F3 liberal-loader pattern), but they have no effect.
- `maxConcurrent` is deprecated in favor of `spawnBudget`. Existing agent definitions keep working via the fallback chain; `hive doctor` flags the fallback source so operators can migrate.
- Reflection trigger changed from queue-drain to post-quiescence debounce; tuning lives on `memory.reflectionMinTurns` + the 30s debounce constant.

## Provider adapters

Agents can run on providers other than Claude. The agent's `model` field selects the provider via `resolveProviderModel` (`src/agents/agent-manager.ts`): a bare model id (no `/`) routes to **Claude** (the default); a `<provider>/<model>[:<reasoningEffort>]` prefix routes elsewhere — `openai`, `gemini`/`google-gemini`, or `codex`/`openai-codex`. Unknown prefixes fall back to Claude. The optional `:effort` suffix (`minimal`|`none`|`low`|`medium`|`high`|`xhigh`) applies to codex/openai.

`AgentManager.createProviderAdapter()` builds the adapter per spawn:

- **`ClaudeAgentAdapter`** — the default, full-featured path: wraps `AgentRunner`, so it gets the whole hive runtime (MCP tools, skills, memory, hooks).
- **`CodexSubscriptionAdapter` / `OpenAIAgentsAdapter` / `GeminiAdkAdapter`** — **pilot** adapters (`src/agents/provider-adapters/`, KPR-231–234). Each spawn receives a `ProviderTurnAssembly` built by `assembleProviderTurn` (`provider-adapters/turn-assembly.ts`, KPR-347): assembled instructions (soul + systemPrompt via the relocated `buildPilotInstructions`), the real partitioned tool inventory, a session-semantics descriptor, and a fail-closed guardrail gate. The pilots still **advertise zero tools** to their providers — tool execution arrives with the KPR-348 bridge — and assembly faults classify `non-provider` (`TurnAssemblyError`), never tripping a provider breaker. Models default from `config.{codex,openai,gemini}.agentModel`; credentials resolve via `oauth-credentials.ts` (e.g. Codex subscription auth).

All adapters implement the `AgentProviderAdapter` contract (`provider`, `runTurn()`, `abort()`, `wasAborted` — `src/agents/provider-adapters/types.ts`). `tool-transport.ts` classifies each hive tool's transport and cross-provider compatibility (`direct` | `mcp-bridge-candidate` | `requires-hive-bridge` | `claude-only` | `unsupported`) — the boundary governing which tools a non-Claude adapter can eventually carry. Design specs live in `keepur/hive-docs/internal/specs/` (KPR-231–234).

## Common Gotchas

- After editing MCP server source: `npm run build` (tsc → `dist/`) for dev, or `npm run bundle` (esbuild → `pkg/`) for the publish-ready artifact. The runtime engine in `<instance>/.hive/` runs from `pkg/server.min.js`. Restart Hive (`launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent`) to pick up changes — or for agent-definition changes only, send `SIGUSR1` (no restart).
- Agent definitions are DB-native — edit via admin MCP tools or REST API, changes take effect on next SIGUSR1 reload
- **Prefix cache (KPR-213):** assembled system-prompt prefixes are cached in-memory per agent and **invalidated automatically** on every write path that affects them — agent-def updates, memory writes (FS-style and structured-tier), constitution edits, team-roster changes, skill changes. SIGUSR1 still flushes the cache + reloads the registry, but it is **no longer load-bearing for prefix freshness** — it stays as an explicit operator escape hatch. Cache stats are heartbeated to `db.telemetry` (kind=`prefix_cache_stats`) every 30s and surfaced via `hive doctor`.
- `hive.yaml` and `.env` are gitignored — exist separately in dev and deploy dirs
- Slack file downloads: auth header stripped on redirect — must follow redirects manually
- Thread deduplication: 60s window prevents double-processing
- Spawn budget default: 5 in-flight per agent (per-agent, not per-thread). Same-thread spawns serialize via the per-thread lock; budget bounds parallel spawns across different threads.
- **Provider circuit breaker (KPR-306):** `spawnTurn` acquires a per-provider breaker permit before any model-router spend. Three consecutive hard provider faults (connect-fail/timeout/rate-limit/auth/5xx — typed classifier at `src/agents/provider-adapters/error-classification.ts`) or a p95 `llmMs` breach open the circuit; open turns fast-fail with the exported `ProviderCircuitOpenError` (Open-Circuit Contract — KPR-307 binds to it; frozen fields in `src/agents/provider-circuit-breaker.ts`). Half-open probes are real user turns (15s base cooldown, ×2 backoff, 60s cap). Tool/agent errors classify `non-provider` and never trip. Config: hive.yaml `circuitBreaker` (all keys optional; `enabled: false` = shadow mode — observe + telemetry, never fast-fail). State is in-memory (restart resets to closed); heartbeated to `db.telemetry` (`kind=circuit_breaker_stats`, per provider, 30s) and rendered as an informational `hive doctor` section (never flips the exit code).
- **Honest outage behavior (KPR-307):** while a provider circuit (KPR-306) is open, the dispatcher intercepts fast-fails and probe-failure turns: one plain-text notice per thread per outage episode (SMS/iMessage now send one honest text per episode **instead of silently skipping** — deliberate behavior change), and the turn persists to `outage_queue` for automatic replay (15s poller, oldest-first, 4h TTL, depth 500, 3 real attempts). Cron turns skip (they re-fire); callback/event/team one-shots queue silently. Voice speaks an honest outage sentence as a normal completion. Config: `outageQueue` section in hive.yaml (`enabled`, `replayIntervalMs`, `maxAgeHours`, `maxDepth`, `maxReplayAttempts`) — `enabled: false` reverts to raw error surfacing. The delivery retry queue (`src/sweeper/retry-queue.ts`) is a different mechanism (turn succeeded, delivery failed) and is unchanged. `hive doctor` shows an informational "Outage queue" section; status queries still work mid-outage (no model call).
- MongoDB collections (engine-written): `agent_definitions`, `agent_definition_versions`, `sessions` (per-thread session resume), `memory`, `memory_versions` (FS-style agent memory), `agent_memory`, `agent_memory_autodream_state` (structured/tiered memory), `contacts`, `crm_contacts`, `agent_callbacks`, `agent_events`, `team_channels`, `team_messages`, `team_pending_requests`, `workflow_plans`, `workflow_tasks`, `workflow_task_comments`, `code_index`, `activity_log`, `imessage_threads`, `agent_turn_telemetry`, `migrations`, `outage_queue` (honest-outage replay queue KPR-307 — fast-failed turns queued while a provider breaker is open; composite `(itemId, agentId)` key; replayed by a 15s poller), `instance_identity` (identity sentinel, KPR-294), `telemetry` (prefix-cache stats heartbeat KPR-213; spawn-coordinator stats heartbeat KPR-220; memory-lifecycle stats heartbeat `memory_lifecycle_stats` KPR-241 (per agent); circuit-breaker stats heartbeat `circuit_breaker_stats` KPR-306 (per provider); db-identity stats heartbeat `db_identity_stats` KPR-294; `agent_roster_stats` empty-roster guard KPR-295 — event-driven, `updatedAt` is not liveness)
- Legacy collections you may still see in older DBs — nothing in the engine reads or writes them: `model_overrides` (last referenced 2026-03-30, superseded by the admin MCP rewrite), `devices` (removed with the device registry in KPR-9), `agent_sessions` (never a real source name — the session collection has always been `sessions`). Safe to drop operationally.
- `HIVE_DB_SENTINEL_RESTAMP=1` re-stamps the DB identity sentinel for one boot (adopting another instance's DB); remove after use — it is honored every boot it is set
- **Empty-roster reload guard (KPR-295):** if an agent-definitions reload observes the collection at **zero docs after any non-empty load in this process's lifetime**, the reload is blocked as a **full no-op** — no roster mutation, no post-reload hooks, schedules/skills/plugins refresh all skipped — and the registry logs the alarm, marks `agent_roster_stats.degraded: true` in `db.telemetry`, and retries every 30s, auto-recovering (no operator ack) as soon as docs reappear. This is deliberate impostor/wipe protection: **runtime deletion of the entire roster is blocked by design and there is no bypass knob** — if you genuinely mean to run with an empty roster, restart the engine (a fresh process has no non-empty baseline and commits the empty set). A fresh-install empty boot, partial shrinkage, or all-agents-disabled all commit normally; only the →0 cliff blocks. `hive doctor`'s Datastore identity section surfaces the degraded state.
- **`hive doctor` Datastore identity section (KPR-296):** the first and only post-check doctor section that can **fail the doctor (exit 1)**. Fail conditions: **F1** identity sentinel present-but-mismatched (instanceId/dbName), **F2** roster guard degraded, **F3** engine identity monitor reporting non-verified on a fresh (≤120s) heartbeat — unknown monitor states fail closed. Everything else warns or informs: absent-sentinel-with-data is a **warn**, not a fail (upgrade window preserved); a temp-dir `dbPath` (`/tmp`, `/var/folders`) warns — the Jul-4 impostor signature. Remediations: intentional DB adoption → `HIVE_DB_SENTINEL_RESTAMP=1` for one boot; roster/state recovery after a DB restore → `SIGUSR1`. Every other doctor section remains informational — identity-class incidents flip the exit code, telemetry health never does.
- **Tool search / deferred MCP tool loading (KPR-329):** every Claude spawn pins `ENABLE_TOOL_SEARCH` explicitly — resolution: agent-definition `toolSearch` field → hive.yaml `toolSearch.mode` → engine default `auto`. `auto` = the CLI's token-threshold mode (defers MCP tool schemas only past ~10% of context — small agents see zero change); `on` = always defer; `off` = eager loading, exactly the pre-KPR-329 intended behavior. Rollback: set `toolSearch.mode: off` in hive.yaml + restart (per-agent: `admin_agent_update` + SIGUSR1, takes effect next spawn). Haiku models are excluded by the SDK (silently eager). Operators fronting a non-first-party `ANTHROPIC_BASE_URL` proxy should set `mode: off` — a proxy that strips `tool_reference` blocks degrades `on`/`auto` turns. Ambient `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` force-disables tool search inside the CLI (engine warns once per process).
- **Node 26 / undici (KPR-344):** hive's own `undici` is v8 — its `setGlobalDispatcher` writes both global symbols, so KPR-252 pooling works on Node 22/24/26. Never pass an undici Agent as a **per-request** `dispatcher` to the runtime's built-in `fetch` (no cross-major compat, both directions) — pair it with undici's own `fetch` import instead (see `src/beekeeper-client.ts`). `@qdrant/js-client-rest` is bundled (not external) with its internal v6 dispatcher stubbed to plain fetch by `build/bundle.ts` + guarded by `check-bundle-qdrant-stub.mjs`; **dev mode (tsx) keeps the upstream dispatcher and is broken on Node 26 — develop on Node 22/24.**
