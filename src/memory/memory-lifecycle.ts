import { ObjectId } from "mongodb";
import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryEmbedder } from "./memory-embedder.js";
import type { MemoryRecord, MemoryLifecycleConfig, MemoryTier } from "./memory-types.js";
import { IMPORTANCE_WEIGHTS, TYPE_WEIGHTS } from "./memory-types.js";

const log = createLogger("memory-lifecycle");

export class MemoryLifecycle {
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
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
        } catch (err) {
          errors.push(`${agentId}: ${err}`);
          log.error("Memory lifecycle sweep failed for agent", { agentId, error: String(err) });
        }
      }
    } catch (err) {
      errors.push(`global: ${err}`);
    }

    const totalActions = promoted + demoted + summarized + cleaned;
    if (totalActions > 0) {
      log.info("Memory lifecycle sweep complete", {
        durationMs: Date.now() - start,
        promoted,
        demoted,
        summarized,
        cleaned,
        errors: errors.length,
      });
    }

    return {
      component: "memory-lifecycle",
      pruned: demoted + cleaned,
      retried: promoted,
      bytesFreed: 0,
      errors,
    };
  }

  private async sweepAgent(
    agentId: string,
  ): Promise<{ promoted: number; demoted: number; summarized: number; cleaned: number }> {
    let promoted = 0;
    let demoted = 0;

    // 1. Score all non-pinned records
    const records = await this.store.getAllNonPinned(agentId);
    if (records.length === 0) return { promoted: 0, demoted: 0, summarized: 0, cleaned: 0 };

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
    let pinnedTokens = 0;
    let nonPinnedTokens = 0;
    const toOverflow: ObjectId[] = [];
    for (const r of hotRecords) {
      const tokens = this.estimateTokens(r.content);
      if (r.pinned) {
        pinnedTokens += tokens;
      } else {
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
    let summarizedCount = 0;
    try {
      summarizedCount = await this.summarizeCold(agentId);
    } catch (err) {
      log.warn("Cold summarization failed", { agentId, error: String(err) });
    }

    // 5. Clean up old summarized records
    const retentionDate = new Date(Date.now() - this.config.coldRetentionDays * 24 * 60 * 60 * 1000);
    const cleanedCount = await this.store.deleteSummarizedOlderThan(agentId, retentionDate);

    return { promoted, demoted, summarized: summarizedCount, cleaned: cleanedCount };
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
