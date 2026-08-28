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
- Plugins: separately-published npm packages (`@keepur/hive-plugin-<name>`) installed via `hive plugin add`. Each plugin ships MCP servers + agent seeds for a specific business domain (and, since KPR-394, optionally a Lane B provider adapter). Internal-only plugins (e.g. CRM integrations specific to one business) can live in private repos. The OSS engine repo carries no business-specific plugins.

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
- `src/channels/dispatcher.ts` — main routing logic, agent resolution, retry queue, honest-outage + deadline-continuation arms
- `src/channels/deadline-continuation.ts` — deadline-abort continuation chain: cap, notice templates, flat per-leg `#dl<n>` id derivation (KPR-402)
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
- `admin-mcp-server.ts` — agent CRUD + version history, agent model catalog (KPR-381) [in-process]
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

The OSS engine ships no business-specific plugins. Plugins are separately-published npm packages installed via `hive plugin add @keepur/hive-plugin-<name>`. Each plugin lives at `<instance>/plugins/<name>/` post-install and contains its own MCP servers + agent seeds + (optionally) operator skills. A plugin may also carry one `provider:` block in `plugin.yaml`, making a new `<id>/<model>` agent-model prefix routable — see **Provider plugins (KPR-394)** under Provider adapters.

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
npm run bundle         # Stage 2: esbuild → pkg/ (publish-ready) — build only, no gates
npm run check:bundle   # bundle + the 4 guards (strings, pack, runtime, qdrant-stub)

# Late-binding credentials (Honeypot, post-bootstrap)
hive credentials list           # Show curated keys + provider-plugin manifest keys + which are set
hive credentials add <KEY>      # Set or rotate one (curated registry + provider-plugin keys, KPR-394)
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

Agents can run on providers other than Claude. The agent's `model` field selects the provider via `resolveProviderModel` (`src/agents/agent-manager.ts`): a bare model id (no `/`) routes to **Claude** (the default); a `<provider>/<model>[:<reasoningEffort>]` prefix routes elsewhere — `openai`, `gemini`/`google-gemini`, `codex`/`openai-codex`, `grok` (KPR-371, natively on Lane B since KPR-392), the Lane A passthrough providers kimi/deepseek (KPR-346), or any provider id declared by an installed provider plugin (KPR-394 — see **Provider plugins** below). Unknown prefixes still fall back to Claude. The optional `:effort` suffix (`minimal`|`none`|`low`|`medium`|`high`|`xhigh`) is consumed by codex (`reasoning.effort` — also gates encrypted-reasoning replay), gemini (`thinking_level`, `none→minimal`/`xhigh→high` coerced), and grok (chat-completions `reasoning_effort`, delivered verbatim incl. `xhigh`, `minimal`/`none→low`), delivered clamped to `{low,medium,high}` on Lane A, and currently parsed-but-not-delivered on openai.

**Which model ids are valid (KPR-381):** the admin MCP's `agent_model_catalog_list` is the agent-facing answer — gemini resolved live from the vendor (`x-goog-api-key` header auth, ~10 min process-wide TTL cache in `src/admin/model-catalog-cache.ts`, no stale-cache fallback on failure), claude/grok/codex — and, since KPR-394, plugin-registered provider ids (via an injected `listPluginProviderIds`) — read from the curated `agent_model_catalog` collection. Gemini key resolution on the agent-provider path — the adapter and `agent_model_catalog_list` — uses the adapter's **literal** chain (`config.gemini.apiKey` → env `GOOGLE_GENAI_API_KEY` → `GEMINI_API_KEY` → `GOOGLE_API_KEY`, KPR-382); mirror that chain at any new provider-path site. The env fallbacks stay adapter-local — read from `process.env` at call time, never pushed into `config.ts`, never Keychain-resolved. The LLM sidecar (`src/llm/registry.ts`, and doctor's sidecar line) deliberately reads `config.gemini.apiKey` only — a separate, narrower surface, not a divergence to "fix." That catalog is operator/agent-maintained via `agent_model_catalog_refresh` (full replacement list per provider, no vendor calls of its own, appends to `agent_model_catalog_versions`) — an unseeded provider returns a prose "not yet seeded" note, not an error. Both tools live in `src/admin/admin-mcp-server.ts` and are unrelated to `src/llm/catalog.ts` (`LLM_CATALOG`), which serves the engine's own internal sidecar tasks.

`AgentManager.createProviderAdapter()` builds the adapter per spawn:

- **`ClaudeAgentAdapter`** — the default, full-featured path: wraps `AgentRunner`, so it gets the whole hive runtime (MCP tools, skills, memory, hooks).
- **`CodexSubscriptionAdapter` / `OpenAIAgentsAdapter` / `GeminiInteractionsAdapter` / `GrokAdapter`** — the Lane B native adapters (`src/agents/provider-adapters/`; born as tool-free pilots in KPR-231–234, full tool-executing surfaces since the KPR-345 epic). Each spawn receives a `ProviderTurnAssembly` built by `assembleProviderTurn` (`provider-adapters/turn-assembly.ts`, KPR-347): the real Lane B system prompt from `buildProviderInstructions` (via the runner's `buildProviderPrompt`, KPR-349) — the same shared section helpers the Claude lane composes (soul → archetype card → systemPrompt → constitution → team summary → toolkit → follow-through → memory/skills — the `TOOL_EXECUTING_PROVIDERS` gate completed and dissolved in KPR-352, so assembly now passes `toolsExecutable: true` unconditionally; the follow-through section (KPR-393, `followThroughSection()` in `prefix-builder.ts`) is a Lane B-only layer (alongside the skills section and the inventory-rendered provider toolkit — `buildPrefix` composes its own KPR-87 toolkit via `buildToolkitSection`, and never a skills section) — composed solely by `buildProviderInstructions` inside the toolsExecutable gate, never by the Claude lane's `buildPrefix`, whose golden bytes stay untouched) — the real partitioned tool inventory, and a fail-closed guardrail gate; a per-provider session-semantics descriptor (`SESSION_SEMANTICS`, `types.ts`) separately drives session persistence on both write and read sides. All four Lane B adapters **execute real hive tools** through the KPR-348 `ToolBridge` (openai via the Agents SDK loop; codex via a bounded Responses dispatch loop, KPR-353, with hive-persisted stateless-replay history in `provider_turn_history` — client-side replay incl. encrypted reasoning, `store: false` always; gemini via a bounded Interactions dispatch loop, KPR-352, on the codex-loop template; grok via a bounded chat-completions dispatch loop, KPR-392, on the same codex-loop template). OpenAI durable resume is `previous_response_id` chaining (KPR-350 ruling — Conversations API deliberately unused): the handle lives in `sessions` (7d idle TTL < 30d server retention) and is rewritten every turn, the adapter pins `store: true` + `truncation: "auto"` (Lane B's compaction analog), and a stale/expired handle self-heals via one manager-level fresh retry (`isStaleServerHandleError`, semantics-gated `server-resumable`, breaker-invisible, one exchange of context lost; ZDR orgs unsupported for chaining — parity-matrix caveat). Gemini durable resume is `previous_interaction_id` chaining (KPR-352 — handle in `sessions`, 7d idle TTL < 55d paid retention (1d free tier — self-heal degrades idle threads to daily fresh context), `store: true` pinned, stale/expired handles self-heal via the same semantics-gated `server-resumable` manager arm as openai; API-key auth only, no Vertex until Interactions ships there; `:effort` maps to `thinking_level` with `none→minimal`/`xhigh→high` coercion). Grok (`GrokAdapter`, KPR-392, direct-to-xAI since KPR-410) is `stateless-replay` like codex — chat-completions directly against `https://api.x.ai` (`grok-adapter.ts`), hive-persisted turn history in `provider_turn_history` (no encrypted reasoning — grok has none to replay), no in-adapter 4xx self-heal (a 4xx on hive-composed replay items is a real request-shape bug, not a backend quirk to mask); `:effort` delivers verbatim incl. `xhigh` with `minimal`/`none→low` (warn-once); the credential is an xAI subscription OAuth access token, resolved (and refreshed) per spawn from `~/.grok/auth.json` by `grok-oauth.ts` via the manager's own grok arm (`resolveGrokModuleSlice`, not the vendor-config chain the other three use); `costUsd` reports 0 with real token counts. Delegate subagents run on all four tool-executing surfaces (KPR-354): the bridge synthesizes one Claude-identical `Task` tool from the agent's `delegateServers`, and executing it runs a nested same-provider adapter turn (delegate prompt, that server + the six executor builtins, maxTurns 7/10 parity) through a manager-owned runner — budget-accounted against `spawnBudget` (delegates on Lane B need `spawnBudget ≥ 2`; default 5 is fine), lock-exempt, abort-chained, session-less/history-less (nested codex and grok get no historyStore), breaker-invisible (nested provider faults surface as Task tool text). General-purpose Task subagents (arbitrary `subagent_type`) remain claude-only. Assembly faults classify `non-provider` (`TurnAssemblyError`), never tripping a provider breaker. Models default from `config.{codex,openai,gemini,grok}.agentModel`. Auth: codex = subscription OAuth (`oauth-credentials.ts`, `~/.codex/auth.json`); openai = **API-key single path** (`OPENAI_API_KEY` — the codex-oauth fallback attempt was deleted in KPR-351: the subscription token authenticates the chatgpt.com backend only and 401s against api.openai.com Responses; a missing key fast-fails as an `auth`-classified error into the honest-outage path); gemini = API-key single path (KPR-352, Vertex deleted); grok = subscription OAuth single path (KPR-410 — hive itself holds and refreshes the `grok login` session via `~/.grok/auth.json`, same posture as codex). The codex surface is live-validated in production (KPR-351: keepur/Luna flagship arc — tools, stateless replay incl. encrypted reasoning, delegate Task turn, KPR-313 inverse transition).

**Shared Lane B implementation layer (KPR-391):** the four native adapters no longer hand-clone their scaffolding. `turn-scaffold.ts` (`LaneBTurnScaffold`) owns the per-turn lifecycle all four sit on — abort lifecycle, the #407 wall-clock deadline, ToolBridge construct/close, the try/catch/finally containment frame, the one-writer usage accumulator, and `RunResult` building (`llmMs = max(0, durationMs − toolMs)`); each adapter implements only `executeTurn(harness)`. `dispatch-loop.ts` (`runBoundedDispatchLoop`) is the shared bounded tool-dispatch loop for the raw-API adapters — **codex, gemini, and (since KPR-392) grok**; openai keeps the `@openai/agents` SDK loop and sits on the scaffold alone. `sse.ts` holds generic SSE framing (event splitting, field parsing, `[DONE]`) lifted out of codex, with provider-specific event interpretation staying in each adapter. Adapter construction for **both** `agent-manager.ts` sites (the top-level `createProviderAdapter` tail and the nested KPR-354 `delegateTurnRunner`) is now a single `LANE_B_PROVIDER_MODULES` table lookup (`provider-modules.ts`) instead of two hand-built switches, so model default chains, primary-only history wiring, and gemini/grok key threading cannot drift between them — grok proved the pattern (KPR-392: one module entry, `grok-adapter.ts`, no fifth clone). New in-engine Lane B providers add a module entry, not a clone; out-of-engine providers ship as provider plugins (KPR-394, below) — and since KPR-394 the `LANE_B_PROVIDER_MODULES` + `SESSION_SEMANTICS` tables double as the builtin seed for the runtime provider registry.

All adapters implement the `AgentProviderAdapter` contract (`provider`, `runTurn()`, `abort()`, `wasAborted` — `src/agents/provider-adapters/types.ts`). `tool-transport.ts` classifies each hive tool's transport and cross-provider compatibility (`direct` | `mcp-bridge-candidate` | `requires-hive-bridge` | `claude-only` | `unsupported`) — since KPR-348 this partition (`partitionInventoryForProvider`) drives each Lane B adapter's actual bridged tool inventory, with claude-only omissions logged, never silent. Since KPR-394 (R3) every compatibility record also carries a generic `laneB` column: built-in provider ids read their own column, plugin provider ids fall back to `laneB`, and a record with neither is honestly `unsupported` (`partitionInventoryForProvider` now takes `provider: string`). Design specs for the original pilots live in `keepur/hive-docs/internal/specs/` (KPR-231–234); the KPR-345 epic spec/plans live under `docs/epics/kpr-345/`. The public supported-provider parity matrix is `docs/providers.md` (KPR-355) — any future change touching provider behavior must update its rows.

**Provider plugins (KPR-394):** a plugin whose `plugin.yaml` carries a `provider:` block (`id`, `entry`, `abi`, `session-semantics`, optional `default-model`/`api-key-env`/`base-url-env`/`description`; at most one per plugin, v1) makes `<id>/<model>[:<effort>]` a routable agent model after `hive plugin add`'s restart. Plugin-author surface: the **types-only** subpath export `@keepur/hive/provider-abi` (`src/agents/provider-adapters/provider-abi.ts` — `LANE_B_PROVIDER_ABI_VERSION = 1`, an exact-integer handshake against the manifest's `abi:`; `LaneBProviderKit`; frozen re-exports of the KPR-391 layer; bundle ships **only the provider-abi transitive d.ts closure** under `pkg/types/` (KPR-407 — traced from `provider-abi.d.ts` over relative type edges, loud bundle failure on any unresolvable or dist-escaping edge, and `scripts/check-bundle-strings.mjs` scans the shipped d.ts for forbidden business strings alongside the minified bundles), package.json's first `exports` map). There is deliberately no runtime export — the engine injects its running scaffold/dispatch-loop/sse/logger into the plugin's `createProviderModule(kit)` factory by reference; a plugin never imports engine code. Manifest layer: `src/plugins/provider-decl.ts` (normalize/validate/read/audit — id regex, reserved builtin ids plus `constructor` (KPR-407 — the sole `Object.prototype` name the id regex admits; the two provider-keyed indexed lookups in `provider-registry.ts`/`tool-transport.ts` are independently hasOwnProperty-guarded, since plugin-controlled ids must never read the prototype chain), reserved credential keys derived from the curated registry so `api-key-env` can never name an engine credential; no adapter/runtime imports, so `hive plugin add`/`hive credentials`/`hive doctor` stay light). Runtime: `src/agents/provider-adapters/provider-registry.ts` — a module-global registry (resolveProviderModel is module-scope), two-phase boot load: synchronous declare in the AgentManager constructor (from the first instant a declared prefix routes to an honest `TurnAssemblyError`, never the Claude fallback), then async `agentManager.activateProviderPlugins()` awaited in `index.ts` immediately after manager construction, **before** `bgTaskManager.start()`/`scanOrphans()` (their callbacks can already dispatch turns). Any activation failure — ABI mismatch, invalid decl, builtin-id shadow, entry import/factory fault — lands the id **declared-broken**: per-turn honest failure naming the reason, never silent fallback. Boot-only: SIGUSR1 never loads/unloads provider code (it only re-runs the orphan-prefix warn); session semantics for a route come from the registry's `sessionSemanticsForRoute` (the builtin-only `sessionSemanticsFor` accessor is deleted — read `SESSION_SEMANTICS` directly for builtin-only facts); the manager resolves the manifest-named `api-key-env` (env → Honeypot) and `base-url-env` slices per spawn, handed to the module opaquely (C7). R2 widened provider-typed fields from `AgentProviderId` to `string` across the ops surfaces (adapter contract, circuit breaker, `TurnHistoryStore`, sessions/telemetry) — builtin adapters keep their literals. `hive credentials list/add` surfaces manifest-declared keys as dynamic entries alongside the curated registry (fail-soft pre-init), and `hive doctor` gains an informational "Provider plugins" section (static manifest audit + orphan-model scan — an agent `model` prefix no builtin route or installed plugin claims warns, since it silently routes to Claude under the unknown-prefix canon). Spec: `docs/epics/kpr-385/kpr-394-spec.md`.

**Lane A passthrough (KPR-346):** `kimi/…` and `deepseek/…` route through the full Claude runtime (`ClaudeAgentAdapter`/`AgentRunner` — MCP tools, skills, hooks, memory, resume) with per-spawn env substitution: provider base URL + Honeypot-resolved key (`KIMI_API_KEY`/`DEEPSEEK_API_KEY`, per-spawn env→Keychain — `hive credentials add` takes effect next spawn), foreign-model pins incl. subagents, `ENABLE_TOOL_SEARCH` forced off. Table: `src/agents/provider-adapters/passthrough-providers.ts` (defaults `kimi-k3` / `deepseek-v4-pro`, overridable via `KIMI_AGENT_MODEL`/`DEEPSEEK_AGENT_MODEL`). Missing credential ⇒ `TurnAssemblyError` (breaker-invisible). Grok rode this table from KPR-371 through KPR-384 (default `grok-4.6`, `GROK_AGENT_MODEL` override) until KPR-392 promoted it to a native Lane B adapter — see below; the table has no Lane A exceptions left.

**Grok talks directly to xAI, authenticated by the machine's `grok login` subscription OAuth session (KPR-410; grok itself is a native Lane B adapter since KPR-392).** From KPR-384 through KPR-410, `GrokAdapter` (then `GrokGatewayAdapter`) sat behind an operator-hosted CLIProxyAPI gateway, because xAI's own Anthropic-compat `/v1/messages` rejected tool `input_schema`s missing the `required` array — a validator quirk that never actually applied to this adapter's OpenAI-format chat-completions call shape (and `tool-bridge.ts:538` fills `required: []` on every bridged schema regardless), so the gateway's justification didn't survive scrutiny. `GrokAdapter` now posts directly to `https://api.x.ai/v1/chat/completions` — no override, no operator-hosted middlebox. The credential is `~/.grok/auth.json`, the same file the `grok` CLI itself reads and writes: hive resolves and, when the access token is within an hour of expiry, refreshes and durably writes back the rotated pair via `grok-oauth.ts` (revived KPR-371 machinery, unmodified — single-flight refresh so concurrent spawns can't race and burn the rotating refresh token, fsync-before-rename write-back, https/same-origin-pinned OIDC discovery). `GROK_GATEWAY_URL`/`GROK_GATEWAY_KEY` and the `hive credentials` entry for grok are retired; the operator still runs `grok login` once per machine, but hive itself performs every subsequent refresh. Home-directory gotcha: `grok-oauth.ts`'s `expandHome()` resolves `~/.grok/auth.json` against the **process's** home directory — for hive running as a launchd service that's the service account's home, not whatever interactive shell an operator happened to run `grok login` in; the failure message (`missingCredentialMessage`) does interpolate the full expanded path, so an operator seeing e.g. `/var/lib/hive/.grok/auth.json` when they expected their own `/Users/<them>/...` has the account-mismatch diagnostic right there — read the path in the error before assuming a plain missing-login case, and run `grok login` as (or su to) the service account, not just any logged-in session. A missing or unreadable credential file fails the turn as a breaker-invisible `TurnAssemblyError` naming `grok login`, same posture as every other provider's missing credential — note this ticket adds a network dependency the KPR-384 gateway era never had: under the gateway, `GROK_GATEWAY_KEY` was a purely local env/Keychain read with no transport to fault at all, so credential resolution was already breaker-invisible by construction; now credential resolution is itself a network call (OAuth refresh against `auth.x.ai`), and a fault there classifies non-provider/breaker-invisible (the original KPR-371 contract) — the same posture, extended to a path that's now actually networked. A transport fault against grok's actual chat-completions inference endpoint still trips the breaker as a connect-fail, unchanged from the gateway era. Subscription exposes only `grok-4.6`/`grok-4.5`; `xhigh` effort remains expressible (`reasoning_effort` delivers verbatim, `minimal`/`none` coerce to `low`). Sessions remain `stateless-replay` on `provider_turn_history` (unchanged by this ticket). Ops surfaces are otherwise unchanged: a grok outage still trips only the `grok` breaker/outage queue when it does trip. Post-migration cleanup: `GROK_GATEWAY_KEY` is no longer in the curated credential registry, but `hive credentials remove GROK_GATEWAY_KEY` still works on it (`removeCredential` keys off `hasSecret` against Honeypot directly, not registry membership) — run it once to clear the now-orphaned Honeypot entry. Per-agent rollback (reassign that agent's `model` away from `grok/...` + SIGUSR1) needs neither the gateway nor `GROK_GATEWAY_KEY` — it's just routing that one agent elsewhere. A full code-level revert of this ticket's commit range is the operation that needs the gateway back: the operator-hosted CLIProxyAPI gateway (`io.keepur.grok-gateway`) must still be installed/running to restore working grok access, and re-provisioning the credential is one-way — `addCredential` (`src/cli/credentials.ts`) requires registry membership (`findCredentialEntryByKey` or a plugin's `dynamicEntries`, unlike `removeCredential`'s Honeypot-only check above), so `hive credentials add GROK_GATEWAY_KEY` fails with "Unknown key" post-merge since the registry entry is gone; restoring it needs a registry-side change too, not just the adapter revert.

## Common Gotchas

- After editing MCP server source: `npm run build` (tsc → `dist/`) for dev, or `npm run bundle` (esbuild → `pkg/`) for the publish-ready artifact. The runtime engine in `<instance>/.hive/` runs from `pkg/server.min.js`. Restart Hive (`launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent`) to pick up changes — or for agent-definition changes only, send `SIGUSR1` (no restart).
- Agent definitions are DB-native — edit via admin MCP tools or REST API, changes take effect on next SIGUSR1 reload
- **Prefix cache (KPR-213):** assembled system-prompt prefixes are cached in-memory per agent and **invalidated automatically** on every write path that affects them — agent-def updates, memory writes (FS-style and structured-tier), constitution edits, team-roster changes, skill changes. SIGUSR1 still flushes the cache + reloads the registry, but it is **no longer load-bearing for prefix freshness** — it stays as an explicit operator escape hatch. Cache stats are heartbeated to `db.telemetry` (kind=`prefix_cache_stats`) every 30s and surfaced via `hive doctor`.
- `hive.yaml` and `.env` are gitignored — exist separately in dev and deploy dirs
- Slack file downloads: auth header stripped on redirect — must follow redirects manually
- Thread deduplication: 60s window prevents double-processing
- Spawn budget default: 5 in-flight per agent (per-agent, not per-thread). Same-thread spawns serialize via the per-thread lock; budget bounds parallel spawns across different threads.
- **Provider circuit breaker (KPR-306):** `spawnTurn` acquires a per-provider breaker permit before any model-router spend. Three consecutive hard provider faults (connect-fail/timeout/rate-limit/auth/5xx — typed classifier at `src/agents/provider-adapters/error-classification.ts`) or a p95 `llmMs` breach open the circuit; open turns fast-fail with the exported `ProviderCircuitOpenError` (Open-Circuit Contract — KPR-307 binds to it; frozen fields in `src/agents/provider-circuit-breaker.ts`). Half-open probes are real user turns (15s base cooldown, ×2 backoff, 60s cap); a probe's lost-permit staleness bound follows the probe turn's own deadline + 60s grace (KPR-400 — acquire meta carries the manager's upper-bound `deadlineMs`; replaces the flat 360s that stale-killed long-`timeoutMs` probes mid-flight; meta-less acquires keep 360s). Tool/agent errors classify `non-provider` and never trip. Deadline aborts split on observed progress (KPR-398): a `timedOut && aborted` turn that made progress (a tool call, a streamed event, or non-empty text) classifies breaker-inconclusive `turn-deadline` — never trips, never resets a fault streak or closes a half-open probe, and never enters `outage_queue` (the dispatcher's post-turn gate classifies the full `RunResult`); only a zero-progress deadline abort keeps the hard `timeout` kind (the hang signature, fail-closed on absent progress fields). Config: hive.yaml `circuitBreaker` (all keys optional; `enabled: false` = shadow mode — observe + telemetry, never fast-fail). State is in-memory (restart resets to closed); heartbeated to `db.telemetry` (`kind=circuit_breaker_stats`, per provider, 30s) and rendered as an informational `hive doctor` section (never flips the exit code).
- **Aborted-turn session persistence + claude resume self-heal (KPR-399):** an aborted claude-lane turn with observed progress (the KPR-398 signal — a tool call, a streamed event, or non-empty text) persists its session handle in `finalizeSpawnResult`, so the next message, an outage-queue replay, or reflection resumes the partial transcript instead of restarting cold. Client-transcript semantics only (claude + Lane A kimi/deepseek/grok — Lane B untouched); tokenData-less write (prior turn's usage stats preserved); zero-progress aborts persist nothing (fail-closed). Because a mid-abort handle isn't guaranteed resumable, a resume the CLI rejects (unknown session, or a dangling `tool_use` in the replayed transcript — `isClaudeResumeLoadError`, classifies `non-provider`) self-heals via one manager-level fresh retry, breaker-invisible, one exchange of context lost — the third one-shot self-heal arm beside auth-rebuild and the openai/gemini stale-server-handle arm (mutually exclusive, at most one per turn).
- **Honest outage behavior (KPR-307):** while a provider circuit (KPR-306) is open, the dispatcher intercepts fast-fails and probe-failure turns: one plain-text notice per thread per outage episode (SMS/iMessage now send one honest text per episode **instead of silently skipping** — deliberate behavior change), and the turn persists to `outage_queue` for automatic replay (15s poller, class-ordered — fast-fail-class turns before post-turn-fault-class, oldest-first within class (KPR-400) — 4h TTL, depth 500, 3 real attempts). Cron turns skip (they re-fire); callback/event/team one-shots queue silently. Voice speaks an honest outage sentence as a normal completion. Config: `outageQueue` section in hive.yaml (`enabled`, `replayIntervalMs`, `maxAgeHours`, `maxDepth`, `maxReplayAttempts`) — `enabled: false` reverts to raw error surfacing. The delivery retry queue (`src/sweeper/retry-queue.ts`) is a different mechanism (turn succeeded, delivery failed) and is unchanged. `hive doctor` shows an informational "Outage queue" section; status queries still work mid-outage (no model call). **Deadline aborts (KPR-402):** the same honest-notice machinery also covers the closed-circuit case where a Claude-lane/Lane-A turn burns its wall-clock deadline — with progress (`classifyTurnResult` kind `turn-deadline`), notify and silent lanes get an honest notice (notify only) plus up to 2 in-process resume-first continuations (per-leg ids `<origin>#dl<n>` — templates + leg-id derivation in `src/channels/deadline-continuation.ts`; session resume is emergent via KPR-399), then a terminal notice naming the manual "continue" hatch; zero progress never re-dispatches — the notify lane gets a notice only, a silent one-shot only a warn log; cron is fully inert. No config knob — rollback = code revert.
- MongoDB collections (engine-written): `agent_definitions`, `agent_definition_versions`, `agent_model_catalog` + `agent_model_catalog_versions` (agent-facing model-id catalog KPR-381 — one curated doc per subscription-auth provider claude/grok/codex, plus plugin provider ids since KPR-394, + append-only refresh audit trail; gemini is never stored, always resolved live via `agent_model_catalog_list`), `sessions` (per-thread session resume), `provider_turn_history` (stateless-replay turn history KPR-353/KPR-392 — codex/grok plus any stateless-replay plugin provider (KPR-394); per-(agent, thread, provider) input items, codex's incl. encrypted reasoning, whole-turn-trimmed under a char budget, 7d TTL, cleared on KPR-313 provider handoff), `memory`, `memory_versions` (FS-style agent memory), `agent_memory`, `agent_memory_autodream_state` (structured/tiered memory), `contacts`, `crm_contacts`, `agent_callbacks`, `agent_events`, `team_channels`, `team_messages`, `team_pending_requests`, `workflow_plans`, `workflow_tasks`, `workflow_task_comments`, `code_index`, `activity_log` (KPR-393: optional `intentTrailer: true` on non-error turns whose delivered text ends on an unexecuted first-person commitment — boolean only, never the text; detector `src/agents/intent-trailer.ts`, written at AgentManager's activity-audit site for every provider), `imessage_threads`, `agent_turn_telemetry` (per-turn usage/cache telemetry; since KPR-401 aborted turns with real spend are recorded too — sparse `aborted: true` on the doc, zero-usage aborts still skipped, aggregations unchanged), `migrations`, `outage_queue` (honest-outage replay queue KPR-307 — turns queued while a provider breaker is open, both fast-fails and post-turn hard faults, classed by a sparse immutable `enqueueOrigin` field that drives replay class ordering (KPR-400 — absent on legacy docs, which claim first); a sparse immutable `deadlineMs` stamp (KPR-403 — the agent's acquire-time turn-deadline upper bound, written at enqueue) gives the `replaying`-orphan recovery sweep a per-doc bound, and that sweep now runs at boot AND as every 15s tick's first step (absent on legacy docs, which keep the old flat 360s); composite `(itemId, agentId)` key; replayed by a 15s poller), `instance_identity` (identity sentinel, KPR-294), `telemetry` (prefix-cache stats heartbeat KPR-213; spawn-coordinator stats heartbeat KPR-220; memory-lifecycle stats heartbeat `memory_lifecycle_stats` KPR-241 (per agent); circuit-breaker stats heartbeat `circuit_breaker_stats` KPR-306 (per provider); db-identity stats heartbeat `db_identity_stats` KPR-294; `agent_roster_stats` empty-roster guard KPR-295 — event-driven, `updatedAt` is not liveness)
- Legacy collections you may still see in older DBs — nothing in the engine reads or writes them: `model_overrides` (last referenced 2026-03-30, superseded by the admin MCP rewrite), `devices` (removed with the device registry in KPR-9), `agent_sessions` (never a real source name — the session collection has always been `sessions`). Safe to drop operationally.
- `HIVE_DB_SENTINEL_RESTAMP=1` re-stamps the DB identity sentinel for one boot (adopting another instance's DB); remove after use — it is honored every boot it is set
- **Empty-roster reload guard (KPR-295):** if an agent-definitions reload observes the collection at **zero docs after any non-empty load in this process's lifetime**, the reload is blocked as a **full no-op** — no roster mutation, no post-reload hooks, schedules/skills/plugins refresh all skipped — and the registry logs the alarm, marks `agent_roster_stats.degraded: true` in `db.telemetry`, and retries every 30s, auto-recovering (no operator ack) as soon as docs reappear. This is deliberate impostor/wipe protection: **runtime deletion of the entire roster is blocked by design and there is no bypass knob** — if you genuinely mean to run with an empty roster, restart the engine (a fresh process has no non-empty baseline and commits the empty set). A fresh-install empty boot, partial shrinkage, or all-agents-disabled all commit normally; only the →0 cliff blocks. `hive doctor`'s Datastore identity section surfaces the degraded state.
- **`hive doctor` Datastore identity section (KPR-296):** the first and only post-check doctor section that can **fail the doctor (exit 1)**. Fail conditions: **F1** identity sentinel present-but-mismatched (instanceId/dbName), **F2** roster guard degraded, **F3** engine identity monitor reporting non-verified on a fresh (≤120s) heartbeat — unknown monitor states fail closed. Everything else warns or informs: absent-sentinel-with-data is a **warn**, not a fail (upgrade window preserved); a temp-dir `dbPath` (`/tmp`, `/var/folders`) warns — the Jul-4 impostor signature. Remediations: intentional DB adoption → `HIVE_DB_SENTINEL_RESTAMP=1` for one boot; roster/state recovery after a DB restore → `SIGUSR1`. Every other doctor section remains informational — identity-class incidents flip the exit code, telemetry health never does.
- **Tool search / deferred MCP tool loading (KPR-329):** every Claude spawn pins `ENABLE_TOOL_SEARCH` explicitly — resolution: agent-definition `toolSearch` field → hive.yaml `toolSearch.mode` → engine default `auto`. `auto` = the CLI's token-threshold mode (defers MCP tool schemas only past ~10% of context — small agents see zero change); `on` = always defer; `off` = eager loading, exactly the pre-KPR-329 intended behavior. Rollback: set `toolSearch.mode: off` in hive.yaml + restart (per-agent: `admin_agent_update` + SIGUSR1, takes effect next spawn). Haiku models are excluded by the SDK (silently eager). Operators fronting a non-first-party `ANTHROPIC_BASE_URL` proxy should set `mode: off` — a proxy that strips `tool_reference` blocks degrades `on`/`auto` turns. Ambient `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` force-disables tool search inside the CLI (engine warns once per process).
- **Node 26 / undici (KPR-344):** hive's own `undici` is v8 — its `setGlobalDispatcher` writes both global symbols, so KPR-252 pooling works on Node 22/24/26. Never pass an undici Agent as a **per-request** `dispatcher` to the runtime's built-in `fetch` (no cross-major compat, both directions) — pair it with undici's own `fetch` import instead (see `src/beekeeper-client.ts`). `@qdrant/js-client-rest` is bundled (not external) with its internal v6 dispatcher stubbed to plain fetch by `build/bundle.ts` + guarded by `check-bundle-qdrant-stub.mjs`; **dev mode (tsx) keeps the upstream dispatcher and is broken on Node 26 — develop on Node 22/24.**
