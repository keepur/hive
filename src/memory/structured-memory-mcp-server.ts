#!/usr/bin/env node

/**
 * Structured Memory MCP Server — runs as a stdio subprocess inside each agent session.
 * Provides structured memory tools with semantic search and lifecycle management.
 *
 * Env vars:
 *   AGENT_ID      — the agent's ID
 *   MONGODB_URI   — MongoDB connection string
 *   MONGODB_DB    — database name
 *   CHANNEL_ID    — current channel (auto-populated by agent-runner)
 *   THREAD_ID     — current thread (auto-populated by agent-runner)
 *   QDRANT_URL    — Qdrant endpoint
 *   OLLAMA_URL    — Ollama endpoint
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { MemoryStore } from "./memory-store.js";
import { MemoryEmbedder } from "./memory-embedder.js";
import type { MemoryType, MemoryImportance } from "./memory-types.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const CHANNEL_ID = process.env.CHANNEL_ID;
const THREAD_ID = process.env.THREAD_ID;

if (!AGENT_ID) {
  process.stderr.write("structured-memory-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}

const store = new MemoryStore(MONGODB_URI, MONGODB_DB);
await store.init();

const embedder = new MemoryEmbedder(
  process.env.QDRANT_URL,
  process.env.OLLAMA_URL,
);

const server = new McpServer({
  name: "hive-structured-memory",
  version: "1.0.0",
});

const VALID_TYPES = ["fact", "task", "interaction", "preference", "decision"] as const;
const VALID_IMPORTANCE = ["critical", "high", "medium", "low"] as const;

server.registerTool(
  "memory_save",
  {
    title: "Save Memory",
    description: "Save a new structured memory record. Use this to remember facts, tasks, interactions, preferences, or decisions.",
    inputSchema: {
      content: z.string().describe("The memory content — a fact, note, task, preference, or decision"),
      type: z.enum(VALID_TYPES).describe("Memory type: fact, task, interaction, preference, or decision"),
      topic: z.string().describe('Freeform topic tag, e.g. "customer:jones", "project:kitchen-reno"'),
      importance: z.enum(VALID_IMPORTANCE).describe("Importance level: critical, high, medium, or low"),
    },
  },
  async ({ content, type, topic, importance }) => {
    const pointId = crypto.randomUUID();
    const record = await store.save(
      AGENT_ID,
      { content, type: type as MemoryType, topic, importance: importance as MemoryImportance },
      pointId,
      CHANNEL_ID,
      THREAD_ID,
    );

    // Embed async — don't block the response on Qdrant
    embedder.upsert(pointId, content, {
      agentId: AGENT_ID,
      mongoId: record._id!.toString(),
      type,
      topic,
      tier: "hot",
      importance,
      createdAt: Math.floor(record.createdAt.getTime() / 1000),
    }).catch((err) => {
      process.stderr.write(`memory_save embed error: ${err}\n`);
    });

    return {
      content: [{ type: "text", text: `Saved memory [${record._id}] — type:${type} topic:"${topic}" importance:${importance}` }],
    };
  },
);

server.registerTool(
  "memory_recall",
  {
    title: "Recall Memory",
    description: "Search your memories semantically. Returns the most relevant memories across all tiers (hot, warm, cold). Use this before starting tasks to find relevant context.",
    inputSchema: {
      query: z.string().describe("What to search for — natural language query"),
      type: z.enum([...VALID_TYPES, "summary"]).optional().describe("Filter by memory type"),
      topic: z.string().optional().describe("Filter by topic tag"),
      tier: z.enum(["hot", "warm", "cold"]).optional().describe("Filter by tier"),
      importance: z.enum(VALID_IMPORTANCE).optional().describe("Filter by importance"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, type, topic, tier, importance, limit }) => {
    const searchResults = await embedder.search(query, AGENT_ID, {
      type: type as any,
      topic,
      tier: tier as any,
      importance: importance as any,
      limit,
    });

    if (searchResults.length === 0) {
      return { content: [{ type: "text", text: "No matching memories found." }] };
    }

    // Fetch full records from MongoDB
    const ids = searchResults.map((r) => new ObjectId(r.mongoId));
    const records: string[] = [];

    for (const sr of searchResults) {
      const record = await store.getById(new ObjectId(sr.mongoId));
      if (!record) continue;
      const pinLabel = record.pinned ? " [pinned]" : "";
      const date = record.updatedAt.toISOString().split("T")[0];
      records.push(
        `**[${record._id}]** (${record.type}/${record.importance}, ${record.tier}${pinLabel}, ${date}, relevance: ${sr.score.toFixed(2)})\n` +
        `Topic: ${record.topic}\n${record.content}`
      );
    }

    // Touch access counts
    await store.touchAccess(ids);

    return { content: [{ type: "text", text: records.join("\n\n---\n\n") }] };
  },
);

server.registerTool(
  "memory_update",
  {
    title: "Update Memory",
    description: "Update an existing memory record's content and/or importance. Resets recency.",
    inputSchema: {
      id: z.string().describe("Memory record ID (from memory_recall results)"),
      content: z.string().describe("Updated content"),
      importance: z.enum(VALID_IMPORTANCE).optional().describe("Updated importance level"),
    },
  },
  async ({ id, content, importance }) => {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return { content: [{ type: "text", text: `Invalid memory ID: ${id}` }], isError: true };
    }

    const existing = await store.getById(objectId);
    if (!existing || existing.agentId !== AGENT_ID) {
      return { content: [{ type: "text", text: `Memory not found: ${id}` }], isError: true };
    }

    const updated = await store.update(objectId, content, importance);
    if (!updated) {
      return { content: [{ type: "text", text: `Failed to update memory: ${id}` }], isError: true };
    }

    // Re-embed
    embedder.upsert(updated.qdrantPointId, content, {
      agentId: AGENT_ID,
      mongoId: id,
      type: updated.type,
      topic: updated.topic,
      tier: updated.tier,
      importance: updated.importance,
      createdAt: Math.floor(updated.createdAt.getTime() / 1000),
    }).catch((err) => {
      process.stderr.write(`memory_update embed error: ${err}\n`);
    });

    return { content: [{ type: "text", text: `Updated memory [${id}]` }] };
  },
);

server.registerTool(
  "memory_pin",
  {
    title: "Pin Memory",
    description: "Pin a memory to the hot tier. Pinned memories are always included in your context. Use for critical facts that must never be forgotten.",
    inputSchema: {
      id: z.string().describe("Memory record ID to pin"),
    },
  },
  async ({ id }) => {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return { content: [{ type: "text", text: `Invalid memory ID: ${id}` }], isError: true };
    }

    const existing = await store.getById(objectId);
    if (!existing || existing.agentId !== AGENT_ID) {
      return { content: [{ type: "text", text: `Memory not found: ${id}` }], isError: true };
    }

    await store.pin(objectId);
    return { content: [{ type: "text", text: `Pinned memory [${id}] — will stay in your active context` }] };
  },
);

server.registerTool(
  "memory_unpin",
  {
    title: "Unpin Memory",
    description: "Remove pin from a memory, returning it to normal lifecycle scoring. It may be demoted to warm/cold on the next sweep.",
    inputSchema: {
      id: z.string().describe("Memory record ID to unpin"),
    },
  },
  async ({ id }) => {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return { content: [{ type: "text", text: `Invalid memory ID: ${id}` }], isError: true };
    }

    const existing = await store.getById(objectId);
    if (!existing || existing.agentId !== AGENT_ID) {
      return { content: [{ type: "text", text: `Memory not found: ${id}` }], isError: true };
    }

    await store.unpin(objectId);
    return { content: [{ type: "text", text: `Unpinned memory [${id}] — will be scored normally` }] };
  },
);

server.registerTool(
  "memory_forget",
  {
    title: "Forget Memory",
    description: "Permanently delete a memory. Use when information is no longer relevant or was saved in error.",
    inputSchema: {
      id: z.string().describe("Memory record ID to delete"),
    },
  },
  async ({ id }) => {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return { content: [{ type: "text", text: `Invalid memory ID: ${id}` }], isError: true };
    }

    // Check ownership before deleting (avoid TOCTOU — don't delete then check)
    const existing = await store.getById(objectId);
    if (!existing || existing.agentId !== AGENT_ID) {
      return { content: [{ type: "text", text: `Memory not found: ${id}` }], isError: true };
    }

    await store.delete(objectId);

    // Remove vector
    embedder.remove(existing.qdrantPointId).catch((err) => {
      process.stderr.write(`memory_forget embed error: ${err}\n`);
    });

    return { content: [{ type: "text", text: `Forgotten memory [${id}]` }] };
  },
);

// Cleanup on exit
process.on("SIGTERM", () => store.close());
process.on("SIGINT", () => store.close());

const transport = new StdioServerTransport();
await server.connect(transport);
