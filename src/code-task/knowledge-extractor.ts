import Anthropic from "@anthropic-ai/sdk";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryEmbedder } from "../memory/memory-embedder.js";
import type { MemoryRecordInput } from "../memory/memory-types.js";
import type { ClaudeCodeOutput } from "./output-parser.js";

interface ExtractedInsight {
  filePath: string;
  repo: string;
  insight: string;
  wasModified: boolean;
}

export class KnowledgeExtractor {
  private anthropic: Anthropic;

  constructor(
    private memoryStore: MemoryStore,
    private memoryEmbedder: MemoryEmbedder,
  ) {
    this.anthropic = new Anthropic();
  }

  /**
   * Extract code insights from a completed code_task output and save to memory.
   * Fire-and-forget safe — logs errors, never throws.
   */
  async extract(agentId: string, output: ClaudeCodeOutput | null): Promise<number> {
    if (!output?.result) return 0;

    // Truncate very long outputs to stay within Haiku context
    const resultText = output.result.length > 30000 ? output.result.slice(0, 30000) + "\n[...truncated]" : output.result;

    const response = await this.anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Extract code insights from this completed coding session. For each source file the session read or modified, note:
- filePath: the relative file path
- repo: which repo (hive or dodi_v2), infer from the working directory or file paths
- insight: what was learned — what the file does, key patterns, gotchas, architectural decisions. Be specific and useful for a future session working on the same code.
- wasModified: true if the file was created or edited, false if only read

Return a JSON array. Only include files where the session gained meaningful understanding — skip trivial reads (package.json, tsconfig, etc). Only JSON, no other text.

Session output:
${resultText}`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    let insights: ExtractedInsight[];
    try {
      insights = JSON.parse(jsonMatch[0]);
    } catch {
      return 0;
    }

    let saved = 0;
    for (const insight of insights) {
      if (!insight.filePath || !insight.insight) continue;

      const topic = `code:${insight.repo ?? "unknown"}:${insight.filePath}`;

      try {
        // Delete-before-save: find prior records FIRST, then clean up Qdrant, then delete from MongoDB
        const memCollection = this.memoryStore.getCollection();
        const priorRecords = await memCollection.find({ agentId, topic, pinned: { $ne: true } }).toArray();

        // Remove their Qdrant vectors before deleting from MongoDB
        for (const rec of priorRecords) {
          if (rec.qdrantPointId) {
            await this.memoryEmbedder.remove(rec.qdrantPointId).catch(() => {});
          }
        }

        // Now delete from MongoDB
        if (priorRecords.length > 0) {
          await memCollection.deleteMany({ _id: { $in: priorRecords.map((r) => r._id!) } });
        }

        // Save new record
        const input: MemoryRecordInput = {
          content: insight.insight,
          type: "fact",
          topic,
          importance: insight.wasModified ? "high" : "medium",
        };

        const pointId = crypto.randomUUID();
        const record = await this.memoryStore.save(agentId, input, pointId);

        // Embed
        await this.memoryEmbedder.upsert(pointId, insight.insight, {
          agentId,
          mongoId: record._id!.toString(),
          type: "fact",
          topic,
          tier: "hot",
          importance: input.importance,
          createdAt: Date.now(),
        });

        saved++;
      } catch (err) {
        console.error(`Knowledge extractor: failed to save insight for ${topic}:`, err);
      }
    }

    return saved;
  }
}
