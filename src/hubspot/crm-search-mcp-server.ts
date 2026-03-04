#!/usr/bin/env node
/**
 * CRM Search MCP Server — semantic search over synced HubSpot data in MongoDB Atlas.
 *
 * Queries Atlas vector indexes for contacts, companies, deals, and activities
 * that were extracted and embedded by hubspot-sync.ts. No HubSpot API calls at runtime.
 *
 * Env vars:
 *   MONGODB_ATLAS_URI — Atlas cluster connection string
 *   VOYAGEAI_API_KEY  — Voyage AI API key for query embedding
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MongoClient, type Db } from "mongodb";
import { z } from "zod";

const ATLAS_URI = process.env.MONGODB_ATLAS_URI ?? "";
const VOYAGE_KEY = process.env.VOYAGEAI_API_KEY ?? "";

if (!ATLAS_URI || !VOYAGE_KEY) {
  process.stderr.write("crm-search: MONGODB_ATLAS_URI and VOYAGEAI_API_KEY required\n");
  process.exit(1);
}

// ── Lazy MongoDB Connection ─────────────────────────────────────────────────

let db: Db;
let connected = false;

async function connect(): Promise<void> {
  if (db) return;
  const client = new MongoClient(ATLAS_URI);
  await client.connect();
  db = client.db(); // Atlas URI includes the DB name
}

async function ensureConnected(): Promise<void> {
  if (!connected) {
    await connect();
    await loadStageMappings();
    connected = true;
  }
}

// ── Voyage AI Embedding Helper ──────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
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

// ── Collection Mapping ──────────────────────────────────────────────────────

interface CollectionInfo {
  name: string;
  type: string;
}

function collectionsForType(objectType: string): CollectionInfo[] {
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
  const lines = [`${index}. [${r.objectType}] ${enrichEmbeddingText(r.embeddingText)}`];
  lines.push(`   Score: ${r.score.toFixed(3)} | HubSpot ID: ${r.hubspotId} | dodi ID: ${r.dodiId ?? "N/A"}`);

  if (r.properties) {
    const props = r.properties;
    if (props.email) lines.push(`   Email: ${props.email}`);
    if (props.phone) lines.push(`   Phone: ${props.phone}`);
    if (props.amount) lines.push(`   Amount: $${props.amount}`);
    if (props.dealstage) lines.push(`   Stage: ${resolveStage(props.dealstage)}`);
    if (props.dealname) lines.push(`   Deal: ${props.dealname}`);
    if (props.lifecyclestage) lines.push(`   Lifecycle: ${props.lifecyclestage}`);
    if (props.hs_engagement_type) lines.push(`   Type: ${props.hs_engagement_type}`);
  }

  return lines.join("\n");
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "crm-search",
  version: "1.0.0",
});

// ── Tool: crm_search ────────────────────────────────────────────────────────

server.registerTool("crm_search", {
  title: "CRM Search",
  description:
    "Search CRM data (contacts, companies, deals, activities) using natural language. Returns the most relevant records with full context from 5 years of customer history.",
  inputSchema: {
    query: z
      .string()
      .describe(
        "Natural language search query (e.g., 'homeowners in Austin who purchased cabinets', 'deals over $50k closed in 2024')",
      ),
    objectType: z
      .enum(["contact", "company", "deal", "activity", "all"])
      .optional()
      .default("all")
      .describe("Filter by record type. Default: search all types."),
    limit: z.number().optional().default(10).describe("Maximum results to return"),
  },
}, async ({ query, objectType, limit }) => {
  try {
    await ensureConnected();
    const queryEmbedding = await embed(query);

    const collections = collectionsForType(objectType);

    // Run $vectorSearch on each collection
    const allResults: any[] = [];
    for (const col of collections) {
      const results = await db
        .collection(col.name)
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
      allResults.push(...results);
    }

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

// ── Tool: crm_find_similar ──────────────────────────────────────────────────

server.registerTool("crm_find_similar", {
  title: "Find Similar Records",
  description:
    "Find CRM records similar to a given record. Uses the source record's embedding to find semantically similar contacts, deals, or activities.",
  inputSchema: {
    hubspotId: z.string().describe("HubSpot ID of the source record"),
    objectType: z
      .enum(["contact", "company", "deal", "activity"])
      .describe("Type of the source record"),
    limit: z.number().optional().default(5).describe("Number of similar records to find"),
  },
}, async ({ hubspotId, objectType, limit }) => {
  try {
    await ensureConnected();

    const colName = collectionForObjectType(objectType);
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
    const results = await col
      .aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: source.embedding,
            numCandidates: (limit + 1) * 10,
            limit: limit + 1,
          },
        },
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

// ── Tool: crm_timeline ──────────────────────────────────────────────────────

server.registerTool("crm_timeline", {
  title: "CRM Timeline",
  description:
    "Get a chronological activity history for a person or company. Searches activities by name using semantic search and returns them sorted by date.",
  inputSchema: {
    name: z.string().describe("Person or company name to look up"),
    limit: z.number().optional().default(20).describe("Maximum activities to return"),
  },
}, async ({ name, limit }) => {
  try {
    await ensureConnected();

    // Use vector search on rag_activities with a name-focused query.
    // The embedding text for activities includes associated record context.
    const queryEmbedding = await embed(`all activities for ${name}`);

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

// ── Tool: crm_stats ─────────────────────────────────────────────────────────

server.registerTool("crm_stats", {
  title: "CRM Statistics",
  description:
    "Get pipeline, lifecycle, and record statistics from the CRM data. Useful for understanding deal pipeline health, contact lifecycle distribution, and activity volume.",
  inputSchema: {
    metric: z
      .enum(["pipeline", "lifecycle", "activity_types", "overview"])
      .optional()
      .default("overview")
      .describe("Type of statistics to return"),
  },
}, async ({ metric }) => {
  try {
    await ensureConnected();

    if (metric === "overview") {
      const [contactCount, dealCount, activityCount] = await Promise.all([
        db.collection("rag_contacts").countDocuments(),
        db.collection("rag_deals").countDocuments(),
        db.collection("rag_activities").countDocuments(),
      ]);

      // Break down contacts vs companies
      const [contactOnly, companyOnly] = await Promise.all([
        db.collection("rag_contacts").countDocuments({ objectType: "contact" }),
        db.collection("rag_contacts").countDocuments({ objectType: "company" }),
      ]);

      const lines = [
        "CRM Overview",
        "============",
        `Contacts:   ${contactOnly.toLocaleString()}`,
        `Companies:  ${companyOnly.toLocaleString()}`,
        `Deals:      ${dealCount.toLocaleString()}`,
        `Activities: ${activityCount.toLocaleString()}`,
        `─────────────────────`,
        `Total records: ${(contactCount + dealCount + activityCount).toLocaleString()}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (metric === "pipeline") {
      const pipeline = await db
        .collection("rag_deals")
        .aggregate([
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
      lines.push("─────────────────────");
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
      lines.push("─────────────────────");
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
      lines.push("─────────────────────");
      lines.push(`Total activities: ${total}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    return { content: [{ type: "text", text: `Unknown metric: ${metric}` }], isError: true };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Connect and run ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
