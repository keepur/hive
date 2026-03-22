# Agent Memory Lifecycle Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace freeform `memory.md` blobs with structured, tiered memory records managed by a system-level lifecycle process.

**Architecture:** New `agent_memory` MongoDB collection with structured records, Qdrant vector collection for semantic search, three-tier lifecycle (hot/warm/cold) with automatic scoring and demotion. Agents write via new MCP tools (`memory_save`, `memory_recall`, etc.); system manages sizing, aging, and summarization via the existing sweeper. Phase 1 deploys alongside legacy system — no breaking changes until Phase 3 cutover.

**Tech Stack:** TypeScript, MongoDB, Qdrant (`@qdrant/js-client-rest`), Ollama (`bge-large` embeddings), MCP SDK (`@modelcontextprotocol/sdk`), Claude Haiku (cold summarization)

**Spec:** `docs/specs/2026-03-21-memory-lifecycle-design.md`

---

### Task 1: Types and Config

**Files:**
- Create: `src/memory/memory-types.ts`
- Modify: `src/config.ts:52-204`

- [ ] **Step 1:** Create `src/memory/memory-types.ts` with all shared types

```typescript
import type { ObjectId } from "mongodb";

export type MemoryType = "fact" | "task" | "interaction" | "preference" | "decision" | "summary";
export type MemoryImportance = "critical" | "high" | "medium" | "low";
export type MemoryTier = "hot" | "warm" | "cold";

export interface MemoryRecord {
  _id?: ObjectId;
  agentId: string;
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
  tier: MemoryTier;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  sourceChannel?: string;
  sourceThread?: string;
  pinned: boolean;
  supersededBy?: ObjectId;
  summaryGroup?: ObjectId;
  summarized: boolean;
  qdrantPointId: string;
}

export interface MemoryRecordInput {
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
}

export interface MemoryRecallFilters {
  type?: MemoryType;
  topic?: string;
  tier?: MemoryTier;
  importance?: MemoryImportance;
  limit?: number;
}

export interface MemoryRecallResult extends MemoryRecord {
  score: number;
}

export interface MemoryLifecycleConfig {
  hotBudgetTokens: number;
  sweepIntervalHours: number;
  hotThreshold: number;
  warmThreshold: number;
  recencyHalfLifeDays: number;
  coldSummaryMinRecords: number;
  coldRetentionDays: number;
}

export const IMPORTANCE_WEIGHTS: Record<MemoryImportance, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.0,
  fact: 0.8,
  preference: 0.8,
  summary: 0.6,
  task: 0.5,
  interaction: 0.3,
};
```

- [ ] **Step 2:** Add `memory` config section to `src/config.ts`

After the `sweeper` block (line ~196), add:

```typescript
  memory: {
    hotBudgetTokens: parseInt(optional("MEMORY_HOT_BUDGET_TOKENS", String(hive.memory?.hotBudgetTokens ?? 3000)), 10),
    sweepIntervalHours: parseFloat(optional("MEMORY_SWEEP_INTERVAL_HOURS", String(hive.memory?.sweepIntervalHours ?? 6))),
    hotThreshold: parseFloat(optional("MEMORY_HOT_THRESHOLD", String(hive.memory?.hotThreshold ?? 0.6))),
    warmThreshold: parseFloat(optional("MEMORY_WARM_THRESHOLD", String(hive.memory?.warmThreshold ?? 0.3))),
    recencyHalfLifeDays: parseFloat(optional("MEMORY_RECENCY_HALF_LIFE_DAYS", String(hive.memory?.recencyHalfLifeDays ?? 7))),
    coldSummaryMinRecords: parseInt(optional("MEMORY_COLD_SUMMARY_MIN", String(hive.memory?.coldSummaryMinRecords ?? 5)), 10),
    coldRetentionDays: parseInt(optional("MEMORY_COLD_RETENTION_DAYS", String(hive.memory?.coldRetentionDays ?? 90)), 10),
  },
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-types.ts src/config.ts
git commit -m "feat(memory): add structured memory types and config section"
```

---

### Task 2: Memory Store (MongoDB CRUD)

**Files:**
- Create: `src/memory/memory-store.ts`

- [ ] **Step 1:** Create `src/memory/memory-store.ts` — MongoDB CRUD for structured memory records

```typescript
import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecord, MemoryRecordInput, MemoryTier } from "./memory-types.js";

const log = createLogger("memory-store");

export class MemoryStore {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<MemoryRecord>;

  constructor(private mongoUri: string, private dbName: string) {
    this.client = new MongoClient(mongoUri);
  }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<MemoryRecord>("agent_memory");

    await this.collection.createIndex({ agentId: 1, tier: 1 });
    await this.collection.createIndex({ agentId: 1, topic: 1 });
    await this.collection.createIndex({ agentId: 1, updatedAt: 1 });
    await this.collection.createIndex({ agentId: 1, type: 1 });
    log.info("Memory store initialized", { db: this.dbName });
  }

  async save(agentId: string, input: MemoryRecordInput, qdrantPointId: string, sourceChannel?: string, sourceThread?: string): Promise<MemoryRecord> {
    const now = new Date();
    const record: MemoryRecord = {
      agentId,
      content: input.content,
      type: input.type,
      topic: input.topic,
      importance: input.importance,
      tier: "hot",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceChannel,
      sourceThread,
      pinned: false,
      summarized: false,
      qdrantPointId,
    };
    const result = await this.collection.insertOne(record as any);
    record._id = result.insertedId;
    return record;
  }

  async getById(id: ObjectId): Promise<MemoryRecord | null> {
    return this.collection.findOne({ _id: id });
  }

  async update(id: ObjectId, content: string, importance?: string, qdrantPointId?: string): Promise<MemoryRecord | null> {
    const updates: Record<string, any> = {
      content,
      updatedAt: new Date(),
    };
    if (importance) updates.importance = importance;
    if (qdrantPointId) updates.qdrantPointId = qdrantPointId;

    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: updates },
      { returnDocument: "after" },
    );
    return result;
  }

  async pin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id },
      { $set: { pinned: true, tier: "hot" as MemoryTier } },
    );
    return result.modifiedCount > 0;
  }

  async unpin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id },
      { $set: { pinned: false } },
    );
    return result.modifiedCount > 0;
  }

  async delete(id: ObjectId): Promise<MemoryRecord | null> {
    return this.collection.findOneAndDelete({ _id: id });
  }

  async touchAccess(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { lastAccessedAt: new Date() }, $inc: { accessCount: 1 } },
    );
  }

  async getHotTier(agentId: string): Promise<MemoryRecord[]> {
    // Sort in application code — importance is an enum that can't be sorted
    // correctly as a string (alphabetical: critical < high < low < medium).
    // We need weighted sort: pinned first, then by importance weight desc, then recency.
    const WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const records = await this.collection.find({ agentId, tier: "hot" }).toArray();
    return records.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const wDiff = (WEIGHT[b.importance] ?? 0) - (WEIGHT[a.importance] ?? 0);
      if (wDiff !== 0) return wDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  }

  async getAllNonPinned(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId, pinned: false }).toArray();
  }

  async getAllForAgent(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId }).toArray();
  }

  async setTier(id: ObjectId, tier: MemoryTier): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: { tier } });
  }

  async setTierBulk(ids: ObjectId[], tier: MemoryTier): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { tier } });
  }

  async getColdByTopic(agentId: string, topic: string): Promise<MemoryRecord[]> {
    return this.collection
      .find({ agentId, tier: "cold", topic, summarized: false })
      .sort({ createdAt: 1 })
      .toArray();
  }

  async getColdTopics(agentId: string): Promise<string[]> {
    const result = await this.collection.distinct("topic", {
      agentId,
      tier: "cold",
      summarized: false,
    });
    return result;
  }

  async markSummarized(ids: ObjectId[], summaryGroupId: ObjectId): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { summarized: true, summaryGroup: summaryGroupId } },
    );
  }

  async deleteSummarizedOlderThan(agentId: string, before: Date): Promise<number> {
    const result = await this.collection.deleteMany({
      agentId,
      summarized: true,
      updatedAt: { $lt: before },
    });
    return result.deletedCount;
  }

  async getAgentIds(): Promise<string[]> {
    return this.collection.distinct("agentId");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-store.ts
git commit -m "feat(memory): add MemoryStore — structured record CRUD for agent_memory collection"
```

---

### Task 3: Memory Embedder (Qdrant Integration)

**Files:**
- Create: `src/memory/memory-embedder.ts`

This follows the exact same pattern as `src/search/conversation-index.ts` — Ollama embedding + Qdrant upsert/search/delete — but stores the `qdrantPointId` for update/delete capability.

- [ ] **Step 1:** Create `src/memory/memory-embedder.ts`

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecallFilters } from "./memory-types.js";

const log = createLogger("memory-embedder");

const COLLECTION = "agent_memory";
const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

interface QdrantPayload {
  agentId: string;
  mongoId: string;
  type: string;
  topic: string;
  tier: string;
  importance: string;
  createdAt: number;
}

export interface EmbedSearchResult {
  mongoId: string;
  score: number;
}

export class MemoryEmbedder {
  private qdrant: QdrantClient | null = null;
  private collectionReady = false;

  constructor(
    private qdrantUrl: string = process.env.QDRANT_URL ?? "http://localhost:6333",
    private ollamaUrl: string = process.env.OLLAMA_URL ?? "http://localhost:11434",
  ) {}

  private getClient(): QdrantClient {
    if (!this.qdrant) {
      this.qdrant = new QdrantClient({ url: this.qdrantUrl });
    }
    return this.qdrant;
  }

  private async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.embeddings[0];
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const client = this.getClient();
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);

    if (!exists) {
      const testVector = await this.embed("test");
      await client.createCollection(COLLECTION, {
        vectors: { size: testVector.length, distance: "Cosine" },
      });
      log.info("Created Qdrant collection", { collection: COLLECTION, vectorSize: testVector.length });
    }
    this.collectionReady = true;
  }

  async upsert(pointId: string, content: string, payload: QdrantPayload): Promise<void> {
    await this.ensureCollection();
    const vector = await this.embed(content);
    await this.getClient().upsert(COLLECTION, {
      points: [{ id: pointId, vector, payload }],
    });
  }

  async remove(pointId: string): Promise<void> {
    await this.ensureCollection();
    await this.getClient().delete(COLLECTION, {
      points: [pointId],
    });
  }

  async search(query: string, agentId: string, filters?: MemoryRecallFilters): Promise<EmbedSearchResult[]> {
    await this.ensureCollection();
    const queryVector = await this.embed(query);
    const limit = filters?.limit ?? 10;

    const must: any[] = [{ key: "agentId", match: { value: agentId } }];
    if (filters?.type) must.push({ key: "type", match: { value: filters.type } });
    if (filters?.topic) must.push({ key: "topic", match: { value: filters.topic } });
    if (filters?.tier) must.push({ key: "tier", match: { value: filters.tier } });
    if (filters?.importance) must.push({ key: "importance", match: { value: filters.importance } });

    const results = await this.getClient().search(COLLECTION, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: { must },
    });

    return results.map((r) => ({
      mongoId: r.payload?.mongoId as string,
      score: r.score,
    }));
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-embedder.ts
git commit -m "feat(memory): add MemoryEmbedder — Qdrant vector integration for semantic recall"
```

---

### Task 4: Memory MCP Server (New Tools)

**Files:**
- Create: `src/memory/structured-memory-mcp-server.ts`

New MCP server with `memory_save`, `memory_recall`, `memory_update`, `memory_pin`, `memory_unpin`, `memory_forget`. Runs as a stdio subprocess per agent session. Does NOT replace the legacy server yet — both coexist during Phase 1.

- [ ] **Step 1:** Create `src/memory/structured-memory-mcp-server.ts`

```typescript
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
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/memory/structured-memory-mcp-server.ts
git commit -m "feat(memory): add structured memory MCP server with save/recall/update/pin/forget tools"
```

---

### Task 5: Memory Lifecycle Engine

**Files:**
- Create: `src/memory/memory-lifecycle.ts`

The scoring engine, tier enforcement, budget management, and cold summarization. Exposes a `sweep(): Promise<SweepResult>` method for the sweeper.

- [ ] **Step 1:** Create `src/memory/memory-lifecycle.ts`

```typescript
import { ObjectId } from "mongodb";
import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryEmbedder } from "./memory-embedder.js";
import type { MemoryRecord, MemoryLifecycleConfig, MemoryTier } from "./memory-types.js";
import { IMPORTANCE_WEIGHTS, TYPE_WEIGHTS } from "./memory-types.js";

const log = createLogger("memory-lifecycle");

export class MemoryLifecycle {
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
  ) {}

  /**
   * Compute retention score for a memory record.
   * score = (importance × 0.4) + (recency × 0.3) + (access × 0.2) + (type × 0.1)
   */
  computeScore(record: MemoryRecord, medianAccess: number): number {
    const importanceWeight = IMPORTANCE_WEIGHTS[record.importance] ?? 0.5;
    const typeWeight = TYPE_WEIGHTS[record.type] ?? 0.5;

    // Recency: exponential decay from updatedAt
    const ageMs = Date.now() - record.updatedAt.getTime();
    const halfLifeMs = this.config.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
    const recencyWeight = Math.exp(-0.693 * ageMs / halfLifeMs); // ln(2) ≈ 0.693

    // Access frequency: normalized against agent median
    const accessWeight = medianAccess > 0
      ? Math.min(record.accessCount / medianAccess, 1.0)
      : (record.accessCount > 0 ? 1.0 : 0.0);

    return (importanceWeight * 0.4) + (recencyWeight * 0.3) + (accessWeight * 0.2) + (typeWeight * 0.1);
  }

  /**
   * Approximate token count (chars / 4).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Run one lifecycle sweep across all agents.
   */
  async sweep(): Promise<SweepResult> {
    const start = Date.now();
    let promoted = 0;
    let demoted = 0;
    let summarized = 0;
    let cleaned = 0;
    const errors: string[] = [];

    try {
      const agentIds = await this.store.getAgentIds();

      for (const agentId of agentIds) {
        try {
          const result = await this.sweepAgent(agentId);
          promoted += result.promoted;
          demoted += result.demoted;
          summarized += result.summarized;
          cleaned += result.cleaned;
        } catch (err) {
          errors.push(`${agentId}: ${err}`);
          log.error("Memory lifecycle sweep failed for agent", { agentId, error: String(err) });
        }
      }
    } catch (err) {
      errors.push(`global: ${err}`);
    }

    const totalActions = promoted + demoted + summarized + cleaned;
    if (totalActions > 0) {
      log.info("Memory lifecycle sweep complete", {
        durationMs: Date.now() - start,
        promoted,
        demoted,
        summarized,
        cleaned,
        errors: errors.length,
      });
    }

    return {
      component: "memory-lifecycle",
      pruned: demoted + cleaned,
      retried: promoted,
      bytesFreed: 0,
      errors,
    };
  }

  private async sweepAgent(agentId: string): Promise<{ promoted: number; demoted: number; summarized: number; cleaned: number }> {
    let promoted = 0;
    let demoted = 0;

    // 1. Score all non-pinned records
    const records = await this.store.getAllNonPinned(agentId);
    if (records.length === 0) return { promoted: 0, demoted: 0, summarized: 0, cleaned: 0 };

    const accessCounts = records.map((r) => r.accessCount).sort((a, b) => a - b);
    const medianAccess = accessCounts[Math.floor(accessCounts.length / 2)] ?? 0;

    const scored = records.map((r) => ({
      record: r,
      score: this.computeScore(r, medianAccess),
    }));

    // 2. Enforce tier placement based on score
    const tierUpdates: { id: ObjectId; newTier: MemoryTier }[] = [];
    for (const { record, score } of scored) {
      let targetTier: MemoryTier;
      if (score >= this.config.hotThreshold) {
        targetTier = "hot";
      } else if (score >= this.config.warmThreshold) {
        targetTier = "warm";
      } else {
        targetTier = "cold";
      }

      if (targetTier !== record.tier) {
        tierUpdates.push({ id: record._id!, newTier: targetTier });
        if (targetTier === "hot" && record.tier !== "hot") promoted++;
        if (targetTier !== "hot" && record.tier === "hot") demoted++;
      }
    }

    // Apply tier changes
    for (const tier of ["hot", "warm", "cold"] as MemoryTier[]) {
      const ids = tierUpdates.filter((u) => u.newTier === tier).map((u) => u.id);
      await this.store.setTierBulk(ids, tier);
    }

    // 3. Enforce hot budget
    const hotRecords = await this.store.getHotTier(agentId);
    let totalTokens = 0;
    const toOverflow: ObjectId[] = [];
    for (const r of hotRecords) {
      totalTokens += this.estimateTokens(r.content);
      if (totalTokens > this.config.hotBudgetTokens && !r.pinned) {
        toOverflow.push(r._id!);
      }
    }
    if (toOverflow.length > 0) {
      await this.store.setTierBulk(toOverflow, "warm");
      demoted += toOverflow.length;
    }

    // 4. Summarize cold batches
    let summarizedCount = 0;
    try {
      summarizedCount = await this.summarizeCold(agentId);
    } catch (err) {
      log.warn("Cold summarization failed", { agentId, error: String(err) });
    }

    // 5. Clean up old summarized records
    const retentionDate = new Date(Date.now() - this.config.coldRetentionDays * 24 * 60 * 60 * 1000);
    const cleanedCount = await this.store.deleteSummarizedOlderThan(agentId, retentionDate);

    return { promoted, demoted, summarized: summarizedCount, cleaned: cleanedCount };
  }

  private async summarizeCold(agentId: string): Promise<number> {
    const topics = await this.store.getColdTopics(agentId);
    let summarized = 0;

    for (const topic of topics) {
      const coldRecords = await this.store.getColdByTopic(agentId, topic);
      if (coldRecords.length < this.config.coldSummaryMinRecords) continue;

      const entries = coldRecords
        .map((r) => `- [${r.type}/${r.importance}] ${r.content}`)
        .join("\n");

      const prompt = [
        `Summarize the following memory entries for agent ${agentId} about topic "${topic}".`,
        "Preserve key facts, decisions, and outcomes. Discard routine interactions.",
        "Be concise — aim for 2-5 sentences.",
        "",
        entries,
      ].join("\n");

      // Use Haiku for cheap summarization — SDK returns an async iterable
      const q = query({
        prompt,
        options: {
          model: "claude-haiku-4-5-20251001",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          persistSession: false,
        },
      });

      let summaryText = "";
      for await (const message of q) {
        const msg = message as SDKMessage;
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success" && result.result) {
            summaryText = result.result;
          }
        }
      }
      if (!summaryText) continue;

      // Save summary as a warm-tier record
      const pointId = crypto.randomUUID();
      const summaryRecord = await this.store.save(
        agentId,
        { content: summaryText, type: "summary", topic, importance: "medium" },
        pointId,
      );

      // Set to warm (summaries start warm, can be promoted to hot by access)
      await this.store.setTier(summaryRecord._id!, "warm");

      // Embed the summary
      await this.embedder.upsert(pointId, summaryText, {
        agentId,
        mongoId: summaryRecord._id!.toString(),
        type: "summary",
        topic,
        tier: "warm",
        importance: "medium",
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Mark originals as summarized
      await this.store.markSummarized(
        coldRecords.map((r) => r._id!),
        summaryRecord._id!,
      );

      summarized += coldRecords.length;
    }

    return summarized;
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/memory/memory-lifecycle.ts
git commit -m "feat(memory): add MemoryLifecycle engine — scoring, tiering, budget enforcement, cold summarization"
```

---

### Task 6: Hot-Tier System Prompt Injection

**Files:**
- Modify: `src/agents/agent-runner.ts:53-91`
- Modify: `src/memory/memory-manager.ts`

Add a `getHotTierPrompt()` method to `MemoryManager` that queries structured records and renders them into the system prompt format from the spec. Modify `buildSystemPrompt()` to use it alongside the legacy path.

- [ ] **Step 1:** Add hot-tier injection to `MemoryManager`

Add imports and a new method to `src/memory/memory-manager.ts`:

```typescript
import type { MemoryRecord, MemoryType } from "./memory-types.js";
```

Add a new method after `list()`:

```typescript
  /**
   * Build the hot-tier memory section for system prompt injection.
   * Returns null if no structured memories exist for this agent.
   */
  async getHotTierPrompt(agentId: string, budgetTokens: number): Promise<string | null> {
    const db = this.client.db(this.dbName);
    const agentMemory = db.collection<MemoryRecord>("agent_memory");

    const hotRecords = await agentMemory
      .find({ agentId, tier: "hot" })
      .sort({ pinned: -1, updatedAt: -1 })
      .toArray();

    if (hotRecords.length === 0) return null;

    // Group by type, enforce token budget
    const sections: Record<string, string[]> = {};
    const sectionLabels: Record<string, string> = {
      task: "Active Tasks",
      fact: "Key Facts",
      decision: "Recent Decisions",
      preference: "Preferences",
      interaction: "Recent Interactions",
      summary: "Summaries",
    };

    let tokenCount = 0;
    const pinnedEntries: string[] = [];
    let includedCount = 0;
    const totalCount = hotRecords.length;

    for (const r of hotRecords) {
      const date = r.updatedAt.toISOString().split("T")[0];
      const line = `- [${date}] ${r.content} (${r.importance})`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenCount + lineTokens > budgetTokens && !r.pinned) break;
      tokenCount += lineTokens;
      includedCount++;

      if (r.pinned) {
        pinnedEntries.push(`- ${r.content} (${r.importance}, pinned)`);
      } else {
        const type = r.type as string;
        if (!sections[type]) sections[type] = [];
        sections[type].push(line);
      }
    }

    // Render
    const parts: string[] = ["## Your Memory"];

    for (const [type, label] of Object.entries(sectionLabels)) {
      if (sections[type]?.length) {
        parts.push(`### ${label}\n${sections[type].join("\n")}`);
      }
    }
    if (pinnedEntries.length > 0) {
      parts.push(`### Pinned\n${pinnedEntries.join("\n")}`);
    }

    // Count warm+cold for the hint
    const warmColdCount = await agentMemory.countDocuments({ agentId, tier: { $ne: "hot" } });
    if (warmColdCount > 0) {
      parts.push(`---\nYou have ${warmColdCount} additional memories available via \`memory_recall\`. Use it to search for context before starting tasks.`);
    }

    return parts.join("\n\n");
  }
```

- [ ] **Step 2:** Modify `buildSystemPrompt()` in `src/agents/agent-runner.ts` (lines 73-88)

Replace the legacy memory injection block with a dual-path that prefers structured records:

```typescript
    // Memory injection — prefer structured records, fall back to legacy blob
    const hotTierPrompt = await this.memoryManager.getHotTierPrompt(
      this.agentConfig.id,
      config.memory.hotBudgetTokens,
    );
    if (hotTierPrompt) {
      parts.push(hotTierPrompt);
    } else {
      // Legacy path — inject memory.md blob if structured records don't exist yet
      const memoryDir = `agents/${this.agentConfig.id}`;
      const memory = await this.memoryManager.read(`${memoryDir}/memory.md`);
      if (memory) {
        parts.push(`## Your Memory\n${memory}`);
      }

      // List available memory files so the agent knows what references it has
      const memoryFiles = await this.memoryManager.list(memoryDir);
      const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
      if (mdFiles.length > 0) {
        parts.push(
          `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
          mdFiles.map((f) => `- ${memoryDir}/${f}`).join("\n") +
          `\n\nRead relevant files via the memory MCP server (\`memory_read\`) before starting tasks that may relate to them.`,
        );
      }
    }
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4:** Commit

```bash
git add src/memory/memory-manager.ts src/agents/agent-runner.ts
git commit -m "feat(memory): hot-tier system prompt injection with legacy fallback"
```

---

### Task 7: Wire MCP Server in Agent Runner

**Files:**
- Modify: `src/agents/agent-runner.ts:95-118`

Add the structured memory MCP server alongside the legacy one. The agent gets both during Phase 1; legacy tools are removed in Phase 3.

- [ ] **Step 1:** Add structured memory MCP server in `buildMcpServers()` after the existing memory server block (line ~118)

```typescript
    // Structured Memory MCP — new lifecycle-managed memory tools
    servers["structured-memory"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/memory/structured-memory-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        CHANNEL_ID: context?.channelId ?? "",
        THREAD_ID: context?.threadId ?? "",
        QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
        OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      },
    };
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(memory): wire structured memory MCP server into agent runner"
```

---

### Task 8: Sweeper Integration

**Files:**
- Modify: `src/sweeper/sweeper.ts:31-41,78-173`
- Modify: `src/index.ts:42-44,271-291`

Add `MemoryLifecycle` as an optional sweep target with its own cycle counter (every 72nd cycle ≈ 6 hours).

- [ ] **Step 1:** Add to `SweeperTargets` interface in `src/sweeper/sweeper.ts`

Import at top:
```typescript
import type { MemoryLifecycle } from "../memory/memory-lifecycle.js";
```

Add to `SweeperTargets` (after `retryQueue`):
```typescript
  memoryLifecycle?: MemoryLifecycle;
```

Add to `SweeperConfig` (after `cacheTtlMs`):
```typescript
  memorySweepIntervalHours?: number;
```

Add cycle counter to `Sweeper` class (after line 52):
```typescript
  private memoryCycleCounter = 0;
  private memorySweepEvery: number;
```

In the `Sweeper` constructor body, compute cycle count from hours:
```typescript
  // Derive memory sweep cycle count: e.g., 6 hours / (300000ms → 0.0833h) = 72 cycles
  const sweepIntervalH = config.memorySweepIntervalHours ?? 6;
  this.memorySweepEvery = Math.round(sweepIntervalH * 3600000 / config.intervalMs);
```

- [ ] **Step 2:** Add memory lifecycle sweep to `sweep()` method

After the retry queue block (step 8, around line 173), before the aggregate section:

```typescript
    // 9. Memory lifecycle — tier scoring, budget enforcement, summarization
    if (this.targets.memoryLifecycle) {
      this.memoryCycleCounter++;
      if (this.memoryCycleCounter >= this.memorySweepEvery) {
        this.memoryCycleCounter = 0;
        try {
          results.push(await this.targets.memoryLifecycle.sweep());
        } catch (err) {
          results.push({ component: "memory-lifecycle", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
        }
      }
    }
```

- [ ] **Step 3:** Wire in `src/index.ts`

Add imports at top:
```typescript
import { MemoryStore } from "./memory/memory-store.js";
import { MemoryEmbedder } from "./memory/memory-embedder.js";
import { MemoryLifecycle } from "./memory/memory-lifecycle.js";
```

After `memoryManager.init()` (around line 44), initialize the structured memory components:
```typescript
  // Structured memory lifecycle
  const memoryStore = new MemoryStore(config.mongo.uri, config.mongo.dbName);
  await memoryStore.init();
  const memoryEmbedder = new MemoryEmbedder();
  const memoryLifecycle = new MemoryLifecycle(memoryStore, memoryEmbedder, {
    hotBudgetTokens: config.memory.hotBudgetTokens,
    sweepIntervalHours: config.memory.sweepIntervalHours,
    hotThreshold: config.memory.hotThreshold,
    warmThreshold: config.memory.warmThreshold,
    recencyHalfLifeDays: config.memory.recencyHalfLifeDays,
    coldSummaryMinRecords: config.memory.coldSummaryMinRecords,
    coldRetentionDays: config.memory.coldRetentionDays,
  });
```

Add `memoryLifecycle` to the sweeper targets object (around line 288):
```typescript
      memoryLifecycle,
```

Add `memorySweepIntervalHours` to the sweeper config object (around line 273):
```typescript
      memorySweepIntervalHours: config.memory.sweepIntervalHours,
```

Add to shutdown (around line 307):
```typescript
    await memoryStore.close();
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5:** Commit

```bash
git add src/sweeper/sweeper.ts src/index.ts
git commit -m "feat(memory): integrate memory lifecycle into sweeper — 6-hour scoring cycle"
```

---

### Task 9: Agent Template Updates

**Files:**
- Modify: All `agents-templates/*/system-prompt.md.tpl` files that reference memory tools

Update memory tool documentation in all agent templates to include the new structured tools alongside the legacy ones.

- [ ] **Step 1:** Update all agent template memory tool lines

For each template that has a memory tool line, replace the single `Memory MCP` line with dual documentation. The exact replacement depends on the template, but the pattern is:

**Business agents** (chief-of-staff, vp-engineering, marketing-manager, product-manager, executive-assistant):
```markdown
- **Memory MCP** — `memory_save`, `memory_recall`, `memory_update`, `memory_pin`, `memory_unpin`, `memory_forget` for structured memory management. Your important memories are automatically included in context; use `memory_recall` to search for older context.
```

**Personal agents** (personal-coach, social-connector, game-designer, etc.):
```markdown
- **Memory MCP** — `memory_save`, `memory_recall`, `memory_update`, `memory_pin`, `memory_forget` for structured memory management. Key memories are auto-loaded; use `memory_recall` for deeper search.
```

Replace each template's memory line using the appropriate variant. All 13 templates that reference Memory MCP need updating.

- [ ] **Step 2:** Regenerate agents

Run: `npm run setup:agents`
Expected: All agents regenerated without errors

- [ ] **Step 3:** Verify build

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4:** Commit

```bash
git add agents-templates/
git commit -m "feat(memory): update all agent templates with structured memory tool documentation"
```

---

### Task 10: Migration Script

**Files:**
- Create: `setup/migrate-memory.ts`

One-time migration: reads legacy `memory.md` blobs from `memory` collection, uses Haiku to split into structured records, saves to `agent_memory` + Qdrant.

- [ ] **Step 1:** Create `setup/migrate-memory.ts`

```typescript
#!/usr/bin/env node

/**
 * Memory Migration Script — converts legacy memory.md blobs to structured records.
 *
 * Usage: npx tsx setup/migrate-memory.ts [--dry-run] [--agent <id>]
 *
 * Reads from legacy `memory` collection, classifies via Haiku, writes to `agent_memory` + Qdrant.
 */

import { MongoClient } from "mongodb";
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../src/config.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { MemoryEmbedder } from "../src/memory/memory-embedder.js";
import type { MemoryRecordInput, MemoryType, MemoryImportance } from "../src/memory/memory-types.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;

console.log(`Memory migration${dryRun ? " (DRY RUN)" : ""}${agentFilter ? ` for agent: ${agentFilter}` : ""}`);

const mongo = new MongoClient(config.mongo.uri);
await mongo.connect();
const db = mongo.db(config.mongo.dbName);
const legacyCollection = db.collection("memory");

const store = new MemoryStore(config.mongo.uri, config.mongo.dbName);
await store.init();
const embedder = new MemoryEmbedder();

// Find all agent memory files
const filter: Record<string, any> = { path: { $regex: "^agents/" } };
if (agentFilter) {
  filter.path = { $regex: `^agents/${agentFilter}/` };
}

const legacyDocs = await legacyCollection.find(filter).toArray();
console.log(`Found ${legacyDocs.length} legacy memory documents`);

for (const doc of legacyDocs) {
  const pathParts = doc.path.split("/");
  const agentId = pathParts[1];
  const filename = pathParts.slice(2).join("/");
  console.log(`\nProcessing: ${doc.path} (${doc.content.length} chars)`);

  const content = doc.content;
  if (!content || content.trim().length === 0) {
    console.log("  Skipping — empty content");
    continue;
  }

  // Chunk if content is large (>16K chars ≈ 4K tokens)
  const chunks: string[] = [];
  if (content.length > 16000) {
    // Split by section headers or double newlines
    const sections = content.split(/\n(?=#{1,3}\s)|\n\n\n/);
    let currentChunk = "";
    for (const section of sections) {
      if ((currentChunk + section).length > 14000 && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = section;
      } else {
        currentChunk += (currentChunk ? "\n\n" : "") + section;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
  } else {
    chunks.push(content);
  }

  console.log(`  Split into ${chunks.length} chunk(s)`);

  for (const chunk of chunks) {
    const classifyPrompt = [
      "Split this agent memory content into individual memory entries.",
      "For each entry, classify:",
      "- type: fact, task, interaction, preference, or decision",
      `- topic: a freeform tag (e.g., "customer:jones", "project:kitchen-reno", "general")`,
      "- importance: critical, high, medium, or low",
      "- content: the memory text (clean, concise)",
      "",
      `Source file: ${filename}`,
      "",
      "Return ONLY a JSON array, no markdown fences, no explanation:",
      '[{"content":"...","type":"...","topic":"...","importance":"..."},...]',
      "",
      chunk,
    ].join("\n");

    // SDK returns an async iterable — collect the result message
    const q = query({
      prompt: classifyPrompt,
      options: {
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        persistSession: false,
      },
    });

    let resultText = "";
    for await (const message of q) {
      const msg = message as SDKMessage;
      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        if (result.subtype === "success" && result.result) {
          resultText = result.result;
        }
      }
    }

    let entries: MemoryRecordInput[];
    try {
      const text = resultText.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      entries = JSON.parse(text);
    } catch (err) {
      console.log(`  Failed to parse Haiku response for chunk — skipping`);
      console.log(`  Response: ${resultText.slice(0, 200)}...`);
      continue;
    }

    console.log(`  Classified ${entries.length} entries from chunk`);

    if (dryRun) {
      for (const e of entries) {
        console.log(`    [${e.type}/${e.importance}] ${e.topic}: ${e.content.slice(0, 80)}...`);
      }
      continue;
    }

    for (const entry of entries) {
      const pointId = crypto.randomUUID();
      const record = await store.save(agentId, {
        content: entry.content,
        type: entry.type as MemoryType,
        topic: entry.topic,
        importance: entry.importance as MemoryImportance,
      }, pointId);

      await embedder.upsert(pointId, entry.content, {
        agentId,
        mongoId: record._id!.toString(),
        type: entry.type,
        topic: entry.topic,
        tier: "hot",
        importance: entry.importance,
        createdAt: Math.floor(Date.now() / 1000),
      });
    }
  }
}

console.log("\nMigration complete");
await store.close();
await mongo.close();
process.exit(0);
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3:** Test dry run

Run: `npx tsx setup/migrate-memory.ts --dry-run`
Expected: Lists legacy docs and classified entries without writing

- [ ] **Step 4:** Commit

```bash
git add setup/migrate-memory.ts
git commit -m "feat(memory): add migration script — converts legacy memory blobs to structured records"
```

---

### Task 11: Tests

**Files:**
- Create: `tests/memory/memory-lifecycle.test.ts`
- Create: `tests/memory/memory-store.test.ts`

Test the scoring algorithm and store operations against a real MongoDB (same pattern as any existing tests).

- [ ] **Step 1:** Create `tests/memory/memory-lifecycle.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { MemoryLifecycle } from "../../src/memory/memory-lifecycle.js";
import type { MemoryRecord } from "../../src/memory/memory-types.js";

// Test scoring in isolation — no MongoDB or Qdrant needed
describe("MemoryLifecycle.computeScore", () => {
  const lifecycle = new MemoryLifecycle(null as any, null as any, {
    hotBudgetTokens: 3000,
    sweepIntervalHours: 6,
    hotThreshold: 0.6,
    warmThreshold: 0.3,
    recencyHalfLifeDays: 7,
    coldSummaryMinRecords: 5,
    coldRetentionDays: 90,
  });

  const baseRecord: MemoryRecord = {
    agentId: "test",
    content: "test memory",
    type: "fact",
    topic: "test",
    importance: "high",
    tier: "hot",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
    accessCount: 5,
    pinned: false,
    summarized: false,
    qdrantPointId: "test-id",
  };

  it("scores critical + recent + accessed fact near 1.0", () => {
    const record = { ...baseRecord, importance: "critical" as const, accessCount: 10 };
    const score = lifecycle.computeScore(record, 5);
    expect(score).toBeGreaterThan(0.8);
  });

  it("scores low importance + old + unaccessed interaction near 0", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const record = {
      ...baseRecord,
      importance: "low" as const,
      type: "interaction" as const,
      updatedAt: thirtyDaysAgo,
      accessCount: 0,
    };
    const score = lifecycle.computeScore(record, 5);
    expect(score).toBeLessThan(0.3);
  });

  it("gives decisions higher type weight than interactions", () => {
    const decision = { ...baseRecord, type: "decision" as const };
    const interaction = { ...baseRecord, type: "interaction" as const };
    const decisionScore = lifecycle.computeScore(decision, 5);
    const interactionScore = lifecycle.computeScore(interaction, 5);
    expect(decisionScore).toBeGreaterThan(interactionScore);
  });

  it("recency decays over time", () => {
    const fresh = { ...baseRecord, updatedAt: new Date() };
    const sevenDaysAgo = { ...baseRecord, updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
    const freshScore = lifecycle.computeScore(fresh, 5);
    const oldScore = lifecycle.computeScore(sevenDaysAgo, 5);
    expect(freshScore).toBeGreaterThan(oldScore);
    // At exactly one half-life, recency should be ~0.5 of fresh
    const recencyDiff = freshScore - oldScore;
    expect(recencyDiff).toBeGreaterThan(0.1);
  });
});
```

- [ ] **Step 2:** Verify tests pass

Run: `npm run test`
Expected: All tests pass, including new memory lifecycle tests

- [ ] **Step 3:** Commit

```bash
git add tests/memory/
git commit -m "test(memory): add lifecycle scoring unit tests"
```

---

## Build Verification

After Task 8 (sweeper integration), run a full build to verify compiled output:

```bash
npm run build
```

This is required because MCP servers run from `dist/` — `npx tsc --noEmit` only checks types.

After all tasks are complete, run the full quality gate:

```bash
npm run check
```

This runs typecheck + lint + format + test. Must pass before PR submission.

## Execution Order

Task 1 is the foundation — types used by everything.
Tasks 2 and 3 depend on Task 1 (import types).
Task 4 depends on 1+2+3 (MCP server uses store + embedder + types).
Task 5 depends on 1+2+3 (lifecycle uses store + embedder + types).
Task 6 depends on 1 (hot-tier injection uses types; direct MongoDB query, no store dependency).
Task 7 depends on 4 (wires MCP server).
Task 8 depends on 5 (wires lifecycle into sweeper).
Task 9 is independent (template text changes).
Task 10 depends on 1+2+3 (migration uses store + embedder).
Task 11 depends on 5 (tests lifecycle scoring).

Parallel execution groups:
1. Task 1, Task 9 (independent)
2. Tasks 2, 3 (depend on 1)
3. Tasks 4, 5, 6, 10 (depend on 1-3)
4. Tasks 7, 8, 11 (depend on 4-6), then `npm run build`
5. `npm run check` (final gate)
