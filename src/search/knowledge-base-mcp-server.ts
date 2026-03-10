#!/usr/bin/env node
/**
 * Knowledge Base MCP Server — semantic search over synced CRM and operational data.
 *
 * Supports two backends (controlled by KB_BACKEND env var):
 *   - "qdrant" (default): Ollama for embeddings + Qdrant for vector search
 *   - "atlas": Voyage AI for embeddings + MongoDB Atlas $vectorSearch (legacy)
 *
 * Env vars:
 *   KB_BACKEND        — "qdrant" (default) or "atlas"
 *   OLLAMA_URL        — Ollama server URL (default: http://localhost:11434)
 *   QDRANT_URL        — Qdrant server URL (default: http://localhost:6333)
 *   MONGODB_STAGING_URI — Local MongoDB connection string (preferred)
 *   MONGODB_ATLAS_URI   — Atlas cluster connection string (fallback; required for atlas backend)
 *   VOYAGEAI_API_KEY    — Voyage AI API key (required for atlas backend)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MongoClient, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";

const KB_BACKEND = (process.env.KB_BACKEND ?? "qdrant") as "qdrant" | "atlas";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const MONGO_URI = process.env.MONGODB_STAGING_URI ?? process.env.MONGODB_ATLAS_URI ?? "";
const VOYAGE_KEY = process.env.VOYAGEAI_API_KEY ?? "";
const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

if (KB_BACKEND === "atlas" && (!MONGO_URI || !VOYAGE_KEY)) {
  process.stderr.write("knowledge-base: KB_BACKEND=atlas requires MONGODB_ATLAS_URI and VOYAGEAI_API_KEY\n");
  process.exit(1);
}

// ── Lazy MongoDB Connection (atlas backend + stage mappings) ────────────────

let db: Db;
let mongoConnected = false;

async function connectMongo(): Promise<void> {
  if (db) return;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(); // Atlas URI includes the DB name
}

async function ensureMongoConnected(): Promise<void> {
  if (!mongoConnected) {
    await connectMongo();
    await loadStageMappings();
    mongoConnected = true;
  }
}

// ── Qdrant Client (qdrant backend) ──────────────────────────────────────────

let qdrant: QdrantClient;
let qdrantReady = false;

async function ensureQdrantReady(): Promise<void> {
  if (qdrantReady) return;
  qdrant = new QdrantClient({ url: QDRANT_URL });
  // Verify connectivity
  try {
    await qdrant.getCollections();
  } catch (e: any) {
    throw new Error(`Qdrant connection failed at ${QDRANT_URL}: ${e.message}`);
  }
  qdrantReady = true;
}

// ── Backend Init ────────────────────────────────────────────────────────────

let backendReady = false;

async function ensureReady(): Promise<void> {
  if (backendReady) return;
  if (KB_BACKEND === "qdrant") {
    await ensureQdrantReady();
    // Also connect to MongoDB for stage mappings if available
    if (MONGO_URI) {
      try {
        await connectMongo();
        await loadStageMappings();
        mongoConnected = true;
      } catch {
        // Non-fatal — stage lookups will fall through to raw IDs
        process.stderr.write("knowledge-base: MongoDB connection for stage mappings unavailable, using raw IDs\n");
      }
    }
  } else {
    await ensureMongoConnected();
  }
  backendReady = true;
}

// ── Embedding Helpers ───────────────────────────────────────────────────────

async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}

async function embedVoyage(text: string): Promise<number[]> {
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

async function embed(text: string): Promise<number[]> {
  return KB_BACKEND === "qdrant" ? embedOllama(text) : embedVoyage(text);
}

// ── Collection Mapping ──────────────────────────────────────────────────────

const CRM_COLLECTIONS = ["contacts", "deals", "activities"];
const OPS_COLLECTIONS = [
  "persons", "projects", "designs", "quotes",
  "orders", "jobs", "operational_tasks", "parts", "cases",
  "comments", "product_families",
];

interface CollectionInfo {
  name: string;
  type: string;
}

function collectionsForType(objectType: string): CollectionInfo[] {
  if (KB_BACKEND === "atlas") {
    return collectionsForTypeAtlas(objectType);
  }
  return collectionsForTypeQdrant(objectType);
}

function collectionsForTypeQdrant(objectType: string): CollectionInfo[] {
  switch (objectType) {
    case "all":
      return [...CRM_COLLECTIONS, ...OPS_COLLECTIONS].map((c) => ({ name: c, type: c }));
    case "contact":
    case "company":
      return [{ name: "contacts", type: "contact/company" }];
    case "deal":
      return [{ name: "deals", type: "deal" }];
    case "activity":
      return [{ name: "activities", type: "activity" }];
    case "person":
      return [{ name: "persons", type: "person" }];
    case "project":
      return [{ name: "projects", type: "project" }];
    case "design":
      return [{ name: "designs", type: "design" }];
    case "quote":
      return [{ name: "quotes", type: "quote" }];
    case "order":
      return [{ name: "orders", type: "order" }];
    case "job":
      return [{ name: "jobs", type: "job" }];
    case "task":
      return [{ name: "operational_tasks", type: "operational_task" }];
    case "part":
      return [{ name: "parts", type: "part" }];
    case "case":
      return [{ name: "cases", type: "case" }];
    case "comment":
      return [{ name: "comments", type: "comment" }];
    case "product_family":
      return [{ name: "product_families", type: "product_family" }];
    default:
      return CRM_COLLECTIONS.map((c) => ({ name: c, type: c }));
  }
}

function collectionsForTypeAtlas(objectType: string): CollectionInfo[] {
  const collections: CollectionInfo[] = [];
  if (objectType === "all" || objectType === "contact" || objectType === "company") {
    collections.push({ name: "rag_contacts", type: "contact/company" });
  }
  if (objectType === "all" || objectType === "deal") {
    collections.push({ name: "rag_deals", type: "deal" });
  }
  if (objectType === "all" || objectType === "activity") {
    collections.push({ name: "rag_activities", type: "activity" });
  }
  return collections;
}

function collectionForObjectType(objectType: string): string {
  if (KB_BACKEND === "qdrant") {
    switch (objectType) {
      case "contact":
      case "company":
        return "contacts";
      case "deal":
        return "deals";
      case "activity":
        return "activities";
      case "person":
        return "persons";
      case "project":
        return "projects";
      case "design":
        return "designs";
      case "quote":
        return "quotes";
      case "order":
        return "orders";
      case "job":
        return "jobs";
      case "task":
        return "operational_tasks";
      case "part":
        return "parts";
      case "case":
        return "cases";
      case "comment":
        return "comments";
      case "product_family":
        return "product_families";
      default:
        return "contacts";
    }
  }
  // Atlas mapping
  switch (objectType) {
    case "contact":
    case "company":
      return "rag_contacts";
    case "deal":
      return "rag_deals";
    case "activity":
      return "rag_activities";
    default:
      return "rag_contacts";
  }
}

// ── Qdrant Search Helper ────────────────────────────────────────────────────

async function searchQdrant(
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

// ── Pipeline Stage Lookup ────────────────────────────────────────────────────

let stageMap: Map<string, string> | null = null;
let pipelineMap: Map<string, string> | null = null;

async function loadStageMappings(): Promise<void> {
  if (stageMap) return;
  stageMap = new Map();
  pipelineMap = new Map();
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
}

function resolveStage(stageId: string): string {
  return stageMap?.get(stageId) ?? stageId;
}

function resolvePipeline(pipelineId: string): string {
  return pipelineMap?.get(pipelineId) ?? pipelineId;
}

// ── Result Formatting ───────────────────────────────────────────────────────

function enrichEmbeddingText(text: string): string {
  if (!stageMap) return text;
  // Replace raw stage IDs in embedding text (e.g. "Stage: 33086345" → "Stage: Closed won early adopter program")
  return text.replace(/Stage: (\w+)/g, (match, id) => {
    const resolved = resolveStage(id);
    return resolved !== id ? `Stage: ${resolved}` : match;
  });
}

function formatResult(r: any, index: number): string {
  const text = r.embeddingText?.length > 300 ? r.embeddingText.slice(0, 300) + "..." : r.embeddingText;
  const lines = [`${index}. [${r.objectType}] ${enrichEmbeddingText(text)}`];
  lines.push(`   Score: ${r.score.toFixed(3)} | HubSpot ID: ${r.hubspotId ?? "N/A"} | dodi ID: ${r.dodiId ?? "N/A"}`);

  // Atlas backend stores fields under r.properties; Qdrant stores them flat in payload
  if (r.properties) {
    const props = r.properties;
    if (props.email) lines.push(`   Email: ${props.email}`);
    if (props.phone) lines.push(`   Phone: ${props.phone}`);
    if (props.amount) lines.push(`   Amount: $${props.amount}`);
    if (props.dealstage) lines.push(`   Stage: ${resolveStage(props.dealstage)}`);
    if (props.dealname) lines.push(`   Deal: ${props.dealname}`);
    if (props.lifecyclestage) lines.push(`   Lifecycle: ${props.lifecyclestage}`);
    if (props.hs_engagement_type) lines.push(`   Type: ${props.hs_engagement_type}`);
  } else {
    // Qdrant payload fields are at top level
    if (r.email) lines.push(`   Email: ${r.email}`);
    if (r.phone) lines.push(`   Phone: ${r.phone}`);
    if (r.amount) lines.push(`   Amount: $${r.amount}`);
    if (r.dealstage) lines.push(`   Stage: ${resolveStage(r.dealstage)}`);
    if (r.dealname) lines.push(`   Deal: ${r.dealname}`);
    if (r.lifecyclestage) lines.push(`   Lifecycle: ${r.lifecyclestage}`);
    if (r.engagementType) lines.push(`   Type: ${r.engagementType}`);
    if (r.status) lines.push(`   Status: ${r.status}`);
    if (r.total) lines.push(`   Total: $${r.total}`);
    if (r.family) lines.push(`   Family: ${r.family}`);
    if (r.price) lines.push(`   Price: $${r.price}`);
    if (r.author) lines.push(`   Author: ${r.author}`);
    if (r.targetId) lines.push(`   Target: ${r.targetId}`);
    if (r.vendor) lines.push(`   Vendor: ${r.vendor}`);
    if (r.familyType) lines.push(`   Type: ${r.familyType}`);
    if (r.customerName) lines.push(`   Customer: ${r.customerName}`);
    if (r.projectName) lines.push(`   Project: ${r.projectName}`);
  }

  return lines.join("\n");
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "knowledge-base",
  version: "1.0.0",
});

// ── Tool: kb_search ─────────────────────────────────────────────────────────

const objectTypeEnum = z.enum([
  "contact", "company", "deal", "activity",
  "person", "project", "design", "quote",
  "order", "job", "task", "part", "case",
  "comment", "product_family",
  "all",
]);

server.registerTool("kb_search", {
  title: "Knowledge Base Search",
  description:
    "Semantic search across all CRM, design, and production data — contacts, companies, deals, activities, projects, quotes, orders, jobs, parts, and cases. Returns the most relevant records for a natural language query.",
  inputSchema: {
    query: z
      .string()
      .describe(
        "Natural language search query (e.g., 'homeowners in Austin who purchased cabinets', 'deals over $50k closed in 2024')",
      ),
    objectType: objectTypeEnum
      .optional()
      .default("all")
      .describe("Filter by record type. Default: search all types."),
    limit: z.number().optional().default(10).describe("Maximum results to return"),
  },
}, async ({ query, objectType, limit }) => {
  try {
    await ensureReady();
    const queryEmbedding = await embed(query);
    const collections = collectionsForType(objectType);

    if (KB_BACKEND === "qdrant") {
      // Parallel Qdrant searches across all target collections
      const searchPromises = collections.map((col) =>
        searchQdrant(
          col.name,
          queryEmbedding,
          col.name === "deals" ? limit * 3 : limit,
          col.name === "deals" ? { pipeline: "default" } : undefined,
        ).catch((e) => {
          process.stderr.write(`knowledge-base: search failed on ${col.name}: ${e.message}\n`);
          return [] as any[];
        }),
      );
      const resultArrays = await Promise.all(searchPromises);
      const allResults = resultArrays.flat();

      // Sort by score descending, take top N
      allResults.sort((a, b) => b.score - a.score);
      const topResults = allResults.slice(0, limit);

      if (topResults.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const formatted = topResults.map((r, i) => formatResult(r, i + 1)).join("\n\n");
      return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
    }

    // Atlas backend — parallel $vectorSearch
    const searchPromises = collections.map((col) => {
      const fetchLimit = col.name === "rag_deals" ? limit * 3 : limit;
      return db
        .collection(col.name)
        .aggregate([
          {
            $vectorSearch: {
              index: "vector_index",
              path: "embedding",
              queryVector: queryEmbedding,
              numCandidates: fetchLimit * 10,
              limit: fetchLimit,
            },
          },
          // Only show Sales Pipeline deals (pipeline "default"), skip junk pipelines
          ...(col.name === "rag_deals" ? [{ $match: { "properties.pipeline": "default" } }] : []),
          {
            $project: {
              _id: 1,
              dodiId: 1,
              hubspotId: 1,
              objectType: 1,
              embeddingText: 1,
              properties: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ])
        .toArray();
    });
    const resultArrays = await Promise.all(searchPromises);
    const allResults = resultArrays.flat();

    // Sort by score descending, take top N
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, limit);

    if (topResults.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const formatted = topResults.map((r, i) => formatResult(r, i + 1)).join("\n\n");
    return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Tool: kb_find_similar ───────────────────────────────────────────────────

server.registerTool("kb_find_similar", {
  title: "Find Similar Records",
  description:
    "Find records similar to a given record. Uses the source record's embedding to find semantically similar contacts, deals, or activities.",
  inputSchema: {
    hubspotId: z.string().describe("HubSpot ID of the source record"),
    objectType: z
      .enum(["contact", "company", "deal", "activity"])
      .describe("Type of the source record"),
    limit: z.number().optional().default(5).describe("Number of similar records to find"),
  },
}, async ({ hubspotId, objectType, limit }) => {
  try {
    await ensureReady();
    const colName = collectionForObjectType(objectType);

    if (KB_BACKEND === "qdrant") {
      // Fetch source record's embedding from Qdrant via scroll + filter
      const scrollResult = await qdrant.scroll(colName, {
        filter: {
          must: [{ key: "hubspotId", match: { value: hubspotId } }],
        },
        limit: 1,
        with_vector: true,
        with_payload: true,
      });

      if (!scrollResult.points || scrollResult.points.length === 0) {
        return {
          content: [{ type: "text", text: `No ${objectType} found with HubSpot ID ${hubspotId}` }],
        };
      }

      const source = scrollResult.points[0];
      const sourceVector = source.vector as number[];

      if (!sourceVector || !Array.isArray(sourceVector)) {
        return {
          content: [{ type: "text", text: `Record ${hubspotId} has no embedding vector.` }],
        };
      }

      // Search for similar, fetch extra to exclude source
      const results = await searchQdrant(
        colName,
        sourceVector,
        limit + 1,
        colName === "deals" ? { pipeline: "default" } : undefined,
      );

      // Exclude the source record
      const filtered = results
        .filter((r) => r.hubspotId !== hubspotId)
        .slice(0, limit);

      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "No similar records found." }] };
      }

      const sourceLabel = (source.payload as any)?.embeddingText ?? `${objectType} ${hubspotId}`;
      const formatted = filtered.map((r, i) => formatResult(r, i + 1)).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Records similar to "${sourceLabel}":\n\n${formatted}`,
          },
        ],
      };
    }

    // Atlas backend
    const col = db.collection(colName);

    // Find the source record to get its embedding
    const source = await col.findOne({ hubspotId });
    if (!source) {
      return {
        content: [{ type: "text", text: `No ${objectType} found with HubSpot ID ${hubspotId}` }],
      };
    }

    if (!source.embedding || !Array.isArray(source.embedding)) {
      return {
        content: [{ type: "text", text: `Record ${hubspotId} has no embedding vector.` }],
      };
    }

    // Search for similar records using the source embedding, fetch one extra to exclude source
    const similarFetchLimit = colName === "rag_deals" ? (limit + 1) * 3 : limit + 1;
    const results = await col
      .aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: source.embedding,
            numCandidates: similarFetchLimit * 10,
            limit: similarFetchLimit,
          },
        },
        ...(colName === "rag_deals" ? [{ $match: { "properties.pipeline": "default" } }] : []),
        {
          $project: {
            _id: 1,
            dodiId: 1,
            hubspotId: 1,
            objectType: 1,
            embeddingText: 1,
            properties: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();

    // Exclude the source record
    const filtered = results
      .filter((r) => r.hubspotId !== hubspotId)
      .slice(0, limit);

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: "No similar records found." }] };
    }

    const sourceLabel = source.embeddingText ?? `${objectType} ${hubspotId}`;
    const formatted = filtered.map((r, i) => formatResult(r, i + 1)).join("\n\n");
    return {
      content: [
        {
          type: "text",
          text: `Records similar to "${sourceLabel}":\n\n${formatted}`,
        },
      ],
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Tool: kb_timeline ───────────────────────────────────────────────────────

server.registerTool("kb_timeline", {
  title: "Activity Timeline",
  description:
    "Get a chronological activity history for a person or company. Searches activities by name using semantic search and returns them sorted by date.",
  inputSchema: {
    name: z.string().describe("Person or company name to look up"),
    limit: z.number().optional().default(20).describe("Maximum activities to return"),
  },
}, async ({ name, limit }) => {
  try {
    await ensureReady();

    // Use vector search on activities with a name-focused query.
    // The embedding text for activities includes associated record context.
    const queryEmbedding = await embed(`all activities for ${name}`);

    if (KB_BACKEND === "qdrant") {
      const results = await searchQdrant("activities", queryEmbedding, limit);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No activities found for "${name}".` }] };
      }

      // Sort by timestamp chronologically
      results.sort((a, b) => {
        const dateA = a.timestamp ?? a.syncedAt ?? "";
        const dateB = b.timestamp ?? b.syncedAt ?? "";
        return new Date(dateA).getTime() - new Date(dateB).getTime();
      });

      const formatted = results
        .map((r, i) => {
          const type = r.engagementType ?? r.objectType ?? "Activity";
          const date = r.timestamp
            ? new Date(r.timestamp).toISOString().split("T")[0]
            : "unknown date";
          const body = r.embeddingText ?? "(no details)";
          const scoreLine = `   Score: ${r.score.toFixed(3)} | HubSpot ID: ${r.hubspotId ?? "N/A"}`;
          return `${i + 1}. [${date}] ${type}\n   ${body}\n${scoreLine}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Timeline for "${name}" (${results.length} activities):\n\n${formatted}`,
          },
        ],
      };
    }

    // Atlas backend
    const results = await db
      .collection("rag_activities")
      .aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: limit * 10,
            limit: limit,
          },
        },
        {
          $project: {
            _id: 1,
            hubspotId: 1,
            objectType: 1,
            embeddingText: 1,
            properties: 1,
            syncedAt: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No activities found for "${name}".` }] };
    }

    // Sort by timestamp (from properties or syncedAt)
    results.sort((a, b) => {
      const dateA = a.properties?.hs_timestamp ?? a.syncedAt ?? "";
      const dateB = b.properties?.hs_timestamp ?? b.syncedAt ?? "";
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    });

    const formatted = results
      .map((r, i) => {
        const type = r.properties?.hs_engagement_type ?? r.objectType ?? "Activity";
        const date = r.properties?.hs_timestamp
          ? new Date(r.properties.hs_timestamp).toISOString().split("T")[0]
          : "unknown date";
        const body = r.embeddingText ?? "(no details)";
        const scoreLine = `   Score: ${r.score.toFixed(3)} | HubSpot ID: ${r.hubspotId}`;
        return `${i + 1}. [${date}] ${type}\n   ${body}\n${scoreLine}`;
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Timeline for "${name}" (${results.length} activities):\n\n${formatted}`,
        },
      ],
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Tool: kb_stats ──────────────────────────────────────────────────────────

server.registerTool("kb_stats", {
  title: "Data Statistics",
  description:
    "Get pipeline, lifecycle, and record statistics from the knowledge base. Useful for understanding deal pipeline health, contact lifecycle distribution, and activity volume.",
  inputSchema: {
    metric: z
      .enum(["pipeline", "lifecycle", "activity_types", "overview"])
      .optional()
      .default("overview")
      .describe("Type of statistics to return"),
  },
}, async ({ metric }) => {
  try {
    await ensureReady();

    if (KB_BACKEND === "qdrant") {
      return await kbStatsQdrant(metric);
    }
    return await kbStatsAtlas(metric);
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function kbStatsQdrant(metric: string): Promise<ToolResult> {
  if (metric === "overview") {
    // Query point counts from all collections in parallel
    const allCollections = [...CRM_COLLECTIONS, ...OPS_COLLECTIONS];
    const countPromises = allCollections.map(async (name) => {
      try {
        const info = await qdrant.getCollection(name);
        return { name, count: info.points_count ?? 0 };
      } catch {
        return { name, count: 0 };
      }
    });
    const counts = await Promise.all(countPromises);
    const countMap = new Map(counts.map((c) => [c.name, c.count]));

    // For contacts, get breakdown by objectType
    let contactOnly = 0;
    let companyOnly = 0;
    try {
      const contactResult = await qdrant.count("contacts", {
        filter: { must: [{ key: "objectType", match: { value: "contact" } }] },
        exact: true,
      });
      contactOnly = contactResult.count;
      const companyResult = await qdrant.count("contacts", {
        filter: { must: [{ key: "objectType", match: { value: "company" } }] },
        exact: true,
      });
      companyOnly = companyResult.count;
    } catch {
      contactOnly = countMap.get("contacts") ?? 0;
    }

    // Deals: count only sales pipeline
    let dealCount = 0;
    try {
      const dealResult = await qdrant.count("deals", {
        filter: { must: [{ key: "pipeline", match: { value: "default" } }] },
        exact: true,
      });
      dealCount = dealResult.count;
    } catch {
      dealCount = countMap.get("deals") ?? 0;
    }

    const activityCount = countMap.get("activities") ?? 0;

    const lines = [
      "Knowledge Base Overview",
      "=======================",
      "",
      "CRM Data",
      "--------",
      `Contacts:   ${contactOnly.toLocaleString()}`,
      `Companies:  ${companyOnly.toLocaleString()}`,
      `Deals:      ${dealCount.toLocaleString()}`,
      `Activities: ${activityCount.toLocaleString()}`,
    ];

    // Operational data
    const opsLines: string[] = [];
    for (const name of OPS_COLLECTIONS) {
      const count = countMap.get(name) ?? 0;
      if (count > 0) {
        const label = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
        opsLines.push(`${label}: ${count.toLocaleString()}`);
      }
    }
    if (opsLines.length > 0) {
      lines.push("", "Operational Data", "----------------", ...opsLines);
    }

    const totalCrm = contactOnly + companyOnly + dealCount + activityCount;
    const totalOps = OPS_COLLECTIONS.reduce((sum, n) => sum + (countMap.get(n) ?? 0), 0);

    lines.push(
      "",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `Total records: ${(totalCrm + totalOps).toLocaleString()}`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (metric === "pipeline" || metric === "lifecycle" || metric === "activity_types") {
    // For aggregation metrics, fall back to MongoDB if available
    if (MONGO_URI && mongoConnected) {
      return await kbStatsAtlas(metric);
    }
    return {
      content: [
        {
          type: "text",
          text: `The "${metric}" metric requires MongoDB for aggregation. Set MONGODB_ATLAS_URI to enable this.`,
        },
      ],
    };
  }

  return { content: [{ type: "text", text: `Unknown metric: ${metric}` }], isError: true };
}

async function kbStatsAtlas(metric: string): Promise<ToolResult> {
  if (metric === "overview") {
    const [contactCount, dealCount, activityCount] = await Promise.all([
      db.collection("rag_contacts").countDocuments(),
      db.collection("rag_deals").countDocuments({ "properties.pipeline": "default" }),
      db.collection("rag_activities").countDocuments(),
    ]);

    // Break down contacts vs companies
    const [contactOnly, companyOnly] = await Promise.all([
      db.collection("rag_contacts").countDocuments({ objectType: "contact" }),
      db.collection("rag_contacts").countDocuments({ objectType: "company" }),
    ]);

    const lines = [
      "Knowledge Base Overview",
      "=======================",
      `Contacts:   ${contactOnly.toLocaleString()}`,
      `Companies:  ${companyOnly.toLocaleString()}`,
      `Deals:      ${dealCount.toLocaleString()}`,
      `Activities: ${activityCount.toLocaleString()}`,
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      `Total records: ${(contactCount + dealCount + activityCount).toLocaleString()}`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (metric === "pipeline") {
    const pipeline = await db
      .collection("rag_deals")
      .aggregate([
        { $match: { "properties.pipeline": "default" } },
        {
          $group: {
            _id: "$properties.dealstage",
            count: { $sum: 1 },
            totalAmount: {
              $sum: { $toDouble: { $ifNull: ["$properties.amount", "0"] } },
            },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();

    if (pipeline.length === 0) {
      return { content: [{ type: "text", text: "No deal pipeline data found." }] };
    }

    const lines = ["Deal Pipeline", "============="];
    for (const stage of pipeline) {
      const stageName = stage._id ? resolveStage(stage._id) : "Unknown";
      const amount = stage.totalAmount
        ? ` | Total: $${stage.totalAmount.toLocaleString()}`
        : "";
      lines.push(`${stageName}: ${stage.count} deals${amount}`);
    }

    const totalDeals = pipeline.reduce((sum, s) => sum + s.count, 0);
    const totalAmount = pipeline.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
    lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    lines.push(
      `Total: ${totalDeals} deals | $${totalAmount.toLocaleString()}`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (metric === "lifecycle") {
    const lifecycle = await db
      .collection("rag_contacts")
      .aggregate([
        { $match: { objectType: "contact" } },
        {
          $group: {
            _id: "$properties.lifecyclestage",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();

    if (lifecycle.length === 0) {
      return { content: [{ type: "text", text: "No lifecycle data found." }] };
    }

    const lines = ["Contact Lifecycle Stages", "========================"];
    for (const stage of lifecycle) {
      lines.push(`${stage._id || "Unknown"}: ${stage.count}`);
    }

    const total = lifecycle.reduce((sum, s) => sum + s.count, 0);
    lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    lines.push(`Total contacts: ${total}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (metric === "activity_types") {
    const types = await db
      .collection("rag_activities")
      .aggregate([
        {
          $group: {
            _id: "$properties.hs_engagement_type",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();

    if (types.length === 0) {
      return { content: [{ type: "text", text: "No activity type data found." }] };
    }

    const lines = ["Activity Types", "=============="];
    for (const t of types) {
      lines.push(`${t._id || "Unknown"}: ${t.count}`);
    }

    const total = types.reduce((sum, t) => sum + t.count, 0);
    lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    lines.push(`Total activities: ${total}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return { content: [{ type: "text", text: `Unknown metric: ${metric}` }], isError: true };
}

// ── Connect and run ─────────────────────────────────────────────────────────

process.stderr.write(`knowledge-base: starting with backend=${KB_BACKEND}\n`);
const transport = new StdioServerTransport();
await server.connect(transport);
