# Periodic Sweeper — Implementation Specs

## Files to Create

### `src/sweeper/retry-queue.ts`

```typescript
import type { WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "../channels/channel-adapter.js";

interface RetryEntry {
  result: WorkResult;
  adapter: ChannelAdapter;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}

export interface RetryQueueConfig {
  maxAttempts: number;     // default 3
  baseDelayMs: number;     // default 30000
}

export interface RetryQueueStats {
  pending: number;
  retried: number;
  dropped: number;
  errors: string[];
}

export class RetryQueue {
  enqueue(result: WorkResult, adapter: ChannelAdapter): void
  async processRetries(): Promise<RetryQueueStats>
  get size(): number
}
```

- Exponential backoff: `baseDelayMs * 2^attempts`
- On success: remove entry, increment `retried`
- On failure at max attempts: remove entry, increment `dropped`, log error
- On failure below max: update `nextRetryAt`, keep in queue

### `src/sweeper/sweeper.ts`

```typescript
export interface SweepResult {
  component: string;
  pruned: number;
  retried: number;
  bytesFreed: number;
  errors: string[];
}

export interface SweeperConfig {
  intervalMs: number;
  threadTtlMs: number;
  taskFileTtlMs: number;
  meetingSessionTtlMs: number;
  cacheTtlMs: number;
}

export interface SweeperTargets {
  dispatcher: Dispatcher;
  slackAdapters: SlackAdapter[];
  bgTaskManager: BackgroundTaskManager;
  meetingMonitor?: MeetingMonitor;
  taskLedger?: TaskLedger;
  slackGateways: SlackGateway[];
  agentManager: AgentManager;
  retryQueue?: RetryQueue;
}
```

- `start()`: setInterval at config.intervalMs
- `stop()`: clearInterval
- `sweep()`: calls each component sequentially, aggregates results, logs, reports to dodi_v2
- SlackGateway sweep runs every 12th cycle (~1h at 5min interval)
- dodi_v2 reporting: creates `[Sweeper]` task on first meaningful sweep, adds comment each cycle

## Files to Modify

### `src/config.ts`

Add sweeper config block:
```typescript
sweeper: {
  intervalMs: parseInt(optional("SWEEPER_INTERVAL_MS", "300000"), 10),
  threadTtlMs: parseInt(optional("SWEEPER_THREAD_TTL_MS", "86400000"), 10),
  taskFileTtlMs: parseInt(optional("SWEEPER_TASK_FILE_TTL_MS", "604800000"), 10),
  meetingSessionTtlMs: parseInt(optional("SWEEPER_MEETING_TTL_MS", "3600000"), 10),
  cacheTtlMs: parseInt(optional("SWEEPER_CACHE_TTL_MS", "3600000"), 10),
  retryMaxAttempts: parseInt(optional("SWEEPER_RETRY_MAX_ATTEMPTS", "3"), 10),
  retryBaseDelayMs: parseInt(optional("SWEEPER_RETRY_BASE_DELAY_MS", "30000"), 10),
},
```

### `src/channels/dispatcher.ts`

1. Add parallel `threadAgentLastSeen = new Map<string, number>()`
2. Touch timestamp in `dispatch()` after `threadAgentMap.set()` and in `resolveAgent()` on hit
3. Add `sweep(threadTtlMs: number): SweepResult` method
4. Add `retryQueue?: RetryQueue` field + `setRetryQueue()` setter
5. Wrap all 5 `adapter.deliver()` call sites in try/catch that enqueues to retryQueue on failure:
   - Line ~136 (triage done delivery)
   - Line ~152 (triage continue ack)
   - Line ~199 (full agent response)
   - Line ~229 (error response)
   - Line ~82 (status query response)

### `src/channels/slack-adapter.ts`

1. Move module-level `threadContextMap` into class as instance field
2. Add parallel `threadContextLastSeen = new Map<string, number>()`
3. Touch timestamp in `onThreadStarted` and `onThreadContextChanged` handlers
4. Add `sweep(threadTtlMs: number): SweepResult` method

### `src/agents/agent-manager.ts`

Add `sweep(): SweepResult` method:
1. Remove zombie states for agents not in registry (status === "stopped" and not in registry)
2. Detect stuck processing flags (threadKey in `processing` but no active runner for that agent)
3. Call `retryDeferredThreads()` for ALL agents with deferred queues (not just one)

### `src/background/background-task-manager.ts`

Add `async sweep(taskFileTtlMs: number): Promise<SweepResult>`:
1. Iterate `this.tasks` map
2. Skip tasks with status === "running"
3. For completed/failed tasks older than TTL: delete map entry, unlink .json and .log files
4. Track bytes freed via `fs.stat()` before unlink

### `src/recall/meeting-monitor.ts`

1. Add `endedAt: number | null` field to MeetingSession interface
2. Set `endedAt = Date.now()` in `dispatchEnd()` when session status changes to "ended"
3. Add `sweep(sessionTtlMs: number): SweepResult`:
   - Remove sessions where `endedAt !== null && endedAt + ttl < now`
   - Also remove corresponding `sessionsByBotId` entries
   - Clear any lingering `pollTimer` intervals

### `src/tasks/task-ledger.ts`

1. Add parallel `threadTaskLastSeen = new Map<string, number>()`
2. Touch timestamp in `onDispatch()` and `onComplete()`
3. Add `sweep(threadTtlMs: number): SweepResult` method

### `src/slack/slack-gateway.ts`

Add `sweep(): SweepResult`:
```typescript
sweep(): SweepResult {
  const pruned = this.channelNameCache.size + this.userNameCache.size;
  this.channelNameCache.clear();
  this.userNameCache.clear();
  return { component: "slack-gateway", pruned, retried: 0, bytesFreed: 0, errors: [] };
}
```

### `src/index.ts`

After scheduler start:
1. Create RetryQueue with config
2. Call `dispatcher.setRetryQueue(retryQueue)`
3. Create Sweeper with config + all targets
4. Call `sweeper.start()`
5. Add `sweeper.stop()` to shutdown function (before other stops)

## Testing

1. `SWEEPER_INTERVAL_MS=30000` for fast testing
2. Send messages → verify threadAgentMap entries created → wait for TTL → verify pruned
3. Force delivery failure → verify retry queue picks up and retries
4. Check dodi_v2 dashboard for `[Sweeper]` task with metric comments
5. `npm run build` must pass clean
