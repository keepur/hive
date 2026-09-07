## TL;DR

KPR-453 carries the existing `WorkItem.id`, unchanged, as `workItemId` through `WorkItemContext` to in-process MCP handlers, hook construction, and Lane B ToolBridge. Manager-owned work-item turns always supply it; the public field remains optional for existing provider integrations and invocations that have no `WorkItem`. This is context plumbing only: it creates no events, identifiers, storage fields, or routing policy.

## Key Points

- **One identity source:** `workItemId = ctx.workItem.id` at the manager's provider-attempt boundary, before adapter assembly. Neither a Slack timestamp, thread ID, provider session ID, nor a generated UUID substitutes for it.
- **⚠ Delegated compatibility decision:** add `workItemId?: string`, because `WorkItemContext` is published provider ABI and some existing invocation paths do not own a `WorkItem`. Presence is nevertheless an invariant for every manager-owned `WorkItem` turn; missing means unavailable, never an invented identifier.
- **Both provider lanes inherit the same value:** Claude receives it through `AgentRunner.send()` and hook factories; Lane B assembly, its per-turn ToolBridge, guardrail calls, and inline delegates retain it through their existing context arguments.
- **Every enabled in-process MCP factory must expose the current value to its tool builders.** Extend the three existing mutable context projections and give the remaining factories an optional runner-owned context reference. Preserve server caching, enablement, and worker containment; no tool input/output schema changes.
- **Refresh on every invocation, including absence.** Cached handlers must observe A, then B, then unavailable across successive contexts. Each runner owns its references, so simultaneous spawns cannot share identity state.
- **Preserve existing identity semantics:** outage replay and provider retries may reuse an item ID; deadline continuations and scheduled callbacks use their already-created item IDs. This field does not identify a unique provider attempt or establish continuity between separate work items.
- **⚠ Delegated boundary for detached roles:** meeting fetch-worker and scribe invocations without a `WorkItem` keep the field absent. Their boss's ID and their thread/claim IDs are not silently relabeled as the worker's work-item identity; subsequent `worker:` re-entry WorkItems are covered normally.
- **KPR-452 and KPR-458 remain outside this slice.** Audit-copy preferences, taxonomy, severities, recipients, escalation, runtime event emission, and operational readers remain with their owning children. No production deployment is part of this ticket.

## Scope and authority

Ticket: **KPR-453 — workItemId on WorkItemContext — thread WorkItem.id to MCP servers, hooks, ToolBridge**. Parent: KPR-451. Baseline inspected: `6abe046065d05fc5b52f44b18f17ac8cc82cee53`.

The approved Gate 1 package and signoff delegate routine specification, planning, and implementation decisions in waterfall mode, subject to child readiness. The preserved human gates for KPR-452 and KPR-458 do not prevent this identity-only change.

No child comments were supplied. KPR-453 has no dependencies. No KPR-451 Decision Register — Canon summary or merged-sibling decisions exist yet; this absence is recorded and is not a blocker. There are no existing KPR-453 partial artifacts in this worktree.

This draft follows `AGENTS.md` and the relevant conventions in `CLAUDE.md`. This epic artifact lives under `docs/epics/kpr-451/`, following the repository epic-artifact convention. Drafting does not approve a child implementation plan or cross the repository's `/spec-and-implement` boundary.

## Problem and observed behavior

`WorkItem` already requires an `id` (`src/types/work-item.ts:12`), but `WorkItemContext` currently contains only seven transport/thread fields (`src/agents/agent-runner.ts:148`). `AgentManager.runOneSpawnAttempt()` constructs that context from `ctx.workItem` at `src/agents/agent-manager.ts:1941` and discards the ID. Consequently runtime consumers cannot associate their observations with the item that caused the turn without guessing from unrelated identifiers.

The principal propagation paths already exist:

| Surface | Current code and gap |
| --- | --- |
| Manager → provider | `runOneSpawnAttempt()` builds one context before `createProviderAdapter()`, then sends it in `adapter.runTurn()`. Add the source field here. |
| Claude lane | `claude-agent-adapter.ts` forwards the entire context to `AgentRunner.send()`. `buildHooks(context)` passes it to `preToolUseHooks`; `sessionOptions` receives it too. No new transport is needed. |
| Lane B | `turn-assembly.ts` passes context to inventory construction, in-process server construction, cwd resolution, and guardrails. `turn-scaffold.ts:186` passes the request context to `ToolBridge`; `tool-bridge.ts:331` supplies it to each guardrail call. |
| Existing context-aware MCPs | Callback, worker-pool, and structured-memory use mutable references, but `buildInProcessServers()` manually copies selected fields (`agent-runner.ts:1587`, `:1614`, `:1637`). Their projected types also omit the ID. |
| Other in-process MCPs | Nine factories currently have no per-turn context dependency. Merely widening `WorkItemContext` would not make identity available inside their tool builders, including event-bus, which KPR-454 will need. |
| Detached invocations | `workItemContextFromClaim()` and the scribe's `runRoleTurn()` context describe source channels but do not come from a worker-owned `WorkItem`. |

Two existing behaviors qualify the epic's shorthand “unique per turn.” `outage-replay-processor.ts:120` intentionally preserves the queued item's ID. Deadline continuation at `dispatcher.ts:1027` deliberately creates a new suffixed item ID while preserving the thread. KPR-453 must expose those existing choices faithfully, not redefine them.

## Goals and non-goals

The result must provide the exact originating work-item identity at each runtime context boundary, cover all manager-owned channel kinds and both provider lanes, preserve optional-context callers, and prevent stale or cross-runner identity in cached MCP handlers. Downstream children can consume this field without reopening propagation.

Out of scope:

- New trace/run/attempt IDs, AsyncLocalStorage, a correlation registry, parent/child lineage, or identifier normalization.
- Event types, payload enrichment, tool-failure hooks, error signatures, diagnostics, new logging, `activity_log` changes, or any Mongo schema/migration.
- Persisting originating identity in callback documents, worker claims, team requests, scheduled jobs, or memory records. Identity available inside a handler does not authorize a new write.
- Slack routing, audit copies, escalation, ownership, timers, readers, dashboards, and deployment.
- Passing identity into external MCP subprocess environments, HTTP headers, model prompts, tool arguments, or public tool results. Engine hooks and ToolBridge can observe tools on those transports using their existing runtime context.
- Giving detached role invocations new WorkItems or changing their scheduling/accounting model.

## Design

### D1. Identity contract and compatibility

Add an optional `workItemId?: string` property to the existing `WorkItemContext` interface in `agent-runner.ts`. Document it as the unmodified ID of the work item whose execution this context represents; it may be absent when no work item exists or when a compatible older caller omits it.

`WorkItemContext` is re-exported by `provider-abi.ts:127`. Its ABI governance permits additive, non-breaking growth without a version bump (`provider-abi.ts:9`; KPR-394 spec §4.7). Keeping the field optional preserves existing callers that construct seven-field contexts. Keep `LANE_B_PROVIDER_ABI_VERSION = 1`; do not move the public interface or change any existing required fields.

For engine-managed work items, optionality is compatibility at the API boundary, not permission to omit known identity. `runOneSpawnAttempt()` must set `workItemId: ctx.workItem.id` in the same object used for assembly and execution. No fallback, coercion, trimming, prefix parsing, validation failure, or new generation is introduced. A caller supplying an unusual string still receives that exact string; validation of `WorkItem.id` itself is a separate concern.

### D2. Manager, provider, hook, and delegate propagation

Keep the existing flow:

`WorkItem.id → manager WorkItemContext → provider assembly/request → runner/hooks or ToolBridge`.

Populate identity before `createProviderAdapter()` so Lane B's eagerly built MCP servers receive the same value as its later `runTurn()` call. Forward complete context objects across existing adapter, assembly, scaffold, guardrail, archetype, and nested-delegate boundaries; do not add parallel `workItemId` arguments to those APIs.

`buildHooks(context)` already receives the current turn context and rebuilds each invocation. Archetype `preToolUseHooks` receives the added field through its existing argument. No PostToolUse hook is introduced, and PreCompact behavior remains unchanged. KPR-454 can close over this existing context when implementing its runtime hooks.

ToolBridge's `opts.workItemContext` is the identity source at tool execution, including its existing failure-containment boundary. Its guardrail and `DelegateTurnCall` receive the same context. Inline delegates are part of the originating work item's execution and retain its ID; do not mint a delegate ID or change `ToolBridgeOptions` to duplicate it.

### D3. In-process MCP context availability

Follow the existing mutable-reference pattern rather than rebuilding cached SDK servers or introducing ambient state.

For the current context-aware factories, add `workItemId?: string` to `CallbackTurnContext`, `WorkerPoolTurnContext`, and `StructuredMemoryTurnContext`. Each corresponding assignment inside `buildInProcessServers(context)` copies `context?.workItemId` into the replacement `.current` object. Update the optional turn-dependency shapes and explicit projections in `buildCallbackMcpForTurn()` and `buildStructuredMemoryMcpForTurn()` as well, so these alternate builders do not silently discard a supplied ID.

The remaining factories need an additive dependency because they currently have no context channel:

| Existing factory surface | Identity access after this change |
| --- | --- |
| `memory`, `event-bus`, `contacts`, `schedule`, `team`, `admin`, `code-search`, `workflow` dependency objects | Optional `workItemContext` reference, forwarded from `create…McpServer(deps)` to `build…Tools(deps)`. |
| `team-roster` positional factory and builder | Optional second `workItemContext` reference argument, preserving existing one-argument callers. |
| `callback`, `worker-pool`, `structured-memory` | Their existing `context.current.workItemId`; no duplicate reference dependency. |

Use one simple internal type for the newly supplied references, alongside the existing context type: `{ current: WorkItemContext | undefined }`. Type-only imports avoid runtime cycles. A single runner-owned reference serves the nine factories that lack an existing projection; its `.current` is replaced at the start of every `buildInProcessServers(context)` call, before any cached-server return or enablement branch. The other three keep their existing references. There is no global/static reference and no reference shared between runners.

Factories and tool builders retain the reference, not the initial `workItemId` scalar. The current ID is accessible as `deps.workItemContext?.current?.workItemId` (or the equivalent positional reference for team-roster). Existing context-aware builders read their current projected context as before. This ticket supplies access only; it must not add synthetic reads, no-op logging, diagnostic tool results, or durable writes just to exercise the field.

Preserve which servers exist, their order, cache reuse, `shouldEnableInProcessServer`, workflow gating, and `suppressAutoInjectedServers`. An optional diagnostic context does not make a server operationally dependent on channel/thread routing: do not add these nine servers to `TURN_CONTEXT_DEPENDENT_SERVERS` or change delegate restrictions.

### D4. Missing context and detached roles

Calling `buildInProcessServers()` without context must clear the new shared reference and the projected IDs, just as the existing projection code replaces channel/thread values. Calling it with an older seven-field context likewise makes the ID unavailable. Never retain a previous ID with an expression such as `context?.workItemId ?? previousId`.

Detached fetch-worker execution at `meeting-worker-pool.ts:478` is created from a claim, not a `WorkItem`. The scribe at `meeting-scribe.ts:241` is a debounced role execution, also without its own `WorkItem`. Their existing contexts remain compatible and have no `workItemId`. Do not copy a boss/trigger ID into those separate executions, persist it into claim source data, or turn a claim/thread ID into a work-item ID. `runRoleTurn`'s structural context type may expose the same optional field for callers that already have a valid context; it must pass any supplied value through unchanged.

The pool's subsequent boss re-entry uses an actual `WorkItem` with `id: worker:<claimId>` (`meeting-worker-pool.ts:690`), so the manager attaches that ID normally. A detached role's missing ID is a known coverage limit for downstream observability, not evidence that the role succeeded, failed, or belongs to another work item.

### D5. Retry, continuation, and concurrency behavior

- Internal retries of one `WorkItem`, including provider-session self-heal, keep its ID even if `sessionId` changes.
- An outage replay preserves the queued item's ID, in accordance with current queue/dedup behavior.
- A deadline continuation, callback, event delivery, team request, reflection, or worker re-entry uses the exact ID its producer already assigned to that new `WorkItem`.
- Different items in one thread may share `threadId` and `sessionId` while exposing different `workItemId` values. Never derive identity from either shared field.
- Work-item identity is scoped by the consumer's agent identity where needed; this ticket does not promise fleet-global uniqueness or a unique ID per tool call.
- Fresh per-spawn runners provide isolation for simultaneous turns. Sequential reuse of a runner continues to use its existing mutable-reference lifecycle. Supporting overlapping `send()` calls on one reused runner is not introduced here.

## Acceptance criteria and verification contract

1. A manager-owned `WorkItem` with an ID deliberately different from its Slack timestamp, thread ID, and session ID reaches Claude's `send()` and Lane B's assembly plus `runTurn()` with that exact `workItemId`. Include Slack and at least one non-Slack source; the mapping has no channel-specific branch.
2. Two items in one thread yield different IDs, and retries of the same item preserve its ID. Existing outage replay and deadline-continuation behavior remains intact; no ID producers change.
3. Every enabled in-process factory listed in D3 receives a live reference carrying the ID. Existing factory-capture tests can verify the dependency boundary. A cached-server lifecycle regression must observe A → B → absent using the same captured reference, including both a context-free factory such as event-bus and the existing projected-context path. A second runner must retain its own value when the first is refreshed.
4. Existing callback and structured-memory alternate turn builders preserve an explicitly supplied ID. Handler-visible schemas, callback/claim/memory documents, and normal tool responses remain unchanged.
5. A hook factory captures the current ID on successive builds. A bridged tool invocation delivers it to the guardrail, and the bridge's inline-delegate path forwards it unchanged. Use a representative real in-process MCP round trip through the existing ToolBridge fixture where practical; no live provider/network calls are required.
6. Missing contexts and older seven-field contexts remain valid, carry no fabricated ID, and cannot inherit the prior ID. Detached worker/scribe contexts remain valid without one. Preserve existing worker server-containment checks.
7. The published `WorkItemContext` accepts both old and enriched shapes without an ABI bump. ToolBridge and provider APIs acquire no second identity field, and prompt assembly, external MCP configuration, and persistence schemas are unchanged.

Extend existing Vitest seams in `agent-manager.test.ts`, `agent-runner.test.ts`, `claude-agent-adapter.test.ts`, `tool-bridge.test.ts`, and the relevant existing MCP/worker builder tests. Prefer behavioral assertions for identity preservation, refresh, absence, and isolation over duplicated tests for each provider's pass-through code. Typecheck excludes `*.test.ts`, so a test file's unexecuted type annotation alone is not sufficient evidence of ABI compatibility; use a compiled compatibility fixture or an explicit typecheck that includes it.

Implementation verification must run targeted tests while changing the propagation seams, then the repository-required `npm run check` before submission. The draft stage performs no implementation tests and makes no runtime success claim.

## Open assumptions and downstream handoff

- **Non-blocking, delegated:** optional public identity plus mandatory manager population is the smallest compatible contract; no provider ABI bump is necessary.
- **Non-blocking, delegated:** the ticket's “every in-process MCP server” includes currently context-free factories. The small optional-reference plumbing in D3 is required to make that promise true; merely adding a field at the manager would leave event-bus and other builders without access.
- **Non-blocking, delegated:** detached role invocations without WorkItems report unavailable identity. Giving them durable identity is a separate scope decision, not an implicit boss-to-worker continuity rule.
- **Non-blocking, observed:** replay may reuse the ID. KPR-454/455 must not treat it as proof of one provider attempt, nor treat a different callback/retry ID as proof that previously blocked work resumed.
- **No blocking product questions for KPR-453.** KPR-454 still requires KPR-458's authored policy and its own ready contract before event emission or block-state design can proceed.
