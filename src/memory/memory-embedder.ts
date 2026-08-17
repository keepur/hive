import { QdrantClient } from "@qdrant/js-client-rest";
import { createLogger } from "../logging/logger.js";
import { embedOllama } from "../search/embed-utils.js";
import type { MemoryRecallFilters, MemoryTier } from "./memory-types.js";
import type { MemoryVectorIndex } from "./memory-vector-index.js";
import { describeError } from "../logging/describe-error.js";

const log = createLogger("memory-embedder");

const COLLECTION = "agent_memory";

/**
 * KPR-241 follow-up: the 6000-char cap that used to live here has been removed.
 * It assumed a ~2048-token Ollama default, but the embedding model's real
 * window is 512 tokens (`bert.context_length`), so the cap was ~4x too large to
 * ever prevent an "input length exceeds the context length" 400. It also only
 * covered `upsert()`, leaving `search()` — which embeds full record content
 * during the burst-similarity check — unguarded, and it silently discarded
 * everything past the cut.
 *
 * `embedOllama` now chunks and mean-pools internally, so it accepts text of any
 * length and no content is dropped. See src/search/embed-utils.ts.
 */

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

export interface EmbedSearchResult {
  mongoId: string;
  score: number;
}

export class MemoryEmbedder implements MemoryVectorIndex {
  private qdrant: QdrantClient | null = null;
  private collectionReady = false;

  constructor(
    private qdrantUrl: string = process.env.QDRANT_URL ?? "http://localhost:6333",
    private ollamaUrl: string = process.env.OLLAMA_URL ?? "http://localhost:11434",
  ) {}

  private getClient(): QdrantClient {
    if (!this.qdrant) {
      this.qdrant = new QdrantClient({ url: this.qdrantUrl });
    }
    return this.qdrant;
  }

  private async embed(text: string): Promise<number[]> {
    return embedOllama(this.ollamaUrl, text);
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const client = this.getClient();
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);

    if (!exists) {
      const testVector = await this.embed("test");
      await client.createCollection(COLLECTION, {
        vectors: { size: testVector.length, distance: "Cosine" },
      });
      log.info("Created Qdrant collection", { collection: COLLECTION, vectorSize: testVector.length });
    }
    this.collectionReady = true;
  }

  async upsert(pointId: string, content: string, payload: QdrantPayload): Promise<void> {
    await this.ensureCollection();
    // No truncation: embedOllama chunks + mean-pools, so the whole record is
    // represented in the vector regardless of length.
    const vector = await this.embed(content);
    await this.getClient().upsert(COLLECTION, {
      points: [{ id: pointId, vector, payload }],
    });
  }

  async remove(pointId: string): Promise<void> {
    await this.ensureCollection();
    await this.getClient().delete(COLLECTION, {
      points: [pointId],
    });
  }

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
    let results;
    try {
      results = await this.getClient().query(COLLECTION, {
        query: { recommend: { positive: [pointId] } },
        filter: {
          must: [{ key: "agentId", match: { value: agentId } }],
        },
        limit,
        with_payload: true,
        score_threshold: threshold,
      });
    } catch (err) {
      // Orphan Mongo record — its qdrantPointId doesn't exist in Qdrant.
      // Treat as no-neighbors rather than aborting the caller's entire pass.
      if (String(err).includes("Not Found") || String(err).includes("does not exists")) {
        log.warn("findSimilar skipped orphan point", { pointId, agentId });
        return [];
      }
      throw err;
    }

    return results.points.map((r) => ({
      mongoId: r.payload?.mongoId as string,
      score: r.score ?? 0,
      pointId: typeof r.id === "string" ? r.id : String(r.id),
    }));
  }

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
      log.warn("setTierPayload failed", { count: pointIds.length, tier, error: describeError(err) });
    }
  }
}
