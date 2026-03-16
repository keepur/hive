/**
 * Conversation Index — embeds and indexes agent conversations in Qdrant
 * for semantic recall. Self-contained (no search-shared dependency) so it
 * can be imported by both the MCP server and agent-manager without pulling
 * in MongoDB deps.
 */

import { QdrantClient } from "@qdrant/js-client-rest";

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = "conversations";
const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationDocument {
  agentId: string;
  threadId: string;
  channelId: string;
  source: string;
  senderName: string;
  timestampUnix: number;
  timestamp: string;
  inbound: string;
  response: string;
}

export interface ConversationResult {
  agentId: string;
  threadId: string;
  channelId: string;
  source: string;
  senderName: string;
  timestampUnix: number;
  timestamp: string;
  inbound: string;
  response: string;
  score: number;
}

// ── Embedding helper ─────────────────────────────────────────────────────────

async function embedOllama(ollamaUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}

// ── ConversationIndex class ──────────────────────────────────────────────────

export class ConversationIndex {
  private qdrantUrl: string;
  private ollamaUrl: string;
  private qdrant: QdrantClient | null = null;
  private collectionReady = false;

  constructor(qdrantUrl?: string, ollamaUrl?: string) {
    this.qdrantUrl = qdrantUrl ?? process.env.QDRANT_URL ?? "http://localhost:6333";
    this.ollamaUrl = ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  }

  private getClient(): QdrantClient {
    if (!this.qdrant) {
      this.qdrant = new QdrantClient({ url: this.qdrantUrl });
    }
    return this.qdrant;
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;

    const client = this.getClient();

    // Check if collection already exists
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);

    if (!exists) {
      // Get vector size from a test embedding
      const testVector = await embedOllama(this.ollamaUrl, "test");
      const vectorSize = testVector.length;

      await client.createCollection(COLLECTION, {
        vectors: { size: vectorSize, distance: "Cosine" },
      });
    }

    this.collectionReady = true;
  }

  async index(doc: ConversationDocument): Promise<void> {
    await this.ensureCollection();

    const client = this.getClient();
    const text = doc.inbound + "\n\n" + doc.response;
    const vector = await embedOllama(this.ollamaUrl, text);
    const pointId = crypto.randomUUID();

    await client.upsert(COLLECTION, {
      points: [
        {
          id: pointId,
          vector,
          payload: {
            agentId: doc.agentId,
            threadId: doc.threadId,
            channelId: doc.channelId,
            source: doc.source,
            senderName: doc.senderName,
            timestampUnix: doc.timestampUnix,
            timestamp: doc.timestamp,
            inbound: doc.inbound,
            response: doc.response,
          },
        },
      ],
    });
  }

  async search(query: string, agentId: string, limit: number, sinceUnix?: number): Promise<ConversationResult[]> {
    await this.ensureCollection();

    const client = this.getClient();
    const queryVector = await embedOllama(this.ollamaUrl, query);

    const must: any[] = [
      {
        key: "agentId",
        match: { value: agentId },
      },
    ];

    if (sinceUnix !== undefined) {
      must.push({
        key: "timestampUnix",
        range: { gte: sinceUnix },
      });
    }

    const results = await client.search(COLLECTION, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: { must },
    });

    return results.map((r) => ({
      agentId: r.payload?.agentId as string,
      threadId: r.payload?.threadId as string,
      channelId: r.payload?.channelId as string,
      source: r.payload?.source as string,
      senderName: r.payload?.senderName as string,
      timestampUnix: r.payload?.timestampUnix as number,
      timestamp: r.payload?.timestamp as string,
      inbound: r.payload?.inbound as string,
      response: r.payload?.response as string,
      score: r.score,
    }));
  }
}
