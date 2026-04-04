# Activity Log Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add a queryable, MongoDB-backed audit trail that records one entry per agent turn — answering "what did my agents do today?" without log mining.

**Architecture:** A singleton `ActivityLogger` buffers turn-level records in memory (up to 200) and bulk-flushes to a `activity_log` MongoDB collection on a 30-second timer, when the buffer fills, or on graceful shutdown. Integration is a single call in `AgentManager` after each `runner.send()` completes.

**Tech Stack:** TypeScript, MongoDB (bulk `insertMany`), existing `config.ts` pattern

---

### File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/activity/activity-logger.ts` | Create | `ActivityLogger` class — buffer, flush, shutdown drain, DB setup |
| `src/activity/types.ts` | Create | `ActivityRecord` interface |
| `src/config.ts` | Modify | Add `activity` config section |
| `src/agents/agent-manager.ts` | Modify | Import and call `activityLogger.record()` after each turn |
| `src/index.ts` | Modify | Instantiate `ActivityLogger`, connect, wire into shutdown |

---

### Task 1: ActivityRecord Type

**Files:**
- Create: `src/activity/types.ts`

- [ ] **Step 1:** Create the type file:

```typescript
export interface ActivityRecord {
  // Identity
  agentId: string;
  threadId: string;
  timestamp: Date;

  // Source
  sender: string;
  senderName?: string;
  channel: string;
  channelKind: string;

  // Model
  model: string;
  modelTier?: string;

  // Cost & performance
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;

  // Tools
  toolCalls: number;
  toolSummary: string;

  // Compaction
  compactions: number;

  // Outcome
  streamed: boolean;
  error?: string;
}
```

- [ ] **Step 2:** Commit

```bash
git add src/activity/types.ts
git commit -m "feat(#82): add ActivityRecord type"
```

---

### Task 2: Activity Config

**Files:**
- Modify: `src/config.ts:249-259` (before the closing `} as const`)

- [ ] **Step 1:** Add `activity` config section after `events` and before `browser`:

```typescript
  activity: {
    enabled: (hive.activity?.enabled ?? true) && process.env.ACTIVITY_LOG_ENABLED !== "false",
    bufferSize: parseInt(optional("ACTIVITY_BUFFER_SIZE", String(hive.activity?.bufferSize ?? 200)), 10),
    flushIntervalMs: parseInt(optional("ACTIVITY_FLUSH_INTERVAL_MS", String(hive.activity?.flushIntervalMs ?? 30000)), 10),
    retentionDays: parseInt(optional("ACTIVITY_RETENTION_DAYS", String(hive.activity?.retentionDays ?? 90)), 10),
  },
```

- [ ] **Step 2:** Commit

```bash
git add src/config.ts
git commit -m "feat(#82): add activity log config section"
```

---

### Task 3: ActivityLogger Class

**Files:**
- Create: `src/activity/activity-logger.ts`

- [ ] **Step 1:** Create the full `ActivityLogger` class:

```typescript
import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { ActivityRecord } from "./types.js";

const log = createLogger("activity-logger");

interface ActivityLogConfig {
  enabled: boolean;
  bufferSize: number;
  flushIntervalMs: number;
  retentionDays: number;
}

export class ActivityLogger {
  private collection!: Collection<ActivityRecord>;
  private buffer: ActivityRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: ActivityLogConfig;
  private connected = false;

  constructor(private db: Db, config: ActivityLogConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      log.info("Activity log disabled");
      return;
    }

    this.collection = this.db.collection<ActivityRecord>("activity_log");

    // Index: per-agent queries sorted by time
    await this.collection.createIndex(
      { agentId: 1, timestamp: -1 },
    );

    // TTL index: auto-delete old records
    await this.collection.createIndex(
      { timestamp: 1 },
      { expireAfterSeconds: this.config.retentionDays * 24 * 60 * 60 },
    );

    this.connected = true;

    // Start periodic flush
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) =>
        log.warn("Periodic flush failed", { error: String(err) }),
      );
    }, this.config.flushIntervalMs);

    const count = await this.collection.estimatedDocumentCount();
    log.info("Activity log connected", { records: count, retentionDays: this.config.retentionDays });
  }

  /**
   * Buffer an activity record. Triggers immediate flush if buffer is full.
   */
  record(entry: ActivityRecord): void {
    if (!this.config.enabled || !this.connected) return;

    this.buffer.push(entry);

    if (this.buffer.length >= this.config.bufferSize) {
      this.flush().catch((err) =>
        log.warn("Buffer-full flush failed", { error: String(err) }),
      );
    }
  }

  /**
   * Flush buffered records to MongoDB via bulk insertMany.
   * Retries once on failure, then drops the batch.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);

    try {
      await this.collection.insertMany(batch, { ordered: false });
    } catch (err) {
      log.warn("Bulk write failed, retrying once", {
        count: batch.length,
        error: String(err),
      });
      try {
        await this.collection.insertMany(batch, { ordered: false });
      } catch (retryErr) {
        log.error("Bulk write failed after retry, dropping batch", {
          count: batch.length,
          error: String(retryErr),
        });
        // Don't re-add to buffer — drop and move on
      }
    }
  }

  /**
   * Stop the flush timer and drain remaining buffer.
   * Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length > 0) {
      log.info("Draining activity buffer on shutdown", { count: this.buffer.length });
      await this.flush();
    }
  }
}
```

- [ ] **Step 2:** Commit

```bash
git add src/activity/activity-logger.ts
git commit -m "feat(#82): add ActivityLogger with buffered bulk writes"
```

---

### Task 4: Integrate into AgentManager

**Files:**
- Modify: `src/agents/agent-manager.ts:1-18` (imports)
- Modify: `src/agents/agent-manager.ts:27-45` (constructor)
- Modify: `src/agents/agent-manager.ts:214-233` (after `runner.send()` result)

- [ ] **Step 1:** Add import at top of file:

```typescript
import type { ActivityLogger } from "../activity/activity-logger.js";
```

- [ ] **Step 2:** Add `activityLogger` to constructor and field:

Add field to the class:
```typescript
private activityLogger?: ActivityLogger;
```

Add optional parameter to constructor:
```typescript
constructor(
  registry: AgentRegistry,
  memoryManager: MemoryManager,
  sessionStore: SessionStore,
  activityLogger?: ActivityLogger,
) {
  this.registry = registry;
  this.memoryManager = memoryManager;
  this.sessionStore = sessionStore;
  this.activityLogger = activityLogger;
  this.plugins = loadPlugins(appConfig.plugins, process.cwd());
  this.skillIndex = loadSkillIndex();
}
```

- [ ] **Step 3:** Record activity after each turn completes. Insert after the conversation indexing block (after line 233), before the `catch`:

```typescript
        // Record activity for audit trail
        this.activityLogger?.record({
          agentId,
          threadId,
          timestamp: new Date(),
          sender: item.message.sender,
          senderName: item.message.senderName,
          channel: item.message.source.label,
          channelKind: item.message.source.kind,
          model: modelOverride ?? config?.model ?? "unknown",
          modelTier: modelOverride ? undefined : undefined, // Model router tier not currently passed through
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          contextWindow: result.contextWindow,
          toolCalls: result.toolCalls,
          toolSummary: result.toolSummary,
          compactions: result.compactions,
          streamed: result.streamed,
          error: result.error,
        });
```

Note: `modelTier` requires the model router result to be passed through. For now, leave as undefined — it can be added when the router result is threaded through (minor follow-up).

Also record exception turns in the `catch` block (line 234) so crashed turns aren't silently dropped from the audit trail:

```typescript
      } catch (err) {
        const state = this.states.get(agentId);
        if (state) {
          state.errorCount++;
          state.lastActivity = new Date();
        }
        // Record failed turn in audit trail
        this.activityLogger?.record({
          agentId,
          threadId,
          timestamp: new Date(),
          sender: item.message.sender,
          senderName: item.message.senderName,
          channel: item.message.source.label,
          channelKind: item.message.source.kind,
          model: modelOverride ?? config?.model ?? "unknown",
          costUsd: 0,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: 0,
          toolCalls: 0,
          toolSummary: "none",
          compactions: 0,
          streamed: false,
          error: String(err),
        });
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
```

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(#82): wire ActivityLogger into AgentManager turn processing"
```

---

### Task 5: Wire into Application Bootstrap and Shutdown

**Files:**
- Modify: `src/index.ts:125-146` (after sessionStore, before agentManager)
- Modify: `src/index.ts:387-408` (shutdown handler)

- [ ] **Step 1:** Add import at top of `index.ts`:

```typescript
import { ActivityLogger } from "./activity/activity-logger.js";
```

- [ ] **Step 2:** Instantiate and connect after `sessionStore.connect()` (after line 126). The shared `mongoClient` and `db` already exist at lines 42-44:

```typescript
  let activityLogger: ActivityLogger | undefined;
  if (config.activity.enabled) {
    activityLogger = new ActivityLogger(db, config.activity);
    await activityLogger.connect();
  }
```

- [ ] **Step 3:** Pass `activityLogger` to `AgentManager` constructor (line 146):

```typescript
  agentManager = new AgentManager(registry, memoryManager, sessionStore, activityLogger);
```

- [ ] **Step 4:** Add to shutdown handler (line 388-408), before `sessionStore.close()`:

```typescript
    if (activityLogger) await activityLogger.stop();
```

- [ ] **Step 5:** Commit

```bash
git add src/index.ts
git commit -m "feat(#82): bootstrap ActivityLogger and wire into shutdown"
```

---

### Task 6: Build & Type Check

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

- [ ] **Step 3:** Commit any fixes if needed, then verify with:

```bash
git log --oneline -5
```

---

## Summary

| What | How |
|------|-----|
| **Record schema** | `ActivityRecord` — one record per agent turn with identity, source, model, cost, tools, outcome |
| **Buffering** | In-memory array, flush at 200 records or 30s interval |
| **Persistence** | `activity_log` MongoDB collection, bulk `insertMany`, `ordered: false` |
| **Retention** | TTL index, default 90 days, configurable via `hive.yaml` |
| **Integration** | Single `activityLogger.record(...)` call in `AgentManager.processThreadQueue()` |
| **Shutdown** | `activityLogger.stop()` drains buffer before exit |
| **Config** | `activity.enabled/bufferSize/flushIntervalMs/retentionDays` in `hive.yaml` + env vars |
| **Estimated scope** | ~200 lines across 5 files |

## What We're NOT Building

- **Event-level logging** — no individual tool call records. Turn-level only for v1.
- **Query API** — activity is in MongoDB, query it directly. No REST endpoint for now.
- **Dashboard** — raw data only. Visualization is a product feature for later.
- **Per-agent collections** — single collection, filtered by `agentId`.
