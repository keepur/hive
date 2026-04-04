# autoDream — Proactive Memory Consolidation Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add three memory consolidation operations (duplicate merge, contradiction detection, pattern promotion) to `MemoryLifecycle`, triggered by agent idle detection in the sweeper.

**Architecture:** New `dream()` method on `MemoryLifecycle` orchestrates three sub-operations per agent. Each uses Qdrant similarity search and/or Haiku LLM calls. The sweeper gains idle-detection logic: when all agents have been idle for 30+ minutes and the cooldown has elapsed, it triggers `dream()`. It also runs after the regular 6-hour sweep.

**Tech Stack:** TypeScript, MongoDB (memory records), Qdrant (vector similarity), Ollama (embeddings), Claude Haiku (merge/contradiction/pattern LLM calls)

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/memory/memory-types.ts` | Modify | Add `needsReview` field to `MemoryRecord`, add `DreamConfig` interface, add `DreamResult` type |
| `src/memory/memory-store.ts` | Modify | Add `getByTiersForAgent()`, `getFactsAndDecisionsByTopic()`, `getInteractionsByTopic()`, `markSuperseded()` queries; exclude superseded records from `getAllNonPinned()` and `getHotTier()` |
| `src/memory/memory-embedder.ts` | Modify | Add `findSimilar(pointId, agentId, threshold, limit)` method |
| `src/memory/memory-lifecycle.ts` | Modify | Add `dream()` method with three sub-operations |
| `src/config.ts` | Modify | Add `autoDream` config section |
| `src/sweeper/sweeper.ts` | Modify | Add idle detection, `autoDreamCooldown` tracking, trigger logic |
| `src/index.ts` | Modify | Pass `autoDream` config and `agentManager` to sweeper |
| `src/memory/memory-lifecycle.test.ts` | Modify | Add tests for dream operations |

---

### Task 1: Schema and type changes

**Files:**
- Modify: `src/memory/memory-types.ts:7-29` (MemoryRecord)
- Modify: `src/memory/memory-types.ts:58-67` (MemoryLifecycleConfig)

- [ ] **Step 1:** Add `needsReview` field to `MemoryRecord`

In `src/memory/memory-types.ts`, add after line 28 (`purgedAt?: Date;`):

```typescript
  needsReview?: boolean; // Contradiction detection couldn't resolve automatically
```

- [ ] **Step 2:** Add `DreamConfig` interface

After `MemoryLifecycleConfig` (line 67), add:

```typescript
export interface DreamConfig {
  enabled: boolean;
  idleThresholdMinutes: number;
  cooldownMinutes: number;
  similarityThreshold: number;
  patternMinCount: number;
  maxClustersPerRun: number;
  maxContradictionPairsPerRun: number;
}

export interface DreamResult {
  merged: number;
  contradictions: number;
  promoted: number;
  flaggedForReview: number;
  errors: string[];
}
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-types.ts
git commit -m "feat(autodream): add DreamConfig, DreamResult types and needsReview field (#80)"
```

---

### Task 2: Memory store — new queries

**Files:**
- Modify: `src/memory/memory-store.ts`

- [ ] **Step 1:** Add `getByTiersForAgent()` — get all hot+warm records for an agent (duplicate detection input)

After `getAllNonPinned()` (line 145), add:

```typescript
  /** Get all non-purged, non-superseded records in specified tiers for an agent */
  async getByTiersForAgent(agentId: string, tiers: MemoryTier[]): Promise<MemoryRecord[]> {
    return this.collection
      .find({
        agentId,
        tier: { $in: tiers },
        purged: { $ne: true },
        summarized: false,
        supersededBy: { $exists: false },
      })
      .toArray();
  }
```

- [ ] **Step 2:** Add `getFactsAndDecisionsByTopic()` — grouped for contradiction detection

```typescript
  /** Get fact and decision records grouped by topic for an agent */
  async getFactsAndDecisionsByTopic(agentId: string): Promise<Map<string, MemoryRecord[]>> {
    const records = await this.collection
      .find({
        agentId,
        type: { $in: ["fact", "decision"] },
        purged: { $ne: true },
        supersededBy: { $exists: false },
        needsReview: { $ne: true },
      })
      .toArray();
    const byTopic = new Map<string, MemoryRecord[]>();
    for (const r of records) {
      const list = byTopic.get(r.topic) ?? [];
      list.push(r);
      byTopic.set(r.topic, list);
    }
    return byTopic;
  }
```

- [ ] **Step 3:** Add `getInteractionsByTopic()` — for pattern promotion

```typescript
  /** Get interaction records grouped by topic, with distinct sourceThread counts */
  async getInteractionsByTopic(agentId: string): Promise<Map<string, MemoryRecord[]>> {
    const records = await this.collection
      .find({
        agentId,
        type: "interaction",
        purged: { $ne: true },
        supersededBy: { $exists: false },
        summarized: false,
      })
      .toArray();
    const byTopic = new Map<string, MemoryRecord[]>();
    for (const r of records) {
      const list = byTopic.get(r.topic) ?? [];
      list.push(r);
      byTopic.set(r.topic, list);
    }
    return byTopic;
  }
```

- [ ] **Step 4:** Add `markSuperseded()` — soft-link originals to merged record

```typescript
  /** Mark records as superseded by a merged/winning record */
  async markSuperseded(ids: ObjectId[], supersededBy: ObjectId): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { supersededBy, tier: "cold" as MemoryTier } },
    );
  }
```

- [ ] **Step 5:** Add `flagForReview()` — mark unresolvable contradictions

```typescript
  /** Flag records for human review (unresolvable contradictions) */
  async flagForReview(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { needsReview: true } },
    );
  }
```

- [ ] **Step 6:** Exclude superseded records from existing queries

**Critical:** The regular sweep's `getAllNonPinned()` and `getHotTier()` must exclude superseded records, or the sweep will re-score and re-promote records that `dream()` superseded.

In `getAllNonPinned()` (line 143-145), add `supersededBy` filter:

```typescript
  // BEFORE:
  async getAllNonPinned(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId, pinned: false, purged: { $ne: true } }).toArray();
  }

  // AFTER:
  async getAllNonPinned(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({
      agentId, pinned: false, purged: { $ne: true }, supersededBy: { $exists: false },
    }).toArray();
  }
```

In `getHotTier()` (line 115), add `supersededBy` filter:

```typescript
  // BEFORE:
  const records = await this.collection.find({ agentId, tier: "hot", purged: { $ne: true } }).toArray();

  // AFTER:
  const records = await this.collection.find({
    agentId, tier: "hot", purged: { $ne: true }, supersededBy: { $exists: false },
  }).toArray();
```

- [ ] **Step 7:** Add import for `MemoryTier` at top if not already present

Check that `MemoryTier` is in the import list at line 3. It should already be there.

- [ ] **Step 8:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 9:** Commit

```bash
git add src/memory/memory-store.ts
git commit -m "feat(autodream): add store queries, exclude superseded from sweep queries (#80)"
```

---

### Task 3: Memory embedder — find similar points

**Files:**
- Modify: `src/memory/memory-embedder.ts`

- [ ] **Step 1:** Add `findSimilar()` method — find Qdrant points similar to a given point

After `search()` method (line 99), add:

```typescript
  /**
   * Find points similar to a given point (by its ID) within the same agent.
   * Uses Qdrant's query API with recommend mode (positive example).
   * Note: the older `recommend()` method is deprecated in the Qdrant client.
   */
  async findSimilar(
    pointId: string,
    agentId: string,
    threshold: number,
    limit: number = 10,
  ): Promise<{ mongoId: string; score: number; pointId: string }[]> {
    await this.ensureCollection();
    const results = await this.getClient().query(COLLECTION, {
      query: { recommend: { positive: [pointId] } },
      filter: {
        must: [{ key: "agentId", match: { value: agentId } }],
      },
      limit,
      with_payload: true,
      score_threshold: threshold,
    });

    return (results.points ?? []).map((r) => ({
      mongoId: r.payload?.mongoId as string,
      score: r.score ?? 0,
      pointId: typeof r.id === "string" ? r.id : String(r.id),
    }));
  }
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-embedder.ts
git commit -m "feat(autodream): add findSimilar() using Qdrant recommend API (#80)"
```

---

### Task 4: Config — add autoDream section

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1:** Add `autoDream` config section

In `src/config.ts`, add after the `activity` section (after line 260, before `browser`):

```typescript
  autoDream: {
    enabled: (hive.autoDream?.enabled ?? false) as boolean,
    idleThresholdMinutes: parseInt(
      optional("AUTODREAM_IDLE_THRESHOLD_MINUTES", String(hive.autoDream?.idleThresholdMinutes ?? 30)),
      10,
    ),
    cooldownMinutes: parseInt(
      optional("AUTODREAM_COOLDOWN_MINUTES", String(hive.autoDream?.cooldownMinutes ?? 60)),
      10,
    ),
    similarityThreshold: parseFloat(
      optional("AUTODREAM_SIMILARITY_THRESHOLD", String(hive.autoDream?.similarityThreshold ?? 0.85)),
    ),
    patternMinCount: parseInt(
      optional("AUTODREAM_PATTERN_MIN_COUNT", String(hive.autoDream?.patternMinCount ?? 3)),
      10,
    ),
    maxClustersPerRun: parseInt(
      optional("AUTODREAM_MAX_CLUSTERS", String(hive.autoDream?.maxClustersPerRun ?? 20)),
      10,
    ),
    maxContradictionPairsPerRun: parseInt(
      optional("AUTODREAM_MAX_CONTRADICTIONS", String(hive.autoDream?.maxContradictionPairsPerRun ?? 30)),
      10,
    ),
  },
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/config.ts
git commit -m "feat(autodream): add autoDream config section (#80)"
```

---

### Task 5: Memory lifecycle — dream() method

**Files:**
- Modify: `src/memory/memory-lifecycle.ts`

This is the core task. Add the `dream()` method and its three sub-operations to `MemoryLifecycle`.

- [ ] **Step 1:** Add imports and DreamConfig to constructor

At the top of `src/memory/memory-lifecycle.ts`, add to imports:

```typescript
import type { DreamConfig, DreamResult } from "./memory-types.js";
```

Update the constructor to accept an optional `DreamConfig`:

```typescript
export class MemoryLifecycle {
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
    private dreamConfig?: DreamConfig,
  ) {}
```

- [ ] **Step 2:** Add the `dream()` orchestrator method

After `sweep()` (after line 98), add:

```typescript
  /**
   * Run autoDream consolidation across all agents.
   * Three operations: duplicate merge, contradiction detection, pattern promotion.
   */
  async dream(): Promise<DreamResult> {
    if (!this.dreamConfig?.enabled) {
      return { merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] };
    }

    const start = Date.now();
    let merged = 0;
    let contradictions = 0;
    let promoted = 0;
    let flaggedForReview = 0;
    const errors: string[] = [];

    try {
      const agentIds = await this.store.getAgentIds();

      for (const agentId of agentIds) {
        try {
          const r1 = await this.mergeDuplicates(agentId);
          merged += r1.merged;

          const r2 = await this.detectContradictions(agentId);
          contradictions += r2.resolved;
          flaggedForReview += r2.flagged;

          const r3 = await this.promotePatterns(agentId);
          promoted += r3.promoted;
        } catch (err) {
          errors.push(`${agentId}: ${err}`);
          log.error("autoDream failed for agent", { agentId, error: String(err) });
        }
      }
    } catch (err) {
      errors.push(`global: ${err}`);
    }

    const totalActions = merged + contradictions + promoted + flaggedForReview;
    if (totalActions > 0) {
      log.info("autoDream complete", {
        durationMs: Date.now() - start,
        merged,
        contradictions,
        promoted,
        flaggedForReview,
        errors: errors.length,
      });
    }

    return { merged, contradictions, promoted, flaggedForReview, errors };
  }
```

- [ ] **Step 3:** Add `mergeDuplicates()` — duplicate detection with Haiku merge

```typescript
  /**
   * Find and merge duplicate memories within an agent's hot+warm tiers.
   * Uses Qdrant recommend API to find similar records (cosine > threshold),
   * then Haiku to merge each cluster into a single consolidated record.
   */
  private async mergeDuplicates(agentId: string): Promise<{ merged: number }> {
    const cfg = this.dreamConfig!;
    const records = await this.store.getByTiersForAgent(agentId, ["hot", "warm"]);
    if (records.length < 2) return { merged: 0 };

    // Track which records have already been merged (by Qdrant point ID)
    const processed = new Set<string>();
    let merged = 0;
    let clustersProcessed = 0;

    for (const record of records) {
      if (clustersProcessed >= cfg.maxClustersPerRun) break;
      if (processed.has(record.qdrantPointId)) continue;

      // Find similar records using Qdrant recommend
      const similar = await this.embedder.findSimilar(
        record.qdrantPointId,
        agentId,
        cfg.similarityThreshold,
        10,
      );

      // Filter to only records we haven't already processed
      const cluster = similar.filter((s) => !processed.has(s.pointId));
      if (cluster.length === 0) continue;

      // Mark all as processed (including the source)
      processed.add(record.qdrantPointId);
      for (const s of cluster) processed.add(s.pointId);

      // Load the full records for the cluster
      const clusterIds = cluster.map((s) => new ObjectId(s.mongoId));
      const clusterRecords = await this.store.getByIds(clusterIds);
      const allRecords = [record, ...clusterRecords];

      // Haiku merge
      const entries = allRecords
        .map((r) => `- [${r.type}/${r.importance}] ${r.content}`)
        .join("\n");

      const prompt = [
        "Merge the following duplicate or overlapping memories into a single consolidated record.",
        "Preserve all unique details. Discard exact duplicates. Be concise.",
        "",
        entries,
      ].join("\n");

      const q = query({
        prompt,
        options: {
          model: "claude-haiku-4-5-20251001",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          persistSession: false,
        },
      });

      let mergedText = "";
      for await (const message of q) {
        const msg = message as SDKMessage;
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success" && result.result) {
            mergedText = result.result;
          }
        }
      }
      if (!mergedText) continue;

      // Save merged record — inherit highest importance, keep topic and type from source
      const bestImportance = this.highestImportance(allRecords);
      const pointId = crypto.randomUUID();
      const mergedRecord = await this.store.save(
        agentId,
        { content: mergedText, type: record.type, topic: record.topic, importance: bestImportance },
        pointId,
      );

      // Embed the merged record
      await this.embedder.upsert(pointId, mergedText, {
        agentId,
        mongoId: mergedRecord._id!.toString(),
        type: record.type,
        topic: record.topic,
        tier: "hot",
        importance: bestImportance,
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Mark originals as superseded
      const originalIds = allRecords.map((r) => r._id!);
      await this.store.markSuperseded(originalIds, mergedRecord._id!);

      merged += allRecords.length;
      clustersProcessed++;
    }

    if (merged > 0) {
      log.info("autoDream: duplicates merged", { agentId, merged, clusters: clustersProcessed });
    }

    return { merged };
  }

  private highestImportance(records: MemoryRecord[]): MemoryImportance {
    const order: MemoryImportance[] = ["critical", "high", "medium", "low"];
    for (const level of order) {
      if (records.some((r) => r.importance === level)) return level;
    }
    return "medium";
  }
```

- [ ] **Step 4:** Add `detectContradictions()` — Haiku pairwise check within topic groups

```typescript
  /**
   * Detect contradicting fact/decision records within the same topic.
   * Haiku evaluates each pair. Loser is superseded by winner (newer wins tie).
   */
  private async detectContradictions(agentId: string): Promise<{ resolved: number; flagged: number }> {
    const cfg = this.dreamConfig!;
    const byTopic = await this.store.getFactsAndDecisionsByTopic(agentId);
    let resolved = 0;
    let flagged = 0;
    let pairsChecked = 0;

    for (const [topic, records] of byTopic) {
      if (pairsChecked >= cfg.maxContradictionPairsPerRun) break;
      if (records.length < 2) continue;

      // Check all pairs within this topic
      for (let i = 0; i < records.length - 1; i++) {
        for (let j = i + 1; j < records.length; j++) {
          if (pairsChecked >= cfg.maxContradictionPairsPerRun) break;

          const a = records[i];
          const b = records[j];

          const prompt = [
            `Do these two memories contradict each other?`,
            ``,
            `Memory A (${a.type}, created ${a.createdAt.toISOString()}):`,
            a.content,
            ``,
            `Memory B (${b.type}, created ${b.createdAt.toISOString()}):`,
            b.content,
            ``,
            `Reply with exactly one of:`,
            `- "NO" if they don't contradict`,
            `- "A_WINS" if Memory A is more current/accurate`,
            `- "B_WINS" if Memory B is more current/accurate`,
            `- "UNCLEAR" if they contradict but you can't determine which is correct`,
          ].join("\n");

          const q = query({
            prompt,
            options: {
              model: "claude-haiku-4-5-20251001",
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              maxTurns: 1,
              maxBudgetUsd: 0.02,
              persistSession: false,
            },
          });

          let verdict = "";
          for await (const message of q) {
            const msg = message as SDKMessage;
            if (msg.type === "result") {
              const result = msg as SDKResultMessage;
              if (result.subtype === "success" && result.result) {
                verdict = result.result.trim().toUpperCase();
              }
            }
          }

          pairsChecked++;

          if (verdict.includes("A_WINS")) {
            await this.store.markSuperseded([b._id!], a._id!);
            resolved++;
          } else if (verdict.includes("B_WINS")) {
            await this.store.markSuperseded([a._id!], b._id!);
            resolved++;
          } else if (verdict.includes("UNCLEAR")) {
            await this.store.flagForReview([a._id!, b._id!]);
            flagged += 2;
          }
          // "NO" = no contradiction, do nothing
        }
        if (pairsChecked >= cfg.maxContradictionPairsPerRun) break;
      }
    }

    if (resolved > 0 || flagged > 0) {
      log.info("autoDream: contradictions processed", { agentId, resolved, flagged, pairsChecked });
    }

    return { resolved, flagged };
  }
```

- [ ] **Step 5:** Add `promotePatterns()` — interaction clusters become facts

```typescript
  /**
   * Promote recurring interaction patterns to facts.
   * If 3+ interactions on the same topic come from different conversations,
   * generate a fact summary and promote to hot tier.
   */
  private async promotePatterns(agentId: string): Promise<{ promoted: number }> {
    const cfg = this.dreamConfig!;
    const byTopic = await this.store.getInteractionsByTopic(agentId);
    let promoted = 0;

    for (const [topic, records] of byTopic) {
      // Count distinct source threads
      const threads = new Set(records.map((r) => r.sourceThread).filter(Boolean));
      if (threads.size < cfg.patternMinCount) continue;

      // Take most recent N interactions for the prompt
      const sorted = records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const sample = sorted.slice(0, 10); // Cap prompt size

      const entries = sample
        .map((r) => `- [${r.importance}] ${r.content}`)
        .join("\n");

      const prompt = [
        `These ${records.length} interactions across ${threads.size} conversations share topic "${topic}".`,
        "Generate a single fact that captures the recurring pattern or insight.",
        "Be concise — one to three sentences.",
        "",
        entries,
      ].join("\n");

      const q = query({
        prompt,
        options: {
          model: "claude-haiku-4-5-20251001",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          persistSession: false,
        },
      });

      let factText = "";
      for await (const message of q) {
        const msg = message as SDKMessage;
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success" && result.result) {
            factText = result.result;
          }
        }
      }
      if (!factText) continue;

      // Save as a hot-tier fact
      const pointId = crypto.randomUUID();
      const factRecord = await this.store.save(
        agentId,
        { content: factText, type: "fact", topic, importance: "medium" },
        pointId,
      );

      // Embed the fact
      await this.embedder.upsert(pointId, factText, {
        agentId,
        mongoId: factRecord._id!.toString(),
        type: "fact",
        topic,
        tier: "hot",
        importance: "medium",
        createdAt: Math.floor(Date.now() / 1000),
      });

      promoted++;

      // Don't delete interactions — they have conversation context.
      // They'll decay to cold naturally via the regular sweep scoring.
    }

    if (promoted > 0) {
      log.info("autoDream: patterns promoted", { agentId, promoted });
    }

    return { promoted };
  }
```

- [ ] **Step 6:** Add `MemoryImportance` to the import from memory-types

Ensure line 7 includes `MemoryImportance`:

```typescript
import type { MemoryRecord, MemoryLifecycleConfig, MemoryTier, DreamConfig, DreamResult, MemoryImportance } from "./memory-types.js";
```

Also add `ObjectId` import from mongodb:

```typescript
import { ObjectId } from "mongodb";
```

(ObjectId is already imported at line 1 — verify it's there.)

- [ ] **Step 7:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8:** Commit

```bash
git add src/memory/memory-lifecycle.ts
git commit -m "feat(autodream): add dream() with duplicate merge, contradiction detection, pattern promotion (#80)"
```

---

### Task 6: Sweeper — idle detection and autoDream trigger

**Files:**
- Modify: `src/sweeper/sweeper.ts`

- [ ] **Step 1:** Add imports and config types

At the top of `src/sweeper/sweeper.ts`, add to imports:

```typescript
import type { DreamConfig } from "../memory/memory-types.js";
```

- [ ] **Step 2:** Update `SweeperConfig` to include dream config

In `SweeperConfig` (line 24-31), add:

```typescript
  dreamConfig?: DreamConfig;
```

- [ ] **Step 3:** Add idle tracking state to `Sweeper` class

Add after `memorySweepEvery` (line 55):

```typescript
  private lastDreamAt = 0; // timestamp of last dream run
```

- [ ] **Step 4:** Add autoDream trigger logic as step 10 in `sweep()`

After the memory lifecycle block (after line 194), add:

```typescript
    // 10. autoDream — proactive memory consolidation
    // Trigger conditions: (a) after regular memory sweep, or (b) all agents idle for threshold
    if (this.targets.memoryLifecycle && this.config.dreamConfig?.enabled) {
      const dreamCfg = this.config.dreamConfig;
      const cooldownMs = dreamCfg.cooldownMinutes * 60 * 1000;
      const now = Date.now();
      const cooldownElapsed = (now - this.lastDreamAt) > cooldownMs;

      // (a) Post-sweep trigger: runs right after the regular memory lifecycle sweep
      const justSwept = this.memoryCycleCounter === 0; // counter was just reset above

      // (b) Idle trigger: all agents idle for threshold duration
      let allIdle = false;
      if (cooldownElapsed && !justSwept) {
        const thresholdMs = dreamCfg.idleThresholdMinutes * 60 * 1000;
        const states = this.targets.agentManager.getAllStates();
        allIdle = states.length > 0 && states.every(
          (s) => s.status === "idle" && (now - s.lastActivity.getTime()) > thresholdMs,
        );
      }

      if (cooldownElapsed && (justSwept || allIdle)) {
        const trigger = justSwept ? "post-sweep" : "idle";
        log.info("autoDream triggered", { trigger });
        try {
          const dreamResult = await this.targets.memoryLifecycle.dream();
          this.lastDreamAt = Date.now();
          const totalActions = dreamResult.merged + dreamResult.contradictions + dreamResult.promoted;
          if (totalActions > 0 || dreamResult.errors.length > 0) {
            results.push({
              component: "autodream",
              pruned: dreamResult.merged + dreamResult.contradictions,
              retried: dreamResult.promoted,
              bytesFreed: 0,
              errors: dreamResult.errors,
            });
          }
        } catch (err) {
          results.push({ component: "autodream", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
        }
      }
    }
```

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6:** Commit

```bash
git add src/sweeper/sweeper.ts
git commit -m "feat(autodream): add idle detection and autoDream trigger in sweeper (#80)"
```

---

### Task 7: Wire up in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1:** Pass `dreamConfig` to `MemoryLifecycle` constructor

Find where `MemoryLifecycle` is instantiated (around line 110-120). The constructor currently takes `(store, embedder, config)`. Add the dream config as the 4th argument:

```typescript
  // BEFORE:
  const memoryLifecycle = new MemoryLifecycle(memoryStore, memoryEmbedder, {
    hotBudgetTokens: config.memory.hotBudgetTokens,
    ...rest of config...
  });

  // AFTER:
  const memoryLifecycle = new MemoryLifecycle(memoryStore, memoryEmbedder, {
    hotBudgetTokens: config.memory.hotBudgetTokens,
    ...rest of config...
  }, config.autoDream);
```

- [ ] **Step 2:** Pass `dreamConfig` to Sweeper

Find where the `Sweeper` is instantiated and its config is built. Add `dreamConfig` to the sweeper config:

```typescript
  // Add to sweeper config object:
  dreamConfig: config.autoDream,
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/index.ts
git commit -m "feat(autodream): wire dream config into MemoryLifecycle and Sweeper (#80)"
```

---

### Task 8: Tests

**Files:**
- Modify: `src/memory/memory-lifecycle.test.ts`

- [ ] **Step 1:** Read the existing test file and add new method stubs to mock factory

Read `src/memory/memory-lifecycle.test.ts` to see how `MemoryLifecycle` is mocked. The `makeMockStore()` factory function needs new method stubs for the queries added in Task 2:

```typescript
// Add to makeMockStore():
getByTiersForAgent: vi.fn().mockResolvedValue([]),
getFactsAndDecisionsByTopic: vi.fn().mockResolvedValue(new Map()),
getInteractionsByTopic: vi.fn().mockResolvedValue(new Map()),
markSuperseded: vi.fn().mockResolvedValue(undefined),
flagForReview: vi.fn().mockResolvedValue(undefined),
```

Similarly, add `findSimilar` to `makeMockEmbedder()`:

```typescript
findSimilar: vi.fn().mockResolvedValue([]),
```

- [ ] **Step 2:** Add tests for `dream()` — basic orchestration

Add a new `describe("dream()")` block with tests:

```typescript
describe("dream()", () => {
  it("returns zeros when dreamConfig is not provided", async () => {
    // MemoryLifecycle without dreamConfig
    const lifecycle = new MemoryLifecycle(mockStore, mockEmbedder, baseConfig);
    const result = await lifecycle.dream();
    expect(result).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
  });

  it("returns zeros when dreamConfig.enabled is false", async () => {
    const lifecycle = new MemoryLifecycle(mockStore, mockEmbedder, baseConfig, {
      enabled: false,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
    });
    const result = await lifecycle.dream();
    expect(result).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
  });

  it("catches per-agent errors without stopping other agents", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
    };
    const lifecycle = new MemoryLifecycle(mockStore, mockEmbedder, baseConfig, dreamCfg);

    // Mock getAgentIds returns two agents
    mockStore.getAgentIds.mockResolvedValue(["agent-a", "agent-b"]);
    // First agent throws, second succeeds
    mockStore.getByTiersForAgent
      .mockRejectedValueOnce(new Error("db error"))
      .mockResolvedValue([]);
    mockStore.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    mockStore.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("agent-a");
  });
});
```

Note: The exact mock setup depends on the patterns in the existing test file. Read the file first (Step 1) and adapt.

- [ ] **Step 3:** Verify

Run: `npx vitest run src/memory/memory-lifecycle.test.ts`
Expected: all tests pass

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-lifecycle.test.ts
git commit -m "test(autodream): add dream() tests (#80)"
```

---

### Task 9: Final verification

- [ ] **Step 1:** Full type check

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2:** Full test suite

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: clean build

- [ ] **Step 4:** Verify no remaining TODOs

Run: `grep -rn "TODO\|FIXME\|HACK" src/memory/memory-lifecycle.ts src/memory/memory-store.ts src/memory/memory-embedder.ts src/sweeper/sweeper.ts`
Expected: no new TODOs (existing ones are fine)
