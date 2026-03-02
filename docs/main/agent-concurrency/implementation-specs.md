# Implementation Specs: Agent Concurrency

## Files to Modify

### 1. `src/types/agent-config.ts`

**AgentConfig** — add two optional fields:
```typescript
maxConcurrent?: number;  // Max concurrent threads per agent. Default 3
timeoutMs?: number;      // Response timeout in ms. Default 300000 (5 min)
```

**AgentState** — add:
```typescript
activeThreadCount: number;  // Number of threads currently processing
```

### 2. `src/agents/agent-registry.ts`

In `loadAgent()`, parse new fields:
```typescript
maxConcurrent: (raw.maxConcurrent as number) || undefined,
timeoutMs: (raw.timeoutMs as number) || undefined,
```

### 3. `src/agents/agent-manager.ts` (major rewrite)

**Data structures** — change from per-agent to per-thread:
- `queues: Map<string, QueuedMessage[]>` — key changes from `agentId` to `threadKey` (`${agentId}:${threadId}`)
- `processing: Set<string>` — tracks `threadKey` instead of `agentId`
- Remove `runners: Map<string, AgentRunner>` singleton
- Add `activeRunners: Map<string, Set<AgentRunner>>` — `agentId` -> set of active runners
- Add `activeThreads: Map<string, Set<string>>` — `agentId` -> set of active threadKeys

**sendMessage()** — queue by threadKey:
```typescript
const threadId = message.threadId ?? message.id;
const threadKey = `${agentId}:${threadId}`;
// queue under threadKey, call processThreadQueue(agentId, threadKey)
```

**processThreadQueue(agentId, threadKey)** — replaces processQueue():
1. Check `this.processing.has(threadKey)` — serialize within same thread
2. Check concurrency limit: `activeThreads.get(agentId).size >= maxConcurrent` — defer if at limit
3. Create fresh runner via `createRunner(agentId)`
4. Register runner in `activeRunners`
5. Process queue items sequentially (same thread = same conversation)
6. On completion: unregister runner, remove threadKey from activeThreads, call retryDeferredThreads()

**createRunner(agentId)** — factory method:
```typescript
private createRunner(agentId: string): AgentRunner {
  const config = this.registry.get(agentId);
  if (!config) throw new Error(`Unknown agent: ${agentId}`);
  return new AgentRunner(config, this.memoryManager);
}
```

**retryDeferredThreads(agentId)** — pick up waiting threads:
```typescript
// Scan queues for threadKeys starting with `${agentId}:` that aren't processing
// Start the first one found (respecting concurrency limit)
```

**stopAgent()** — abort all active runners:
```typescript
const runners = this.activeRunners.get(agentId);
if (runners) { for (const r of runners) r.abort(); runners.clear(); }
```

**State initialization** — include `activeThreadCount: 0` in initial AgentState.

### 4. `src/agents/agent-runner.ts`

In `send()`, wrap the `for await` loop with a timeout:
```typescript
const timeoutMs = this.agentConfig.timeoutMs ?? 300_000;
const deadline = setTimeout(() => {
  log.warn("Agent query timed out, aborting", { agent: this.agentConfig.id, timeoutMs });
  this.abort();
}, timeoutMs);

try {
  for await (const message of q) { /* existing logic */ }
} finally {
  clearTimeout(deadline);
}
```

### 5. `src/health/health-reporter.ts`

**HealthReport interface** — add `activeThreads: number` to agent entry.

**generateReport()** — include `activeThreads: state.activeThreadCount ?? 0`.

**formatForSlack()** — show thread count when processing:
```typescript
const threadInfo = info.activeThreads > 0 ? ` (${info.activeThreads} threads)` : "";
lines.push(`${statusEmoji} *${id}*${threadInfo}`);
```

## Testing

1. `npm run build` — compiles clean
2. Restart Hive and send two messages in different threads rapidly — both should respond concurrently
3. Send a message while cron job is running — should not block
4. Verify timeout: a very slow prompt should auto-abort after 5 min
5. Health status should show active thread count
