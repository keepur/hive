import { ObjectId } from "mongodb";
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { MemoryStore, AutoDreamAgentState } from "./memory-store.js";
import type { MemoryEmbedder } from "./memory-embedder.js";
import type {
  MemoryRecord,
  MemoryLifecycleConfig,
  MemoryTier,
  DreamConfig,
  DreamResult,
  MemoryImportance,
  ConsolidationCursor,
} from "./memory-types.js";
import { IMPORTANCE_WEIGHTS, TYPE_WEIGHTS } from "./memory-types.js";

const log = createLogger("memory-lifecycle");

class AutoDreamBudget {
  spentUsd = 0;
  llmCalls = 0;

  constructor(
    readonly maxRunUsd: number,
    readonly maxCallUsd: number,
  ) {}

  remainingUsd(): number {
    return Math.max(0, this.maxRunUsd - this.spentUsd);
  }

  canSpend(): boolean {
    return this.remainingUsd() > 0.001;
  }

  callBudgetUsd(): number {
    return Math.min(this.maxCallUsd, this.remainingUsd());
  }

  record(costUsd: number): void {
    this.spentUsd += costUsd;
    this.llmCalls++;
  }
}

export class MemoryLifecycle {
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
    private dreamConfig?: DreamConfig,
    private getActiveAgentIds?: () => Promise<Set<string>>,
  ) {}

  /**
   * Filter memory-derived agent IDs (includes orphans from retired agents)
   * against the current active roster. If no roster provider is injected,
   * returns the input unchanged — preserves backward compat and test setups.
   */
  private async filterActiveAgents(ids: string[]): Promise<string[]> {
    if (!this.getActiveAgentIds) return ids;
    const active = await this.getActiveAgentIds();
    const filtered = ids.filter((id) => active.has(id));
    const skippedCount = ids.length - filtered.length;
    if (skippedCount > 0) {
      log.debug("Skipped retired agents", {
        skipped: skippedCount,
        retiredIds: ids.filter((id) => !active.has(id)),
      });
    }
    return filtered;
  }

  private autoDreamRunBudget(): number {
    return this.dreamConfig?.maxRunBudgetUsd ?? this.dreamConfig?.maxBudgetUsd ?? 0.05;
  }

  private autoDreamCallBudget(): number {
    return this.dreamConfig?.maxCallBudgetUsd ?? this.dreamConfig?.maxBudgetUsd ?? 0.01;
  }

  private autoDreamMinNewMemories(): number {
    return this.dreamConfig?.minNewMemories ?? 10;
  }

  private async runDreamQuery(prompt: string, budget: AutoDreamBudget): Promise<string> {
    if (!budget.canSpend()) throw new Error("autoDream run budget exhausted");

    const q = query({
      prompt,
      options: {
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: budget.callBudgetUsd(),
        persistSession: false,
      },
    });

    let text = "";
    for await (const message of q) {
      const msg = message as SDKMessage;
      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        budget.record(result.total_cost_usd ?? 0);
        if (result.subtype === "success" && result.result) {
          text = result.result;
        }
      }
    }

    return text;
  }

  /**
   * Compute retention score for a memory record.
   * score = (importance × 0.4) + (recency × 0.3) + (access × 0.2) + (type × 0.1)
   */
  computeScore(record: MemoryRecord, medianAccess: number): number {
    const importanceWeight = IMPORTANCE_WEIGHTS[record.importance] ?? 0.5;
    const typeWeight = TYPE_WEIGHTS[record.type] ?? 0.5;

    // Recency: exponential decay from updatedAt
    const ageMs = Date.now() - record.updatedAt.getTime();
    const halfLifeMs = this.config.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
    const recencyWeight = Math.exp((-0.693 * ageMs) / halfLifeMs); // ln(2) ≈ 0.693

    // Access frequency: normalized against agent median
    const accessWeight =
      medianAccess > 0 ? Math.min(record.accessCount / medianAccess, 1.0) : record.accessCount > 0 ? 1.0 : 0.0;

    return importanceWeight * 0.4 + recencyWeight * 0.3 + accessWeight * 0.2 + typeWeight * 0.1;
  }

  /**
   * Approximate token count (chars / 4).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Run one lifecycle sweep across all agents.
   */
  async sweep(): Promise<SweepResult> {
    const start = Date.now();
    let promoted = 0;
    let demoted = 0;
    let summarized = 0;
    let cleaned = 0;
    let purged = 0;
    const errors: string[] = [];

    try {
      const allIds = await this.store.getAgentIds();
      const agentIds = await this.filterActiveAgents(allIds);

      for (const agentId of agentIds) {
        try {
          const result = await this.sweepAgent(agentId);
          promoted += result.promoted;
          demoted += result.demoted;
          summarized += result.summarized;
          cleaned += result.cleaned;
          purged += result.purged;
        } catch (err) {
          errors.push(`${agentId}: ${err}`);
          log.error("Memory lifecycle sweep failed for agent", { agentId, error: String(err) });
        }
      }
    } catch (err) {
      errors.push(`global: ${err}`);
    }

    const totalActions = promoted + demoted + summarized + cleaned + purged;
    if (totalActions > 0) {
      log.info("Memory lifecycle sweep complete", {
        durationMs: Date.now() - start,
        promoted,
        demoted,
        summarized,
        cleaned,
        purged,
        errors: errors.length,
      });
    }

    return {
      component: "memory-lifecycle",
      pruned: demoted + cleaned + purged,
      retried: promoted,
      bytesFreed: 0,
      errors,
    };
  }

  private async sweepAgent(
    agentId: string,
  ): Promise<{ promoted: number; demoted: number; summarized: number; cleaned: number; purged: number }> {
    let promoted = 0;
    let demoted = 0;

    // 1. Score all non-pinned records
    const records = await this.store.getAllNonPinned(agentId);
    let cleanedCount = 0;

    if (records.length > 0) {
      const accessCounts = records.map((r) => r.accessCount).sort((a, b) => a - b);
      const medianAccess = accessCounts[Math.floor(accessCounts.length / 2)] ?? 0;

      const scored = records.map((r) => ({
        record: r,
        score: this.computeScore(r, medianAccess),
      }));

      // 2. Enforce tier placement based on score
      const tierUpdates: { id: ObjectId; newTier: MemoryTier }[] = [];
      for (const { record, score } of scored) {
        let targetTier: MemoryTier;
        if (score >= this.config.hotThreshold) {
          targetTier = "hot";
        } else if (score >= this.config.warmThreshold) {
          targetTier = "warm";
        } else {
          targetTier = "cold";
        }

        if (targetTier !== record.tier) {
          tierUpdates.push({ id: record._id!, newTier: targetTier });
          if (targetTier === "hot" && record.tier !== "hot") promoted++;
          if (targetTier !== "hot" && record.tier === "hot") demoted++;
        }
      }

      // Apply tier changes
      for (const tier of ["hot", "warm", "cold"] as MemoryTier[]) {
        const ids = tierUpdates.filter((u) => u.newTier === tier).map((u) => u.id);
        await this.store.setTierBulk(ids, tier);
      }

      // 3. Enforce hot budget — pinned records don't count against the budget
      const hotRecords = await this.store.getHotTier(agentId);
      let nonPinnedTokens = 0;
      const toOverflow: ObjectId[] = [];
      for (const r of hotRecords) {
        const tokens = this.estimateTokens(r.content);
        if (!r.pinned) {
          nonPinnedTokens += tokens;
          if (nonPinnedTokens > this.config.hotBudgetTokens) {
            toOverflow.push(r._id!);
          }
        }
      }
      if (toOverflow.length > 0) {
        await this.store.setTierBulk(toOverflow, "warm");
        demoted += toOverflow.length;
      }
    }

    // 4. Clean up old summarized records
    // Runs unconditionally — agents with no active memories still have old summaries to clean.
    const retentionDate = new Date(Date.now() - this.config.coldRetentionDays * 24 * 60 * 60 * 1000);
    cleanedCount = await this.store.deleteSummarizedOlderThan(agentId, retentionDate);

    // 5. Hard-delete purged records older than retention period
    // Runs unconditionally — agents that purged all memories still need cleanup.
    const purgeCutoff = new Date(Date.now() - this.config.purgeRetentionDays * 24 * 60 * 60 * 1000);
    let purgedCount = 0;
    try {
      const purgedRecords = await this.store.deletePurgedOlderThan(agentId, purgeCutoff);
      purgedCount = purgedRecords.length;
      if (purgedRecords.length > 0) {
        const pointIds = purgedRecords.map((r) => r.qdrantPointId).filter(Boolean);
        for (const pointId of pointIds) {
          await this.embedder.remove(pointId);
        }
        log.info("Hard-deleted purged records", { agentId, count: purgedRecords.length });
      }
    } catch (err) {
      log.warn("Purge hard-delete phase failed", { agentId, error: String(err) });
    }

    return { promoted, demoted, summarized: 0, cleaned: cleanedCount, purged: purgedCount };
  }

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
    let skippedAgents = 0;
    let summarized = 0;
    const errors: string[] = [];
    const budget = new AutoDreamBudget(this.autoDreamRunBudget(), this.autoDreamCallBudget());

    try {
      const allIds = await this.store.getAgentIds();
      const agentIds = await this.filterActiveAgents(allIds);

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
                ...(resetCheckpoint ? { phase: "idle" as const, topic: null, cursor: null } : {}),
              });
            } catch (markErr) {
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
    } catch (err) {
      errors.push(`global: ${err}`);
    }

    const totalActions = merged + contradictions + promoted + flaggedForReview + summarized;
    if (totalActions > 0) {
      log.info("autoDream complete", {
        durationMs: Date.now() - start,
        merged,
        contradictions,
        promoted,
        flaggedForReview,
        summarized,
        skippedAgents,
        spentUsd: budget.spentUsd,
        budgetUsd: budget.maxRunUsd,
        llmCalls: budget.llmCalls,
        errors: errors.length,
      });
    }

    return {
      merged,
      contradictions,
      promoted,
      flaggedForReview,
      summarized,
      errors,
      skippedAgents,
      spentUsd: budget.spentUsd,
      budgetUsd: budget.maxRunUsd,
      llmCalls: budget.llmCalls,
    };
  }

  /**
   * Find and merge duplicate memories within an agent's hot+warm tiers.
   * Uses Qdrant recommend API to find similar records (cosine > threshold),
   * then Haiku to merge each cluster into a single consolidated record.
   */
  private async mergeDuplicates(agentId: string, budget: AutoDreamBudget): Promise<{ merged: number }> {
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
      const similar = await this.embedder.findSimilar(record.qdrantPointId, agentId, cfg.similarityThreshold, 10);

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
      const entries = allRecords.map((r) => `- [${r.type}/${r.importance}] ${r.content}`).join("\n");

      const prompt = [
        "Merge the following duplicate or overlapping memories into a single consolidated record.",
        "Preserve all unique details. Discard exact duplicates. Be concise.",
        "",
        entries,
      ].join("\n");

      const promptTokens = this.estimateTokens(prompt);
      const cap = this.dreamConfig?.coldSummaryPromptTokenBudget ?? 8000;
      if (promptTokens > cap) {
        log.warn("autoDream: skipping prompt exceeding token budget", {
          agentId, phase: "mergeDuplicates", promptTokens, cap,
        });
        continue;
      }

      const mergedText = await this.runDreamQuery(prompt, budget);
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

  /**
   * Detect contradicting fact/decision records within the same topic.
   * Haiku evaluates each pair. Loser is superseded by winner (newer wins tie).
   */
  private async detectContradictions(
    agentId: string,
    budget: AutoDreamBudget,
  ): Promise<{ resolved: number; flagged: number }> {
    const cfg = this.dreamConfig!;
    const byTopic = await this.store.getFactsAndDecisionsByTopic(agentId);
    let resolved = 0;
    let flagged = 0;
    let pairsChecked = 0;
    // Track records already resolved/flagged this run to avoid state corruption:
    // a superseded record must not participate in later pair comparisons.
    const eliminated = new Set<string>();

    for (const [topic, records] of byTopic) {
      if (pairsChecked >= cfg.maxContradictionPairsPerRun) break;
      if (records.length < 2) continue;

      // Check all pairs within this topic
      for (let i = 0; i < records.length - 1; i++) {
        if (eliminated.has(records[i]._id!.toString())) continue;
        for (let j = i + 1; j < records.length; j++) {
          if (pairsChecked >= cfg.maxContradictionPairsPerRun) break;
          if (eliminated.has(records[j]._id!.toString())) continue;

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

          const promptTokens = this.estimateTokens(prompt);
          const cap = this.dreamConfig?.coldSummaryPromptTokenBudget ?? 8000;
          if (promptTokens > cap) {
            log.warn("autoDream: skipping prompt exceeding token budget", {
              agentId, phase: "detectContradictions", promptTokens, cap,
            });
            continue;
          }

          const verdict = (await this.runDreamQuery(prompt, budget)).trim().toUpperCase();

          pairsChecked++;

          if (verdict.includes("A_WINS")) {
            await this.store.markSuperseded([b._id!], a._id!);
            eliminated.add(b._id!.toString());
            resolved++;
          } else if (verdict.includes("B_WINS")) {
            await this.store.markSuperseded([a._id!], b._id!);
            eliminated.add(a._id!.toString());
            resolved++;
          } else if (verdict.includes("UNCLEAR")) {
            await this.store.flagForReview([a._id!, b._id!]);
            eliminated.add(a._id!.toString());
            eliminated.add(b._id!.toString());
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

  /**
   * Promote recurring interaction patterns to facts.
   * If 3+ interactions on the same topic come from different conversations,
   * generate a fact summary and promote to hot tier.
   */
  private async promotePatterns(agentId: string, budget: AutoDreamBudget): Promise<{ promoted: number }> {
    const cfg = this.dreamConfig!;
    const byTopic = await this.store.getInteractionsByTopic(agentId);
    let promoted = 0;

    for (const [topic, records] of byTopic) {
      if (promoted >= cfg.maxPromotionsPerRun) break;

      // Count distinct source threads
      const threads = new Set(records.map((r) => r.sourceThread).filter(Boolean));
      if (threads.size < cfg.patternMinCount) continue;

      // Take most recent N interactions for the prompt
      const sorted = records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const sample = sorted.slice(0, 10); // Cap prompt size

      const entries = sample.map((r) => `- [${r.importance}] ${r.content}`).join("\n");

      const prompt = [
        `These ${records.length} interactions across ${threads.size} conversations share topic "${topic}".`,
        "Generate a single fact that captures the recurring pattern or insight.",
        "Be concise — one to three sentences.",
        "",
        entries,
      ].join("\n");

      const promptTokens = this.estimateTokens(prompt);
      const cap = this.dreamConfig?.coldSummaryPromptTokenBudget ?? 8000;
      if (promptTokens > cap) {
        log.warn("autoDream: skipping prompt exceeding token budget", {
          agentId, phase: "promotePatterns", promptTokens, cap,
        });
        continue;
      }

      const factText = await this.runDreamQuery(prompt, budget);
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

      // Supersede source interactions so they don't re-promote on next cycle.
      const interactionIds = records.map((r) => r._id!);
      await this.store.markSuperseded(interactionIds, factRecord._id!);

      promoted++;
    }

    if (promoted > 0) {
      log.info("autoDream: patterns promoted", { agentId, promoted });
    }

    return { promoted };
  }

  /**
   * KPR-241: paged + checkpointed cold-summary consolidation as an
   * autoDream phase. Drains backlog across multiple sweep cycles; each
   * call processes at most `coldSummaryPageSize` records per topic.
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

      // Inner pagination loop — at most one page per dream() invocation per topic.
      const page = await this.store.getColdByTopicPaged(agentId, topic, cursor, pageSize);
      if (page.length < this.config.coldSummaryMinRecords) continue;

      // Oversized single-record handling — filter before page-shrinking so
      // one huge record doesn't cause the shrink loop to discard normal records.
      const afterOversizeFilter: typeof page = [];
      for (const r of page) {
        if (this.estimateTokens(r.content) > promptTokenBudget) {
          await this.store.flagForReview([r._id!]);
          log.warn("autoDream: cold record flagged needsReview (oversized)", {
            agentId, topic, recordId: r._id!.toString(),
          });
          continue;
        }
        afterOversizeFilter.push(r);
      }
      if (afterOversizeFilter.length < this.config.coldSummaryMinRecords) continue;

      // Token-budget defense: shrink page if estimated prompt exceeds budget.
      let pageEntries = afterOversizeFilter;
      let estTokens = this.estimateTokens(pageEntries.map((r) => r.content).join("\n"));
      while (estTokens > promptTokenBudget && pageEntries.length > this.config.coldSummaryMinRecords) {
        pageEntries = pageEntries.slice(0, Math.floor(pageEntries.length / 2));
        estTokens = this.estimateTokens(pageEntries.map((r) => r.content).join("\n"));
      }

      const usable = pageEntries;
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

      if (!budget.canSpend()) {
        return { summarized, drained: false };
      }
    }

    // Reached end of topics. Check whether anything is left across all topics.
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
}
