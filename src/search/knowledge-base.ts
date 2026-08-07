/**
 * Knowledge Base — RAG pipeline for document ingestion + semantic retrieval.
 *
 * Ingests documents (PDF, DOCX, XLSX, TXT, MD, HTML, etc.), chunks them,
 * embeds via Ollama bge-large, and stores in Qdrant for semantic search.
 * Self-contained (follows ConversationIndex pattern) — no engine config deps.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { embedOllama } from "./embed-utils.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = "knowledge_base";

/**
 * Chunk size in characters. ~500 tokens ≈ 2000 chars for English.
 * bge-large context window is 512 tokens — stay within it.
 */
const CHUNK_SIZE = 1800;
/** Overlap between chunks to preserve context at boundaries. */
const CHUNK_OVERLAP = 200;
/** Max content length for embedding (matches MEMORY_EMBED_MAX_CHARS). */
const EMBED_MAX_CHARS = parseInt(process.env.MEMORY_EMBED_MAX_CHARS ?? "6000", 10);

// ── Types ────────────────────────────────────────────────────────────────────

export interface KBDocument {
  /** Unique document ID (UUID) */
  id: string;
  /** Original filename or URL */
  source: string;
  /** Agent who ingested this document */
  agentId: string;
  /** Total chunks created */
  totalChunks: number;
  /** Ingestion timestamp (ISO) */
  ingestedAt: string;
  /** Optional tags for filtering */
  tags: string[];
  /** File size in bytes */
  sizeBytes: number;
}

export interface KBSearchResult {
  /** Source document identifier */
  source: string;
  /** Chunk index within the document */
  chunkIndex: number;
  /** Total chunks in the document */
  totalChunks: number;
  /** The text content of this chunk */
  content: string;
  /** Similarity score */
  score: number;
  /** Agent who ingested the document */
  agentId: string;
  /** Tags on the document */
  tags: string[];
  /** Document ID for reference */
  documentId: string;
}

export interface KBListEntry {
  documentId: string;
  source: string;
  totalChunks: number;
  ingestedAt: string;
  tags: string[];
  sizeBytes: number;
}

// ── Text extraction (inline — follows file-processor patterns) ───────────────

async function extractText(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const mimetype = extToMime(ext);

  // HTML — strip tags
  if (ext === "html" || ext === "htm") {
    const raw = buffer.toString("utf-8");
    return raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Text-based files
  const textExts = new Set(["csv", "tsv", "txt", "text", "md", "markdown", "json", "xml", "yaml", "yml", "log"]);
  if (textExts.has(ext) || mimetype.startsWith("text/")) {
    return buffer.toString("utf-8");
  }

  // PDF
  if (ext === "pdf") {
    const pdfModule = await import("pdf-parse");
    const pdfParse = (pdfModule as any).default ?? pdfModule;
    const result = await pdfParse(buffer);
    return result.text;
  }

  // DOCX
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // XLSX
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
      return `--- Sheet: ${name} ---\n${csv}`;
    }).join("\n\n");
  }

  throw new Error(`Unsupported file type: .${ext}`);
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    xml: "text/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Chunking ─────────────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  index: number;
}

function chunkText(text: string): Chunk[] {
  // Normalize whitespace
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  // If text fits in a single chunk, return as-is
  if (cleaned.length <= CHUNK_SIZE) {
    return [{ text: cleaned, index: 0 }];
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = start + CHUNK_SIZE;

    if (end >= cleaned.length) {
      // Last chunk — take the rest
      chunks.push({ text: cleaned.slice(start).trim(), index: chunks.length });
      break;
    }

    // Try to break at a paragraph boundary first, then sentence, then word
    const slice = cleaned.slice(start, end);
    let breakAt = slice.lastIndexOf("\n\n");
    if (breakAt < CHUNK_SIZE * 0.3) {
      breakAt = slice.lastIndexOf(". ");
      if (breakAt >= 0) breakAt += 1; // include the period
    }
    if (breakAt < CHUNK_SIZE * 0.3) {
      breakAt = slice.lastIndexOf(" ");
    }
    if (breakAt < CHUNK_SIZE * 0.3) {
      breakAt = CHUNK_SIZE; // hard cut
    }

    chunks.push({ text: cleaned.slice(start, start + breakAt).trim(), index: chunks.length });
    start += breakAt - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }

  return chunks.filter((c) => c.text.length > 0);
}

// ── KnowledgeBase class ──────────────────────────────────────────────────────

export class KnowledgeBase {
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
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);

    if (!exists) {
      const testVector = await embedOllama(this.ollamaUrl, "test");
      await client.createCollection(COLLECTION, {
        vectors: { size: testVector.length, distance: "Cosine" },
      });
    }
    this.collectionReady = true;
  }

  /**
   * Ingest a local file into the knowledge base.
   * Extracts text, chunks it, embeds each chunk, stores in Qdrant.
   */
  async ingest(filePath: string, agentId: string, tags: string[] = []): Promise<KBDocument> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const stat = statSync(filePath);
    const text = await extractText(filePath);
    if (!text.trim()) throw new Error(`No text content extracted from: ${filePath}`);

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error(`No chunks created from: ${filePath}`);

    await this.ensureCollection();

    const documentId = crypto.randomUUID();
    const source = basename(filePath);
    const now = new Date().toISOString();
    const client = this.getClient();

    // Embed and upsert chunks in batches of 10
    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const points = await Promise.all(
        batch.map(async (chunk) => {
          const embedText = chunk.text.length > EMBED_MAX_CHARS ? chunk.text.slice(0, EMBED_MAX_CHARS) : chunk.text;
          const vector = await embedOllama(this.ollamaUrl, embedText);
          return {
            id: crypto.randomUUID(),
            vector,
            payload: {
              documentId,
              source,
              agentId,
              chunkIndex: chunk.index,
              totalChunks: chunks.length,
              content: chunk.text,
              tags,
              ingestedAt: now,
              sizeBytes: stat.size,
            },
          };
        }),
      );
      await client.upsert(COLLECTION, { points });
    }

    return {
      id: documentId,
      source,
      agentId,
      totalChunks: chunks.length,
      ingestedAt: now,
      tags,
      sizeBytes: stat.size,
    };
  }

  /**
   * Ingest raw text content (for piped/programmatic input).
   */
  async ingestText(text: string, sourceName: string, agentId: string, tags: string[] = []): Promise<KBDocument> {
    if (!text.trim()) throw new Error("Empty text content");

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("No chunks created from text");

    await this.ensureCollection();

    const documentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const client = this.getClient();

    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const points = await Promise.all(
        batch.map(async (chunk) => {
          const embedText = chunk.text.length > EMBED_MAX_CHARS ? chunk.text.slice(0, EMBED_MAX_CHARS) : chunk.text;
          const vector = await embedOllama(this.ollamaUrl, embedText);
          return {
            id: crypto.randomUUID(),
            vector,
            payload: {
              documentId,
              source: sourceName,
              agentId,
              chunkIndex: chunk.index,
              totalChunks: chunks.length,
              content: chunk.text,
              tags,
              ingestedAt: now,
              sizeBytes: Buffer.byteLength(text, "utf-8"),
            },
          };
        }),
      );
      await client.upsert(COLLECTION, { points });
    }

    return {
      id: documentId,
      source: sourceName,
      agentId,
      totalChunks: chunks.length,
      ingestedAt: now,
      tags,
      sizeBytes: Buffer.byteLength(text, "utf-8"),
    };
  }

  /**
   * Semantic search across the knowledge base.
   */
  async search(
    query: string,
    agentId: string,
    options?: { limit?: number; tags?: string[] },
  ): Promise<KBSearchResult[]> {
    await this.ensureCollection();

    const limit = options?.limit ?? 5;
    const queryVector = await embedOllama(this.ollamaUrl, query);

    const must: any[] = [{ key: "agentId", match: { value: agentId } }];
    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        must.push({ key: "tags", match: { value: tag } });
      }
    }

    const results = await this.getClient().search(COLLECTION, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: { must },
    });

    return results.map((r) => ({
      source: r.payload?.source as string,
      chunkIndex: r.payload?.chunkIndex as number,
      totalChunks: r.payload?.totalChunks as number,
      content: r.payload?.content as string,
      score: r.score,
      agentId: r.payload?.agentId as string,
      tags: (r.payload?.tags as string[]) ?? [],
      documentId: r.payload?.documentId as string,
    }));
  }

  /**
   * List all documents ingested by an agent.
   */
  async list(agentId: string): Promise<KBListEntry[]> {
    await this.ensureCollection();

    // Scroll through all points for this agent, deduplicate by documentId
    const seen = new Map<string, KBListEntry>();
    let offset: string | number | Record<string, unknown> | undefined;

    for (;;) {
      const result = await this.getClient().scroll(COLLECTION, {
        filter: {
          must: [
            { key: "agentId", match: { value: agentId } },
            { key: "chunkIndex", match: { value: 0 } }, // only first chunk per doc
          ],
        },
        limit: 100,
        with_payload: true,
        ...(offset !== undefined ? { offset } : {}),
      });

      for (const point of result.points) {
        const docId = point.payload?.documentId as string;
        if (!seen.has(docId)) {
          seen.set(docId, {
            documentId: docId,
            source: point.payload?.source as string,
            totalChunks: point.payload?.totalChunks as number,
            ingestedAt: point.payload?.ingestedAt as string,
            tags: (point.payload?.tags as string[]) ?? [],
            sizeBytes: point.payload?.sizeBytes as number,
          });
        }
      }

      if (!result.next_page_offset) break;
      offset = result.next_page_offset;
    }

    return [...seen.values()].sort((a, b) => new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime());
  }

  /**
   * Delete a document and all its chunks from the knowledge base.
   */
  async delete(documentId: string, agentId: string): Promise<number> {
    await this.ensureCollection();

    // Delete all points with this documentId (owned by this agent)
    const result = await this.getClient().delete(COLLECTION, {
      filter: {
        must: [
          { key: "documentId", match: { value: documentId } },
          { key: "agentId", match: { value: agentId } },
        ],
      },
    });

    // Qdrant delete doesn't return count easily — return a status indicator
    return typeof result === "object" ? 1 : 0;
  }
}
