# Memory Purge — Design Spec

**Date**: 2026-03-25
**Status**: Draft
**Scope**: Add `memory_purge` tool to structured memory MCP server

## Problem

Agents can only delete memories one at a time via `memory_forget(id)`. When an agent has stale memories from a deprecated workflow (e.g., Milo's old pipeline-review format), cleanup requires recalling each record individually and deleting them one by one. This is slow, error-prone, and impractical for agents acting autonomously (scheduled reviews, notification responses).

## Design

### New Tool: `memory_purge`

Bulk soft-delete of memory records by filter. Agent-scoped — can only purge own memories.

**Parameters** (at least one required):

| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Exact match on topic tag |
| `type` | `fact \| task \| interaction \| preference \| decision` | Filter by memory type |
| `importance` | `critical \| high \| medium \| low` | Filter by importance |
| `tier` | `hot \| warm \| cold` | Filter by current tier |
| `olderThan` | string (ISO date) | Records with `updatedAt` before this date |

**Behavior**:
- All filters are AND-ed together
- At least one filter is required (rejects empty filter to prevent accidental full purge)
- Pinned records are excluded from purge (must be unpinned first)
- Sets `purged: true` and `purgedAt: Date` on matching records
- Returns count of purged records + summary of what was matched

**Response format**:
```
Purged 12 memories matching topic:"pipeline-review" type:task
```

### Soft Delete

Purged records are not immediately destroyed. They become invisible to the agent but recoverable for a retention period.

**Record changes** — add two fields to `MemoryRecord`:

```typescript
purged: boolean;      // default false
purgedAt?: Date;
```

**Exclusion** — purged records are filtered out by adding `purged: { $ne: true }` to these store queries:
- `getHotTier()` — prompt injection
- `getAllNonPinned()` — lifecycle scoring
- `getByIds()` — used by `memory_recall` (without this, Qdrant matches on purged records would still return data)
- `getColdByTopic()` / `getColdTopics()` — summarization

**Qdrant ghost results** — between purge and hard-delete, Qdrant still returns vector matches for purged records. These are filtered out at the MongoDB layer (`getByIds` excludes them), but they count against the search `limit`. This means an agent who just purged 50 records on a topic may get fewer real results than expected for a few search calls. Acceptable trade-off — the alternative (immediate Qdrant deletion) would make purge slow and add failure modes.

**Hard delete** — the sweeper hard-deletes purged records (MongoDB + Qdrant vectors) after a configurable retention period (default: 7 days).

### Store Changes

New methods on `MemoryStore`:

```typescript
async purge(agentId: string, filters: PurgeFilters): Promise<number>
async deletePurgedOlderThan(agentId: string, before: Date): Promise<number>
```

`PurgeFilters` type:

```typescript
interface PurgeFilters {
  topic?: string;
  type?: MemoryType;
  importance?: MemoryImportance;
  tier?: MemoryTier;
  olderThan?: Date;
}
```

The `purge` method builds a MongoDB query from filters, adds `{ agentId, pinned: false, purged: { $ne: true } }`, and does `updateMany({ $set: { purged: true, purgedAt: new Date() } })`.

### Embedder Changes

No immediate Qdrant removal on purge. Vectors for purged records are cleaned up during hard delete (sweeper). This keeps the purge operation fast and avoids N Qdrant API calls.

Search results from Qdrant that reference purged MongoDB records are already handled — `memory_recall` bulk-fetches from MongoDB and skips missing/filtered records.

### Sweeper Integration

Add to the existing memory lifecycle sweep (runs every 6 hours):

```
Phase 5: Hard-delete purged records older than retention period
  - Query: { purged: true, purgedAt: { $lt: retentionCutoff } }
  - Delete from MongoDB
  - Remove vectors from Qdrant (batch by qdrantPointId)
```

### Config

Add to `memory` section in `hive.yaml`:

```yaml
memory:
  purgeRetentionDays: 7  # how long soft-deleted records are kept
```

Default: 7 days. Env var override: `MEMORY_PURGE_RETENTION_DAYS`.

## Deletion Semantics

Two deletion paths exist, intentionally different:

- **`memory_forget`** — single record, hard-delete (immediate MongoDB + Qdrant removal). For intentional, precise removal where the agent knows exactly what they're deleting.
- **`memory_purge`** — bulk filter, soft-delete with 7-day retention. For cleanup sweeps where the blast radius is larger and recoverability matters.

This is a deliberate design choice: forget is a scalpel, purge is a broom with a dustpan.

## Files to Change

| File | Change |
|------|--------|
| `src/memory/memory-types.ts` | Add `purged`, `purgedAt` to `MemoryRecord`; add `PurgeFilters` interface |
| `src/memory/memory-store.ts` | Add `purge()`, `deletePurgedOlderThan()` methods; add `purged: { $ne: true }` to `getHotTier`, `getAllNonPinned`, `getByIds`, `getColdByTopic`, `getColdTopics`; add index `{ agentId: 1, purged: 1, purgedAt: 1 }` in `init()` |
| `src/memory/structured-memory-mcp-server.ts` | Register `memory_purge` tool |
| `src/memory/memory-lifecycle.ts` | Add hard-delete phase for purged records |
| `src/config.ts` | Add `purgeRetentionDays` to `MemoryLifecycleConfig`, pattern: `hive.memory?.purgeRetentionDays` with env var fallback `MEMORY_PURGE_RETENTION_DAYS` |

## Not In Scope

- Cross-agent purge (admin tool) — separate feature if needed
- Undo/restore tool — manual MongoDB query for now; recovery is `db.agent_memory.updateMany({purged: true, ...}, {$unset: {purged: "", purgedAt: ""}})`
- Content/regex matching — can be added later if topic/type filters prove insufficient
