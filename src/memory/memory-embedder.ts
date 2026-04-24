import { QdrantClient } from "@qdrant/js-client-rest";
import { createLogger } from "../logging/logger.js";
import { embedOllama } from "../search/embed-utils.js";
import type { MemoryRecallFilters } from "./memory-types.js";

const log = createLogger("memory-embedder");

const COLLECTION = "agent_memory";

interface QdrantPayload {
  [key: string]: unknown;
  agentId: string;
  mongoId: string;
  type: string;
  topic: string;
  tier: string;
  importance: string;
  createdAt: number;
}

export interface EmbedSearchResult {
  mongoId: string;
  score: number;
}

export class MemoryEmbedder {
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

  async search(query: string, agentId: string, filters?: MemoryRecallFilters): Promise<EmbedSearchResult[]> {
    await this.ensureCollection();
    const queryVector = await this.embed(query);
    const limit = filters?.limit ?? 10;

    const must: any[] = [{ key: "agentId", match: { value: agentId } }];
    if (filters?.type) must.push({ key: "type", match: { value: filters.type } });
    if (filters?.topic) must.push({ key: "topic", match: { value: filters.topic } });
    if (filters?.tier) must.push({ key: "tier", match: { value: filters.tier } });
    if (filters?.importance) must.push({ key: "importance", match: { value: filters.importance } });

    const results = await this.getClient().search(COLLECTION, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: { must },
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
}
