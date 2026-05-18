# KPR-231 Provider Adapter Boundary Design

## Summary

KPR-231 is Phase B0 of the KPR-230 epic. It introduces the provider-agent-SDK boundary as a narrow code seam while preserving today's production behavior: every runtime agent turn still runs through the Claude Agent SDK path that Phase A stabilized.

The goal is to make the next provider work possible without rebuilding Hive's old `AgentRuntime` abstraction. Hive remains the channel, dispatcher, governance, prompt assembly, tool catalog, session-id, budget, telemetry, and operator layer. Provider SDKs continue to own their own agent loops.

## Context

KPR-210 Phase A made per-turn `query({ resume })` the single execution path. `AgentManager.spawnTurn` now owns coordination around one turn: per-thread lock, per-agent spawn budget, stop/abort ticket lifecycle, prompt shaping, model routing, auth-resume retry, session-store update, reflection scheduling, telemetry, conversation indexing, and activity audit.

`AgentRunner` still directly assembles Claude Agent SDK options and calls `query()`. It owns Claude-specific concerns: `mcpServers`, SDK in-process MCP server objects, SDK `agents` sub-agents, SDK plugins and native skills, hooks, settings sources, `extraArgs`, Claude auth env, and result-message parsing.

That shape is fine for Phase A, but B1-B3 need an explicit boundary before OpenAI or Gemini work starts. The boundary must not pretend the providers share one rich common runtime. It should capture only Hive's one-turn handoff contract.

## Goals

- Introduce a provider adapter interface for running one Hive turn.
- Add a Claude adapter implementation that delegates to the existing `AgentRunner`.
- Move `AgentManager` to depend on the adapter interface for execution and abort wiring.
- Preserve all current behavior for Slack, SMS, WebSocket, voice, scheduler, callbacks, event bus, team messaging, reflection, telemetry, and doctor surfaces.
- Keep the adapter contract intentionally small so future provider adapters translate from Hive's turn shape into provider-native SDK calls.
- Document that B0 is a no-behavior-change extraction and that OpenAI/Gemini implementation remains in B2/B3.

## Non-Goals

- No `agent_definitions.provider` field.
- No per-agent provider selection.
- No OpenAI Agents SDK runtime adapter.
- No Gemini ADK runtime adapter.
- No changes to model IDs, model routing, sidecar LLM calls, or PR #194's sidecar registry.
- No redesign of in-process MCP server transport. B1 owns the transport/provider-tool compatibility decision.
- No memory-boundary changes. Phase D remains deferred.
- No runtime warmth or process pool. KPR-208 remains held.

## Design

### Adapter Contract

Create `src/agents/provider-adapters/types.ts` with a narrow turn-level contract:

- `AgentProviderId`: starts as `"claude"` only.
- `AgentProviderTurnRequest`: the values `AgentManager` currently passes to `AgentRunner.send`:
  - shaped prompt
  - optional provider session id
  - optional stream callback
  - `WorkItemContext`
  - optional model override
  - optional resource limits
  - optional system-prompt override
- `AgentProviderAdapter`: runs one turn and can be aborted by the spawn ticket.

The intended shape is:

```typescript
export type AgentProviderId = "claude";

export interface AgentProviderTurnRequest {
  prompt: string;
  sessionId?: string;
  onStream?: StreamCallback;
  workItemContext?: WorkItemContext;
  modelOverride?: string;
  resourceLimits?: ResourceLimits;
  systemPromptOverride?: string;
}

export interface AgentProviderAdapter {
  readonly provider: AgentProviderId;
  runTurn(request: AgentProviderTurnRequest): Promise<RunResult>;
  abort(): void;
  readonly wasAborted: boolean;
}
```

The contract returns the existing `RunResult` shape from `agent-runner.ts`. That is acceptable in B0 because this is an extraction around current behavior, not the final multi-provider telemetry model. The reuse must stay type-only at the boundary; shared adapter types should not introduce new runtime imports from `AgentRunner` beyond the Claude adapter implementation itself. If B2/B3 find provider-specific result fields that do not map cleanly, they can evolve the result type in their own tickets.

Adapter lifetime is per spawn attempt. `AgentManager.runOneSpawnAttempt` creates a fresh adapter inside the active spawn ticket, attaches the ticket abort handle to that adapter, calls `runTurn`, then discards the adapter after the attempt. The auth-rebuild-resume retry creates a second fresh adapter because it calls `runOneSpawnAttempt` again. This mirrors the current fresh-`AgentRunner` lifecycle and keeps abort state scoped to the current attempt.

### Claude Implementation

Create `src/agents/provider-adapters/claude-agent-adapter.ts`.

`ClaudeAgentAdapter` wraps an `AgentRunner` instance:

- `runTurn(request)` delegates to `runner.send(...)`.
- `abort()` delegates to `runner.abort()`.
- `wasAborted` exposes `runner.wasAborted`.
- `provider` is `"claude"`.

The adapter does not move Claude SDK option assembly out of `AgentRunner`. B0's value is the boundary at the `AgentManager` execution handoff. B1 can decide how much of the tool transport and SDK option assembly must become provider-specific before OpenAI/Gemini adapters are viable.

### AgentManager Integration

Rename the private execution factory conceptually from `createRunner(agentId)` to `createProviderAdapter(agentId)`.

`AgentManager` still resolves the agent config, subscriber map, plugins, skill index, memory manager, team roster, database handle, prefetcher, and prefix cache exactly as today. The only change is that it builds a Claude adapter around the current runner and calls:

- `adapter.runTurn(...)` instead of `runner.send(...)`
- `ticket.attachAbort(() => adapter.abort())` instead of `runner.abort()`

The rest of `spawnTurn` remains unchanged:

- `withSpawnTicket` lifecycle
- auth-rebuild-resume retry
- prompt shaping and voice carve-out
- model router override and resource limits
- session-store update
- reflection scheduling
- telemetry, conversation index, and activity audit

### Documentation

Update `docs/architecture.md` so the process model shows:

`Agent manager -> Provider adapter (Claude implementation) -> Agent runner / Claude Agent SDK`

The docs should explicitly say B0 is a no-behavior-change extraction and that provider selection is not available yet.

## Acceptance Criteria

- `AgentManager` depends on `AgentProviderAdapter` for turn execution and abort wiring.
- Claude remains the only runtime provider and all runtime turns still use the existing Claude Agent SDK `query()` path.
- `AgentRunner` behavior is unchanged: prompt assembly, MCP server wiring, hooks, SDK plugins, native skills, sub-agents, cwd/settings, strict MCP config, Claude env, streaming, result parsing, and compaction handling remain in place.
- Existing channel callers do not change their public API usage.
- Voice keeps its `systemPromptOverride` and model-router bypass behavior.
- Auth-rebuild-resume retry still retries once without resume and preserves existing telemetry behavior.
- Stop/abort still aborts the underlying Claude query through the spawn ticket.
- No schema or operator configuration changes are introduced.
- Documentation names the new boundary and its current Claude-only implementation.
- Tests cover the Claude adapter wrapper and the manager's existing spawn behavior remains green.

## Test Requirements

- Unit tests are required for `ClaudeAgentAdapter` delegation and abort behavior.
- Existing `AgentManager` tests must remain green because they cover spawn lifecycle, prompt shaping, model routing, retries, reflection, stop/restart, telemetry, and voice carve-out.
- Existing `AgentRunner` tests must remain green because they cover Claude SDK option assembly and result parsing.
- Broader regression must run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` before implementation is considered ready.

## Dependency Notes

- KPR-232 depends on this boundary being present before tool transport compatibility is designed.
- KPR-233 and KPR-234 should not start runtime implementation until B0 is merged into the epic branch.
- PR #194 may still be useful for sidecar LLM calls, but it is not part of this runtime adapter boundary.
