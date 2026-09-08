# Hive — Codex Instructions

## Workflow

- **Major planning work**: After a plan is approved, always run `/spec-and-implement` to generate specification documents and delegate parallel implementation. Never skip this step for non-trivial architectural changes.

## Project

- TypeScript, Codex Agent SDK, Slack Socket Mode + Web API
- Runtime: Node 24 on Mac Mini, runs as launchd service (`com.hive.agent`)
- Config: `hive.yaml` (instance config) + `.env` (secrets)
- Agents: `agents/` (gitignored, per-instance) generated from `agents-templates/`

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit, test, commit, push
- **Deploy**: `~/services/hive` — separate clone, compiled JS, launchd points here
- **Deploy script**: `~/services/hive/deploy.sh` — pulls, installs, builds, syncs agents, restarts
- Editing source in dev does NOT affect the running service

## Conventions

- Use `createLogger("module-name")` for logging
- MCP servers use in-process SDK servers for engine Mongo-backed tools; stdio remains for process-isolated and vendor integrations. `AgentRunner.buildInProcessServers(context)` refreshes runner-owned context references for both provider lanes.
- **Work-item identity (KPR-453):** Manager-owned turns set `WorkItemContext.workItemId` to the exact `WorkItem.id` before provider assembly; hooks, ToolBridge, guardrails, and inline delegates retain it. The public field stays optional (provider ABI v1); older callers and detached worker/scribe executions without a `WorkItem` may omit it. Never derive an ID from a thread, session, claim, or boss turn. Every enabled in-process MCP builder receives a live runner-owned reference: callback, worker-pool, and structured-memory use their existing projections; the other nine share one `WorkItemContextRef` per runner. Refresh references on every invocation, including absence, and read `.current` at tool execution rather than capturing the first ID. This runtime-only plumbing adds no persistence or external MCP/model/tool payload fields; retries and outage replay may reuse an item ID.
- **Delivery obligations (KPR-456):** `src/obligations/` owns operator-registered expectations independently of cron. The existing schedule server exposes `my_delivery_obligations` and `deliver_obligation` on both provider lanes, bound to its constructor agent ID; occurrence identity is `(obligationId, dueAt)`, never `workItemId`. Preserve worker containment. Await append-only receipts even when turn logging is disabled; retain occurrence checkpoints after receipt TTL expiry without recreating expired history. Store obligation/evidence metadata, never deliverable text or raw transport errors. Unknown submissions never auto-retry; only the closed, provenance-checked nonacceptance allowlist permits retries. Registration and workflow enrollment are explicit operator actions; no recipient defaults or human-read/exactly-once delivery guarantee. See [delivery obligations](docs/delivery-obligations.md).
- Agent identity layers: `soul.md` (personality) + `system-prompt.md` (role) + `memory.md` (knowledge)
