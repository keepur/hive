import { ObjectId } from "mongodb";
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryEmbedder } from "./memory-embedder.js";
import type {
  MemoryRecord,
  MemoryLifecycleConfig,
  MemoryTier,
  DreamConfig,
  DreamResult,
  MemoryImportance,
} from "./memory-types.js";
import { IMPORTANCE_WEIGHTS, TYPE_WEIGHTS } from "./memory-types.js";

const log = createLogger("memory-lifecycle");

export class MemoryLifecycle {
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
    private dreamConfig?: DreamConfig,
  ) {}

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
      const agentIds = await this.store.getAgentIds();

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
    let summarizedCount = 0;
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

      // 4. Summarize cold batches
      try {
        summarizedCount = await this.summarizeCold(agentId);
      } catch (err) {
        log.warn("Cold summarization failed", { agentId, error: String(err) });
      }
    }

    // 5. Clean up old summarized records
    // Runs unconditionally — agents with no active memories still have old summaries to clean.
    const retentionDate = new Date(Date.now() - this.config.coldRetentionDays * 24 * 60 * 60 * 1000);
    cleanedCount = await this.store.deleteSummarizedOlderThan(agentId, retentionDate);

    // 6. Hard-delete purged records older than retention period
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

    return { promoted, demoted, summarized: summarizedCount, cleaned: cleanedCount, purged: purgedCount };
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

      const entries = sample.map((r) => `- [${r.importance}] ${r.content}`).join("\n");

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

  private async summarizeCold(agentId: string): Promise<number> {
    const topics = await this.store.getColdTopics(agentId);
    let summarized = 0;

    for (const topic of topics) {
      const coldRecords = await this.store.getColdByTopic(agentId, topic);
      if (coldRecords.length < this.config.coldSummaryMinRecords) continue;

      const entries = coldRecords.map((r) => `- [${r.type}/${r.importance}] ${r.content}`).join("\n");

      const prompt = [
        `Summarize the following memory entries for agent ${agentId} about topic "${topic}".`,
        "Preserve key facts, decisions, and outcomes. Discard routine interactions.",
        "Be concise — aim for 2-5 sentences.",
        "",
        entries,
      ].join("\n");

      // Use Haiku for cheap summarization — SDK returns an async iterable
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

      let summaryText = "";
      for await (const message of q) {
        const msg = message as SDKMessage;
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success" && result.result) {
            summaryText = result.result;
          }
        }
      }
      if (!summaryText) continue;

      // Save summary as a warm-tier record
      const pointId = crypto.randomUUID();
      const summaryRecord = await this.store.save(
        agentId,
        { content: summaryText, type: "summary", topic, importance: "medium" },
        pointId,
      );

      // Set to warm (summaries start warm, can be promoted to hot by access)
      await this.store.setTier(summaryRecord._id!, "warm");

      // Embed the summary
      await this.embedder.upsert(pointId, summaryText, {
        agentId,
        mongoId: summaryRecord._id!.toString(),
        type: "summary",
        topic,
        tier: "warm",
        importance: "medium",
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Mark originals as summarized
      await this.store.markSummarized(
        coldRecords.map((r) => r._id!),
        summaryRecord._id!,
      );

      summarized += coldRecords.length;
    }

    return summarized;
  }
}
