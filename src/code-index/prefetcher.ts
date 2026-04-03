import { QdrantClient } from "@qdrant/js-client-rest";
import { MongoClient, type Collection } from "mongodb";
import { embedOllama } from "../search/embed-utils.js";
import { CODE_INDEX_COLLECTION, type CodeIndexRecord } from "./code-index-types.js";

export interface PrefetcherOptions {
  mongoUri: string;
  dbName: string;
  qdrantUrl: string;
  ollamaUrl: string;
  scoreThreshold?: number;
  prefetchLimit?: number;
}

export class CodeIndexPrefetcher {
  private mongo!: MongoClient;
  private collection!: Collection<CodeIndexRecord>;
  private qdrant!: QdrantClient;
  private connected = false;
  private scoreThreshold: number;
  private prefetchLimit: number;

  constructor(private options: PrefetcherOptions) {
    this.scoreThreshold = options.scoreThreshold ?? 0.65;
    this.prefetchLimit = options.prefetchLimit ?? 8;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    this.mongo = new MongoClient(this.options.mongoUri);
    await this.mongo.connect();
    this.collection = this.mongo.db(this.options.dbName).collection<CodeIndexRecord>("code_index");
    this.qdrant = new QdrantClient({ url: this.options.qdrantUrl });
    this.connected = true;
  }

  /**
   * Get pre-fetched codebase context for a code_task prompt.
   * Returns a markdown block to prepend, or empty string if nothing relevant.
   */
  async getContext(prompt: string, agentId?: string): Promise<string> {
    try {
      await this.ensureConnected();
    } catch (err) {
      // Degrade gracefully — don't block task spawn
      return "";
    }

    const sections: string[] = [];

    // Embed prompt once — reuse for both searches
    let queryVector: number[];
    try {
      queryVector = await embedOllama(this.options.ollamaUrl, prompt);
    } catch {
      return ""; // Ollama down — skip entirely
    }

    // 1. Query code index
    try {
      const codeResults = await this.qdrant.search(CODE_INDEX_COLLECTION, {
        vector: queryVector,
        limit: this.prefetchLimit,
        with_payload: true,
      });

      const relevant = codeResults.filter((r) => r.score >= this.scoreThreshold);
      if (relevant.length > 0) {
        const lines = relevant.map((r) => {
          const p = r.payload as Record<string, unknown>;
          return `- **${p.repo}:${p.filePath}** — ${p.summary} (${p.role})`;
        });
        sections.push("**Relevant files:**\n" + lines.join("\n"));
      }
    } catch {
      // Qdrant/Ollama down — skip code index
    }

    // 2. Query agent memory for code knowledge
    // Note: Qdrant doesn't support prefix matching on payload fields without a text index.
    // We filter by agentId in Qdrant and post-filter by topic prefix in application code.
    if (agentId) {
      try {
        const memResults = await this.qdrant.search("agent_memory", {
          vector: queryVector,
          limit: 15, // fetch extra to account for post-filter
          with_payload: true,
          filter: {
            must: [{ key: "agentId", match: { value: agentId } }],
          },
        });

        const relevant = memResults
          .filter((r) => r.score >= this.scoreThreshold)
          .filter((r) => typeof r.payload?.topic === "string" && (r.payload.topic as string).startsWith("code:"));
        if (relevant.length > 0) {
          // Fetch full content from MongoDB
          const mongoIds = relevant.map((r) => r.payload?.mongoId as string).filter(Boolean);
          if (mongoIds.length > 0) {
            const memCollection = this.mongo.db(this.options.dbName).collection("agent_memory");
            const { ObjectId } = await import("mongodb");
            const records = await memCollection
              .find({ _id: { $in: mongoIds.map((id) => new ObjectId(id)) } })
              .toArray();

            if (records.length > 0) {
              const lines = records.map((r: any) => `- ${r.topic.replace(/^code:/, "")}: ${r.content}`);
              sections.push("**Previous session insights:**\n" + lines.join("\n"));
            }
          }
        }
      } catch {
        // Memory search failed — skip
      }
    }

    if (sections.length === 0) return "";

    return [
      "## Codebase Context (auto-retrieved)",
      ...sections,
      "",
      "_Results may be stale — verify by reading files._",
    ].join("\n");
  }

  async close(): Promise<void> {
    if (this.connected) await this.mongo.close();
  }
}
