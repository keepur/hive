import { QdrantClient } from "@qdrant/js-client-rest";
import { MongoClient } from "mongodb";
import { embedOllama } from "../search/embed-utils.js";
import { CODE_INDEX_COLLECTION } from "./code-index-types.js";

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
              const lines = records.map(
                (r) =>
                  `- ${String((r as Record<string, unknown>).topic ?? "").replace(/^code:/, "")}: ${String((r as Record<string, unknown>).content ?? "")}`,
              );
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

  /** Extract probable file paths from conversation text */
  private extractFilePaths(text: string): string[] {
    const pathRegex =
      /(?:^|\s|`|"|')((src|plugins|dist|docs|scripts|setup|skills|service|agents-templates|test)\/.{1,200}\.(ts|tsx|js|jsx|json|yaml|yml|md))\b/gm;
    const paths = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(text)) !== null) {
      paths.add(match[1]);
    }
    return [...paths];
  }

  /**
   * Get code context for PreCompact hook — two-layer extraction.
   * Layer 1: Regex extract file paths → exact MongoDB lookups (precise, no embedding)
   * Layer 2: Embed conversation tail → Qdrant similarity + code insights (fuzzy)
   * Returns formatted text to append to PreCompact systemMessage, or empty string.
   */
  async getCompactionContext(conversationText: string, agentId?: string): Promise<string> {
    try {
      await this.ensureConnected();
    } catch {
      return "";
    }

    const fileSections: string[] = [];
    const insightSections: string[] = [];
    const seenPaths = new Set<string>();

    // --- Layer 1: Exact file path lookups (no embedding needed) ---
    try {
      const paths = this.extractFilePaths(conversationText);
      if (paths.length > 0) {
        const codeIndexCol = this.mongo.db(this.options.dbName).collection("code_index");
        const records = await codeIndexCol
          .find({ filePath: { $in: paths } })
          .project({ repo: 1, filePath: 1, summary: 1, role: 1 })
          .toArray();

        for (const r of records) {
          const key = `${r.repo}:${r.filePath}`;
          if (!seenPaths.has(key)) {
            seenPaths.add(key);
            fileSections.push(`- ${key} — ${r.summary} [${r.role}]`);
          }
        }
      }
    } catch {
      // MongoDB down — Layer 1 fails, continue to Layer 2
    }

    // --- Layer 2: Semantic similarity search (needs embedding) ---
    try {
      const tail = conversationText.slice(-2000);
      const queryVector = await embedOllama(this.options.ollamaUrl, tail);

      // 2a. Search code index for relevant files
      const codeResults = await this.qdrant.search(CODE_INDEX_COLLECTION, {
        vector: queryVector,
        limit: this.prefetchLimit,
        with_payload: true,
      });

      for (const r of codeResults) {
        if (r.score < this.scoreThreshold) continue;
        const p = r.payload as Record<string, unknown>;
        const key = `${p.repo}:${p.filePath}`;
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          fileSections.push(`- ${key} — ${p.summary} [${p.role}]`);
        }
      }

      // 2b. Search agent memory for code insights
      if (agentId) {
        const memResults = await this.qdrant.search("agent_memory", {
          vector: queryVector,
          limit: 10,
          with_payload: true,
          filter: {
            must: [{ key: "agentId", match: { value: agentId } }],
          },
        });

        const codeMemories = memResults
          .filter((r) => r.score >= this.scoreThreshold)
          .filter((r) => typeof r.payload?.topic === "string" && (r.payload.topic as string).startsWith("code:"));

        if (codeMemories.length > 0) {
          const mongoIds = codeMemories.map((r) => r.payload?.mongoId as string).filter(Boolean);
          if (mongoIds.length > 0) {
            const { ObjectId } = await import("mongodb");
            const memCollection = this.mongo.db(this.options.dbName).collection("agent_memory");
            const records = await memCollection
              .find({ _id: { $in: mongoIds.map((id) => new ObjectId(id)) } })
              .toArray();

            for (const r of records) {
              const topic = String((r as Record<string, unknown>).topic ?? "").replace(/^code:/, "");
              const content = String((r as Record<string, unknown>).content ?? "");
              insightSections.push(`- ${topic}: ${content}`);
            }
          }
        }
      }
    } catch {
      // Ollama/Qdrant down — Layer 2 fails, use whatever Layer 1 found
    }

    if (fileSections.length === 0 && insightSections.length === 0) return "";

    const cappedFiles = fileSections.slice(0, 10);

    const parts: string[] = [];
    if (cappedFiles.length > 0) {
      parts.push(
        "Files actively referenced in this conversation:",
        ...cappedFiles,
        "Preserve references to these files and any decisions made about them.",
      );
    }
    const cappedInsights = insightSections.slice(0, 10);
    if (cappedInsights.length > 0) {
      parts.push(
        "",
        "Code insights from prior sessions:",
        ...cappedInsights,
        "Preserve these insights if relevant to the conversation.",
      );
    }

    return parts.join("\n");
  }

  async close(): Promise<void> {
    if (this.connected) await this.mongo.close();
  }
}
