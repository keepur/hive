/**
 * Shared utilities for domain-specific search MCP servers.
 *
 * Extracted from knowledge-base-mcp-server.ts to provide reusable
 * infrastructure: backend initialization, embedding, Qdrant search,
 * stage resolution, and result formatting.
 */

import { MongoClient, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Env var constants ────────────────────────────────────────────────────────

export const KB_BACKEND = (process.env.KB_BACKEND ?? "qdrant") as "qdrant" | "atlas";
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
export const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";
export const MONGO_URI = process.env.MONGODB_STAGING_URI ?? process.env.MONGODB_ATLAS_URI ?? "";
export const VOYAGE_KEY = process.env.VOYAGEAI_API_KEY ?? "";

// ── ToolResult type ──────────────────────────────────────────────────────────

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// ── SearchBackend interface and factory ───────────────────────────────────────

export interface SearchBackend {
  qdrant: QdrantClient;
  db: Db | null;
  stageMap: Map<string, string>;
  pipelineMap: Map<string, string>;
  backend: "qdrant" | "atlas";
}

export async function createSearchBackend(opts?: { requireAtlas?: boolean }): Promise<SearchBackend> {
  const stageMap = new Map<string, string>();
  const pipelineMap = new Map<string, string>();
  let qdrant: QdrantClient;
  let db: Db | null = null;

  // Initialize Qdrant client and verify connectivity (unless atlas-only)
  if (KB_BACKEND === "qdrant") {
    qdrant = new QdrantClient({ url: QDRANT_URL });
    try {
      await qdrant.getCollections();
    } catch (e: any) {
      throw new Error(`Qdrant connection failed at ${QDRANT_URL}: ${e.message}`);
    }
  } else {
    // Atlas backend still needs a QdrantClient instance (unused but satisfies the interface)
    qdrant = new QdrantClient({ url: QDRANT_URL });
  }

  // Connect to MongoDB if URI is available
  if (MONGO_URI) {
    try {
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db();

      // Load stage mappings from staging_pipelines collection
      try {
        const pipelines = await db.collection("staging_pipelines").find({}).toArray();
        for (const p of pipelines) {
          pipelineMap.set(p.id, p.label);
          for (const s of p.stages ?? []) {
            stageMap.set(s.id, s.label);
          }
        }
      } catch {
        // Non-fatal — fall through to raw IDs
      }
    } catch {
      if (opts?.requireAtlas) {
        throw new Error("MongoDB connection required but failed. Check MONGODB_STAGING_URI or MONGODB_ATLAS_URI.");
      }
      process.stderr.write("search-shared: MongoDB connection for stage mappings unavailable, using raw IDs\n");
    }
  } else if (opts?.requireAtlas) {
    throw new Error("MongoDB URI required but not configured. Set MONGODB_STAGING_URI or MONGODB_ATLAS_URI.");
  }

  return { qdrant, db, stageMap, pipelineMap, backend: KB_BACKEND };
}

// ── Embedding functions ──────────────────────────────────────────────────────

export async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}

export async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "voyage-4-lite", input: [text], input_type: "query" }),
  });
  if (!res.ok) throw new Error(`Voyage AI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

export async function embed(text: string): Promise<number[]> {
  return KB_BACKEND === "qdrant" ? embedOllama(text) : embedVoyage(text);
}

// ── Qdrant search helper ─────────────────────────────────────────────────────

export async function searchQdrant(
  qdrant: QdrantClient,
  collection: string,
  queryVector: number[],
  limit: number,
  filters?: Record<string, any>,
): Promise<any[]> {
  const filter = filters
    ? {
        must: Object.entries(filters).map(([key, value]) => ({
          key,
          match: { value },
        })),
      }
    : undefined;

  const results = await qdrant.search(collection, {
    vector: queryVector,
    limit,
    with_payload: true,
    filter,
  });

  return results.map((r) => ({
    ...r.payload,
    score: r.score,
  }));
}

// ── Stage resolution ─────────────────────────────────────────────────────────

export function resolveStage(stageMap: Map<string, string>, stageId: string): string {
  return stageMap.get(stageId) ?? stageId;
}

export function resolvePipeline(pipelineMap: Map<string, string>, pipelineId: string): string {
  return pipelineMap.get(pipelineId) ?? pipelineId;
}

export function enrichEmbeddingText(stageMap: Map<string, string>, text: string): string {
  if (stageMap.size === 0) return text;
  return text.replace(/Stage: (\w+)/g, (match, id) => {
    const resolved = resolveStage(stageMap, id);
    return resolved !== id ? `Stage: ${resolved}` : match;
  });
}

// ── Result formatting ────────────────────────────────────────────────────────

export interface FieldDef {
  key: string;
  label: string;
  prefix?: string; // e.g. "$"
  resolve?: "stage"; // apply resolveStage
}

export interface FieldConfig {
  idFields: { hubspotId?: boolean; dodiId?: boolean };
  displayFields: FieldDef[];
  stageMap?: Map<string, string>;
}

export function formatResult(r: any, index: number, config: FieldConfig): string {
  const rawText = r.embeddingText ?? "";
  const text = rawText.length > 300 ? rawText.slice(0, 300) + "..." : rawText;
  const stageMap = config.stageMap ?? new Map<string, string>();

  const lines = [`${index}. [${r.objectType}] ${enrichEmbeddingText(stageMap, text)}`];

  // Score line with IDs
  const idParts: string[] = [];
  if (config.idFields.hubspotId) idParts.push(`HubSpot ID: ${r.hubspotId ?? "N/A"}`);
  if (config.idFields.dodiId) idParts.push(`dodi ID: ${r.dodiId ?? "N/A"}`);
  const idStr = idParts.length > 0 ? ` | ${idParts.join(" | ")}` : "";
  lines.push(`   Score: ${r.score.toFixed(3)}${idStr}`);

  // Display fields
  for (const field of config.displayFields) {
    // Atlas backend: check r.properties[key] first, then fall back to r[key]
    const value = r.properties?.[field.key] ?? r[field.key];
    if (value != null && value !== "") {
      const prefix = field.prefix ?? "";
      const displayValue = field.resolve === "stage" ? resolveStage(stageMap, String(value)) : `${prefix}${value}`;
      lines.push(`   ${field.label}: ${field.resolve === "stage" ? displayValue : displayValue}`);
    }
  }

  return lines.join("\n");
}
