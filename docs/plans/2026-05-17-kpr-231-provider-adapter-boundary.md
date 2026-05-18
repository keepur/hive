# KPR-231 Provider Adapter Boundary Implementation Plan

> **For agentic workers:** After this plan is approved, invoke `/spec-and-implement` for KPR-231 per this repo's workflow. The implementation worker should execute this plan through the dodi-dev implementation flow.

**Goal:** Introduce a thin provider adapter seam while preserving the current Claude-only runtime behavior.

**Architecture:** `AgentManager` will call an `AgentProviderAdapter` instead of calling `AgentRunner.send` directly. The first and only adapter is `ClaudeAgentAdapter`, a wrapper around the existing `AgentRunner`; all Claude SDK option assembly remains in `AgentRunner`.

**Tech Stack:** TypeScript, Vitest, existing Claude Agent SDK runtime path, existing Hive `AgentManager`/`AgentRunner`.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/provider-adapters/claude-agent-adapter.ts`
  - Reason: The new seam must prove it delegates run, abort, and aborted-state behavior correctly.
  - Minimum assertions: `runTurn` calls `AgentRunner.send` with the same ordered arguments; `abort` calls `AgentRunner.abort`; `wasAborted` reflects the wrapped runner.

- Integration: `required`
  - Scope: `src/agents/agent-manager.test.ts` and `src/agents/agent-runner.test.ts`
  - Reason: `AgentManager` is the integration boundary between spawn coordination and provider execution, while `AgentRunner` still owns Claude SDK option assembly.
  - Harness: `existing`
  - Minimum assertions: Existing spawn lifecycle, prompt shaping, auth retry, stop/abort, reflection, telemetry, voice carve-out, and Claude SDK option tests remain green.

- E2E: `not-required`
  - Scope: Runtime channel delivery across Slack/SMS/WS/voice.
  - Reason: B0 is a no-behavior-change internal extraction. Existing integration tests cover the changed boundary; real channel E2E belongs to later provider pilot tickets.
  - Harness: `not-applicable`
  - Minimum assertions: Not applicable for B0.

### Critical Flows

- Slack/SMS/WS/scheduler work item enters `runWorkItemTurn`, resolves session, runs one Claude-backed turn, records the returned session id, and preserves telemetry.
- Voice calls `spawnTurn` with `systemPromptOverride`, bypasses model routing and prompt shaping, and still runs through the Claude-backed adapter.
- `stopAgent` aborts the in-flight provider turn through the spawn ticket.
- Auth-rebuild-resume retry calls the same provider adapter path once more without resume.

### Regression Surface

- `AgentManager.spawnTurn`
- `AgentManager.runWorkItemTurn`
- `AgentRunner.send`
- Voice adapter spawn path
- Reflection scheduling
- Turn telemetry and activity audit
- Claude SDK MCP/hook/plugin/skill option assembly

### Commands

- Unit: `npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts`
- Integration: `npx vitest run src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts`
- E2E: Not required for B0.
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- Existing Vitest mocks for `@anthropic-ai/claude-agent-sdk` and `AgentRunner`.
- No real Claude, Slack, MongoDB, or Qdrant access is required for the targeted tests.
- Full `npm run check` requires the same Slack env stubs used by Phase A quality gates.

### Non-Required Rationale

- E2E: B0 does not expose a new provider, new channel path, or new operator setting. E2E smoke should be attached to B2/B3 provider pilots.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- Create `src/agents/provider-adapters/types.ts`
  - Owns the narrow provider adapter TypeScript contract.
- Create `src/agents/provider-adapters/claude-agent-adapter.ts`
  - Wraps the existing `AgentRunner`.
- Create `src/agents/provider-adapters/claude-agent-adapter.test.ts`
  - Unit tests for delegation and abort behavior.
- Modify `src/agents/agent-manager.ts`
  - Replaces direct runner execution in `runOneSpawnAttempt` with the provider adapter seam.
- Modify `docs/architecture.md`
  - Documents the new boundary and current Claude-only implementation.

## Task 1: Add Provider Adapter Types

**Files:**
- Create: `src/agents/provider-adapters/types.ts`

- [ ] **Step 1:** Create the adapter contract.

```typescript
import type { ResourceLimits } from "../model-router.js";
import type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";

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

- [ ] **Step 2:** Verify TypeScript import paths.

Run: `npm run typecheck`

Expected: TypeScript succeeds or only reports later missing files from subsequent planned tasks if this step is run before Task 2.

## Task 2: Add Claude Adapter Wrapper

**Files:**
- Create: `src/agents/provider-adapters/claude-agent-adapter.ts`
- Test: `src/agents/provider-adapters/claude-agent-adapter.test.ts`

- [ ] **Step 1:** Create the Claude adapter.

```typescript
import type { AgentRunner } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";

export class ClaudeAgentAdapter implements AgentProviderAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly runner: AgentRunner) {}

  runTurn(request: AgentProviderTurnRequest) {
    return this.runner.send(
      request.prompt,
      request.sessionId,
      request.onStream,
      request.workItemContext,
      request.modelOverride,
      request.resourceLimits,
      request.systemPromptOverride,
    );
  }

  abort(): void {
    this.runner.abort();
  }

  get wasAborted(): boolean {
    return this.runner.wasAborted;
  }
}
```

- [ ] **Step 2:** Add unit tests.

```typescript
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";

describe("ClaudeAgentAdapter", () => {
  it("delegates runTurn to AgentRunner.send with the current Hive turn shape", async () => {
    const result = { text: "ok", sessionId: "s1" };
    const runner = {
      send: vi.fn().mockResolvedValue(result),
      abort: vi.fn(),
      wasAborted: false,
    };
    const adapter = new ClaudeAgentAdapter(runner as any);
    const onStream = vi.fn();
    const workItemContext = {
      adapterId: "slack",
      channelId: "C1",
      channelKind: "slack",
      channelLabel: "general",
      threadId: "t1",
      slackTs: "123",
      slackThreadTs: "123",
    };
    const resourceLimits = { timeoutMs: 60_000, maxTurns: 12, budgetUsd: 1 };

    await expect(
      adapter.runTurn({
        prompt: "hello",
        sessionId: "s0",
        onStream,
        workItemContext,
        modelOverride: "claude-haiku-4-5",
        resourceLimits,
        systemPromptOverride: "voice prompt",
      }),
    ).resolves.toBe(result);

    expect(runner.send).toHaveBeenCalledWith(
      "hello",
      "s0",
      onStream,
      workItemContext,
      "claude-haiku-4-5",
      resourceLimits,
      "voice prompt",
    );
  });

  it("delegates abort and exposes aborted state", () => {
    const runner = {
      send: vi.fn(),
      abort: vi.fn(),
      wasAborted: true,
    };
    const adapter = new ClaudeAgentAdapter(runner as any);

    adapter.abort();

    expect(adapter.provider).toBe("claude");
    expect(runner.abort).toHaveBeenCalledTimes(1);
    expect(adapter.wasAborted).toBe(true);
  });
});
```

- [ ] **Step 3:** Run focused unit tests.

Run: `npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts`

Expected: The new adapter test file passes.

## Task 3: Route AgentManager Through the Adapter

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Test: `src/agents/agent-manager.test.ts`

- [ ] **Step 1:** Update imports.

```typescript
import { AgentRunner, DIST_DIR, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import { ClaudeAgentAdapter } from "./provider-adapters/claude-agent-adapter.js";
import type { AgentProviderAdapter } from "./provider-adapters/types.js";
```

- [ ] **Step 2:** Rename the private factory and return the adapter.

Replace `private createRunner(agentId: string): AgentRunner` with:

```typescript
  private createProviderAdapter(agentId: string): AgentProviderAdapter {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    const runner = new AgentRunner(
      config,
      this.memoryManager,
      this.plugins,
      this.skillIndex,
      eventSubscribersJson,
      this.prefetcher,
      this.teamRoster,
      this.db,
      this.prefixCache,
    );
    return new ClaudeAgentAdapter(runner);
  }
```

- [ ] **Step 3:** Update `runOneSpawnAttempt`.

Replace the local runner construction and direct `runner.send` call with:

```typescript
    const adapter = this.createProviderAdapter(ctx.agentId);
    ticket.attachAbort(() => adapter.abort());

    const bgContext: WorkItemContext = {
      adapterId: ctx.workItem.source.adapterId ?? ctx.workItem.source.kind,
      channelId: ctx.channelId,
      channelKind: ctx.workItem.source.kind,
      channelLabel: ctx.workItem.source.label,
      threadId: ctx.threadId,
      slackTs: (ctx.workItem.meta?.slackTs as string) ?? "",
      slackThreadTs: (ctx.workItem.meta?.slackThreadTs as string) ?? "",
    };

    const result = await adapter.runTurn({
      prompt: shaping.prompt,
      sessionId: ctx.sessionId,
      onStream,
      workItemContext: bgContext,
      modelOverride: shaping.modelOverride,
      resourceLimits: shaping.resourceLimits,
      systemPromptOverride: ctx.systemPromptOverride,
    });
```

Keep the existing router-cost addition immediately after `result` is returned:

```typescript
    result.costUsd += shaping.routerCostUsd;
    return result;
```

- [ ] **Step 4:** Run focused integration tests.

Run: `npx vitest run src/agents/agent-manager.test.ts`

Expected: Existing AgentManager tests pass with no behavior changes.

## Task 4: Document the Boundary

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Update the process diagram.

Change the lower runtime path to:

```text
       Agent manager (spawn coordinator: per-thread lock + per-agent budget)
            ↓
       Provider adapter (Claude implementation today)
            ↓
       Agent runner (assembles Claude Agent SDK query options, fresh per turn)
            ↓
       Claude Agent SDK owns the agent loop
```

- [ ] **Step 2:** Update the explanatory paragraph.

Add a short paragraph after the Agent Manager description:

```markdown
KPR-231 introduces the provider adapter seam. In the current engine the only provider implementation is Claude, and the Claude adapter delegates to the existing `AgentRunner`. No operator-facing provider selection exists yet; OpenAI and Gemini pilots belong to later KPR-230 child tickets.
```

- [ ] **Step 3:** Run formatting check.

Run: `npm run format:check`

Expected: Prettier reports all matched files use configured style.

## Task 5: Regression Gate and Handoff

**Files:**
- Verify all files changed by Tasks 1-4.

- [ ] **Step 1:** Run targeted adapter and runtime tests.

Run:

```bash
npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts
```

Expected: All targeted tests pass.

- [ ] **Step 2:** Run full check.

Run:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: TypeScript, ESLint, format check, and Vitest all pass.

- [ ] **Step 3:** Commit the implementation on the child branch.

```bash
git add src/agents/provider-adapters/types.ts \
  src/agents/provider-adapters/claude-agent-adapter.ts \
  src/agents/provider-adapters/claude-agent-adapter.test.ts \
  src/agents/agent-manager.ts \
  docs/architecture.md
git commit -m "KPR-231: introduce Claude provider adapter boundary"
```

Expected: Commit succeeds and `git status --short` is clean.
