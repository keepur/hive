# Hive engine architecture

What's inside the hive engine — the daemon you start with `hive start --daemon`. This is engine-side architecture; for operator-facing day-two docs see [managing-your-hive.md](managing-your-hive.md).

## Process model

```
Slack / SMS / WebSocket / scheduler
            ↓
       Channel adapter
            ↓
       Dispatcher (routing, dedup, status)
            ↓
       Model router (Haiku / Sonnet classifier; respects per-agent ceiling)
            ↓
       Agent manager (spawn coordinator: per-thread lock + per-agent budget)
            ↓
       Provider adapter (Claude implementation; no provider selection yet)
            ↓
       Tool transport inventory → future provider-specific tool bridge
            ↓
       Agent runner (spawns Claude session + MCP servers as subprocesses, fresh per turn)
            ↓
       Response → channel adapter → delivery
```

A single hive process serves multiple agents and multiple channels. Each agent's work runs as a fresh Claude Code session per inbound work item, with a configured set of MCP server subprocesses scoped to it. `AgentManager` hands a one-turn request to a provider adapter; in B0 the only adapter is the Claude implementation, which delegates to the existing `AgentRunner`/Claude Agent SDK path. KPR-232 adds a provider-neutral tool transport inventory for compatibility planning, but it does not add provider selection or OpenAI/Gemini runtime support. Claude still receives the direct SDK MCP wiring. A new `AgentRunner` instance is constructed per spawn so MCP servers, hooks, and `WorkItemContext` (channel id, thread id, source metadata) are captured at spawn time — no stale state survives across turns.

The agent manager is a thin spawn coordinator: per-thread lock on `(agentId, threadId)`, per-agent in-flight budget, ticket lifecycle for abort/stop, post-quiescence reflection scheduler, and the `getSnapshot()` observability surface used by `hive doctor`, the Slack health report, and the WebSocket agent roster.

### Migration notes

- The `agentManager.perTurnSpawn.{sms,slack,ws,voice}` config keys were removed in KPR-220. Per-turn spawn is the only execution path. The YAML loader silently ignores stale `perTurnSpawn` keys (KPR-225 F3 liberal-loader pattern), but they have no effect — drop them when convenient.
- `maxConcurrent` on an agent definition is **deprecated** in favor of `spawnBudget`. The fallback chain is `agent.spawnBudget → agent.maxConcurrent → engine default (5)`. `hive doctor`'s "Spawn coordinator" section surfaces which fallback fired so operators can migrate agent-by-agent.
- Reflection trigger changed from queue-drain ("conversation went idle because the queue is empty") to post-quiescence debounce: 30s after the most recent non-reflection turn on a `(agentId, threadId)` pair. `memory.reflectionMinTurns <= 0` now disables reflection entirely (legacy queue-drain semantics treated zero as "fire every turn", which was a footgun under the new debounce model).

## Key files (read these to understand the engine)

- `src/index.ts` — entry point; wires every subsystem.
- `src/config.ts` — loads env + `hive.yaml` into a typed config.
- `src/agents/agent-runner.ts` — per-spawn `AgentRunner` (fresh instance per turn); assembles the system prompt (cache-friendly prefix: soul → systemPrompt → constitution → toolkit → memory → date), configures MCP servers, builds hooks with the current `WorkItemContext` each spawn.
- `src/agents/agent-manager.ts` — spawn coordinator: lock, budget, ticket lifecycle, reflection scheduler, snapshot surface.
- `src/agents/provider-adapters/` — one-turn provider boundary and tool transport classification. Currently Claude-only at runtime: `ClaudeAgentAdapter` delegates to `AgentRunner`; no config or schema provider selection exists yet.
- `src/agents/spawn-coordinator-heartbeat.ts` — 30s heartbeat that writes the coordinator snapshot to `db.telemetry` (`kind=spawn_coordinator_stats`) per agent for the doctor to read.
- `src/agents/agent-registry.ts` — loads agent definitions from MongoDB.
- `src/agents/model-router.ts` — Haiku/Sonnet classification.
- `src/channels/dispatcher.ts` — main routing logic, agent resolution, retry queue.
- `src/channels/slack-adapter.ts` — Slack events → `WorkItem` → delivery.
- `src/channels/sms-adapter.ts` — SMS via Quo/OpenPhone.
- `src/slack/slack-gateway.ts` — Socket Mode listener, message filtering.

## Storage

- **MongoDB** — agent definitions, agent memory, per-agent sessions, callbacks, contacts, devices, model overrides. Collections include `agent_definitions`, `agent_definition_versions`, `agent_sessions`, `memory`, `memory_versions`, `contacts`, `agent_callbacks`, `devices`, `model_overrides`.
- **Qdrant** — vector storage for semantic recall (conversation search, code search, structured memory). Local Ollama (`bge-large`) generates embeddings.
- **macOS Keychain (Honeypot)** — third-party API keys. Per-instance prefix `hive/<instance-id>/<KEY>`. The cloud language model never sees these — local MCP servers fetch credentials via Keychain at the moment of use.

## MCP servers

Each agent gets a subset of MCP servers — listed in its `coreServers` and `delegateServers` arrays. The engine ships a generic baseline:

- `memory-mcp-server.ts` — read/write/list/history/rollback agent memory.
- `memory/structured-memory-mcp-server.ts` — tiered semantic recall.
- `keychain-mcp-server.ts` — macOS Keychain read-only.
- `contacts-mcp-server.ts` — contact lookups.
- `events/event-bus-mcp-server.ts` — cross-agent event bus.
- `team/team-mcp-server.ts` — direct agent-to-agent messaging.
- `schedule/schedule-mcp-server.ts` — cron-style scheduled tasks.
- `callback/callback-mcp-server.ts` — delayed-response timers.
- `slack/slack-mcp-server.ts` — Slack tooling.
- `linear/linear-mcp-server.ts` — Linear issues.
- `github/github-issues-mcp-server.ts` — GitHub Issues.
- `clickup/clickup-mcp-server.ts` — ClickUp tasks.
- `google/google-mcp-server.ts` — Gmail + Calendar + Drive (via `gog` CLI).
- `quo/quo-mcp-server.ts` — SMS via Quo/OpenPhone.
- `resend/resend-mcp-server.ts` — outbound email via Resend.
- `recall/recall-mcp-server.ts` — meeting participation via Recall.ai.
- `tasks/task-mcp-server.ts` — generic task store.
- `background/background-task-mcp-server.ts` — spawn detached long-running commands.
- `code-index/code-search-mcp-server.ts` — semantic code search over indexed files.
- `code-task/code-task-mcp-server.ts` — delegate coding to Claude Code CLI sessions.
- `search/conversation-search-mcp-server.ts` — semantic search over past conversations.
- `admin/admin-mcp-server.ts` — agent CRUD + version history (admin-scoped).

Plugins (e.g. CRM integrations, business-specific tools) are separately-published packages; install with `hive plugin add <pkg>`.

### Provider tool transport compatibility

KPR-232 adds `AgentRunner.buildToolTransportInventory()` as a read-only inventory of the tool transports visible to a turn. The inventory describes Claude SDK built-ins, parent-session MCP servers, in-process SDK MCP servers, `team-roster`, and delegated sub-agent tools without exporting the Claude SDK `McpServerConfig` shape as the public boundary.

The compatibility path is:

```
Provider adapter → tool transport inventory → provider-specific tool bridge
```

This is a compatibility layer only. Claude continues to use direct Claude Agent SDK `mcpServers`, in-process SDK MCP servers, SDK built-ins, hooks, plugins/native skills, and `agents:` sub-agent wiring. Non-Claude adapters must not consume the Claude-shaped `mcpServers` object directly; future OpenAI/Gemini pilots should consume the inventory and opt into explicitly classified bridge candidates or provider-native tools.

The future bridge belongs inside Hive, not inside each provider adapter. It should keep Honeypot/Keychain resolution local, preserve `WorkItemContext` for context-dependent servers, and expose only selected tools through provider-supported MCP or native function surfaces. SDK plugins/native skills, hooks, prompt assembly, settings sources, and SDK `extraArgs` are out of this inventory and remain Claude runtime behavior unless a later spec gives another provider an equivalent implementation.

## Coordination primitives

Hive supports three distinct cross-agent coordination patterns. They do not overlap; pick the one whose semantics match the use case.

### In-session sub-agent

Synchronous, ephemeral, returns into the caller's turn. Driven by the SDK's `agents:` field, populated from `delegateServers` on the calling agent. The sub-agent is spawned for one focused task, returns its result, and is gone — it has no thread, no session, no inbox. Use when the calling agent needs a focused tool call done **right now** to finish the current turn (e.g. Jessica spawns a CRM-search specialist mid-turn). Built in `src/agents/agent-runner.ts:buildServerSubAgents`. Context-dependent servers (`callback`, `background`, `code-task`, `recall`, `structured-memory`) cannot be sub-agents because they need channel/thread context that does not exist in a sub-agent spawn. `memory` is also delegate-unsafe, but for a different reason: it is Hive-runtime-backed rather than turn-context-dependent.

### Direct messaging (Team MCP)

1-to-1, fire-and-forget by default; optional `expectReply` blocks the caller until the recipient replies. The recipient processes the message in **their own session and time-axis** — it lands as a `WorkItem` on their inbox, not as a sub-agent of the sender. Use when handing off a task whose owner is someone else (e.g. Jessica hands a customer issue to Wyatt). Lives in `src/team/team-mcp-server.ts`. Auto-injected as a core server for every agent — operators don't wire it manually.

### Pub/sub events (Event Bus MCP)

1-to-many broadcast, subscriber-driven response. Publishers don't know or care who's listening; subscribers express interest by name and react via their own work items. Use when announcing something that may concern multiple agents (e.g. Mokie publishes "morning standup," any subscribed agent responds in their own session). Lives in `src/events/event-bus-mcp-server.ts`.

## Channels

- **Slack** — Socket Mode + Web API. Agents have their own bot identities; outbound posts use `chat:write.customize`.
- **SMS** — Quo/OpenPhone webhook → adapter → dispatcher.
- **WebSocket** — long-lived connection from clients. Hive registers as a `?channel=` capability on a sibling beekeeper gateway (loopback on `127.0.0.1:3200`); see [beekeeper's federation doc](https://github.com/keepur/beekeeper/blob/main/docs/federation.md).
- **Scheduler** — `schedule-mcp-server` fires `WorkItem`s on cron expressions defined per agent.

## System prompt assembly

When an agent is invoked, the runner assembles its system prompt in this order, then calls the SDK:

1. **Soul** — agent personality / voice / values.
2. **systemPrompt** — agent's role + guardrails.
3. **Constitution** — shared `constitution.md` for the instance.
4. **Toolkit** — runtime-injected catalog of available MCP tools.
5. **Agent memory** — hot-tier records (always loaded).
6. **Date / time** — last so the static prefix stays prompt-cache-friendly.

## Hot reload

`SIGUSR1` reloads agent definitions from MongoDB without restarting the daemon. Used by admin tooling that mutates `agent_definitions` (the admin MCP server, beekeeper's tune-instance skill).

Post-KPR-213, `SIGUSR1` is **no longer load-bearing for prefix freshness** — the assembled system-prompt prefix cache invalidates automatically on every write path that affects it (agent-def updates, memory writes, constitution edits, team-roster changes, skill changes). `SIGUSR1` still flushes the cache + reloads the registry, but it stays as an explicit operator escape hatch rather than a required step after edits. Cache stats are heartbeated to `db.telemetry` (`kind=prefix_cache_stats`) and surfaced via `hive doctor`.

## Security posture

- **Keychain isolation** — cloud LLMs never see secrets. Keychain reads happen inside MCP servers, scoped by `hive/<instance>/<KEY>`.
- **Per-agent MCP whitelist** — an agent only sees the servers in its `coreServers`/`delegateServers`. Tool selection is enforced by what's spawned, not by prompt instructions.
- **Confirm-before-send for outbound** — by default, customer-facing tools (resend, slack outbound, sms) draft for human approval rather than send autonomously.
- **No shell-string subprocess invocation** — all subprocess spawns pass argv as an array (`spawnSync(binary, [args])`), never as a shell string. Prevents command injection from interpolated input.
- **Background task auth** — bearer token (`BG_TASK_AUTH_TOKEN`) on the background task HTTP API.

For the broader trust model see [README.md#trust-posture](../README.md#trust-posture).
