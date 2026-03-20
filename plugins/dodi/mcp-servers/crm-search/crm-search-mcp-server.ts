#!/usr/bin/env node
/**
 * CRM Search MCP Server — semantic search over CRM/business data.
 *
 * Domain: contacts, companies, deals, activities
 *
 * Supports two backends (controlled by KB_BACKEND env var):
 *   - "qdrant" (default): Ollama for embeddings + Qdrant for vector search
 *   - "atlas": Voyage AI for embeddings + MongoDB Atlas $vectorSearch
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSearchBackend,
  embed,
  searchQdrant,
  formatResult,
  enrichEmbeddingText,
  resolveStage,
  KB_BACKEND,
  MONGO_URI,
  type SearchBackend,
  type FieldConfig,
  type ToolResult,
} from "../search-shared.js";

const server = new McpServer({ name: "crm-search", version: "1.0.0" });

// ── Lazy Backend Init ────────────────────────────────────────────────────────

let backend: SearchBackend;
async function ensureReady() {
  if (!backend) backend = await createSearchBackend({ requireAtlas: KB_BACKEND === "atlas" });
}

// ── Field Configuration ──────────────────────────────────────────────────────

const CRM_FIELDS: FieldConfig = {
  idFields: { hubspotId: true, dodiId: true },
  displayFields: [
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "amount", label: "Amount", prefix: "$" },
    { key: "dealstage", label: "Stage", resolve: "stage" },
    { key: "dealname", label: "Deal" },
    { key: "lifecyclestage", label: "Lifecycle" },
    { key: "engagementType", label: "Type" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
  ],
};

// ── Collection Mapping ───────────────────────────────────────────────────────

interface CollectionInfo {
  name: string;
  type: string;
}

function collectionsForType(objectType: string): CollectionInfo[] {
  if (KB_BACKEND === "qdrant") {
    switch (objectType) {
      case "all":
        return [
          { name: "contacts", type: "contact/company" },
          { name: "deals", type: "deal" },
          { name: "activities", type: "activity" },
        ];
      case "contact":
      case "company":
        return [{ name: "contacts", type: "contact/company" }];
      case "deal":
        return [{ name: "deals", type: "deal" }];
      case "activity":
        return [{ name: "activities", type: "activity" }];
      default:
        return [
          { name: "contacts", type: "contact/company" },
          { name: "deals", type: "deal" },
          { name: "activities", type: "activity" },
        ];
    }
  }

  // Atlas mapping
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

// ── Tool: crm_search ─────────────────────────────────────────────────────────

server.registerTool(
  "crm_search",
  {
    title: "CRM Search",
    description:
      "Semantic search across CRM data — contacts, companies, deals, and activities. Returns the most relevant records for a natural language query.",
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
  },
  async ({ query, objectType, limit }) => {
    try {
      await ensureReady();
      const queryEmbedding = await embed(query);
      const collections = collectionsForType(objectType);

      if (KB_BACKEND === "qdrant") {
        // Parallel Qdrant searches across all target collections
        const searchPromises = collections.map((col) =>
          searchQdrant(
            backend.qdrant,
            col.name,
            queryEmbedding,
            col.name === "deals" ? limit * 3 : limit,
            col.name === "deals" ? { pipeline: "default" } : undefined,
          ).catch((e) => {
            process.stderr.write(`crm-search: search failed on ${col.name}: ${e.message}\n`);
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

        const formatted = topResults
          .map((r, i) => formatResult(r, i + 1, { ...CRM_FIELDS, stageMap: backend.stageMap }))
          .join("\n\n");
        return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
      }

      // Atlas backend — parallel $vectorSearch
      const db = backend.db!;
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

      const formatted = topResults
        .map((r, i) => formatResult(r, i + 1, { ...CRM_FIELDS, stageMap: backend.stageMap }))
        .join("\n\n");
      return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: crm_find_similar ───────────────────────────────────────────────────

server.registerTool(
  "crm_find_similar",
  {
    title: "Find Similar CRM Records",
    description:
      "Find records similar to a given HubSpot record. Uses the source record's embedding to find semantically similar contacts, deals, or activities.",
    inputSchema: {
      hubspotId: z.string().describe("HubSpot ID of the source record"),
      objectType: z.enum(["contact", "company", "deal", "activity"]).describe("Type of the source record"),
      limit: z.number().optional().default(5).describe("Number of similar records to find"),
    },
  },
  async ({ hubspotId, objectType, limit }) => {
    try {
      await ensureReady();
      const colName = collectionForObjectType(objectType);

      if (KB_BACKEND === "qdrant") {
        // Fetch source record's embedding from Qdrant via scroll + filter
        const scrollResult = await backend.qdrant.scroll(colName, {
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
          backend.qdrant,
          colName,
          sourceVector,
          limit + 1,
          colName === "deals" ? { pipeline: "default" } : undefined,
        );

        // Exclude the source record
        const filtered = results.filter((r) => r.hubspotId !== hubspotId).slice(0, limit);

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: "No similar records found." }] };
        }

        const sourceLabel = (source.payload as any)?.embeddingText ?? `${objectType} ${hubspotId}`;
        const formatted = filtered
          .map((r, i) => formatResult(r, i + 1, { ...CRM_FIELDS, stageMap: backend.stageMap }))
          .join("\n\n");
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
      const db = backend.db!;
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
      const filtered = results.filter((r) => r.hubspotId !== hubspotId).slice(0, limit);

      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "No similar records found." }] };
      }

      const sourceLabel = source.embeddingText ?? `${objectType} ${hubspotId}`;
      const formatted = filtered
        .map((r, i) => formatResult(r, i + 1, { ...CRM_FIELDS, stageMap: backend.stageMap }))
        .join("\n\n");
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
  },
);

// ── Tool: crm_timeline ───────────────────────────────────────────────────────

server.registerTool(
  "crm_timeline",
  {
    title: "CRM Activity Timeline",
    description:
      "Get a chronological activity history for a person or company. Searches activities by name using semantic search and returns them sorted by date.",
    inputSchema: {
      name: z.string().describe("Person or company name to look up"),
      limit: z.number().optional().default(20).describe("Maximum activities to return"),
    },
  },
  async ({ name, limit }) => {
    try {
      await ensureReady();

      const queryEmbedding = await embed(`all activities for ${name}`);

      if (KB_BACKEND === "qdrant") {
        const results = await searchQdrant(backend.qdrant, "activities", queryEmbedding, limit);

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
            const date = r.timestamp ? new Date(r.timestamp).toISOString().split("T")[0] : "unknown date";
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
      const db = backend.db!;
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
  },
);

// ── Tool: crm_stats ──────────────────────────────────────────────────────────

server.registerTool(
  "crm_stats",
  {
    title: "CRM Statistics",
    description:
      "Get pipeline, lifecycle, and record statistics from CRM data. Useful for understanding deal pipeline health, contact lifecycle distribution, and activity volume.",
    inputSchema: {
      metric: z
        .enum(["pipeline", "lifecycle", "activity_types", "overview"])
        .optional()
        .default("overview")
        .describe("Type of statistics to return"),
    },
  },
  async ({ metric }) => {
    try {
      await ensureReady();

      if (KB_BACKEND === "qdrant") {
        return await crmStatsQdrant(metric);
      }
      return await crmStatsAtlas(metric);
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

async function crmStatsQdrant(metric: string): Promise<ToolResult> {
  if (metric === "overview") {
    // For contacts, get breakdown by objectType
    let contactOnly = 0;
    let companyOnly = 0;
    try {
      const contactResult = await backend.qdrant.count("contacts", {
        filter: { must: [{ key: "objectType", match: { value: "contact" } }] },
        exact: true,
      });
      contactOnly = contactResult.count;
      const companyResult = await backend.qdrant.count("contacts", {
        filter: { must: [{ key: "objectType", match: { value: "company" } }] },
        exact: true,
      });
      companyOnly = companyResult.count;
    } catch {
      try {
        const info = await backend.qdrant.getCollection("contacts");
        contactOnly = info.points_count ?? 0;
      } catch {
        contactOnly = 0;
      }
    }

    // Deals: count only sales pipeline
    let dealCount = 0;
    try {
      const dealResult = await backend.qdrant.count("deals", {
        filter: { must: [{ key: "pipeline", match: { value: "default" } }] },
        exact: true,
      });
      dealCount = dealResult.count;
    } catch {
      try {
        const info = await backend.qdrant.getCollection("deals");
        dealCount = info.points_count ?? 0;
      } catch {
        dealCount = 0;
      }
    }

    let activityCount = 0;
    try {
      const info = await backend.qdrant.getCollection("activities");
      activityCount = info.points_count ?? 0;
    } catch {
      activityCount = 0;
    }

    const lines = [
      "CRM Overview",
      "============",
      `Contacts:   ${contactOnly.toLocaleString()}`,
      `Companies:  ${companyOnly.toLocaleString()}`,
      `Deals:      ${dealCount.toLocaleString()}`,
      `Activities: ${activityCount.toLocaleString()}`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `Total records: ${(contactOnly + companyOnly + dealCount + activityCount).toLocaleString()}`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (metric === "pipeline" || metric === "lifecycle" || metric === "activity_types") {
    // For aggregation metrics, fall back to MongoDB if available
    if (backend.db) {
      return await crmStatsAtlas(metric);
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

async function crmStatsAtlas(metric: string): Promise<ToolResult> {
  const db = backend.db!;

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
      "CRM Overview",
      "============",
      `Contacts:   ${contactOnly.toLocaleString()}`,
      `Companies:  ${companyOnly.toLocaleString()}`,
      `Deals:      ${dealCount.toLocaleString()}`,
      `Activities: ${activityCount.toLocaleString()}`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
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
      const stageName = stage._id ? resolveStage(backend.stageMap, stage._id) : "Unknown";
      const amount = stage.totalAmount ? ` | Total: $${stage.totalAmount.toLocaleString()}` : "";
      lines.push(`${stageName}: ${stage.count} deals${amount}`);
    }

    const totalDeals = pipeline.reduce((sum, s) => sum + s.count, 0);
    const totalAmount = pipeline.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
    lines.push(
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
    lines.push(`Total: ${totalDeals} deals | $${totalAmount.toLocaleString()}`);

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
    lines.push(
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
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
    lines.push(
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
    lines.push(`Total activities: ${total}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return { content: [{ type: "text", text: `Unknown metric: ${metric}` }], isError: true };
}

// ── Connect and run ─────────────────────────────────────────────────────────

process.stderr.write(`crm-search: starting with backend=${KB_BACKEND}\n`);
const transport = new StdioServerTransport();
await server.connect(transport);
