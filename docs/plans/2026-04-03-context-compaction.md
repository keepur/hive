# Context Compaction Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Issue:** #78
**Spec:** `docs/specs/2026-04-02-borrow-from-claude-code.md` (Priority 1)

**Goal:** Wire Hive into the SDK's built-in auto-compaction system — track token usage per turn, observe compaction events, inject agent-specific context before compaction, and expose the 1M context beta as an opt-in flag.

**Architecture:** The Claude Agent SDK (`v0.2.63`) already auto-compacts conversations when they approach the context window limit. Hive currently ignores all compaction-related messages and doesn't track token usage. This plan adds: (1) per-turn token tracking from `SDKAssistantMessage.message.usage`, (2) compaction event handling from `SDKCompactBoundaryMessage`, (3) a `PreCompact` hook to inject agent-specific instructions so summaries preserve the right context, (4) token/compaction metadata in `RunResult` and `SessionDoc`, and (5) an opt-in `betas` field on `AgentDefinition` for the 1M context window.

**Tech Stack:** TypeScript, Claude Agent SDK hooks, MongoDB

---

### File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/agents/agent-runner.ts` | Modify | Token tracking in response loop, `PreCompact` hook, compaction event handling, `betas` passthrough |
| `src/agents/agent-runner.ts` (`RunResult`) | Modify | Add token usage + compaction fields |
| `src/agents/session-store.ts` | Modify | Add compaction metadata to `SessionDoc` |
| `src/types/agent-config.ts` | Modify | Add `betas` field to `AgentConfig` |
| `src/types/agent-definition.ts` | Modify | Add `betas` field to `AgentDefinition`, wire through `toAgentConfig` |
| `src/config.ts` | Modify | Add `compaction` config section |
| `src/agents/agent-manager.ts` | Modify | Log compaction stats from `RunResult` |

---

### Task 1: Extend RunResult with Token Usage and Compaction Data

**Files:**
- Modify: `src/agents/agent-runner.ts:27-39`

- [ ] **Step 1:** Add token usage and compaction fields to `RunResult`

```typescript
export interface RunResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  llmMs: number;
  toolMs: number;
  toolCalls: number;
  toolSummary: string;
  streamed: boolean;
  error?: string;
  aborted?: boolean;
  // Token usage (from SDKResultMessage.usage / modelUsage)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;       // model's context window size
  // Compaction events observed during this turn
  compactions: number;          // how many compaction boundaries were observed
  preCompactTokens?: number;    // token count before last compaction (from compact_metadata.pre_tokens)
}
```

- [ ] **Step 2:** Initialize the new fields in `send()` alongside existing tracking variables (after line 756):

```typescript
let inputTokens = 0;
let outputTokens = 0;
let cacheReadTokens = 0;
let cacheCreationTokens = 0;
let contextWindow = 0;
let compactions = 0;
let preCompactTokens: number | undefined;
```

- [ ] **Step 3:** Return the new fields in the result object (line 904):

Update the return statement to include:
```typescript
return {
  text: resultText,
  sessionId: resultSessionId,
  costUsd,
  durationMs,
  llmMs,
  toolMs: totalToolMs,
  toolCalls: toolCalls.length,
  toolSummary: toolSummary || "none",
  streamed,
  error,
  aborted: this._aborted,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  contextWindow,
  compactions,
  preCompactTokens,
};
```

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#78): extend RunResult with token usage and compaction fields"
```

---

### Task 2: Track Token Usage from SDK Messages

**Files:**
- Modify: `src/agents/agent-runner.ts:800-840` (response loop)

- [ ] **Step 1:** Import `SDKAssistantMessage` type (if not re-exported, use inline cast). Extract per-turn token usage from `assistant` messages.

Add inside the `msg.type === "assistant"` block (after line 823):

```typescript
if (msg.type === "assistant") {
  const assistantMsg = msg as any;
  // Extract per-turn usage from BetaMessage.usage
  const usage = assistantMsg.message?.usage;
  if (usage) {
    inputTokens = usage.input_tokens ?? 0;
    outputTokens = usage.output_tokens ?? 0;
    cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  }
  // ... existing content processing ...
}
```

Note: `input_tokens` on `assistant` messages represents the total input tokens for that API call (cumulative conversation context), so the last assistant message's `input_tokens` reflects current context size. We track the latest values, not cumulative sums.

- [ ] **Step 2:** Extract aggregate usage and `contextWindow` from the `result` message.

Add inside the `msg.type === "result"` block (after line 829):

```typescript
if (msg.type === "result") {
  const result = msg as SDKResultMessage;
  costUsd = result.total_cost_usd;
  durationMs = result.duration_ms;
  resultSessionId = result.session_id;

  // Extract aggregate token usage
  if ("usage" in result && result.usage) {
    inputTokens = (result.usage as any).input_tokens ?? inputTokens;
    outputTokens = (result.usage as any).output_tokens ?? outputTokens;
    cacheReadTokens = (result.usage as any).cache_read_input_tokens ?? cacheReadTokens;
    cacheCreationTokens = (result.usage as any).cache_creation_input_tokens ?? cacheCreationTokens;
  }

  // Extract contextWindow from modelUsage (per-model breakdown)
  if ("modelUsage" in result && result.modelUsage) {
    const modelUsage = result.modelUsage as Record<string, any>;
    for (const model of Object.values(modelUsage)) {
      if (model.contextWindow) {
        contextWindow = model.contextWindow;
        break;
      }
    }
  }

  // ... existing subtype handling ...
}
```

- [ ] **Step 3:** Update the "Agent response complete" log line to include token stats:

```typescript
log.info("Agent response complete", {
  agent: this.agentConfig.id,
  sessionId: resultSessionId,
  costUsd,
  durationMs,
  llmMs,
  toolMs: totalToolMs,
  toolCalls: toolCalls.length,
  toolSummary: toolSummary || "none",
  inputTokens,
  outputTokens,
  cacheReadTokens,
  contextWindow,
  compactions,
  streamed,
  hasError: !!error,
});
```

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#78): track per-turn token usage from SDK assistant and result messages"
```

---

### Task 3: Handle Compaction Events

**Files:**
- Modify: `src/agents/agent-runner.ts:772-841` (response loop)

- [ ] **Step 1:** Add handler for `compact_boundary` system messages inside the `for await` loop, after the existing `system.init` handler:

```typescript
// Compaction boundary — SDK auto-compacted the conversation
if (msg.type === "system" && (msg as any).subtype === "compact_boundary") {
  const metadata = (msg as any).compact_metadata;
  compactions++;
  preCompactTokens = metadata?.pre_tokens;
  log.info("Conversation compacted", {
    agent: this.agentConfig.id,
    sessionId: resultSessionId,
    trigger: metadata?.trigger,
    preTokens: metadata?.pre_tokens,
    compactionNumber: compactions,
  });
}
```

- [ ] **Step 2:** Add handler for `status` system messages (informational — log when compaction is in progress):

```typescript
// Compaction status — SDK is mid-compaction
if (msg.type === "system" && (msg as any).subtype === "status") {
  const status = (msg as any).status;
  if (status === "compacting") {
    log.info("Compaction in progress", {
      agent: this.agentConfig.id,
      sessionId: resultSessionId,
    });
  }
}
```

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#78): handle compaction boundary and status events from SDK"
```

---

### Task 4: PreCompact Hook — Inject Agent-Specific Context

**Files:**
- Modify: `src/agents/agent-runner.ts:723-745` (query options)
- Modify: `src/agents/agent-runner.ts:1` (imports)

The `PreCompact` hook fires before the SDK runs compaction. We use it to inject instructions telling the model what to preserve in the summary — the agent's identity, active customer context, open tasks, etc.

- [ ] **Step 1:** Add `PreCompactHookInput`, `HookCallbackMatcher`, and `SyncHookJSONOutput` to the SDK import (line 1). Since these may not be directly importable from the top-level, use inline types with `any` cast if needed.

- [ ] **Step 2:** Build a `PreCompact` hook callback in the `send()` method, before the `query()` call. The hook reads from the agent's soul and name to generate preservation instructions:

```typescript
// PreCompact hook — inject agent-specific context preservation instructions
const preCompactHook = {
  hooks: [
    async () => {
      const agentName = this.agentConfig.name;
      const instructions = [
        `You are ${agentName}. Preserve the following in your compaction summary:`,
        `- Your identity and role (you are an agent in the Hive multi-agent system)`,
        `- All active customer names, deal names, and task references`,
        `- Key decisions made in this conversation`,
        `- Any commitments or promises made to users`,
        `- File paths or code references actively being discussed`,
        `- The current state of any multi-step workflow in progress`,
      ].join("\n");

      return { systemMessage: instructions };
    },
  ],
};
```

- [ ] **Step 3:** Pass the hook in the `query()` options:

```typescript
const q = query({
  prompt,
  options: {
    // ... existing options ...
    hooks: {
      PreCompact: [preCompactHook],
    },
  },
});
```

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#78): add PreCompact hook to inject agent-specific context preservation instructions"
```

---

### Task 5: Add Compaction Metadata to SessionDoc

**Files:**
- Modify: `src/agents/session-store.ts:6-13`
- Modify: `src/agents/session-store.ts:112-123` (`set` method)

- [ ] **Step 1:** Extend `SessionDoc` with compaction tracking fields:

```typescript
interface SessionDoc {
  _id: string;              // "{agentId}:{threadId}"
  agentId: string;
  threadId: string;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  // Token usage (latest turn)
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  // Compaction tracking
  compactions?: number;         // cumulative compaction count for this session
  lastCompactedAt?: Date;
}
```

- [ ] **Step 2:** Extend the `set` method signature to accept optional token/compaction data:

```typescript
interface SessionUpdateData {
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  compacted?: boolean;        // if true, increment compactions counter
}

async set(agentId: string, threadId: string, sessionId: string, data?: SessionUpdateData): Promise<void> {
  await this.withRetry(async () => {
    const now = new Date();
    const update: any = {
      $set: { agentId, threadId, sessionId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    };

    if (data?.inputTokens !== undefined) update.$set.inputTokens = data.inputTokens;
    if (data?.outputTokens !== undefined) update.$set.outputTokens = data.outputTokens;
    if (data?.contextWindow !== undefined) update.$set.contextWindow = data.contextWindow;
    if (data?.compacted) {
      update.$inc = { compactions: 1 };
      update.$set.lastCompactedAt = now;
    }

    await this.collection.updateOne(
      { _id: `${agentId}:${threadId}` },
      update,
      { upsert: true },
    );
  }, undefined, `set(${agentId}:${threadId})`);
}
```

- [ ] **Step 3:** Update all existing callers of `sessionStore.set()` to pass the extra data.

In `agent-manager.ts` (line 189), after `runner.send()` returns:

```typescript
if (result.sessionId && !result.aborted) {
  this.sessionStore.set(agentId, threadId, result.sessionId, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    contextWindow: result.contextWindow,
    compacted: result.compactions > 0,
  });
}
```

Also update the reflection session save in `agent-manager.ts` (line 275):

```typescript
// Persist session so next message picks up post-reflection state
if (reflectionResult.sessionId && !reflectionResult.aborted) {
  const threadId = lastItem.message.threadId ?? lastItem.message.id;
  this.sessionStore.set(agentId, threadId, reflectionResult.sessionId, {
    inputTokens: reflectionResult.inputTokens,
    outputTokens: reflectionResult.outputTokens,
    contextWindow: reflectionResult.contextWindow,
    compacted: reflectionResult.compactions > 0,
  });
}
```

- [ ] **Step 4:** Commit

```bash
git add src/agents/session-store.ts src/agents/agent-manager.ts
git commit -m "feat(#78): track token usage and compaction count in SessionDoc"
```

---

### Task 6: Add betas Field to Agent Definition

**Files:**
- Modify: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts`

- [ ] **Step 1:** Add `betas` to `AgentDefinition`:

```typescript
export interface AgentDefinition {
  // ... existing fields ...

  // Capabilities
  coreServers: string[];
  delegateServers: string[];
  delegatePrompts: Record<string, string>;
  plugins?: string[];
  dodiOpsMode?: "full" | "readonly";
  betas?: string[];  // SDK beta features, e.g. ["context-1m-2025-08-07"]. Default: none. Intentionally string[] (not SdkBeta[]) for forward-compat with new betas before SDK upgrade.

  // ... rest ...
}
```

- [ ] **Step 2:** Add `betas` to `AgentConfig`:

```typescript
export interface AgentConfig {
  // ... existing fields ...
  betas?: string[];  // SDK beta features. Default: none.
  soul: string;
  systemPrompt: string;
}
```

- [ ] **Step 3:** Wire through `toAgentConfig`:

```typescript
betas: doc.betas,
```

- [ ] **Step 4:** Commit

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts
git commit -m "feat(#78): add betas field to AgentDefinition and AgentConfig for opt-in SDK features"
```

---

### Task 7: Pass betas to SDK query()

**Files:**
- Modify: `src/agents/agent-runner.ts:723-745` (query options)

- [ ] **Step 1:** Pass `betas` from agent config to the SDK query options:

```typescript
const q = query({
  prompt,
  options: {
    model: effectiveModel,
    systemPrompt,
    // ... existing options ...
    hooks: {
      PreCompact: [preCompactHook],
    },
    ...(this.agentConfig.betas?.length ? { betas: this.agentConfig.betas as any } : {}),
    // ... existing spreads ...
  },
});
```

- [ ] **Step 2:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#78): pass agent betas config to SDK query options"
```

---

### Task 8: Add Compaction Config to hive.yaml Schema

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1:** Add a `compaction` config section after the `memory` section. This is for future tunability — the SDK auto-compacts by default, but we log and track it:

```typescript
compaction: {
  logEnabled: (hive.compaction?.logEnabled ?? true) && process.env.COMPACTION_LOG_ENABLED !== "false",
},
```

This is intentionally minimal. The SDK controls compaction timing. We're just gating whether we log compaction events (useful if logs get noisy).

- [ ] **Step 2:** Commit

```bash
git add src/config.ts
git commit -m "feat(#78): add compaction config section for log gating"
```

---

### Task 9: Surface Compaction Stats in Agent Manager Logs

**Files:**
- Modify: `src/agents/agent-manager.ts`

- [ ] **Step 1:** After `runner.send()` returns and the result is logged, add compaction-specific logging when compaction occurred:

```typescript
if (result.compactions > 0) {
  log.info("Session compacted during turn", {
    agentId,
    threadId,
    compactions: result.compactions,
    preCompactTokens: result.preCompactTokens,
    postTokens: result.inputTokens,
    contextWindow: result.contextWindow,
    contextUtilization: result.contextWindow
      ? `${Math.round((result.inputTokens / result.contextWindow) * 100)}%`
      : "unknown",
  });
}
```

- [ ] **Step 2:** Commit

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(#78): log compaction stats with context utilization percentage"
```

---

### Task 10: Build & Type Check

- [ ] **Step 1:** Run TypeScript type check:

```bash
npx tsc --noEmit
```

Expected: Clean — no type errors.

- [ ] **Step 2:** Run build:

```bash
npm run build
```

Expected: Clean build to `dist/`.

- [ ] **Step 3:** Commit any fixes if needed.

---

## Summary

| What | How |
|------|-----|
| **Token tracking** | Extract from `SDKAssistantMessage.message.usage` (per-turn) and `SDKResultMessage.usage`/`modelUsage` (aggregate + contextWindow) |
| **Compaction observability** | Handle `compact_boundary` and `status` system messages in the response loop |
| **PreCompact hook** | Inject agent identity + context preservation instructions before SDK compacts |
| **Session metadata** | Store `inputTokens`, `outputTokens`, `contextWindow`, `compactions` in `SessionDoc` |
| **1M context opt-in** | `betas` field on `AgentDefinition`, passed through to SDK `query()`. Empty by default. |
| **Estimated scope** | ~150-200 lines of new/modified code across 6 files |

## What We're NOT Building

- **Custom compaction logic** — the SDK handles this. We observe and enrich, not replace.
- **Manual compaction trigger** — v1 relies on SDK auto-compact. Manual trigger can be added later via the SDK's existing `manual` trigger type.
- **Compaction threshold config** — the SDK controls when to compact. No exposed knob yet.
- **1M context by default** — opt-in only via `betas` field per agent.
