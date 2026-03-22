import { QdrantClient } from "@qdrant/js-client-rest";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecallFilters } from "./memory-types.js";

const log = createLogger("memory-embedder");

const COLLECTION = "agent_memory";
const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

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
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.embeddings[0];
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
}
