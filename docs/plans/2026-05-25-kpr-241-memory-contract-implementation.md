# KPR-241 Memory Contract + Bounded Consolidation Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Enforce the Hive memory contract in code — write-time guards at `memory_save`, fidelity filters at `memory_recall`, Qdrant/Mongo tier consistency, paged + checkpointed cold consolidation, oversized-record handling, autoDream default-on, and per-agent operator visibility via heartbeat + admin MCP trigger.

**Architecture:** Memory subsystem hardening across the existing four-file structure (`memory-store.ts`, `memory-embedder.ts`, `memory-lifecycle.ts`, `structured-memory-mcp-server.ts`) plus two new files (`memory-vector-index.ts` interface, `memory-lifecycle-heartbeat.ts` heartbeat class). `summarizeCold` relocates from `sweep()` to `dream()` as a first-class autoDream phase with compound-cursor checkpointing in extended `agent_memory_autodream_state`. New admin MCP tool `memory_lifecycle_run_consolidation` triggers bounded recovery passes; `hive doctor` reads heartbeat telemetry for per-agent surface.

**Tech Stack:** TypeScript (strict, Node 22+), MongoDB, Qdrant (vector store), Ollama (embeddings), Claude Agent SDK (Haiku for summarization calls), Vitest (colocated `*.test.ts`).

**Spec:** [docs/specs/2026-05-25-kpr-241-memory-contract-design.md](docs/specs/2026-05-25-kpr-241-memory-contract-design.md) (commit `f1e0947`).

**Branch:** `may/kpr-241-reassert-hive-memory-contract-and-bound-cold-tier`.

**Follow-up tickets filed:** [KPR-243](https://linear.app/keepur/issue/KPR-243) LLM classifier, [KPR-244](https://linear.app/keepur/issue/KPR-244) agent prompt rewrites, [KPR-245](https://linear.app/keepur/issue/KPR-245) beekeeper CLI verbs, [KPR-246](https://linear.app/keepur/issue/KPR-246) periodic reconciliation, [KPR-247](https://linear.app/keepur/issue/KPR-247) agent-visible deep recall.

## Testing Contract

### Required Test Groups

- **Unit: required**
  - Scope: `MemoryStore` methods, `MemoryEmbedder` methods, `MemoryLifecycle` consolidation logic, `MemoryLifecycleHeartbeat`, `structured-memory-mcp-server` tool handlers (guards + filters).
  - Reason: All four memory files already have colocated `*.test.ts`; the changes are method-level and well-isolated. Unit tests catch regression on each method's contract without standing up Mongo/Qdrant.
  - Minimum assertions:
    - Compound cursor query returns records strictly after `{ createdAt, lastId }` and orders by `{ createdAt: 1, _id: 1 }`.
    - `setTier`/`setTierBulk` invoke `MemoryVectorIndex.setTierPayload` with the correct point IDs and tier; absent index = no-op.
    - `MemoryEmbedder.upsert` truncates content > `embedMaxChars` and sets `truncated: true` in payload.
    - `memory_save` rejects burst (similarity-mock above threshold), oversize (chars > limit), raw-dump (JSON-shape > token threshold without `sourceRef`); all rejections mention `sourceRef`.
    - Burst guard fails open when `embedder.search` throws (Qdrant outage); oversize + raw-dump still enforced.
    - `memory_recall` Mongo lookup excludes `summarized: true`; Qdrant filter contains `must_not: tier=cold` when no explicit tier filter.
    - `summarizeCold` paged loop processes ≤ `coldSummaryPageSize` records per call; advances compound cursor to `{ lastRecord.createdAt, lastRecord._id }`.
    - Oversized single record marked `needsReview: true` and skipped; sweep continues.
    - `markAutoDreamRun` options-object signature persists phase/topic/cursor/error and appends to `spendHistory` capped at 60 entries.
    - `MemoryLifecycleHeartbeat.writeOnce` upserts one doc per agent under `kind: "memory_lifecycle_stats"`.

- **Integration: required**
  - Scope: end-to-end through the MCP tool layer with a mocked embedder and an in-memory `MemoryStore` (existing test patterns). Verify that a `memory_save` + `memory_recall` round-trip honors the new contract.
  - Reason: The interactions between guards, fidelity filters, and consolidation paths are easy to break individually-correctly but globally-incorrectly. One integration test per critical flow protects against that.
  - Harness: existing — vitest with `vi.fn()` mocks for `MemoryEmbedder`, no real Mongo/Qdrant needed (mirrors existing test patterns in `memory-lifecycle.test.ts` and `structured-memory-mcp-server.test.ts`).
  - Minimum assertions:
    - Save → recall round-trip: save a record, recall by topic, get the record back. Save again with similar content → rejected by burst guard. memory_update on the original works.
    - Consolidation round-trip: seed 60 cold records on one topic, run `dream()` with `coldSummaryPageSize: 20`, assert 3 sweeps drain the backlog with 3 summary records produced, cursor advances correctly, originals marked `summarized: true`.
    - Recall hides summarized originals: after consolidation, `memory_recall` returns the summary record, never the originals — even though both are in Mongo within `coldRetentionDays`.

- **E2E: not-required**
  - Reason: No user-visible behavior change at the channel/dispatcher layer. All changes are inside the memory subsystem MCP boundary. The existing agent → MCP → store/embedder path is what unit + integration tests already cover.

### Critical Flows

- `memory_save` happy path with sourceRef → persists, embeds.
- `memory_save` burst-rejected → returns existing record id, save not persisted.
- `memory_save` oversize-rejected with chunking hint.
- `memory_save` raw-dump-rejected, sourceRef hint in error.
- `memory_save` with Qdrant down → burst guard skipped, oversize + raw-dump still fire, save proceeds.
- `memory_recall` default → cold + summarized excluded.
- `dream()` → `summarizeCold` paged drain across multiple sweeps, checkpoint advances, partial failure resumes.
- One oversized record in a topic of normal records → flagged `needsReview`, sweep completes.
- `setTier`/`setTierBulk` → Qdrant payload tier updates via `set_payload`.
- Heartbeat writes per-agent doc to `db.telemetry` every 30s.
- Admin tool `memory_lifecycle_run_consolidation` → bounded pass, returns structured result, updates checkpoint state.

### Regression Surface

- Existing `MemoryLifecycle.sweep()` score-based tier transitions, hot-budget enforcement, purge-hard-delete (untouched logic, but `summarizeCold` is removed from `sweepAgent()`).
- Existing `mergeDuplicates`, `detectContradictions`, `promotePatterns` paths inside `dream()` (gain a token-budget cap on prompt construction).
- Existing `memory_save`, `memory_recall`, `memory_update`, `memory_pin`, `memory_unpin`, `memory_forget`, `memory_purge`, `memory_review` tool behaviors.
- Existing `agent_memory_autodream_state` upsert pattern (extending schema, not breaking it).
- Existing `hive doctor` output sections.

### Commands

- Unit: `npm run test -- src/memory/`
- Integration: `npm run test -- src/memory/` (integration tests colocate with units — no separate runner needed)
- E2E: not applicable.
- Broader regression: `npm run check` (typecheck + lint + format + test all together — the canonical pre-commit gate per `CLAUDE.md`).

### Harness Requirements

- Vitest + the project's existing memory test fixtures (mocked `MemoryStore`, `MemoryEmbedder` via `vi.fn()`; no real Mongo/Qdrant).
- Env stubs for `npm run check`: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test` (per `reference_npm_check_env_stubs`).

### Non-Required Rationale

- E2E: no channel/dispatcher behavior change. All affected paths are inside the memory subsystem MCP boundary; agent-facing surface stays semantically identical except for the new guards (which are unit + integration tested at the boundary).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec/plan mismatch, demote the ticket to the spec lane and update spec + plan together.

---

## File Structure

**New files:**
- `src/memory/memory-vector-index.ts` — `MemoryVectorIndex` interface (one method: `setTierPayload`).
- `src/memory/memory-lifecycle-heartbeat.ts` — `MemoryLifecycleHeartbeat` class (30s heartbeat to `db.telemetry`).
- `src/memory/memory-lifecycle-heartbeat.test.ts` — colocated unit test.

**Modified files:**
- `src/memory/memory-types.ts` — `sourceRef?` on `MemoryRecord` + `MemoryRecordInput`; `ConsolidationPhase`, `ConsolidationCursor`, `AutoDreamSpendSample`; extended `AutoDreamAgentState`.
- `src/memory/memory-embedder.ts` — implement `MemoryVectorIndex`; add `setTierPayload`, `truncateForEmbed`; `upsert` writes `truncated` payload flag.
- `src/memory/memory-store.ts` — optional `vectorIndex` constructor arg; `setTier`/`setTierBulk` call `vectorIndex.setTierPayload`; `getColdByTopic` → `getColdByTopicPaged(agentId, topic, cursor, limit)`; `markAutoDreamRun` to options-object signature; `save()` accepts `sourceRef`.
- `src/memory/memory-lifecycle.ts` — relocate `summarizeCold` from `sweepAgent` to `dream()`; rewrite as paged + checkpointed; add `coldSummaryPromptTokenBudget` cap to all consolidation prompts; oversized-record handling; phase progression.
- `src/memory/structured-memory-mcp-server.ts` — three write-time guards in `memory_save` with fail-open burst; `sourceRef` param in Zod schema + forwarded to `store.save`; `summarized:{$ne:true}` Mongo filter and `must_not: tier=cold` Qdrant filter in `memory_recall`.
- `src/memory/memory-lifecycle.test.ts` — update mocks for new methods; add paged consolidation, checkpoint resume, oversized handling tests.
- `src/memory/memory-store.test.ts` — Qdrant tier-sync test with `vi.fn()` `MemoryVectorIndex`; `getColdByTopicPaged` test; extended state schema test.
- `src/memory/memory-manager.test.ts` — update `getColdByTopic` mock to `getColdByTopicPaged`.
- `src/memory/structured-memory-mcp-server.test.ts` — three guards + fail-open burst + recall filters.
- `src/memory/memory-embedder.test.ts` — truncation, `setTierPayload`.
- `src/admin/admin-mcp-server.ts` — new `memory_lifecycle_run_consolidation` tool.
- `src/cli/doctor-checks.ts` — `MemoryLifecycleRow` interface + `memoryLifecycleStatsForDoctor` adapter.
- `src/cli/doctor.ts` — "Memory lifecycle" output section.
- `src/config.ts` — flip `autoDream.enabled` default; add `memory.writeGuards.*`, `memory.spendWarnThresholdUsd`, `autoDream.coldSummaryPageSize`, `autoDream.coldSummaryPromptTokenBudget`, `autoDream.summaryOfSummariesThreshold`.
- `src/index.ts` — inject `MemoryEmbedder` as `MemoryVectorIndex` into `MemoryStore`; start `MemoryLifecycleHeartbeat`.

---

## Tasks

### Task 1: Schema additions to `memory-types.ts`

**Files:**
- Modify: `src/memory/memory-types.ts`

- [ ] **Step 1:** Add new types — `ConsolidationPhase`, `ConsolidationCursor`, `AutoDreamSpendSample`. Extend `MemoryRecord`, `MemoryRecordInput`, `AutoDreamAgentState`.

In `src/memory/memory-types.ts`, after the existing type aliases at the top:

```typescript
export type ConsolidationPhase =
  | "idle"
  | "summarizeCold"
  | "mergeDuplicates"
  | "detectContradictions"
  | "promotePatterns";

export interface ConsolidationCursor {
  createdAt: Date;
  lastId: ObjectId;
}

export interface AutoDreamSpendSample {
  at: Date;
  spentUsd: number;
}
```

Extend `MemoryRecord` (add optional `sourceRef`):

```typescript
export interface MemoryRecord {
  // ...existing fields...
  needsReview?: boolean;
  sourceRef?: string; // Freeform pointer to system of record. URL form preferred.
}
```

Extend `MemoryRecordInput`:

```typescript
export interface MemoryRecordInput {
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
  sourceRef?: string;
}
```

Note: `AutoDreamAgentState` lives in `memory-store.ts`, not `memory-types.ts` — extend it there (Task 3).

- [ ] **Step 2:** Verify

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-types.ts
git commit -m "feat(memory): schema additions for KPR-241 contract"
```

### Task 2: `MemoryVectorIndex` interface (new file)

**Files:**
- Create: `src/memory/memory-vector-index.ts`

- [ ] **Step 1:** Create the interface file.

```typescript
// src/memory/memory-vector-index.ts
import type { MemoryTier } from "./memory-types.js";

/**
 * KPR-241: narrow interface for the vector-store side of memory.
 *
 * `MemoryStore` depends on this interface, not on `MemoryEmbedder` concretely,
 * so the store stays Mongo-only at the type boundary and store unit tests can
 * inject a no-op or stub without standing up a real Qdrant connection.
 *
 * `MemoryEmbedder` implements this interface (see `memory-embedder.ts`).
 */
export interface MemoryVectorIndex {
  /**
   * Sync the `tier` field of zero or more existing Qdrant points without
   * re-embedding. Used by `MemoryStore.setTier` and `setTierBulk` when a
   * record transitions tiers in Mongo.
   *
   * Best-effort: implementations should not throw — Mongo state is the
   * source of truth and Qdrant drift is surfaced via the doctor sweep.
   */
  setTierPayload(pointIds: string[], tier: MemoryTier): Promise<void>;
}
```

- [ ] **Step 2:** Verify

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-vector-index.ts
git commit -m "feat(memory): MemoryVectorIndex interface (KPR-241)"
```

### Task 3: `MemoryEmbedder` — implement interface, truncate, set_payload

**Files:**
- Modify: `src/memory/memory-embedder.ts`
- Test: `src/memory/memory-embedder.test.ts`

- [ ] **Step 1:** Add the embed-limit constant, `truncateForEmbed` helper, implement `MemoryVectorIndex`. Edit `upsert` to truncate.

Replace the top of `src/memory/memory-embedder.ts`:

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";
import { createLogger } from "../logging/logger.js";
import { embedOllama } from "../search/embed-utils.js";
import type { MemoryRecallFilters, MemoryTier } from "./memory-types.js";
import type { MemoryVectorIndex } from "./memory-vector-index.js";

const log = createLogger("memory-embedder");

const COLLECTION = "agent_memory";

/**
 * KPR-241: Ollama embed-context cap. The Catalyst diagnostic ("Ollama embed
 * 400: the input length exceeds the context length") motivates a hard cap
 * applied at the embedder boundary. 6000 chars ≈ 1500 tokens leaves headroom
 * vs typical 2048-token Ollama defaults. Configurable via env.
 */
const EMBED_MAX_CHARS = parseInt(process.env.MEMORY_EMBED_MAX_CHARS ?? "6000", 10);

interface QdrantPayload {
  [key: string]: unknown;
  agentId: string;
  mongoId: string;
  type: string;
  topic: string;
  tier: string;
  importance: string;
  createdAt: number;
  truncated?: boolean;
}
```

Update the `MemoryEmbedder` class declaration to `implements MemoryVectorIndex`:

```typescript
export class MemoryEmbedder implements MemoryVectorIndex {
```

Add the private `truncateForEmbed` helper inside the class:

```typescript
  /**
   * KPR-241: truncate content to the embed-context limit. Returns the
   * possibly-truncated content and a flag for the payload. Truncating at
   * the embedder boundary keeps the Mongo record intact while preventing
   * Ollama 400s from leaving orphan Mongo records.
   */
  private truncateForEmbed(content: string): { content: string; truncated: boolean } {
    if (content.length <= EMBED_MAX_CHARS) return { content, truncated: false };
    return { content: content.slice(0, EMBED_MAX_CHARS) + "\n…[truncated]", truncated: true };
  }
```

Replace the `upsert` method body:

```typescript
  async upsert(pointId: string, content: string, payload: QdrantPayload): Promise<void> {
    await this.ensureCollection();
    const { content: embedContent, truncated } = this.truncateForEmbed(content);
    const vector = await this.embed(embedContent);
    const finalPayload: QdrantPayload = truncated ? { ...payload, truncated: true } : payload;
    await this.getClient().upsert(COLLECTION, {
      points: [{ id: pointId, vector, payload: finalPayload }],
    });
  }
```

Add `setTierPayload` as a public method (at the end of the class):

```typescript
  /**
   * KPR-241: sync the `tier` field on zero or more existing Qdrant points
   * without re-embedding. Best-effort: errors are logged + swallowed; Mongo
   * is the source of truth and the doctor surfaces sampled drift.
   */
  async setTierPayload(pointIds: string[], tier: MemoryTier): Promise<void> {
    if (pointIds.length === 0) return;
    try {
      await this.ensureCollection();
      await this.getClient().setPayload(COLLECTION, {
        payload: { tier },
        points: pointIds,
      });
    } catch (err) {
      log.warn("setTierPayload failed", { count: pointIds.length, tier, error: String(err) });
    }
  }
```

- [ ] **Step 2:** Add tests in `memory-embedder.test.ts`. Two new test blocks:

```typescript
describe("MemoryEmbedder.upsert truncation (KPR-241)", () => {
  it("does not truncate content under the embed cap", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    // Mock the qdrant client + embed call
    const upsertSpy = vi.fn().mockResolvedValue({});
    (embedder as any).getClient = () => ({ upsert: upsertSpy });
    (embedder as any).embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    (embedder as any).collectionReady = true;
    await embedder.upsert("p1", "short content", {
      agentId: "a", mongoId: "m", type: "fact", topic: "t", tier: "hot", importance: "medium", createdAt: 1,
    });
    const upsertCall = upsertSpy.mock.calls[0][1];
    expect(upsertCall.points[0].payload.truncated).toBeUndefined();
  });

  it("truncates content over the embed cap and sets truncated:true", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    const upsertSpy = vi.fn().mockResolvedValue({});
    const embedSpy = vi.fn().mockResolvedValue([0.1, 0.2]);
    (embedder as any).getClient = () => ({ upsert: upsertSpy });
    (embedder as any).embed = embedSpy;
    (embedder as any).collectionReady = true;
    const longContent = "x".repeat(7000);
    await embedder.upsert("p1", longContent, {
      agentId: "a", mongoId: "m", type: "fact", topic: "t", tier: "hot", importance: "medium", createdAt: 1,
    });
    expect(embedSpy.mock.calls[0][0].length).toBeLessThanOrEqual(6100); // 6000 + "[truncated]" suffix
    expect(upsertSpy.mock.calls[0][1].points[0].payload.truncated).toBe(true);
  });
});

describe("MemoryEmbedder.setTierPayload (KPR-241)", () => {
  it("calls Qdrant setPayload with the given pointIds and tier", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    const setPayloadSpy = vi.fn().mockResolvedValue({});
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    (embedder as any).collectionReady = true;
    await embedder.setTierPayload(["p1", "p2"], "cold");
    expect(setPayloadSpy).toHaveBeenCalledWith("agent_memory", {
      payload: { tier: "cold" },
      points: ["p1", "p2"],
    });
  });

  it("returns early without calling Qdrant when pointIds is empty", async () => {
    const embedder = new MemoryEmbedder();
    const setPayloadSpy = vi.fn();
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    await embedder.setTierPayload([], "warm");
    expect(setPayloadSpy).not.toHaveBeenCalled();
  });

  it("swallows Qdrant errors (best-effort)", async () => {
    const embedder = new MemoryEmbedder();
    const setPayloadSpy = vi.fn().mockRejectedValue(new Error("network down"));
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    (embedder as any).collectionReady = true;
    await expect(embedder.setTierPayload(["p1"], "warm")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3:** Verify

```bash
npm run test -- src/memory/memory-embedder.test.ts
```

Expected: all tests pass (existing + new).

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-embedder.ts src/memory/memory-embedder.test.ts
git commit -m "feat(memory): embedder truncation + set_payload tier sync (KPR-241)"
```

### Task 4: `MemoryStore` — vectorIndex injection, paged cold, sourceRef, options-object autoDream run

**Files:**
- Modify: `src/memory/memory-store.ts`
- Test: `src/memory/memory-store.test.ts`
- Test: `src/memory/memory-manager.test.ts` (mock update)

- [ ] **Step 1:** Add `vectorIndex` constructor injection + extend `AutoDreamAgentState`.

Replace the top imports:

```typescript
import { ObjectId, type Collection, type Db, type WithoutId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type {
  MemoryRecord,
  MemoryRecordInput,
  MemoryImportance,
  MemoryTier,
  PurgeFilters,
  ConsolidationPhase,
  ConsolidationCursor,
  AutoDreamSpendSample,
} from "./memory-types.js";
import type { MemoryVectorIndex } from "./memory-vector-index.js";
```

Replace `AutoDreamAgentState`:

```typescript
export interface AutoDreamAgentState {
  _id: string;
  agentId: string;
  lastDreamAt: Date;
  changedMemoryCount: number;
  spentUsd: number;
  llmCalls: number;
  updatedAt: Date;
  // KPR-241 additions
  phase?: ConsolidationPhase;
  topic?: string | null;
  cursor?: ConsolidationCursor | null;
  lastError?: string | null;
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  spendHistory?: AutoDreamSpendSample[];
}
```

Modify the `MemoryStore` class constructor + add `vectorIndex` field:

```typescript
export class MemoryStore {
  private collection!: Collection<MemoryRecord>;
  private autoDreamStateCollection!: Collection<AutoDreamAgentState>;
  private onMutate?: (agentId: string | null, reason: string) => void;
  /** KPR-241: optional vector-index for Qdrant tier sync on transitions. */
  private vectorIndex?: MemoryVectorIndex;

  constructor(private db: Db, vectorIndex?: MemoryVectorIndex) {
    this.vectorIndex = vectorIndex;
  }
```

(Existing `setOnMutate` stays unchanged.)

- [ ] **Step 2:** Thread `sourceRef` through `save()`. Replace the `save` method:

```typescript
  async save(
    agentId: string,
    input: MemoryRecordInput,
    qdrantPointId: string,
    sourceChannel?: string,
    sourceThread?: string,
  ): Promise<MemoryRecord> {
    const now = new Date();
    const record: MemoryRecord = {
      agentId,
      content: input.content,
      type: input.type,
      topic: input.topic,
      importance: input.importance,
      tier: "hot",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceChannel,
      sourceThread,
      pinned: false,
      summarized: false,
      qdrantPointId,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    };
    const result = await this.collection.insertOne(record as WithoutId<MemoryRecord>);
    record._id = result.insertedId;
    this.onMutate?.(agentId, "memory-save");
    return record;
  }
```

- [ ] **Step 3:** Extend `setTier` and `setTierBulk` to call `vectorIndex.setTierPayload`. Replace both methods:

```typescript
  async setTier(id: ObjectId, tier: MemoryTier): Promise<void> {
    const before = await this.collection.findOne(
      { _id: id },
      { projection: { agentId: 1, qdrantPointId: 1 } },
    );
    await this.collection.updateOne({ _id: id }, { $set: { tier } });
    if (before) {
      this.onMutate?.(before.agentId, "memory-set-tier");
      if (before.qdrantPointId && this.vectorIndex) {
        await this.vectorIndex.setTierPayload([before.qdrantPointId], tier);
      }
    }
  }

  async setTierBulk(ids: ObjectId[], tier: MemoryTier): Promise<void> {
    if (ids.length === 0) return;
    const records = await this.collection
      .find({ _id: { $in: ids } })
      .project<{ qdrantPointId: string }>({ qdrantPointId: 1 })
      .toArray();
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { tier } });
    if (this.vectorIndex) {
      const pointIds = records.map((r) => r.qdrantPointId).filter(Boolean);
      await this.vectorIndex.setTierPayload(pointIds, tier);
    }
    this.onMutate?.(null, "memory-set-tier-bulk");
  }
```

- [ ] **Step 4:** Replace `getColdByTopic` with `getColdByTopicPaged`. Delete the existing `getColdByTopic` method (lines 267-272) and add:

```typescript
  /**
   * KPR-241: paged cold-by-topic lookup with compound cursor. Returns up to
   * `limit` non-summarized cold records for the topic, sorted by
   * `{ createdAt: 1, _id: 1 }`. When cursor is null, returns the oldest
   * records; when set, applies the compound `$or` predicate so same-instant
   * siblings (records sharing createdAt to the millisecond) are not skipped.
   */
  async getColdByTopicPaged(
    agentId: string,
    topic: string,
    cursor: ConsolidationCursor | null,
    limit: number,
  ): Promise<MemoryRecord[]> {
    const filter: Record<string, unknown> = {
      agentId,
      tier: "cold",
      topic,
      summarized: false,
      purged: { $ne: true },
    };
    if (cursor) {
      filter.$or = [
        { createdAt: { $gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $gt: cursor.lastId } },
      ];
    }
    // Follow the existing pattern in `purge` — pass `Record<string, unknown>`
    // directly without casting. TypeScript accepts it against `Filter<MemoryRecord>`
    // for these dynamic-query shapes.
    return this.collection.find(filter).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray();
  }
```

`getColdTopics` stays unchanged (it's a distinct lookup, not a content lookup).

- [ ] **Step 5:** Refactor `markAutoDreamRun` to options-object signature.

Replace:

```typescript
  /**
   * KPR-241: options-object signature so phase/topic/cursor/error fields can
   * be updated independently of the spend fields. Appends to spendHistory
   * (capped at 60 entries) whenever `at` and `spentUsd` are both provided.
   */
  async markAutoDreamRun(
    agentId: string,
    update: {
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
    },
  ): Promise<void> {
    const setFields: Record<string, unknown> = {
      agentId,
      lastDreamAt: update.at,
      updatedAt: new Date(),
    };
    if (update.changedMemoryCount !== undefined) setFields.changedMemoryCount = update.changedMemoryCount;
    if (update.spentUsd !== undefined) setFields.spentUsd = update.spentUsd;
    if (update.llmCalls !== undefined) setFields.llmCalls = update.llmCalls;
    if (update.phase !== undefined) setFields.phase = update.phase;
    if (update.topic !== undefined) setFields.topic = update.topic;
    if (update.cursor !== undefined) setFields.cursor = update.cursor;
    if (update.lastError !== undefined) setFields.lastError = update.lastError;
    if (update.lastAttemptAt !== undefined) setFields.lastAttemptAt = update.lastAttemptAt;
    if (update.lastSuccessAt !== undefined) setFields.lastSuccessAt = update.lastSuccessAt;

    const ops: Record<string, unknown> = { $set: setFields };
    if (update.spentUsd !== undefined && update.spentUsd > 0) {
      ops.$push = {
        spendHistory: {
          $each: [{ at: update.at, spentUsd: update.spentUsd }],
          $slice: -60, // keep most recent 60 samples
        },
      };
    }
    await this.autoDreamStateCollection.updateOne({ _id: agentId }, ops, { upsert: true });
  }
```

- [ ] **Step 6:** Update `memory-lifecycle.ts` callsite to new signature (preview — full lifecycle work in Task 6). For now just adjust the one existing call to keep typecheck green:

In `src/memory/memory-lifecycle.ts`, around line 343-349 inside `dream()`:

```typescript
          await this.store.markAutoDreamRun(agentId, {
            at: new Date(),
            changedMemoryCount,
            spentUsd: budget.spentUsd - agentStartSpent,
            llmCalls: budget.llmCalls - agentStartCalls,
          });
```

(This minimal adjustment keeps `dream()` working; full phase/topic/cursor wiring lands in Task 6.)

- [ ] **Step 7:** Add tests in `memory-store.test.ts`. **Follow the existing mocked-Mongo pattern** at the top of the file (lines 1-60): `mockFind`, `mockFindOne`, `mockUpdateOne`, `mockUpdateMany`, `mockInsertOne`, etc. are vi.fn() stubs returned by a `mockCollection`. Tests configure per-call behavior with `mockX.mockReturnValueOnce(...)` / `mockX.mockResolvedValueOnce(...)`. Don't write tests as if `store.save(...)` reaches a real Mongo.

For `setTier`/`setTierBulk`, the new code calls `collection.find({...}).project({ qdrantPointId: 1 }).toArray()` (bulk path) or `collection.findOne({...}, { projection: { agentId: 1, qdrantPointId: 1 } })` (single path). The existing mock-chain helpers need extending — add `mockProject` near the top of the file:

```typescript
const mockProject = vi.fn().mockReturnValue({ toArray: mockToArray });
const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray });
// Extend mockFind to support `.sort().limit().toArray()` and `.project().toArray()` chains.
mockSort.mockReturnValue({ toArray: mockToArray, limit: mockLimit, project: mockProject });
mockFind.mockReturnValue({
  toArray: mockToArray, sort: mockSort, project: mockProject, limit: mockLimit,
});
```

Then add the new `describe` blocks (use the existing mock infrastructure):

```typescript
import type { MemoryVectorIndex } from "./memory-vector-index.js";
import { MemoryStore } from "./memory-store.js";

describe("MemoryStore vectorIndex injection (KPR-241)", () => {
  let store: MemoryStore;
  let setTierPayloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setTierPayloadSpy = vi.fn().mockResolvedValue(undefined);
    const vectorIndex: MemoryVectorIndex = { setTierPayload: setTierPayloadSpy };
    store = new MemoryStore(mockDb as any, vectorIndex);
    await store.init();
  });

  it("calls vectorIndex.setTierPayload on setTier when qdrantPointId is present", async () => {
    mockFindOne.mockResolvedValueOnce({ agentId: "a1", qdrantPointId: "point-1" });
    await store.setTier(new ObjectId(), "cold");
    expect(setTierPayloadSpy).toHaveBeenCalledWith(["point-1"], "cold");
  });

  it("setTier no-ops vectorIndex when findOne returns null", async () => {
    mockFindOne.mockResolvedValueOnce(null);
    await store.setTier(new ObjectId(), "cold");
    expect(setTierPayloadSpy).not.toHaveBeenCalled();
  });

  it("setTierBulk projects qdrantPointId and forwards all IDs", async () => {
    mockToArray.mockResolvedValueOnce([{ qdrantPointId: "p1" }, { qdrantPointId: "p2" }]);
    await store.setTierBulk([new ObjectId(), new ObjectId()], "warm");
    expect(setTierPayloadSpy).toHaveBeenCalledWith(expect.arrayContaining(["p1", "p2"]), "warm");
  });

  it("no-ops vectorIndex completely when not injected", async () => {
    const noIndexStore = new MemoryStore(mockDb as any);
    await noIndexStore.init();
    mockFindOne.mockResolvedValueOnce({ agentId: "a1", qdrantPointId: "p1" });
    await expect(noIndexStore.setTier(new ObjectId(), "cold")).resolves.toBeUndefined();
    expect(setTierPayloadSpy).not.toHaveBeenCalled(); // shared spy across tests would catch leaks
  });
});

describe("MemoryStore.getColdByTopicPaged (KPR-241)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds filter without $or when cursor is null", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    mockToArray.mockResolvedValueOnce([]);
    await store.getColdByTopicPaged("a1", "t", null, 20);
    const filterArg = mockFind.mock.calls[0][0];
    expect(filterArg).toMatchObject({ agentId: "a1", tier: "cold", topic: "t", summarized: false });
    expect(filterArg.$or).toBeUndefined();
  });

  it("builds compound $or filter when cursor is set", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    const cursorDate = new Date("2026-01-01");
    const cursorId = new ObjectId();
    mockToArray.mockResolvedValueOnce([]);
    await store.getColdByTopicPaged("a1", "t", { createdAt: cursorDate, lastId: cursorId }, 20);
    const filterArg = mockFind.mock.calls[0][0];
    expect(filterArg.$or).toEqual([
      { createdAt: { $gt: cursorDate } },
      { createdAt: cursorDate, _id: { $gt: cursorId } },
    ]);
  });

  it("sorts by { createdAt: 1, _id: 1 } and applies limit", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    mockToArray.mockResolvedValueOnce([]);
    await store.getColdByTopicPaged("a1", "t", null, 7);
    expect(mockSort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(mockLimit).toHaveBeenCalledWith(7);
  });
});

describe("MemoryStore.markAutoDreamRun options-object (KPR-241)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists phase/topic/cursor/lastError via $set", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    const cursor = { createdAt: new Date("2026-01-01"), lastId: new ObjectId() };
    await store.markAutoDreamRun("a1", {
      at: new Date(),
      phase: "summarizeCold",
      topic: "t",
      cursor,
      lastError: "boom",
    });
    const updateCall = mockUpdateOne.mock.calls[0];
    expect(updateCall[0]).toEqual({ _id: "a1" });
    expect(updateCall[1].$set).toMatchObject({
      phase: "summarizeCold", topic: "t", cursor, lastError: "boom",
    });
    expect(updateCall[2]).toMatchObject({ upsert: true });
  });

  it("appends to spendHistory with $push + $slice -60 when spentUsd > 0", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    await store.markAutoDreamRun("a1", { at: new Date("2026-01-01"), spentUsd: 0.01 });
    const updateCall = mockUpdateOne.mock.calls[0];
    expect(updateCall[1].$push).toEqual({
      spendHistory: { $each: [{ at: new Date("2026-01-01"), spentUsd: 0.01 }], $slice: -60 },
    });
  });

  it("does not push to spendHistory when spentUsd is 0 or omitted", async () => {
    const store = new MemoryStore(mockDb as any);
    await store.init();
    await store.markAutoDreamRun("a1", { at: new Date(), phase: "idle" });
    expect(mockUpdateOne.mock.calls[0][1].$push).toBeUndefined();
  });
});
```

- [ ] **Step 8:** Update the `getColdByTopic` mock in `memory-manager.test.ts:63`:

Replace the line:

```typescript
    getColdByTopic: vi.fn(),
```

With:

```typescript
    getColdByTopicPaged: vi.fn().mockResolvedValue([]),
```

(memory-manager.test.ts doesn't exercise this path, but the mock object must satisfy the new interface.)

- [ ] **Step 9:** Verify

```bash
npm run test -- src/memory/memory-store.test.ts src/memory/memory-manager.test.ts
```

Expected: all tests pass.

- [ ] **Step 10:** Commit

```bash
git add src/memory/memory-store.ts src/memory/memory-store.test.ts src/memory/memory-manager.test.ts src/memory/memory-lifecycle.ts
git commit -m "feat(memory): store vectorIndex injection + paged cold + options-object autoDream run (KPR-241)"
```

### Task 5: `structured-memory-mcp-server.ts` — guards + sourceRef + recall filters

**Files:**
- Modify: `src/memory/structured-memory-mcp-server.ts`
- Test: `src/memory/structured-memory-mcp-server.test.ts`

- [ ] **Step 1:** Add config-driven guard thresholds via a new `StructuredMemoryGuardConfig`:

Add near the top of `src/memory/structured-memory-mcp-server.ts` (after imports):

```typescript
/**
 * KPR-241: write-time guard thresholds. Defaults are conservative; operators
 * can tune via hive.yaml memory.writeGuards.*.
 */
export interface StructuredMemoryGuardConfig {
  burst: { enabled: boolean; windowMinutes: number; similarityThreshold: number; topK: number };
  oversize: { enabled: boolean; maxChars: number };
  rawDump: { enabled: boolean; jsonTokenThreshold: number; monolithCharThreshold: number };
}

const GUARD_DEFAULTS: StructuredMemoryGuardConfig = {
  burst: { enabled: true, windowMinutes: 1440, similarityThreshold: 0.92, topK: 5 },
  oversize: { enabled: true, maxChars: 6000 },
  rawDump: { enabled: true, jsonTokenThreshold: 300, monolithCharThreshold: 2000 },
};
```

Extend `StructuredMemoryToolDeps`:

```typescript
export interface StructuredMemoryToolDeps {
  db: Db;
  agentId: string;
  context: { current: StructuredMemoryTurnContext };
  qdrantUrl?: string;
  ollamaUrl?: string;
  onMutate?: (agentId: string | null, reason: string) => void;
  /** KPR-241: optional write-guard config; defaults to GUARD_DEFAULTS. */
  guardConfig?: StructuredMemoryGuardConfig;
}
```

- [ ] **Step 2:** Add `sourceRef` parameter to `memory_save` Zod schema + thread to `store.save`. Also add three guards.

Locate the `memory_save` tool definition. Replace its schema + handler:

```typescript
    tool(
      "memory_save",
      "Save a new structured memory record. Use this to remember facts, tasks, interactions, preferences, decisions, or summaries.",
      {
        content: z.string().describe("The memory content — a fact, note, task, preference, or decision"),
        type: z.enum(VALID_TYPES).describe("Memory type: fact, task, interaction, preference, or decision"),
        topic: z.string().describe('Freeform topic tag, e.g. "customer:jones", "project:kitchen-reno"'),
        importance: z.enum(VALID_IMPORTANCE).describe("Importance level: critical, high, medium, or low"),
        sourceRef: z
          .string()
          .optional()
          .describe(
            "Pointer to system of record (Linear URL, GitHub link, Slack permalink, CRM record). URL form preferred. Add this when the memory references a fact that lives somewhere authoritative.",
          ),
      },
      async ({ content, type, topic, importance, sourceRef }) => {
        try {
          await ensureInit();
          const guard = deps.guardConfig ?? GUARD_DEFAULTS;

          // Oversize guard
          if (guard.oversize.enabled && content.length > guard.oversize.maxChars) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `memory_save error: content too long (${content.length} chars; limit ${guard.oversize.maxChars}). ` +
                    `Memory should be a digest, not a paste. Break into smaller records with a shared topic, ` +
                    `or save a digest + sourceRef pointing to the full source.`,
                },
              ],
            };
          }

          // Raw-fact-dump heuristic
          if (guard.rawDump.enabled && !sourceRef) {
            const isJsonLike = /^[{\[]/.test(content.trim());
            const tokenEst = Math.ceil(content.length / 4);
            const tableLines = (content.match(/^\s*\|.*\|.*$/gm) ?? []).length;
            const isMonolith = !content.includes("\n") && content.length > guard.rawDump.monolithCharThreshold;
            const isJsonDump = isJsonLike && tokenEst > guard.rawDump.jsonTokenThreshold;
            const isTableDump = tableLines > 3;
            if (isJsonDump || isTableDump || isMonolith) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      `memory_save error: content looks like a raw dump from an external system. ` +
                      `Memory should hold a digest plus a sourceRef pointing to the original ` +
                      `(Linear URL, GitHub link, Slack permalink, CRM record).`,
                  },
                ],
              };
            }
          }

          // Burst guard — Qdrant-dependent, fail open on outage.
          if (guard.burst.enabled) {
            try {
              const recentSimilar = await embedder.search(content, agentId, {
                topic,
                limit: guard.burst.topK,
              });
              const cutoff = Date.now() - guard.burst.windowMinutes * 60_000;
              for (const sr of recentSimilar) {
                if (sr.score < guard.burst.similarityThreshold) continue;
                const existing = await store.getById(new ObjectId(sr.mongoId));
                if (!existing) continue;
                if (existing.createdAt.getTime() < cutoff) continue;
                if (existing.topic !== topic) continue;
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text:
                        `memory_save error: too similar to existing record [${existing._id}] in topic "${topic}" ` +
                        `(similarity ${sr.score.toFixed(2)}). Use memory_update on the existing record, ` +
                        `or add a sourceRef to distinguish if these are different sources.`,
                    },
                  ],
                };
              }
            } catch (err) {
              // KPR-241: fail open — Qdrant outage skips burst check only, save proceeds.
              // Oversize + raw-dump already enforced above.
              process.stderr.write(`memory_save burst-guard skipped: ${String(err)}\n`);
            }
          }

          // All guards passed (or skipped on outage). Save.
          const pointId = crypto.randomUUID();
          const record = await store.save(
            agentId,
            { content, type: type as MemoryType, topic, importance: importance as MemoryImportance, sourceRef },
            pointId,
            context.current.channelId,
            context.current.threadId,
          );

          embedder
            .upsert(pointId, content, {
              agentId,
              mongoId: record._id!.toString(),
              type,
              topic,
              tier: "hot",
              importance,
              createdAt: Math.floor(record.createdAt.getTime() / 1000),
            })
            .catch((err) => {
              process.stderr.write(`memory_save embed error: ${err}\n`);
            });

          return {
            content: [
              {
                type: "text",
                text: `Saved memory [${record._id}] — type:${type} topic:"${topic}" importance:${importance}`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_save error: ${String(err)}` }] };
        }
      },
    ),
```

- [ ] **Step 3:** Add fidelity filters to `memory_recall`. Find the existing `memory_recall` definition and replace the handler body's filter construction + lookup:

```typescript
      async ({ query, type, topic, tier, importance, limit }) => {
        try {
          await ensureInit();
          // KPR-241: must_not filter to hide cold from default recall.
          const extraMustNot = tier === undefined ? [{ key: "tier", match: { value: "cold" } }] : [];
          const searchResults = await embedder.search(
            query,
            agentId,
            {
              type: type as MemoryType,
              topic,
              tier: tier as MemoryTier,
              importance: importance as MemoryImportance,
              limit,
            },
            extraMustNot,
          );

          if (searchResults.length === 0) {
            return { content: [{ type: "text", text: "No matching memories found." }] };
          }

          const ids = searchResults.map((r) => new ObjectId(r.mongoId));
          // KPR-241: hide summarized originals from normal recall.
          const allRecords = await store.getByIds(ids, { excludeSummarized: true });
          const recordMap = new Map(allRecords.map((r) => [r._id!.toString(), r]));

          const records: string[] = [];
          for (const sr of searchResults) {
            const record = recordMap.get(sr.mongoId);
            if (!record) continue;
            const pinLabel = record.pinned ? " [pinned]" : "";
            const date = record.updatedAt.toISOString().split("T")[0];
            records.push(
              `**[${record._id}]** (${record.type}/${record.importance}, ${record.tier}${pinLabel}, ${date}, relevance: ${sr.score.toFixed(2)})\n` +
                `Topic: ${record.topic}\n${record.content}`,
            );
          }

          await store.touchAccess(ids);

          if (records.length === 0) {
            return { content: [{ type: "text", text: "No matching memories found." }] };
          }
          return { content: [{ type: "text", text: records.join("\n\n---\n\n") }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_recall error: ${String(err)}` }] };
        }
      },
```

Two helper changes are implied:
1. `MemoryEmbedder.search` gains an optional `extraMustNot` parameter.
2. `MemoryStore.getByIds` gains an `excludeSummarized` option.

Apply those:

In `src/memory/memory-embedder.ts`, modify `search`:

```typescript
  async search(
    query: string,
    agentId: string,
    filters?: MemoryRecallFilters,
    extraMustNot: Array<{ key: string; match: { value: string } }> = [],
  ): Promise<EmbedSearchResult[]> {
    await this.ensureCollection();
    const queryVector = await this.embed(query);
    const limit = filters?.limit ?? 10;

    const must: any[] = [{ key: "agentId", match: { value: agentId } }];
    if (filters?.type) must.push({ key: "type", match: { value: filters.type } });
    if (filters?.topic) must.push({ key: "topic", match: { value: filters.topic } });
    if (filters?.tier) must.push({ key: "tier", match: { value: filters.tier } });
    if (filters?.importance) must.push({ key: "importance", match: { value: filters.importance } });

    const searchFilter: any = { must };
    if (extraMustNot.length > 0) searchFilter.must_not = extraMustNot;

    const results = await this.getClient().search(COLLECTION, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: searchFilter,
    });

    return results.map((r) => ({
      mongoId: r.payload?.mongoId as string,
      score: r.score,
    }));
  }
```

In `src/memory/memory-store.ts`, modify `getByIds`:

```typescript
  async getByIds(
    ids: ObjectId[],
    options: { excludeSummarized?: boolean } = {},
  ): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    const filter: Record<string, unknown> = { _id: { $in: ids }, purged: { $ne: true } };
    if (options.excludeSummarized) filter.summarized = { $ne: true };
    return this.collection.find(filter as Parameters<typeof this.collection.find>[0]).toArray();
  }
```

- [ ] **Step 4:** Add tests in `structured-memory-mcp-server.test.ts`. **Follow the existing pattern at the top of the file (lines 1-50):** `vi.mock("./memory-store.js", ...)` and `vi.mock("./memory-embedder.js", ...)` provide constructors that return canned objects with `vi.fn()` methods; per-test behavior is overridden by reaching into the mocked `MemoryStore` / `MemoryEmbedder` constructor return values. Use the existing `getHandler(tools, name)` helper.

Extend the existing `vi.mock` factories to expose the new methods (`search` was already mocked but we need to control it per-test; `getById`, `markSummarized`, `flagForReview` need additions). Add at the top of the file alongside the existing `mockSave` / `mockUpsert`:

```typescript
const mockSearch = vi.fn().mockResolvedValue([]);
const mockGetById = vi.fn().mockResolvedValue(null);
const mockMarkSummarized = vi.fn().mockResolvedValue(undefined);

// Update the vi.mock("./memory-store.js", ...) factory to include these:
vi.mock("./memory-store.js", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    save: mockSave,
    getById: mockGetById,
    getByIds: vi.fn().mockResolvedValue([]),
    touchAccess: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    purge: vi.fn().mockResolvedValue(0),
    getHotTierWithStats: vi.fn().mockResolvedValue([]),
    markSummarized: mockMarkSummarized,
  })),
}));

// Update the vi.mock("./memory-embedder.js", ...) factory to surface mockSearch:
vi.mock("./memory-embedder.js", () => ({
  MemoryEmbedder: vi.fn().mockImplementation(() => ({
    upsert: mockUpsert,
    search: mockSearch,
    remove: vi.fn().mockResolvedValue(undefined),
  })),
}));
```

A small helper to build a default-deps tools array per test:

```typescript
function buildToolsForTest() {
  return buildStructuredMemoryTools({
    db: { collection: () => ({}) } as any,
    agentId: "a1",
    context: { current: {} },
  });
}
```

Now the new `describe` blocks:

```typescript
import { ObjectId } from "mongodb";

describe("memory_save burst guard (KPR-241)", () => {
  beforeEach(() => { mockSearch.mockReset(); mockGetById.mockReset(); mockSave.mockClear(); });

  it("rejects when a recent same-topic record exceeds similarity threshold", async () => {
    const existingId = new ObjectId();
    mockSearch.mockResolvedValueOnce([{ mongoId: existingId.toString(), score: 0.95 }]);
    mockGetById.mockResolvedValueOnce({
      _id: existingId, topic: "t", createdAt: new Date(),
    });
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "first variant", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("too similar to existing record");
    expect(res.content[0].text).toContain("sourceRef");
  });

  it("does not reject when score is below threshold", async () => {
    mockSearch.mockResolvedValueOnce([{ mongoId: "abc", score: 0.5 }]);
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "novel content", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("does not reject when topic differs (Mongo lookup confirms cross-topic mismatch)", async () => {
    const existingId = new ObjectId();
    mockSearch.mockResolvedValueOnce([{ mongoId: existingId.toString(), score: 0.99 }]);
    mockGetById.mockResolvedValueOnce({
      _id: existingId, topic: "topicA", createdAt: new Date(),
    });
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "x", type: "fact", topic: "topicB", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("fails open when embedder.search throws — save proceeds", async () => {
    mockSearch.mockRejectedValueOnce(new Error("Qdrant down"));
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "novel content", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Saved memory");
  });
});

describe("memory_save oversize guard (KPR-241)", () => {
  beforeEach(() => { mockSearch.mockReset(); mockSave.mockClear(); });

  it("rejects content longer than maxChars", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const longContent = "x".repeat(7000);
    const res = await save({ content: longContent, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("content too long");
    expect(res.content[0].text).toContain("sourceRef");
  });

  it("accepts content below maxChars", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const ok = "x".repeat(5999);
    const res = await save({ content: ok, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("still fires even when burst guard is bypassed by Qdrant error", async () => {
    mockSearch.mockRejectedValueOnce(new Error("Qdrant down"));
    const save = getHandler(buildToolsForTest(), "memory_save");
    const longContent = "x".repeat(7000);
    const res = await save({ content: longContent, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });
});

describe("memory_save raw-dump heuristic (KPR-241)", () => {
  beforeEach(() => { mockSearch.mockReset(); mockSave.mockClear(); });

  it("rejects JSON-shaped content without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const json = '{"foo": "bar", "baz": "' + "x".repeat(2000) + '"}';
    const res = await save({ content: json, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("raw dump");
  });

  it("accepts JSON-shaped content WITH sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const json = '{"foo": "bar", "baz": "' + "x".repeat(2000) + '"}';
    const res = await save({
      content: json, type: "fact", topic: "t", importance: "medium",
      sourceRef: "https://example.com/source",
    });
    expect(res.isError).toBeFalsy();
  });

  it("rejects table-shaped content without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const tbl = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |";
    const res = await save({ content: tbl, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });

  it("rejects single-line monolith without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const monolith = "x".repeat(2500);
    const res = await save({ content: monolith, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });

  it("accepts short normal content with no shape signal", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({
      content: "we decided to use X because of Y constraint",
      type: "decision", topic: "t", importance: "medium",
    });
    expect(res.isError).toBeFalsy();
  });
});

describe("memory_recall fidelity filters (KPR-241)", () => {
  beforeEach(() => { mockSearch.mockReset(); });

  it("adds must_not: tier=cold to Qdrant filter when caller omits tier", async () => {
    mockSearch.mockResolvedValueOnce([]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything" });
    // Embedder.search is called with (query, agentId, filters, extraMustNot) per Task 5 Step 3.
    const callArgs = mockSearch.mock.calls[0];
    expect(callArgs[3]).toEqual([{ key: "tier", match: { value: "cold" } }]);
  });

  it("omits must_not filter when caller passes explicit tier", async () => {
    mockSearch.mockResolvedValueOnce([]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything", tier: "warm" });
    const callArgs = mockSearch.mock.calls[0];
    expect(callArgs[3]).toEqual([]);
  });

  it("calls getByIds with excludeSummarized:true", async () => {
    // Verifying via the mocked store's getByIds — extend the mock to capture the call.
    // (Tests that need to assert call args on getByIds should mock per-test if needed.)
    mockSearch.mockResolvedValueOnce([{ mongoId: "deadbeefdeadbeefdeadbeef", score: 0.9 }]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything" });
    // The mocked MemoryStore returns getByIds: vi.fn().mockResolvedValue([]) by default.
    // To assert excludeSummarized, hoist the getByIds spy alongside mockSearch and assert here.
    // Implementer: add `const mockGetByIds = vi.fn().mockResolvedValue([])` and thread it into the
    // vi.mock factory; assert mockGetByIds.mock.calls[0][1] is { excludeSummarized: true }.
  });
});
```

**Note for implementer:** the last test's `mockGetByIds` instruction is intentional — hoist it the same way `mockSave` and `mockUpsert` are hoisted (lines 17-18 of the existing file). The pattern is: declare the vi.fn at top of file, reference it in the `vi.mock(...)` factory, then assert on its `.mock.calls` per-test.

- [ ] **Step 5:** Verify

```bash
npm run test -- src/memory/structured-memory-mcp-server.test.ts src/memory/memory-embedder.test.ts
```

Expected: all tests pass.

- [ ] **Step 6:** Commit

```bash
git add src/memory/structured-memory-mcp-server.ts src/memory/structured-memory-mcp-server.test.ts src/memory/memory-embedder.ts src/memory/memory-store.ts src/memory/memory-embedder.test.ts
git commit -m "feat(memory): write-time guards + recall fidelity filters (KPR-241)"
```

### Task 6: `MemoryLifecycle` — relocate summarizeCold to dream() as paged phase

**Files:**
- Modify: `src/memory/memory-lifecycle.ts`
- Test: `src/memory/memory-lifecycle.test.ts`

- [ ] **Step 0:** Add missing imports to `src/memory/memory-lifecycle.ts`. The new code references `ConsolidationCursor` (from `memory-types.js`) and `AutoDreamAgentState` (from `memory-store.js`). The current import blocks need extending:

```typescript
import type { MemoryStore, AutoDreamAgentState } from "./memory-store.js";
// ...existing memory-types import gets ConsolidationCursor added:
import type {
  MemoryRecord,
  MemoryLifecycleConfig,
  MemoryTier,
  DreamConfig,
  DreamResult,
  MemoryImportance,
  ConsolidationCursor,
} from "./memory-types.js";
```

- [ ] **Step 1:** Add new config knobs to `MemoryLifecycle` constructor + `DreamConfig` extension.

In `src/memory/memory-types.ts`, extend `DreamConfig`:

```typescript
export interface DreamConfig {
  // ...existing fields...
  // KPR-241 additions
  coldSummaryPageSize?: number;            // default 20
  coldSummaryPromptTokenBudget?: number;   // default 8000
  summaryOfSummariesThreshold?: number;    // default 5
}
```

- [ ] **Step 2:** Remove `summarizeCold` call from `sweepAgent` (line 262-267) and add it as a phase inside `dream()`.

In `src/memory/memory-lifecycle.ts`, inside `sweepAgent`, delete:

```typescript
      // 4. Summarize cold batches
      try {
        summarizedCount = await this.summarizeCold(agentId);
      } catch (err) {
        log.warn("Cold summarization failed", { agentId, error: String(err) });
      }
```

(Renumber comments: 1-3 stay, 4 becomes "Clean up old summarized records", 5 becomes "Hard-delete purged records".)

- [ ] **Step 3:** Replace the per-agent body of `dream()` with phase-progression logic. The full method becomes (focused on the per-agent loop):

```typescript
      for (const agentId of agentIds) {
        try {
          const state = await this.store.getAutoDreamState(agentId);
          const changedMemoryCount = await this.store.countAutoDreamCandidates(agentId, state?.lastDreamAt);
          if (changedMemoryCount < this.autoDreamMinNewMemories()) {
            skippedAgents++;
            log.debug("autoDream skipped agent — insufficient new memory", {
              agentId,
              changedMemoryCount,
              minNewMemories: this.autoDreamMinNewMemories(),
            });
            continue;
          }

          const agentStartSpent = budget.spentUsd;
          const agentStartCalls = budget.llmCalls;
          const runAt = new Date();
          let runError: string | null = null;

          let summarizeColdDrained = true;
          try {
            // Phase 1: summarizeCold (KPR-241 — moved here from sweepAgent)
            const r0 = await this.summarizeColdPhase(agentId, budget, state);
            summarized += r0.summarized;
            summarizeColdDrained = r0.drained;

            // Phase 2-4 (existing)
            const r1 = await this.mergeDuplicates(agentId, budget);
            merged += r1.merged;
            const r2 = await this.detectContradictions(agentId, budget);
            contradictions += r2.resolved;
            flaggedForReview += r2.flagged;
            const r3 = await this.promotePatterns(agentId, budget);
            promoted += r3.promoted;
          } catch (err) {
            runError = String(err);
            throw err;
          } finally {
            // Only reset phase/topic/cursor when summarizeCold fully drained;
            // otherwise preserve checkpoint so next run resumes.
            const resetCheckpoint = runError === null && summarizeColdDrained;
            try {
              await this.store.markAutoDreamRun(agentId, {
                at: runAt,
                changedMemoryCount,
                spentUsd: budget.spentUsd - agentStartSpent,
                llmCalls: budget.llmCalls - agentStartCalls,
                lastAttemptAt: runAt,
                lastError: runError,
                ...(runError === null ? { lastSuccessAt: runAt } : {}),
                ...(resetCheckpoint ? { phase: "idle", topic: null, cursor: null } : {}),
              });
            } catch (markErr) {
              // Don't let a checkpoint-write failure mask the underlying run error.
              log.warn("autoDream markAutoDreamRun failed", { agentId, error: String(markErr) });
            }
          }
        } catch (err) {
          errors.push(`${agentId}: ${err}`);
          log.error("autoDream failed for agent", { agentId, error: String(err) });
          if (String(err).includes("autoDream run budget exhausted")) break;
          if (String(err).includes("hit your limit")) break;
        }
      }
```

(The local `summarized` counter is now collected at the `dream()` level. Add `let summarized = 0` near the existing `let merged = 0` at the top of `dream()`. Add `summarized` to `DreamResult` returns.)

Also extend `DreamResult` in `memory-types.ts`:

```typescript
export interface DreamResult {
  merged: number;
  contradictions: number;
  promoted: number;
  flaggedForReview: number;
  errors: string[];
  skippedAgents?: number;
  spentUsd?: number;
  budgetUsd?: number;
  llmCalls?: number;
  summarized?: number; // KPR-241
}
```

- [ ] **Step 4:** Replace `summarizeCold` with `summarizeColdPhase` — paged + checkpointed + oversize-aware.

Delete the existing `summarizeCold` method body. Add:

```typescript
  /**
   * KPR-241: paged + checkpointed cold-summary consolidation as an
   * autoDream phase. Drains backlog across multiple sweep cycles; each
   * call processes at most `coldSummaryPageSize` records per topic.
   *
   * Resumes from extended `agent_memory_autodream_state.cursor` on
   * partial failure; advances to `{ lastRecord.createdAt, lastRecord._id }`
   * after each successful page.
   *
   * Returns `drained: true` only when every topic was processed to
   * completion within this call. If budget exhausted mid-traversal or a
   * topic still has cold records that didn't fit in the page, returns
   * `drained: false` so the outer `dream()` block does NOT reset
   * phase/topic/cursor — those are needed to resume next run.
   */
  private async summarizeColdPhase(
    agentId: string,
    budget: AutoDreamBudget,
    state: AutoDreamAgentState | null,
  ): Promise<{ summarized: number; drained: boolean }> {
    const cfg = this.dreamConfig!;
    const pageSize = cfg.coldSummaryPageSize ?? 20;
    const promptTokenBudget = cfg.coldSummaryPromptTokenBudget ?? 8000;
    let summarized = 0;

    const topics = await this.store.getColdTopics(agentId);
    if (topics.length === 0) return { summarized: 0, drained: true };
    topics.sort(); // deterministic order

    // Resume from checkpoint if state matches phase=summarizeCold.
    const resumeTopic = state?.phase === "summarizeCold" ? state.topic ?? null : null;
    const resumeCursor = state?.phase === "summarizeCold" ? state.cursor ?? null : null;
    const startIdx = resumeTopic ? Math.max(0, topics.indexOf(resumeTopic)) : 0;

    for (let i = startIdx; i < topics.length; i++) {
      const topic = topics[i];
      const cursor: ConsolidationCursor | null = i === startIdx ? resumeCursor : null;

      // Inner pagination loop — at most one page per dream() invocation
      // per topic (caller cooldown bounds frequency).
      const page = await this.store.getColdByTopicPaged(agentId, topic, cursor, pageSize);
      if (page.length < this.config.coldSummaryMinRecords) continue;

      // Token-budget defense: if the page's estimated prompt exceeds budget,
      // shrink. Page size is the primary bound; this catches pathological variance.
      let pageEntries = page;
      let estTokens = this.estimateTokens(pageEntries.map((r) => r.content).join("\n"));
      while (estTokens > promptTokenBudget && pageEntries.length > this.config.coldSummaryMinRecords) {
        pageEntries = pageEntries.slice(0, Math.floor(pageEntries.length / 2));
        estTokens = this.estimateTokens(pageEntries.map((r) => r.content).join("\n"));
      }

      // Oversized single-record handling. A record whose content alone exceeds
      // the budget gets flagged + skipped so one bad record never aborts.
      const usable: typeof pageEntries = [];
      for (const r of pageEntries) {
        if (this.estimateTokens(r.content) > promptTokenBudget) {
          await this.store.flagForReview([r._id!]);
          log.warn("autoDream: cold record flagged needsReview (oversized)", {
            agentId, topic, recordId: r._id!.toString(),
          });
          continue;
        }
        usable.push(r);
      }
      if (usable.length < this.config.coldSummaryMinRecords) continue;

      // Build prompt and call Haiku.
      const entries = usable.map((r) => `- [${r.type}/${r.importance}] ${r.content}`).join("\n");
      const prompt = [
        `Summarize the following memory entries for agent ${agentId} about topic "${topic}".`,
        "Preserve key facts, decisions, and outcomes. Discard routine interactions.",
        "Be concise — aim for 2-5 sentences.",
        "",
        entries,
      ].join("\n");

      const summaryText = await this.runDreamQuery(prompt, budget);
      if (!summaryText) continue;

      // Save summary as warm `type: "summary"` record, embed.
      const pointId = crypto.randomUUID();
      const summaryRecord = await this.store.save(
        agentId,
        { content: summaryText, type: "summary", topic, importance: "medium" },
        pointId,
      );
      await this.store.setTier(summaryRecord._id!, "warm");
      await this.embedder.upsert(pointId, summaryText, {
        agentId,
        mongoId: summaryRecord._id!.toString(),
        type: "summary",
        topic,
        tier: "warm",
        importance: "medium",
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Mark originals summarized.
      await this.store.markSummarized(usable.map((r) => r._id!), summaryRecord._id!);

      // Advance checkpoint.
      const last = usable[usable.length - 1];
      await this.store.markAutoDreamRun(agentId, {
        at: new Date(),
        phase: "summarizeCold",
        topic,
        cursor: { createdAt: last.createdAt, lastId: last._id! },
      });

      summarized += usable.length;

      // One page per topic per dream() call — drain proceeds organically
      // across cooldownMinutes cycles. Bounded by per-run budget too.
      if (!budget.canSpend()) {
        return { summarized, drained: false }; // budget exhausted mid-traversal
      }
    }

    // Reached end of topics. Now check whether anything is left in any of them.
    // Cheap: re-query getColdTopics — if any topic still has >= coldSummaryMinRecords
    // unsummarized records, we're not drained.
    const remainingTopics = await this.store.getColdTopics(agentId);
    let drained = true;
    for (const t of remainingTopics) {
      const probe = await this.store.getColdByTopicPaged(agentId, t, null, this.config.coldSummaryMinRecords);
      if (probe.length >= this.config.coldSummaryMinRecords) {
        drained = false;
        break;
      }
    }
    return { summarized, drained };
  }
```

- [ ] **Step 5:** Apply the same token-budget cap to `mergeDuplicates`, `detectContradictions`, `promotePatterns` prompt construction. For each, before the `runDreamQuery` call, add a guard:

```typescript
      const promptTokens = this.estimateTokens(prompt);
      const cap = this.dreamConfig?.coldSummaryPromptTokenBudget ?? 8000;
      if (promptTokens > cap) {
        log.warn("autoDream: skipping prompt exceeding token budget", {
          agentId, phase: "<phase-name>", promptTokens, cap,
        });
        continue;
      }
```

(Inserted in each of the three phases, with the appropriate `phase` label.)

- [ ] **Step 6:** Update `makeMockStore` and add tests. **Follow the existing pattern at the top of `memory-lifecycle.test.ts`** (lines 32-67): `makeMockStore()` returns a flat object of `vi.fn()`s; `makeMockEmbedder()` does the same. Tests construct `new MemoryLifecycle(store, embedder, config, dreamConfig)` and inspect call args via `(store.method as ReturnType<typeof vi.fn>).mock.calls`.

First, extend `makeMockStore` to remove the obsolete `getColdByTopic` mock and add the new methods that `summarizeColdPhase` calls (Task 9's `runConsolidationForAgent`, added later, reuses the same mock surface):

```typescript
function makeMockStore() {
  return {
    getAgentIds: vi.fn().mockResolvedValue([]),
    getAllNonPinned: vi.fn().mockResolvedValue([]),
    getHotTier: vi.fn().mockResolvedValue([]),
    setTier: vi.fn().mockResolvedValue(undefined),
    setTierBulk: vi.fn().mockResolvedValue(undefined),
    getColdTopics: vi.fn().mockResolvedValue([]),
    getColdByTopicPaged: vi.fn().mockResolvedValue([]), // KPR-241 replacement
    markSummarized: vi.fn().mockResolvedValue(undefined),
    deleteSummarizedOlderThan: vi.fn().mockResolvedValue(0),
    deletePurgedOlderThan: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({ _id: new ObjectId() }),
    countNonHot: vi.fn().mockResolvedValue(0),
    getById: vi.fn(),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    touchAccess: vi.fn(),
    getByIds: vi.fn(),
    getAllForAgent: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
    getByTiersForAgent: vi.fn().mockResolvedValue([]),
    getFactsAndDecisionsByTopic: vi.fn().mockResolvedValue(new Map()),
    getInteractionsByTopic: vi.fn().mockResolvedValue(new Map()),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    flagForReview: vi.fn().mockResolvedValue(undefined),
    getAutoDreamState: vi.fn().mockResolvedValue(null),
    countAutoDreamCandidates: vi.fn().mockResolvedValue(10),
    markAutoDreamRun: vi.fn().mockResolvedValue(undefined),
    getCollection: vi.fn(), // used by heartbeat; not needed for lifecycle tests but match shape
  };
}
```

A small helper (place near the existing helpers at the top of the file):

```typescript
function makeColdRecord(idx: number, topic: string, content: string = `cold-${idx}`): any {
  return {
    _id: new ObjectId(),
    content,
    type: "interaction",
    topic,
    importance: "medium",
    tier: "cold",
    createdAt: new Date(2026, 0, 1, 0, 0, idx), // monotonic by idx
    updatedAt: new Date(2026, 0, 1, 0, 0, idx),
    lastAccessedAt: new Date(2026, 0, 1, 0, 0, idx),
    accessCount: 0,
    pinned: false,
    summarized: false,
    qdrantPointId: `point-${idx}`,
  };
}

function makeLifecycle(dreamOverrides: Partial<DreamConfig> = {}) {
  const store = makeMockStore();
  const embedder = makeMockEmbedder();
  const config: MemoryLifecycleConfig = {
    hotBudgetTokens: 3000, sweepIntervalHours: 6,
    hotThreshold: 0.6, warmThreshold: 0.3, recencyHalfLifeDays: 7,
    coldSummaryMinRecords: 1, // low for tests
    coldRetentionDays: 90, purgeRetentionDays: 7,
  };
  const dreamConfig: DreamConfig = {
    enabled: true,
    cooldownMinutes: 0, similarityThreshold: 0.85, patternMinCount: 3,
    maxClustersPerRun: 20, maxContradictionPairsPerRun: 30, maxPromotionsPerRun: 2,
    maxRunBudgetUsd: 1.0, maxCallBudgetUsd: 0.1, minNewMemories: 0,
    coldSummaryPageSize: 20, coldSummaryPromptTokenBudget: 8000,
    ...dreamOverrides,
  };
  const lifecycle = new MemoryLifecycle(store as any, embedder as any, config, dreamConfig);
  return { lifecycle, store, embedder };
}
```

Now the new `describe` blocks:

```typescript
describe("MemoryLifecycle.summarizeColdPhase (KPR-241)", () => {
  it("calls getColdByTopicPaged with pageSize limit and returns drained=true when no records left", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 5 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    // First call to getColdByTopicPaged in the main loop returns 5 records (enough to summarize).
    // The follow-up "drain probe" calls return [], so drained=true.
    const recs = [0, 1, 2, 3, 4].map((i) => makeColdRecord(i, "topic-a"));
    (store.getColdByTopicPaged as any)
      .mockResolvedValueOnce(recs)  // main loop
      .mockResolvedValueOnce([]);   // drain probe
    await lifecycle.dream();
    const pagedCalls = (store.getColdByTopicPaged as any).mock.calls;
    expect(pagedCalls[0][3]).toBe(5); // limit arg
  });

  it("returns drained=false when a probe finds remaining cold records", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 2 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const page1 = [makeColdRecord(0, "topic-a"), makeColdRecord(1, "topic-a")];
    (store.getColdByTopicPaged as any)
      .mockResolvedValueOnce(page1)            // main loop, page 1
      .mockResolvedValueOnce([makeColdRecord(2, "topic-a")]); // drain probe — still records left
    await lifecycle.dream();
    // markAutoDreamRun should NOT have been called with phase: "idle" (because not drained).
    const calls = (store.markAutoDreamRun as any).mock.calls;
    const lastCallOpts = calls[calls.length - 1][1];
    expect(lastCallOpts.phase).not.toBe("idle");
  });

  it("flags oversized records needsReview and continues with remaining records", async () => {
    const { lifecycle, store } = makeLifecycle({
      coldSummaryPageSize: 10, coldSummaryPromptTokenBudget: 100,
    });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const huge = makeColdRecord(0, "topic-a", "x".repeat(5000)); // > 100 tokens alone
    const normals = [1, 2, 3, 4].map((i) => makeColdRecord(i, "topic-a", "ok"));
    (store.getColdByTopicPaged as any)
      .mockResolvedValueOnce([huge, ...normals])
      .mockResolvedValueOnce([]);
    await lifecycle.dream();
    expect(store.flagForReview).toHaveBeenCalledWith([huge._id]);
    // markSummarized called with the 4 normal records (oversize was skipped)
    expect(store.markSummarized).toHaveBeenCalled();
    const summarizedIds = (store.markSummarized as any).mock.calls[0][0];
    expect(summarizedIds).toEqual(normals.map((r) => r._id));
  });

  it("advances compound cursor to {lastRecord.createdAt, lastRecord._id}", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 3 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const page = [makeColdRecord(0, "topic-a"), makeColdRecord(1, "topic-a"), makeColdRecord(2, "topic-a")];
    (store.getColdByTopicPaged as any)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    await lifecycle.dream();
    // Find the markAutoDreamRun call that carries the cursor advance (phase: "summarizeCold")
    const cursorCall = (store.markAutoDreamRun as any).mock.calls.find((c: any) => c[1].phase === "summarizeCold");
    expect(cursorCall).toBeDefined();
    expect(cursorCall[1].cursor).toEqual({
      createdAt: page[2].createdAt,
      lastId: page[2]._id,
    });
  });
});

describe("MemoryLifecycle sweep relocation (KPR-241)", () => {
  it("sweepAgent no longer calls summarizeCold path", async () => {
    const { lifecycle, store } = makeLifecycle();
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    await lifecycle.sweep();
    // getColdByTopicPaged is the new entry point; it should not be called in sweep().
    expect(store.getColdByTopicPaged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7:** Verify

```bash
npm run test -- src/memory/memory-lifecycle.test.ts
```

Expected: all tests pass.

- [ ] **Step 8:** Commit

```bash
git add src/memory/memory-lifecycle.ts src/memory/memory-types.ts src/memory/memory-lifecycle.test.ts
git commit -m "feat(memory): relocate summarizeCold to dream() as paged checkpointed phase (KPR-241)"
```

### Task 7: `MemoryLifecycleHeartbeat` (new file)

**Files:**
- Create: `src/memory/memory-lifecycle-heartbeat.ts`
- Create: `src/memory/memory-lifecycle-heartbeat.test.ts`

- [ ] **Step 1:** Create the heartbeat class. Mirrors `SpawnCoordinatorHeartbeat` pattern.

```typescript
// src/memory/memory-lifecycle-heartbeat.ts
import type { Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { AutoDreamSpendSample } from "./memory-types.js";

const log = createLogger("memory-lifecycle-heartbeat");

/**
 * KPR-241: periodic heartbeat that snapshots per-agent memory lifecycle
 * state into `db.telemetry` (kind = `memory_lifecycle_stats`). The
 * out-of-process `hive doctor` CLI reads from this collection, mirroring
 * KPR-213's prefix-cache and KPR-220's spawn-coordinator heartbeats.
 *
 * Cadence: 30s. Per-agent upsert keyed by `{ kind, agentId }`.
 */
export class MemoryLifecycleHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "memory_lifecycle_stats";

  private timer: NodeJS.Timeout | null = null;
  private readonly store: MemoryStore;
  private readonly telemetryCollection: Collection;
  private readonly intervalMs: number;
  private readonly getActiveAgentIds?: () => Promise<Set<string>>;

  constructor(
    store: MemoryStore,
    telemetryCollection: Collection,
    options?: { intervalMs?: number; getActiveAgentIds?: () => Promise<Set<string>> },
  ) {
    this.store = store;
    this.telemetryCollection = telemetryCollection;
    this.intervalMs = options?.intervalMs ?? MemoryLifecycleHeartbeat.INTERVAL_MS;
    this.getActiveAgentIds = options?.getActiveAgentIds;
  }

  async writeOnce(): Promise<void> {
    const collection = this.store.getCollection();
    let agentIds = await this.store.getAgentIds();
    if (this.getActiveAgentIds) {
      const active = await this.getActiveAgentIds();
      agentIds = agentIds.filter((id) => active.has(id));
    }

    const updatedAt = new Date();
    const ops: Array<Promise<unknown>> = [];

    for (const agentId of agentIds) {
      ops.push(this.snapshotAgent(agentId, collection, updatedAt));
    }

    await Promise.all(ops);
  }

  private async snapshotAgent(
    agentId: string,
    memoryCollection: ReturnType<MemoryStore["getCollection"]>,
    updatedAt: Date,
  ): Promise<void> {
    try {
      const [hot, warm, cold, summarizedNotPurged, needsReview, oldestCold, state] = await Promise.all([
        memoryCollection.countDocuments({ agentId, tier: "hot", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, tier: "warm", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, tier: "cold", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, summarized: true, purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, needsReview: true, purged: { $ne: true } }),
        memoryCollection.find({ agentId, tier: "cold", purged: { $ne: true } })
          .sort({ createdAt: 1 }).limit(1).project({ createdAt: 1 }).toArray(),
        this.store.getAutoDreamState(agentId),
      ]);

      const oldestColdAgeDays =
        oldestCold[0]?.createdAt
          ? Math.floor((updatedAt.getTime() - oldestCold[0].createdAt.getTime()) / (1000 * 60 * 60 * 24))
          : null;

      // Derive spend metrics from spendHistory rolling window.
      const history: AutoDreamSpendSample[] = state?.spendHistory ?? [];
      const cutoff = updatedAt.getTime() - 30 * 24 * 60 * 60 * 1000;
      const cumulativeSpentUsd30d = history
        .filter((s) => s.at.getTime() >= cutoff)
        .reduce((sum, s) => sum + s.spentUsd, 0);
      const lastRunSpentUsd = history.length > 0 ? history[history.length - 1].spentUsd : null;

      await this.telemetryCollection.updateOne(
        { kind: MemoryLifecycleHeartbeat.TELEMETRY_KIND, agentId },
        {
          $set: {
            agentId,
            counts: { hot, warm, cold },
            summarizedNotPurged,
            needsReview,
            oldestColdAgeDays,
            consolidation: {
              phase: state?.phase ?? "idle",
              topic: state?.topic ?? null,
              cursor: state?.cursor ?? null,
              lastAttemptAt: state?.lastAttemptAt ?? null,
              lastSuccessAt: state?.lastSuccessAt ?? null,
              lastError: state?.lastError ?? null,
              lastRunSpentUsd,
              cumulativeSpentUsd30d,
            },
            updatedAt,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      log.warn("memory-lifecycle heartbeat write failed", { agentId, error: String(err) });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.writeOnce().catch((err) =>
        log.warn("memory-lifecycle heartbeat tick failed", { error: String(err) }),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 2:** Create the test file.

```typescript
// src/memory/memory-lifecycle-heartbeat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryLifecycleHeartbeat } from "./memory-lifecycle-heartbeat.js";

function makeStore(state: { agentIds: string[]; counts: Record<string, any>; dreamState?: any }) {
  return {
    getCollection: () => ({
      countDocuments: vi.fn((filter: any) => {
        const key = `${filter.tier ?? ""}${filter.summarized ? "summarized" : ""}${filter.needsReview ? "needsReview" : ""}`;
        return Promise.resolve(state.counts[filter.agentId]?.[key] ?? 0);
      }),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            project: () => ({
              toArray: () => Promise.resolve(state.counts[state.agentIds[0]]?.oldestCold ?? []),
            }),
          }),
        }),
      })),
    }),
    getAgentIds: vi.fn(() => Promise.resolve(state.agentIds)),
    getAutoDreamState: vi.fn(() => Promise.resolve(state.dreamState)),
  };
}

describe("MemoryLifecycleHeartbeat", () => {
  it("upserts one doc per agent under kind=memory_lifecycle_stats", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const store = makeStore({
      agentIds: ["a1", "a2"],
      counts: {
        a1: { hot: 2, warm: 5, cold: 10, summarized: 1, needsReview: 0, oldestCold: [{ createdAt: new Date("2026-04-01") }] },
        a2: { hot: 0, warm: 0, cold: 0, summarized: 0, needsReview: 0, oldestCold: [] },
      },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any);
    await heartbeat.writeOnce();
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0][0]).toMatchObject({
      kind: "memory_lifecycle_stats",
      agentId: expect.any(String),
    });
  });

  it("filters by active agents when getActiveAgentIds is provided", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const store = makeStore({
      agentIds: ["a1", "a2"],
      counts: { a1: {}, a2: {} },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any, {
      getActiveAgentIds: () => Promise.resolve(new Set(["a1"])),
    });
    await heartbeat.writeOnce();
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0][0].agentId).toBe("a1");
  });

  it("derives cumulativeSpentUsd30d from spendHistory window", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const now = Date.now();
    const store = makeStore({
      agentIds: ["a1"],
      counts: { a1: {} },
      dreamState: {
        spendHistory: [
          { at: new Date(now - 45 * 24 * 60 * 60 * 1000), spentUsd: 0.5 }, // > 30d, excluded
          { at: new Date(now - 5 * 24 * 60 * 60 * 1000), spentUsd: 0.1 },
          { at: new Date(now - 1 * 24 * 60 * 60 * 1000), spentUsd: 0.05 },
        ],
      },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any);
    await heartbeat.writeOnce();
    const updateBody = updateOne.mock.calls[0][1].$set;
    expect(updateBody.consolidation.cumulativeSpentUsd30d).toBeCloseTo(0.15, 2);
    expect(updateBody.consolidation.lastRunSpentUsd).toBe(0.05);
  });
});
```

- [ ] **Step 3:** Verify

```bash
npm run test -- src/memory/memory-lifecycle-heartbeat.test.ts
```

Expected: all tests pass.

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-lifecycle-heartbeat.ts src/memory/memory-lifecycle-heartbeat.test.ts
git commit -m "feat(memory): MemoryLifecycleHeartbeat (KPR-241)"
```

### Task 8: Doctor surface

**Files:**
- Modify: `src/cli/doctor-checks.ts`
- Modify: `src/cli/doctor.ts`

- [ ] **Step 1:** Add the doctor adapter in `doctor-checks.ts`. Mirror `spawnCoordinatorStatsForDoctor`.

After the existing `SpawnCoordinatorRow` definition, add:

```typescript
/**
 * KPR-241: per-agent memory lifecycle snapshot row from `telemetry`
 * (kind=memory_lifecycle_stats heartbeat).
 *
 * Note: `cursor.lastId` is read as the BSON ObjectId's `.toString()` form
 * (24-char hex) because the doctor runs out-of-process from the engine and
 * surfaces the value to humans. Mongo's driver round-trips it as either an
 * ObjectId or a string depending on serialization path — we accept either
 * shape on read and normalize to string.
 */
export interface MemoryLifecycleRow {
  agentId: string;
  counts: { hot: number; warm: number; cold: number };
  summarizedNotPurged: number;
  needsReview: number;
  oldestColdAgeDays: number | null;
  consolidation: {
    phase: string;
    topic: string | null;
    cursor: { createdAt: Date; lastId: string } | null;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    lastRunSpentUsd: number | null;
    cumulativeSpentUsd30d: number;
  };
  /** Seconds since the engine last wrote this doc; null if no doc found. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for the per-agent
 * `kind="memory_lifecycle_stats"` heartbeat docs. Mirrors
 * `spawnCoordinatorStatsForDoctor`.
 */
export async function memoryLifecycleStatsForDoctor(uri: string, dbName: string): Promise<MemoryLifecycleRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("telemetry")
      .find<{
        agentId?: string;
        counts?: { hot: number; warm: number; cold: number };
        summarizedNotPurged?: number;
        needsReview?: number;
        oldestColdAgeDays?: number | null;
        consolidation?: MemoryLifecycleRow["consolidation"];
        updatedAt?: Date;
      }>({ kind: "memory_lifecycle_stats" })
      .sort({ agentId: 1 })
      .toArray();
    const now = Date.now();
    return docs.map((doc) => {
      const cons = doc.consolidation;
      const cursor = cons?.cursor
        ? {
            createdAt: cons.cursor.createdAt instanceof Date
              ? cons.cursor.createdAt
              : new Date(cons.cursor.createdAt as unknown as string),
            // BSON ObjectId or string — normalize to string for the doctor surface.
            lastId: String((cons.cursor as { lastId: unknown }).lastId ?? ""),
          }
        : null;
      return {
        agentId: doc.agentId ?? "<unknown>",
        counts: doc.counts ?? { hot: 0, warm: 0, cold: 0 },
        summarizedNotPurged: doc.summarizedNotPurged ?? 0,
        needsReview: doc.needsReview ?? 0,
        oldestColdAgeDays: doc.oldestColdAgeDays ?? null,
        consolidation: cons
          ? { ...cons, cursor }
          : {
              phase: "idle",
              topic: null,
              cursor: null,
              lastAttemptAt: null,
              lastSuccessAt: null,
              lastError: null,
              lastRunSpentUsd: null,
              cumulativeSpentUsd30d: 0,
            },
        staleSeconds: doc.updatedAt instanceof Date ? Math.round((now - doc.updatedAt.getTime()) / 1000) : null,
      };
    });
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 2:** Add a "Memory lifecycle" section in `doctor.ts` using the existing `renderXxxSection(rows, emit)` helper pattern (search the file for `renderSpawnCoordinatorSection` to find the existing model — that's the closest analogue).

Add a new exported function `renderMemoryLifecycleSection(rows, emit, spendWarnUsd)` near the other section renderers. Match the existing convention where `emit` defaults to `console.log` (see `renderPrefixCacheSection` / `renderSpawnCoordinatorSection`). Also fold the new `MemoryLifecycleRow` import into the existing grouped import block at the top of `doctor.ts` (where `SpawnCoordinatorRow` already lives) rather than adding a separate import line:

```typescript
// In the existing import block at the top of doctor.ts, add MemoryLifecycleRow:
import type { SpawnCoordinatorRow, MemoryLifecycleRow } from "./doctor-checks.js";

export function renderMemoryLifecycleSection(
  rows: MemoryLifecycleRow[],
  emit: (line: string) => void = console.log,
  spendWarnUsd = 5,
): void {
  if (rows.length === 0) return;
  emit("\nMemory lifecycle (per agent):");
  for (const row of rows) {
    const cons = row.consolidation;
    const staleFlag = row.staleSeconds !== null && row.staleSeconds > 300 ? " ⚠ heartbeat stale" : "";
    const spendFlag = cons.cumulativeSpentUsd30d > spendWarnUsd
      ? ` ⚠ spend $${cons.cumulativeSpentUsd30d.toFixed(2)}/30d`
      : "";
    const errFlag = cons.lastError ? ` ⚠ lastError: ${cons.lastError.slice(0, 60)}` : "";
    const oldest = row.oldestColdAgeDays !== null ? ` (oldest ${row.oldestColdAgeDays}d)` : "";
    emit(
      `  ${row.agentId}: hot=${row.counts.hot} warm=${row.counts.warm} cold=${row.counts.cold}${oldest}, ` +
      `summarized-not-purged=${row.summarizedNotPurged}, needsReview=${row.needsReview}${staleFlag}${spendFlag}${errFlag}`,
    );
    if (cons.phase !== "idle") {
      const cursorStr = cons.cursor?.createdAt
        ? new Date(cons.cursor.createdAt).toISOString().slice(0, 10)
        : "—";
      emit(`        phase=${cons.phase} topic="${cons.topic ?? ""}" cursor=${cursorStr}`);
    }
    if (cons.lastSuccessAt) {
      emit(
        `        last success ${cons.lastSuccessAt.toISOString()} | ` +
        `last attempt ${cons.lastAttemptAt?.toISOString() ?? "—"}`,
      );
    }
  }
}
```

Then in the `runDoctor` body (search for where `renderSpawnCoordinatorSection` is called — typically around lines 390-400), add a parallel call:

```typescript
// After the existing spawn-coordinator render block.
// Note: config field is `config.mongo.uri` / `config.mongo.dbName` per existing doctor pattern;
// `config.memory.spendWarnThresholdUsd` comes from Task 10's config additions.
if (config) {
  const memoryRows = await memoryLifecycleStatsForDoctor(config.mongo.uri, config.mongo.dbName);
  renderMemoryLifecycleSection(memoryRows, console.log, config.memory.spendWarnThresholdUsd ?? 5);
} else {
  console.log("\nMemory lifecycle: skipped (config not loaded)");
}
```

Mirror whatever `if (config)` / `else` guard the existing sections use — that's the precedent (doctor without a loadable config still runs subset checks; memory section follows the same guard).

- [ ] **Step 3:** Verify

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4:** Commit

```bash
git add src/cli/doctor-checks.ts src/cli/doctor.ts
git commit -m "feat(doctor): memory lifecycle per-agent section (KPR-241)"
```

### Task 9: Admin MCP tool `memory_lifecycle_run_consolidation`

**Files:**
- Modify: `src/admin/admin-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` — the admin MCP server is instantiated here (around `agent-runner.ts:1552` inside `setupMcpServers`), so `memoryLifecycle` must thread through the `AgentRunner` constructor and into the `createAdminMcpServer({...})` call.
- Modify: `src/memory/memory-lifecycle.ts` — add `runConsolidationForAgent` method.

- [ ] **Step 1:** Inject the `MemoryLifecycle` instance into admin tool deps. Extend `AdminToolDeps`:

```typescript
export interface AdminToolDeps {
  db: Db;
  agentId: string;
  instanceCapabilitiesJson: string;
  /** KPR-241: shared memory lifecycle instance for the consolidation tool. */
  memoryLifecycle?: import("../memory/memory-lifecycle.js").MemoryLifecycle;
}
```

- [ ] **Step 2:** Add the tool registration inside `buildAdminTools(deps)`. Find the existing tool list and add at the end:

```typescript
    tool(
      "memory_lifecycle_run_consolidation",
      "Run a bounded memory-lifecycle consolidation pass for one agent. Use to drain a large cold backlog faster than normal sweep cadence. Each invocation processes at most `maxPages` pages across all phases, bounded by the configured run budget. Returns structured progress info.",
      {
        agentId: z.string().describe("Agent to consolidate"),
        maxPages: z.number().optional().describe("Cap on pages processed this run across all phases (default 50)"),
        maxBudgetUsdOverride: z.number().optional().describe("Per-run USD budget cap (defaults to config.autoDream.maxRunBudgetUsd)"),
      },
      async ({ agentId: targetAgentId, maxPages, maxBudgetUsdOverride }) => {
        if (!deps.memoryLifecycle) {
          return {
            isError: true,
            content: [{ type: "text", text: "memory_lifecycle_run_consolidation: lifecycle not injected" }],
          };
        }
        try {
          const result = await deps.memoryLifecycle.runConsolidationForAgent(targetAgentId, {
            maxPages: maxPages ?? 50,
            maxBudgetUsdOverride,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `memory_lifecycle_run_consolidation [${targetAgentId}]\n` +
                  `  summarized: ${result.summarized}\n` +
                  `  merged: ${result.merged}\n` +
                  `  contradictions: ${result.contradictions}\n` +
                  `  patternsPromoted: ${result.promoted}\n` +
                  `  pagesProcessed: ${result.pagesProcessed}\n` +
                  `  spentUsd: ${result.spentUsd?.toFixed(4) ?? "0"}\n` +
                  `  errors: ${result.errors.length}`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `memory_lifecycle_run_consolidation error: ${String(err)}` }],
          };
        }
      },
    ),
```

- [ ] **Step 3:** Add `runConsolidationForAgent` to `MemoryLifecycle` (in `src/memory/memory-lifecycle.ts`). The method loops `summarizeColdPhase` (reloading state each iter so cursor advances are visible), bounded by `maxPages`, `drained`, or budget; then runs the three other phases once each:

```typescript
  /**
   * KPR-241: operator-callable bounded consolidation run for a single agent.
   * Loops summarizeColdPhase until the topic backlog is drained, the page
   * cap is hit, or the budget is exhausted. Then runs the other three
   * phases (each has its own per-run caps). Returns structured progress.
   */
  async runConsolidationForAgent(
    agentId: string,
    options: { maxPages: number; maxBudgetUsdOverride?: number },
  ): Promise<{
    summarized: number;
    merged: number;
    contradictions: number;
    promoted: number;
    pagesProcessed: number;
    drained: boolean;
    spentUsd: number;
    errors: string[];
  }> {
    if (!this.dreamConfig) {
      return {
        summarized: 0, merged: 0, contradictions: 0, promoted: 0,
        pagesProcessed: 0, drained: true, spentUsd: 0,
        errors: ["autoDream not configured"],
      };
    }
    const errors: string[] = [];
    const budget = new AutoDreamBudget(
      options.maxBudgetUsdOverride ?? this.autoDreamRunBudget(),
      this.autoDreamCallBudget(),
    );
    let summarized = 0, merged = 0, contradictions = 0, promoted = 0, pagesProcessed = 0;
    let drained = false;
    const runAt = new Date();
    try {
      // Loop summarizeColdPhase. Each call processes ≤1 page per topic,
      // advancing the per-(agent, topic) cursor in the state collection.
      // Reload state each iter so the inner method sees the latest cursor.
      for (let i = 0; i < options.maxPages && budget.canSpend(); i++) {
        const state = await this.store.getAutoDreamState(agentId);
        const r0 = await this.summarizeColdPhase(agentId, budget, state);
        summarized += r0.summarized;
        pagesProcessed++;
        if (r0.drained) { drained = true; break; }
        if (r0.summarized === 0) {
          // No progress this iter (no eligible topics + records) — bail to
          // avoid infinite loop on a non-fatal stall.
          drained = true;
          break;
        }
      }
      // Run other phases once each. They have their own per-run caps.
      if (budget.canSpend()) {
        const r1 = await this.mergeDuplicates(agentId, budget);
        merged += r1.merged;
      }
      if (budget.canSpend()) {
        const r2 = await this.detectContradictions(agentId, budget);
        contradictions += r2.resolved;
      }
      if (budget.canSpend()) {
        const r3 = await this.promotePatterns(agentId, budget);
        promoted += r3.promoted;
      }
    } catch (err) {
      errors.push(String(err));
    } finally {
      try {
        await this.store.markAutoDreamRun(agentId, {
          at: runAt,
          spentUsd: budget.spentUsd,
          llmCalls: budget.llmCalls,
          lastAttemptAt: runAt,
          lastError: errors.length > 0 ? errors[0] : null,
          ...(errors.length === 0 ? { lastSuccessAt: runAt } : {}),
          ...(drained ? { phase: "idle" as const, topic: null, cursor: null } : {}),
        });
      } catch (markErr) {
        log.warn("runConsolidationForAgent markAutoDreamRun failed", { agentId, error: String(markErr) });
      }
    }
    return { summarized, merged, contradictions, promoted, pagesProcessed, drained, spentUsd: budget.spentUsd, errors };
  }
```

- [ ] **Step 4:** Plumb `memoryLifecycle` through `AgentRunner` into the admin MCP construction site.

In `src/agents/agent-runner.ts`:

- Add `memoryLifecycle?: MemoryLifecycle` to the `AgentRunnerDeps`/constructor-args type (read the existing deps interface in the file to find the right location).
- Store it as `private readonly memoryLifecycle?: MemoryLifecycle` on the class.
- Extend the `createAdminMcpServer({...})` call at line ~1552:

```typescript
this.adminMcpServer = createAdminMcpServer({
  db: this.db,
  agentId: this.agentConfig.id,
  instanceCapabilitiesJson: buildCapabilitiesJson(this.plugins),
  memoryLifecycle: this.memoryLifecycle,
});
```

In whatever file constructs `AgentRunner` (likely `src/agents/agent-manager.ts` or similar — `grep -rn "new AgentRunner" src/`), pass the shared `memoryLifecycle` instance through.

Verify with:

```bash
grep -rn "new AgentRunner" src/
```

- [ ] **Step 5:** Add a unit test for `runConsolidationForAgent` in `memory-lifecycle.test.ts`. Use the `makeLifecycle` helper from Task 6 Step 6 (or the existing `makeMockStore`/`makeMockEmbedder` if Task 6 hasn't landed yet):

```typescript
describe("MemoryLifecycle.runConsolidationForAgent (KPR-241)", () => {
  it("returns drained=true when summarizeColdPhase reports drained", async () => {
    const { lifecycle } = makeLifecycle();
    // Stub summarizeColdPhase to report drained on first iter
    (lifecycle as any).summarizeColdPhase = vi.fn().mockResolvedValue({ summarized: 5, drained: true });
    (lifecycle as any).mergeDuplicates = vi.fn().mockResolvedValue({ merged: 0 });
    (lifecycle as any).detectContradictions = vi.fn().mockResolvedValue({ resolved: 0, flagged: 0 });
    (lifecycle as any).promotePatterns = vi.fn().mockResolvedValue({ promoted: 0 });
    const result = await lifecycle.runConsolidationForAgent("a1", { maxPages: 50 });
    expect(result.drained).toBe(true);
    expect(result.summarized).toBe(5);
  });

  it("respects maxPages cap when not yet drained", async () => {
    const { lifecycle } = makeLifecycle();
    const summarizeStub = vi.fn().mockResolvedValue({ summarized: 5, drained: false });
    (lifecycle as any).summarizeColdPhase = summarizeStub;
    (lifecycle as any).mergeDuplicates = vi.fn().mockResolvedValue({ merged: 0 });
    (lifecycle as any).detectContradictions = vi.fn().mockResolvedValue({ resolved: 0, flagged: 0 });
    (lifecycle as any).promotePatterns = vi.fn().mockResolvedValue({ promoted: 0 });
    const result = await lifecycle.runConsolidationForAgent("a1", { maxPages: 3 });
    expect(summarizeStub).toHaveBeenCalledTimes(3);
    expect(result.pagesProcessed).toBe(3);
    expect(result.drained).toBe(false);
  });
});
```

- [ ] **Step 6:** Verify

```bash
npm run test -- src/memory/memory-lifecycle.test.ts src/admin/
npm run typecheck
```

Expected: tests pass, no typecheck errors.

- [ ] **Step 7:** Commit

```bash
git add src/admin/admin-mcp-server.ts src/memory/memory-lifecycle.ts src/memory/memory-lifecycle.test.ts src/agents/agent-runner.ts src/agents/agent-manager.ts
git commit -m "feat(admin): memory_lifecycle_run_consolidation admin MCP tool (KPR-241)"
```

### Task 10: Config additions + default flip

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1:** Inside the `memory:` block (around line 315), add new keys before the closing brace:

```typescript
    spendWarnThresholdUsd: parseFloat(
      optional("MEMORY_SPEND_WARN_THRESHOLD_USD", String(hive.memory?.spendWarnThresholdUsd ?? 5)),
    ),
    writeGuards: {
      burst: {
        enabled: (hive.memory?.writeGuards?.burst?.enabled ?? true) as boolean,
        windowMinutes: parseInt(
          optional("MEMORY_WRITE_GUARD_BURST_WINDOW_MINUTES",
            String(hive.memory?.writeGuards?.burst?.windowMinutes ?? 1440)), 10),
        similarityThreshold: parseFloat(
          optional("MEMORY_WRITE_GUARD_BURST_SIMILARITY",
            String(hive.memory?.writeGuards?.burst?.similarityThreshold ?? 0.92))),
        topK: parseInt(
          optional("MEMORY_WRITE_GUARD_BURST_TOPK",
            String(hive.memory?.writeGuards?.burst?.topK ?? 5)), 10),
      },
      oversize: {
        enabled: (hive.memory?.writeGuards?.oversize?.enabled ?? true) as boolean,
        maxChars: parseInt(
          optional("MEMORY_WRITE_GUARD_OVERSIZE_MAX_CHARS",
            String(hive.memory?.writeGuards?.oversize?.maxChars ?? 6000)), 10),
      },
      rawDump: {
        enabled: (hive.memory?.writeGuards?.rawDump?.enabled ?? true) as boolean,
        jsonTokenThreshold: parseInt(
          optional("MEMORY_WRITE_GUARD_RAWDUMP_JSON_TOKENS",
            String(hive.memory?.writeGuards?.rawDump?.jsonTokenThreshold ?? 300)), 10),
        monolithCharThreshold: parseInt(
          optional("MEMORY_WRITE_GUARD_RAWDUMP_MONOLITH_CHARS",
            String(hive.memory?.writeGuards?.rawDump?.monolithCharThreshold ?? 2000)), 10),
      },
    },
```

- [ ] **Step 2:** Inside the `autoDream:` block (around line 368), add three new keys before the closing brace:

```typescript
    coldSummaryPageSize: parseInt(
      optional("AUTODREAM_COLD_SUMMARY_PAGE_SIZE",
        String(hive.autoDream?.coldSummaryPageSize ?? 20)), 10),
    coldSummaryPromptTokenBudget: parseInt(
      optional("AUTODREAM_COLD_SUMMARY_PROMPT_TOKEN_BUDGET",
        String(hive.autoDream?.coldSummaryPromptTokenBudget ?? 8000)), 10),
    summaryOfSummariesThreshold: parseInt(
      optional("AUTODREAM_SUMMARY_OF_SUMMARIES_THRESHOLD",
        String(hive.autoDream?.summaryOfSummariesThreshold ?? 5)), 10),
```

- [ ] **Step 3:** Flip the autoDream default (line 369):

Change:

```typescript
    enabled: (hive.autoDream?.enabled ?? false) as boolean,
```

To:

```typescript
    enabled: (hive.autoDream?.enabled ?? true) as boolean,
```

- [ ] **Step 4:** Verify

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck
```

Expected: no errors.

- [ ] **Step 5:** Commit

```bash
git add src/config.ts
git commit -m "feat(config): memory write-guards + autoDream paging knobs + default flip (KPR-241)"
```

### Task 11: `index.ts` wiring

**Files:**
- Modify: `src/index.ts`
- Note: `AgentRunner` constructor extension is in Task 9 Step 4 (admin tool plumbing). This task threads the lifecycle instance from `index.ts` through to whatever code constructs `AgentRunner`.

- [ ] **Step 1:** Reorder the memory wiring so the embedder is constructed before the store. The existing `index.ts` block (lines 204-216) has the order: `MemoryStore` → `setOnMutate` block → `MemoryEmbedder`. Reorder to: `MemoryEmbedder` → `MemoryStore` (with embedder injected) → `setOnMutate` block (unchanged content, just relocated).

Concretely — replace this block (lines 204-216):

```typescript
  // Structured memory lifecycle — always enabled
  const memoryStore = new MemoryStore(db);
  await memoryStore.init();
  memoryManager.memoryStore = memoryStore;
  // KPR-213: structured-memory mutations from autoDream lifecycle and the
  // [...existing onMutate comment + block...]
  memoryStore.setOnMutate((agentId, reason) => {
    // [existing body — preserve verbatim]
  });

  const memoryEmbedder = new MemoryEmbedder();
```

With:

```typescript
  // Structured memory lifecycle — always enabled
  // KPR-241: embedder constructed before store so it can be injected as the
  // MemoryVectorIndex implementation for tier-sync on setTier/setTierBulk.
  const memoryEmbedder = new MemoryEmbedder();
  const memoryStore = new MemoryStore(db, memoryEmbedder);
  await memoryStore.init();
  memoryManager.memoryStore = memoryStore;
  // KPR-213: structured-memory mutations from autoDream lifecycle and the
  // [...existing onMutate comment, kept verbatim...]
  memoryStore.setOnMutate((agentId, reason) => {
    // [existing body — preserve verbatim]
  });
```

**Read `src/index.ts` lines 204-216 first** and copy the `setOnMutate` block content unchanged. Only the order of three statements changes (embedder before store + setOnMutate stays as-is).

- [ ] **Step 2:** Plumb `memoryLifecycle` through whatever constructs `AgentRunner`. Per Task 9 Step 4, `AgentRunner` now needs `memoryLifecycle` in its constructor args.

Find the `AgentRunner` construction site:

```bash
grep -rn "new AgentRunner" src/
```

In each construction site (likely `agent-manager.ts`), pass `memoryLifecycle` (which is created in `index.ts` and threaded through `AgentManager` already — verify it's accessible). If `AgentManager` doesn't yet hold a reference, extend its constructor to take the lifecycle.

- [ ] **Step 3:** Start the memory lifecycle heartbeat. The `telemetryCollection` variable already exists in `index.ts` (around line 415 — verify by grep) and is used by `SpawnCoordinatorHeartbeat`. Reuse it.

Find where `SpawnCoordinatorHeartbeat` is started (around `index.ts:436` per existing pattern). Add a parallel block:

```typescript
import { MemoryLifecycleHeartbeat } from "./memory/memory-lifecycle-heartbeat.js";

// ...near where SpawnCoordinatorHeartbeat is started (mirror its pattern):
const memoryLifecycleHeartbeat = new MemoryLifecycleHeartbeat(
  memoryStore,
  telemetryCollection, // KPR-241: reuse existing telemetry collection ref
  { getActiveAgentIds: async () => new Set(registry.listIds()) },
);
await memoryLifecycleHeartbeat.writeOnce(); // initial-write so doctor sees data immediately
memoryLifecycleHeartbeat.start();

// ...in the shutdown handler alongside spawn-coordinator's stop():
memoryLifecycleHeartbeat.stop();
```

Notes:
- `registry.listIds()` (not `getAllAgentIds()`) per the existing `index.ts` callers at lines 139, 167, 168.
- `telemetryCollection` is the existing local variable; do not call `db.collection("telemetry")` again.
- Match the exact shutdown sequence — search for `spawnCoordinatorHeartbeat.stop()` and add the new stop next to it.

- [ ] **Step 4:** Verify

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run test -- src/memory/ src/admin/ src/cli/
```

Run the memory + admin + cli tests first to catch new-file issues quickly. Then the full repo check:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck + lint + format + tests all pass.

- [ ] **Step 5:** Commit

```bash
git add src/index.ts src/agents/agent-manager.ts
git commit -m "wire(memory): vectorIndex injection + lifecycle heartbeat + admin tool wiring (KPR-241)"
```

### Task 12: Final check + release-notes hook

**Files:**
- Modify (optional): `CHANGELOG.md` or release notes location if one exists.

- [ ] **Step 1:** Run the full repo check.

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: green.

- [ ] **Step 2:** Spot-check the new behavior in a dev hive (if available locally) — save a few memories, see the guards fire, run consolidation manually.

- [ ] **Step 3:** The repo doesn't have a `CHANGELOG.md` — surface the release notes in the PR description body instead. Include:
  - `autoDream.enabled` default flipped from `false` to `true`. Operators wanting to keep it off should set `autoDream.enabled: false` in `hive.yaml`.
  - Cost expectation: per-agent run budget defaults at ~$0.05; cumulative spend surfaces via `hive doctor`. Operators on tight cost controls should review.
  - New memory write-time guards may reject saves that previously succeeded (burst, oversize, raw-dump). Errors include `sourceRef` hints; agents may need prompt rewrites (filed as KPR-244).
  - Manual recovery: `memory_lifecycle_run_consolidation` admin MCP tool. Use for instances with >500 cold records per agent.

- [ ] **Step 4:** Push the branch and open a PR per `commit-commands:commit-push-pr`:

```bash
git push -u origin may/kpr-241-reassert-hive-memory-contract-and-bound-cold-tier
# Then open PR via gh, referencing KPR-241
```

---

## Notes for the implementer

- Strict typescript — avoid `as any` outside of test files; the existing code in `memory-store.ts` uses `Parameters<typeof this.collection.find>[0]` casts in a couple places, and that pattern is fine.
- `setupHarness()` in the test stubs above is a placeholder — match the existing test file's helper pattern (or extract one if it doesn't already exist).
- `summarizeColdPhase` processes **one page per topic per dream() call**. Backlog drains over multiple cooldown cycles. The `runConsolidationForAgent` admin tool loops it up to `maxPages` times for fast recovery.
- Burst guard's "same topic" check happens after the Qdrant `search` returns — the search uses the `topic` filter via `MemoryRecallFilters.topic`, but the Mongo verification ensures we don't accidentally trip on cross-topic similarity if Qdrant ever returns stale matches.
- The fail-open burst-guard path writes a `process.stderr.write` line, matching the existing pattern in `memory_save` for embed errors. Logger could be used instead — match repo style.
- The doctor section only renders if heartbeat docs exist; an instance that just upgraded and hasn't ticked yet won't show the section. After the first 30s the section appears.

## Dependencies check

- ✅ KPR-241 spec signed off (`spec-ready` label).
- ✅ Feature branch exists: `may/kpr-241-reassert-hive-memory-contract-and-bound-cold-tier`.
- ✅ Five follow-up tickets filed: KPR-243, KPR-244, KPR-245, KPR-246, KPR-247.
- ✅ No blocking dependencies (adjacent to but not blocked by KPR-209 provider phase work).
