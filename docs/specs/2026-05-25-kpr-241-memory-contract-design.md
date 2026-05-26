# KPR-241 Hive Memory Contract and Bounded Cold-Tier Consolidation

## Summary

Hive memory is not a cache of every fact an agent sees in external systems. It is durable meta-knowledge over systems of record: what the agent learned, why it made a decision, what user/team preferences should shape future work, and where to look for the authoritative source. KPR-241 reasserts that contract at the code boundaries that enforce it — write-time guards at `memory_save`, fidelity enforcement at `memory_recall`, Mongo/Qdrant tier consistency on transitions, bounded paged consolidation with checkpointing, and per-agent operator visibility.

The original ticket scoped write-time quality out. This spec pulls a minimum write-time enforcement slice back in: a contract that is only enforced at consolidation time is a contract that has already been violated. The follow-up surface (LLM-based pre-write classification, agent prompt rewrites) remains out of scope, but deterministic guards at the tool boundary land here.

The Catalyst diagnostics in the ticket are the forcing function: `agent_memory_autodream_state` empty for every agent (autoDream effectively never ran), and three concrete failure modes when it did — run-budget exhaustion, Ollama embed 400 context overflow, and merge-prompt overflow. Cold backlog sizes (jeff 2,358; may 1,906; muriel 358 with 357 sharing one topic) are the canonical recovery target.

## Context

### Code drift from the original design

The crude design principle was:

- Hot: injected into every turn.
- Warm: not injected, full-fidelity Mongo record, semantic-searchable.
- Cold: Mongo record compacted to a summary blob; recall remains possible but vague.

Actual implementation differs at four points:

1. `MemoryStore.setTierBulk` updates Mongo `tier` only; the Qdrant payload `tier` field is not synced. Filtering recall by tier via Qdrant is unreliable.
2. `summarizeCold` creates a separate warm `type: "summary"` record and marks originals `summarized: true`, but `memory_recall` does not filter by `summarized: false`. Until `coldRetentionDays` elapses, Qdrant semantic search can still surface the original cold record.
3. `MemoryLifecycle.summarizeCold` passes **all** cold records for a topic into one Haiku prompt (`src/memory/memory-lifecycle.ts:634` builds `entries`, `:636-642` builds the prompt). For Muriel's 357-record `muriel-behavior` cluster this is one prompt with all 357 records — the merge-prompt overflow.
4. `MemoryEmbedder.upsert` embeds content as-is with no truncation. The Ollama 400 ("input length exceeds the context length") fires on individual oversized records. In `memory_save` the embedder call is fire-and-forget via `.catch`, so saves "succeed" with no Qdrant point — a source of orphans.

### Write-time has no guards

`memory_save` today accepts content, type, topic, importance, persists to Mongo, and fires an async embed. There is no deduplication, no burst guard, no size guard, no shape check, no source-of-record pointer. The Muriel pathology — 357 same-topic `summary`/`decision` records created Apr 1 - May 1, untouched since — is the predictable output of a tool with no write-time discipline.

### autoDream state is minimal

`agent_memory_autodream_state` schema today: `agentId`, `lastDreamAt`, `changedMemoryCount`, `spentUsd`, `llmCalls`, `updatedAt`. No phase, no topic-window position, no error state. There is no place to checkpoint progress within a topic, and partial failure cannot resume — the next run re-attempts from scratch.

## Goals

- Reassert and enforce a memory contract: hot is injected and bounded, warm is full-fidelity recallable, cold is hidden from normal recall.
- Eliminate the three Catalyst failure modes (budget exhaustion, embed overflow, merge-prompt overflow) by bounding every consolidation model call and embed call.
- Make Mongo tier state and Qdrant payload tier consistent on transitions, so tier-filtered recall is trustworthy.
- Add minimum write-time guards at the `memory_save` boundary so the consolidation backlog stops growing as fast as the sweeper drains it.
- Add per-agent checkpointing so partial failures resume and oversized backlogs converge across passes.
- Make one bad record (oversized) never abort an agent's whole sweep.
- Give operators per-agent visibility into memory lifecycle state via `db.telemetry` heartbeat and `hive doctor`.
- Provide an admin MCP trigger for operator-initiated bounded recovery passes.

## Non-Goals

- Do not replace Linear, GitHub, Slack, CRM, or other systems of record. Memory references them; it does not mirror them.
- Do not implement Phase C provider rollout or Phase D provider session-memory boundaries (KPR-209 scope).
- Do not destructively delete cold originals on deploy. Hidden-from-recall is the contract; existing `coldRetentionDays` hard-delete path is preserved.
- Do not solve every write-time memory-quality problem. LLM-based pre-write classification and agent prompt rewrites are explicit follow-up.
- Do not add an agent-visible deep-recall surface in this slice. Operator deep recall goes through beekeeper CLI against Mongo/Qdrant directly.
- Do not migrate existing data. New optional fields (`sourceRef`, extended autoDream state) are absent on legacy records and are written as records are touched.
- Do not add beekeeper CLI verbs in this slice. Hive ships the admin MCP tool here; beekeeper CLI ergonomics are a follow-up ticket.

## Design

### Schema

`MemoryRecord` (in `src/memory/memory-types.ts`) gets one new optional field, and the parallel input type and tool schema follow:

```typescript
export interface MemoryRecord {
  // ...existing fields...
  sourceRef?: string; // Freeform pointer to system of record. URL form preferred.
}

export interface MemoryRecordInput {
  // ...existing fields...
  sourceRef?: string;
}
```

`MemoryStore.save()` signature gains `sourceRef` (read from the input). The `memory_save` Zod schema in `src/memory/structured-memory-mcp-server.ts` adds:

```typescript
sourceRef: z.string().optional().describe(
  "Pointer to system of record (Linear URL, GitHub link, Slack permalink, CRM record). URL form preferred. Add this when the memory references a fact that lives somewhere authoritative."
),
```

The tool handler forwards `sourceRef` into `store.save(...)` alongside `content`/`type`/`topic`/`importance`. Without explicit threading through both layers, agents have no way to populate the field.

`AutoDreamAgentState` (in `src/memory/memory-store.ts`) gets six new optional fields:

```typescript
export type ConsolidationPhase =
  | "idle"
  | "summarizeCold"
  | "mergeDuplicates"
  | "detectContradictions"
  | "promotePatterns";

export interface ConsolidationCursor {
  createdAt: Date;
  lastId: ObjectId;  // tie-breaker: multiple records can share createdAt
}

export interface AutoDreamSpendSample {
  at: Date;
  spentUsd: number;
}

export interface AutoDreamAgentState {
  // ...existing fields...
  phase?: ConsolidationPhase;
  topic?: string;                    // currently-processing topic within phase
  cursor?: ConsolidationCursor;      // compound cursor — (createdAt, _id) pair
  lastError?: string;
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  spendHistory?: AutoDreamSpendSample[];  // rolling per-run spend samples, capped (see below)
}
```

The compound cursor matters: Mongo records seeded in a batch can share `createdAt` to the millisecond. A date-only cursor with `createdAt > cursor` would silently skip same-instant siblings. The compound query is:

```typescript
{
  // ...existing filters...
  $or: [
    { createdAt: { $gt: cursor.createdAt } },
    { createdAt: cursor.createdAt, _id: { $gt: cursor.lastId } },
  ],
}
```

Sort: `{ createdAt: 1, _id: 1 }`. After processing a page, advance cursor to `{ createdAt: lastRecord.createdAt, lastId: lastRecord._id }`.

All new fields are optional. Legacy records and legacy state docs are valid unchanged.

### Write-time guards at `memory_save`

`memory_save` adds four deterministic guards before insert. All guard rejections return `isError: true` with a structured message that names the violated rule and suggests a fix (including a `sourceRef` hint).

**Burst guard.** Reject when a new save's content is too similar to a recent record in the same (`agentId`, `topic`). Concretely: query Qdrant for top-K similar points in the same agent+topic with `createdAt > now - burstWindowMinutes`. If max similarity exceeds `burstSimilarityThreshold`, reject and return the existing record's `_id` in the error body. Default config: K=5, window=24h, threshold=0.92.

**Burst-guard failure mode (Qdrant unavailable).** The burst guard depends on Qdrant — the oversize and raw-dump guards do not. If the Qdrant similarity query throws (network/timeout/embedder failure), **fail open for the burst guard only**: log a warning (`memory-save burst-guard skipped: <error>`), skip the similarity check, but still enforce oversize and raw-dump guards before insert. The save proceeds. Rationale: a Qdrant outage shouldn't block agents from saving meta-knowledge they need; the only cost is occasional same-topic burst during the outage window, which sweep-time consolidation will clean up later. Sustained Qdrant outages will surface in `hive doctor` via heartbeat error fields and embed-error rates, so operators have visibility.

```
memory_save error: too similar to existing record [<id>] in topic "<topic>" (similarity 0.94). Use memory_update on the existing record, or add a sourceRef to distinguish if these are different sources.
```

**Oversize guard.** Reject when content exceeds `embedMaxChars` (default: 6000 chars ≈ 1500 tokens, well under typical Ollama context). Suggest chunking + `sourceRef` to the source document.

```
memory_save error: content too long (N chars; limit M). Memory should be a digest, not a paste. Break into smaller records with a shared topic, or save a digest + sourceRef pointing to the full source.
```

**Raw-fact-dump heuristic.** Reject when content is shaped like a serialized external record:

- Starts with `{` or `[` (likely JSON) and is >K tokens, OR
- Contains >3 pipe-table or markdown-table lines, OR
- Is a single non-broken line >L chars (likely a dumped paragraph)

…and the record has no `sourceRef`. Reject with a hint to add `sourceRef` and a content digest instead. Defaults: K=300 tokens, L=2000 chars. The heuristic is intentionally conservative; the bar is "obviously a dump," not "looks heavy."

```
memory_save error: content looks like a raw dump from an external system. Memory should hold a digest plus a sourceRef pointing to the original (Linear URL, GitHub link, Slack permalink, CRM record).
```

**sourceRef hint in all rejection messages.** Every guard rejection includes a short sentence on `sourceRef`. Plants the seed for agents that haven't been updated yet without making the field mandatory.

All guard thresholds live in `hive.yaml` under `memory.writeGuards.*` with sensible defaults; operators can loosen or tighten per instance.

### Fidelity contract at `memory_recall`

`memory_recall` enforces the contract that already exists in schema but isn't enforced.

The Mongo lookup-by-id step (after Qdrant semantic search) adds `summarized: { $ne: true }` to the filter. Summarized cold originals are dropped from the result set even if Qdrant matches them.

The Qdrant search filter gains a `must_not` clause that excludes `tier: "cold"` from default queries:

```typescript
filter: {
  must: [{ key: "agentId", match: { value: agentId } }, /* other must clauses */],
  must_not: [{ key: "tier", match: { value: "cold" } }],  // new
}
```

When the caller passes `tier: "cold"` explicitly, the literal filter applies — Qdrant returns cold-tier points, but the Mongo `summarized:{$ne:true}` filter drops every consolidated record, so explicit-cold recall yields only never-summarized cold records (rare; mostly leftovers awaiting their next sweep). The query is technically valid but produces no useful agent-visible result, which is consistent with the agreed contract that cold is hidden from normal recall.

Summaries are warm-tier `type: "summary"` records and surface naturally on any normal recall whose query matches the summary content or its topic. Agents looking for "what does this agent know about topic X" get the summary first by way of normal Qdrant relevance ranking — no special tier filter is needed. **There is no `(tier: "cold", type: "summary")` query path in this design; that combination would return nothing because summaries live in warm.**

Operator forensic recall of cold originals happens outside the agent surface via direct Mongo/Qdrant from beekeeper, where the `summarized:{$ne:true}` filter can be lifted intentionally.

### Qdrant tier sync on transitions

`MemoryStore.setTier` and `setTierBulk` are extended to update the Qdrant payload `tier` field for the affected points via Qdrant's `set_payload` API. Cheap (no re-embed). Idempotent.

**Ownership boundary — don't inject MemoryEmbedder into MemoryStore directly.** Doing so would muddy the store's "Mongo-only" surface and force every store unit test to stub a full embedder. Instead, introduce a narrow interface that the embedder implements:

```typescript
// src/memory/memory-vector-index.ts (new)
export interface MemoryVectorIndex {
  setTierPayload(pointIds: string[], tier: MemoryTier): Promise<void>;
}
```

`MemoryEmbedder` implements `MemoryVectorIndex` (adds `setTierPayload` as a public method using Qdrant's `setPayload` API). `MemoryStore` takes an optional `vectorIndex?: MemoryVectorIndex` constructor parameter; if omitted, tier-sync is a no-op (preserves all existing Mongo-only unit tests with zero changes). Production wiring (in `src/index.ts` or wherever the store + embedder are constructed) passes the embedder as the index.

```typescript
// Pseudocode for setTierBulk
async setTierBulk(ids: ObjectId[], tier: MemoryTier): Promise<void> {
  if (ids.length === 0) return;
  const records = await this.collection
    .find({ _id: { $in: ids } })
    .project({ qdrantPointId: 1 })
    .toArray();
  await this.collection.updateMany({ _id: { $in: ids } }, { $set: { tier } });
  // Best-effort: skip silently if no index injected (test paths) or on error (production).
  if (this.vectorIndex) {
    const pointIds = records.map(r => r.qdrantPointId).filter(Boolean);
    try {
      await this.vectorIndex.setTierPayload(pointIds, tier);
    } catch (err) {
      log.warn("Qdrant tier-sync failed; doctor will surface drift", { count: pointIds.length, error: String(err) });
    }
  }
  this.onMutate?.(null, "memory-set-tier-bulk");
}
```

Best-effort: Qdrant errors are logged and the Mongo write still completes, so the consistency model is "eventual within seconds, drift surfaced via doctor."

`hive doctor` will surface a Qdrant-vs-Mongo tier-drift count derived from a sampled reconciliation check, so persistent drift is observable.

### Bounded cold-summary consolidation

`summarizeCold` is rewritten as paged consolidation with per-topic checkpoints, and **relocated from `sweepAgent()` (where it runs today at `memory-lifecycle.ts:263`) to `dream()`**, joining `mergeDuplicates`, `detectContradictions`, and `promotePatterns` as a first-class autoDream phase. Rationale: `summarizeCold` is the heaviest LLM-call path in the lifecycle and belongs with the other bounded-budget consolidation operations, not with the cheap scoring-and-tier-shuffle work in `sweep()`. After this slice, `sweep()` performs only score-based tier transitions, hot-budget enforcement, summarized-record cleanup, and purge hard-delete — all non-LLM work.

`MemoryStore` gains a new method `getColdByTopicPaged(agentId: string, topic: string, cursor: ConsolidationCursor | null, limit: number): Promise<MemoryRecord[]>` that returns up to `limit` non-summarized cold records for the topic, sorted by `{ createdAt: 1, _id: 1 }`. Cursor semantics: when null, return the oldest records; when set, apply the compound `$or` predicate defined in §Schema. The existing `getColdByTopic` is removed in favor of the paged variant; callers in `summarizeCold` are updated.

For each `(agentId, topic)` in cold backlog, ordered deterministically:

1. Read checkpoint cursor for this `(agentId, topic)` from extended `AutoDreamAgentState` (`ConsolidationCursor | null`).
2. Call `getColdByTopicPaged(agentId, topic, cursor, coldSummaryPageSize)` (default `coldSummaryPageSize: 20`) to fetch the next page, sorted by `{ createdAt: 1, _id: 1 }`.
3. If the page does not meet `coldSummaryMinRecords`, advance and continue.
4. Build a prompt from the page entries. Apply a defense-in-depth token cap: if estimated prompt tokens exceed `coldSummaryPromptTokenBudget` (default 8000), truncate the page to fit. The page size cap is the primary bound; the token cap catches pathological variance.
5. For each record in the page, apply oversize handling (next subsection).
6. Run the Haiku summarize call with the existing per-call budget.
7. On success: save the summary as warm `type: "summary"`, embed it, mark originals `summarized: true`, advance cursor to `{ createdAt: lastRecord.createdAt, lastId: lastRecord._id }`, update `lastSuccessAt`.
8. On failure: persist `lastError` and `lastAttemptAt`. Do not advance cursor. Stop processing this topic in this sweep; move to next topic (or next phase if budget exhausted).

Backlog drains across multiple sweep cycles. Muriel's 357 records become roughly 18 summaries spread over ~18 sweeps. A subsequent pass merges summaries-of-summaries if the count of warm `type: "summary"` records for a single topic exceeds `summaryOfSummariesThreshold` (default 5) — same paged + checkpointed mechanism, just operating on warm summaries instead of cold originals.

`mergeDuplicates`, `detectContradictions`, and `promotePatterns` already have per-run caps (clusters, pairs, promotions) but their prompt construction is unbounded. Apply the same `coldSummaryPromptTokenBudget` estimated-tokens cap to each call. If a cluster cannot fit within the budget, halve and process the cluster across multiple calls; if the cluster cannot be halved (single oversized record), apply the oversized-record handling below.

### Oversized single-record handling

Detected at three points:

1. **Write-time:** caught by the oversize guard. Record never enters the system.
2. **Embed-time during save:** the embedder call already runs async in `memory_save`. Extend the embedder with a `truncateForEmbed` step: if content > `embedMaxChars`, truncate to fit + append a `[truncated]` marker stored in the Qdrant payload as `truncated: true`. The Mongo record keeps full content. Errors during embed are still logged but the record is no longer an orphan because the truncated form was embedded.
3. **Consolidation-time:** if a single page entry exceeds `coldSummaryPromptTokenBudget` even alone, mark that record `needsReview: true` (existing field) and skip it. The sweep continues with the remaining records in the page. Operator sees flagged records via doctor + beekeeper inspect.

One bad record never aborts a sweep. Sweep loops over records inside their own try/catch; an exception on record N flags it and continues to record N+1.

### Checkpoint state on `agent_memory_autodream_state`

Phase progression: `idle → summarizeCold → mergeDuplicates → detectContradictions → promotePatterns → idle`. Each `dream()` invocation reads the current phase + topic + cursor and resumes.

Within a phase, topics are iterated in deterministic order (alphabetical). The cursor is per-(phase, topic); when a topic completes, cursor is cleared and topic advances. When all topics in a phase are exhausted, phase advances.

`lastError` is set on partial failure and cleared on successful completion of the next pass. `lastAttemptAt` is updated every run, regardless of outcome. `lastSuccessAt` is updated only when a phase completes cleanly.

`markAutoDreamRun` signature today takes 5 positional arguments (`agentId`, `at`, `changedMemoryCount`, `spentUsd`, `llmCalls`). Adding 5+ more positional args is awkward; refactor to an options-object signature:

```typescript
async markAutoDreamRun(agentId: string, update: {
  at: Date;
  changedMemoryCount?: number;
  spentUsd?: number;
  llmCalls?: number;
  phase?: ConsolidationPhase;
  topic?: string | null;
  cursor?: ConsolidationCursor | null;
  lastError?: string | null;
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
}): Promise<void>
```

Existing callsites pass the original five fields; new callsites pass whichever subset they're updating.

### Default flip: `autoDream.enabled`

`src/config.ts` line 369: `enabled: (hive.autoDream?.enabled ?? false)` becomes `enabled: (hive.autoDream?.enabled ?? true)`.

Operators who want to opt out can set `autoDream.enabled: false` in `hive.yaml`. With bounded budgets, paged consolidation, and checkpointing, the failure modes that motivated the off-by-default posture are addressed. Catalyst's empty `agent_memory_autodream_state` collection proves that off-by-default in practice means never-runs.

**Cost-exposure mitigation.** Flipping the default flips real LLM spend onto every existing instance on first upgrade after this slice ships. To keep that bounded and visible:

- **Ship with conservative defaults already in place.** Today's defaults — `maxRunBudgetUsd: 0.05`, `maxCallBudgetUsd: 0.01`, `cooldownMinutes: 1440` (daily), `minNewMemories: 10` — are already small. A typical instance with 6 agents and bounded recovery sees ~$0.05 × 6 = $0.30/day worst-case across all agents, scoped to days where consolidation actually fires. Do not lower these further in this slice; they're already the right order of magnitude.
- **Heartbeat surfaces last-run + 30-day cumulative spend per agent.** Add `lastRunSpentUsd` and `cumulativeSpentUsd30d` to the heartbeat schema (see §Telemetry heartbeat). Both are derived from `AutoDreamAgentState.spendHistory` — a per-agent rolling array of `{ at, spentUsd }` samples appended on every `markAutoDreamRun` call, capped at 60 entries (covers >30 days at the default daily cooldown; oldest entries dropped on append). `cumulativeSpentUsd30d` = sum of `spentUsd` where `at > now - 30d`; `lastRunSpentUsd` = most recent sample's `spentUsd`. `hive doctor` shows both, so operators see actual spend in one place.
- **Doctor flags overspend.** If `cumulativeSpentUsd30d` for an agent exceeds a configurable `memory.spendWarnThresholdUsd` (default $5/month/agent), doctor shows a warning. Operator can lower budget knobs or set `autoDream.enabled: false` in response.
- **Release notes explicitly call out the default change and cost expectation.** See §First-deploy recovery.

This stays true to the simplicity posture: don't add a new "bounded mode only" code path or first-N-runs ramp; trust the existing bounded budgets, give operators visibility, and let them dial back if needed.

### Telemetry heartbeat

New `src/memory/memory-lifecycle-heartbeat.ts`, modeled on `src/agents/spawn-coordinator-heartbeat.ts`.

Every 30s, upsert one `db.telemetry` doc per agent under `kind: "memory_lifecycle_stats"` with:

```typescript
{
  kind: "memory_lifecycle_stats",
  agentId: string,
  capturedAt: Date,
  counts: { hot: number, warm: number, cold: number },
  summarizedNotPurged: number,         // summarized:true && purged:!=true
  needsReview: number,
  oldestColdAgeDays: number | null,
  consolidation: {
    phase: ConsolidationPhase,
    topic: string | null,
    cursor: ConsolidationCursor | null,  // compound { createdAt, lastId }
    lastAttemptAt: Date | null,
    lastSuccessAt: Date | null,
    lastError: string | null,
    lastRunSpentUsd: number | null,    // spend in the most-recent dream() invocation
    cumulativeSpentUsd30d: number,     // rolling 30-day spend; computed from agent_memory_autodream_state history
  },
  qdrantTierDriftSampled: number,      // drift count from a small reconciliation sample
}
```

Heartbeat is owned by `MemoryLifecycle` (similar to `SpawnCoordinatorHeartbeat` ownership). Starts on engine boot if memory lifecycle is enabled.

### `hive doctor` surface

`hive doctor` adds a "Memory lifecycle" section that reads from telemetry, one block per agent:

```
Memory lifecycle (per agent):
  jeff: hot=8 warm=124 cold=2358 (oldest 47d), summarized-not-purged=0, needsReview=0
        phase=summarizeCold topic="customer-leads" cursor=2026-04-12
        last attempt 2026-05-25T08:00:00Z ✓
        Qdrant tier drift (sampled): 0
  may: ...
```

Drift count > 0 or `lastError` non-null surfaces with a warning marker. No live aggregate fallback; if heartbeat is stale (>5 min), doctor flags "memory heartbeat stale" rather than computing on-demand.

### Admin MCP tool: `memory_lifecycle_run_consolidation`

`src/admin/admin-mcp-server.ts` gains one tool:

```typescript
tool(
  "memory_lifecycle_run_consolidation",
  "Run a bounded memory-lifecycle consolidation pass for one agent. Use to drain a large cold backlog faster than normal sweep cadence.",
  {
    agentId: z.string(),
    maxBudgetUsd: z.number().optional().describe("Run budget cap, default uses config.autoDream.maxRunBudgetUsd"),
    maxPages: z.number().optional().describe("Cap on total pages processed across phases this run, default 50"),
  },
  async ({ agentId, maxBudgetUsd, maxPages }) => { /* invokes MemoryLifecycle.dream with single-agent restriction + overrides */ },
)
```

Operator-callable from any MCP client (beekeeper, debug shell, etc.). Returns a structured result with pages processed, summaries created, errors. Updates the same checkpoint state as scheduled sweeps.

### First-deploy recovery

After upgrade, autoDream is enabled by default. Paged consolidation drains backlog organically across sweep cycles. Release notes call out two things:

1. **Default change:** `autoDream.enabled` now defaults to `true`. Operators who want to keep consolidation off must set `autoDream.enabled: false` explicitly in `hive.yaml`. Mention budget bounds and checkpointing so operators understand why the default flipped.
2. **Manual trigger for large backlogs:** instances with >500 cold memory records per agent (check `hive doctor`) may want to run the manual recovery trigger to drain faster than scheduled sweeps. Example: `memory_lifecycle_run_consolidation({ agentId: "jeff", maxPages: 100 })` from any admin MCP client.

`hive doctor` will surface backlog sizes so operators see the problem.

### Config additions to `hive.yaml`

```yaml
memory:
  writeGuards:
    burst:
      enabled: true
      windowMinutes: 1440        # 24h
      similarityThreshold: 0.92
      topK: 5
    oversize:
      enabled: true
      maxChars: 6000
    rawDump:
      enabled: true
      jsonTokenThreshold: 300
      monolithCharThreshold: 2000

autoDream:
  enabled: true                  # was false
  # ...existing knobs...
  coldSummaryPageSize: 20        # new
  coldSummaryPromptTokenBudget: 8000  # new
  summaryOfSummariesThreshold: 5 # new
```

All values are env-overridable via the existing `AUTODREAM_*` and a new `MEMORY_WRITE_GUARD_*` family.

## Files Touched

Modifications:
- `src/memory/memory-types.ts` — add `sourceRef?` to `MemoryRecord` and `MemoryRecordInput`; extend `AutoDreamAgentState`; export `ConsolidationPhase` and `ConsolidationCursor`.
- `src/memory/memory-store.ts` — accept optional `vectorIndex: MemoryVectorIndex` constructor arg; extend `setTier`/`setTierBulk` to call `vectorIndex.setTierPayload`; refactor `markAutoDreamRun` to options-object signature; replace `getColdByTopic` with `getColdByTopicPaged(agentId, topic, cursor, limit)`; thread `sourceRef` through `save()`.
- `src/memory/memory-embedder.ts` — implement `MemoryVectorIndex.setTierPayload`; add `truncateForEmbed` in `upsert`; expose payload `truncated` flag.
- `src/memory/memory-lifecycle.ts` — relocate `summarizeCold` from `sweepAgent` to `dream()`; rewrite as paged + checkpointed; add token budget caps to all consolidation prompts; oversized-record handling; phase progression.
- `src/memory/structured-memory-mcp-server.ts` — three write-time guards in `memory_save` (with burst-guard fail-open on Qdrant outage); `sourceRef` parameter in Zod schema and forwarded to `store.save`; `summarized:{$ne:true}` Mongo filter and `must_not: tier=cold` Qdrant filter in `memory_recall`.
- `src/admin/admin-mcp-server.ts` — new `memory_lifecycle_run_consolidation` tool.
- `src/config.ts` — flip `autoDream.enabled` default; add memory write-guard config; add new autoDream knobs; add `memory.spendWarnThresholdUsd`.
- `src/cli/doctor.ts` — Memory lifecycle section reading telemetry; spend warnings.
- `src/index.ts` (or equivalent wiring point) — pass `MemoryEmbedder` to `MemoryStore` constructor as the `MemoryVectorIndex` implementation.

New:
- `src/memory/memory-vector-index.ts` — `MemoryVectorIndex` interface.
- `src/memory/memory-lifecycle-heartbeat.ts` — 30s heartbeat to `db.telemetry`.

Tests (alongside existing `*.test.ts` per repo convention):
- `src/memory/memory-lifecycle.test.ts` — extended for paged consolidation, checkpoint resume, oversized handling.
- `src/memory/memory-store.test.ts` — extended for Qdrant tier-sync, extended state schema, `getColdByTopicPaged`.
- `src/memory/memory-manager.test.ts` — update mocks that reference `getColdByTopic` to use the paged variant.
- `src/memory/structured-memory-mcp-server.test.ts` — three guards, recall filtering.
- `src/memory/memory-embedder.test.ts` — truncation + set_payload.
- `src/memory/memory-lifecycle-heartbeat.test.ts` — new.

## Test Plan

Acceptance-criterion coverage:

1. **Tier/Qdrant consistency.** Save record, demote tier via `setTierBulk`, query Qdrant with `tier` filter — record matches new tier. Existing test for tier-only Mongo update extended to assert Qdrant payload.
2. **Cold-summary-first recall.** Save N cold records on one topic, run `summarizeCold`, run `memory_recall` with the topic — only the summary record returns, never the originals, even though originals are still in Mongo within `coldRetentionDays`.
3. **Bounded multi-pass consolidation.** Synthetic test with 60 cold records on one topic, `coldSummaryPageSize: 20`. First sweep produces 1 summary covering records 1-20, cursor advances. Second sweep covers 21-40. Third sweep covers 41-60. Each sweep prompt is <token budget.
4. **Partial-failure checkpoint persistence.** Inject a failure on sweep 2 — cursor stays at 20, `lastError` populated, `lastAttemptAt` updated, `lastSuccessAt` unchanged. Sweep 3 resumes from cursor 20.
5. **Oversized single record.** Insert one cold record with content >>budget into a topic of normal-sized records. Sweep summarizes the normal records, flags the oversized record `needsReview: true`, completes the page. Backlog converges; the oversized record does not block.
6. **Write-time guards.**
   - Burst: save two records with content "X" + topic "T", reject the second. Recall returns the first.
   - Oversize: save 10K-char content, reject with chunking hint.
   - Raw-dump: save a JSON-shaped 500-token payload with no `sourceRef`, reject. Save the same payload with `sourceRef`, accept.
   - sourceRef hint: assert the message text on each rejection contains the word `sourceRef`.
7. **Heartbeat.** Tick lifecycle, assert one doc per agent in `db.telemetry` under `kind: "memory_lifecycle_stats"`, with all required fields populated.
8. **Admin MCP trigger.** Call `memory_lifecycle_run_consolidation({ agentId, maxPages: 2 })` on a 60-record topic, assert 2 pages processed (records 1-40 summarized, cursor at 40), assert subsequent normal sweep continues from cursor 40.

Regression tests:
- Existing `memory-lifecycle.test.ts` assertions on score-based tier demotion remain green.
- Existing `summarizeCold` happy-path test re-fitted to new paged flow.

## Out of Scope (Follow-up Tickets to File)

1. **LLM-based pre-write classifier.** Use a small model to evaluate whether content is meta-knowledge vs. raw fact and route to appropriate handling. Higher precision than deterministic guards; appropriate once the guards have surfaced what gets caught.
2. **Agent prompt rewrites for `sourceRef` discipline.** Teach agents in their system prompts to write meta-knowledge with sourceRef when referencing external systems. Soft, prose-side guidance to complement the hard guards.
3. **Beekeeper CLI verbs.** `beekeeper memory status <instance> [agent]`, `beekeeper memory consolidate <instance> [agent]`, `beekeeper memory inspect <instance> <agent> <recordId>`, and an operator deep-recall verb. Hive ships the admin MCP tool here; beekeeper-side ergonomics are a follow-up.
4. **Periodic Qdrant reconciliation sweep.** A scheduled job that walks Mongo + Qdrant, fixes any persistent payload drift, and updates the doctor surface. Today's `set_payload` on every transition plus doctor sampling is sufficient; reconciliation is needed only if drift becomes recurrent.
5. **Agent-visible deep recall.** If an agent has a documented need to look behind a summary at the originals, add an opt-in tool. Don't add the lever until the need is real.

## Acceptance Criteria Mapping

Mapping back to the ticket's acceptance criteria:

| Ticket criterion | Where it lands |
|---|---|
| Normal prompt injection remains hot-only and bounded | No change. Existing hot budget logic preserved. |
| `memory_recall` matches contract (full hot/warm; cold returns summaries) | Fidelity contract section. Recall filters by `summarized:{$ne:true}` and tier. |
| Mongo tier/fidelity and Qdrant payload stay consistent | Qdrant tier sync section. `setTier`/`setTierBulk` extended. |
| Cold consolidation never assembles unbounded prompt | Bounded consolidation section. Page size + token budget. |
| Cold memories paged with deterministic order + resumable checkpoints | Bounded consolidation + checkpoint sections. |
| Oversized backlogs converge across passes | Page-N with cursor advance per pass. Muriel's 357 → ~18 passes. |
| Per-agent progress/checkpoints persisted | Extended `agent_memory_autodream_state`. |
| Large individual records detected + truncated/chunked safely | Oversized handling section. Three detection points. |
| Operator/doctor visibility (counts, oldest cold, last attempt/success/error, checkpoint) | Heartbeat + doctor sections. |
| Manual CLI/admin trigger for bounded pass | Admin MCP `memory_lifecycle_run_consolidation` tool. Beekeeper CLI follow-up. |
| Tests cover all of the above | Test plan section. |
