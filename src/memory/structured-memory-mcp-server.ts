/**
 * Structured Memory MCP Server — semantic + temporal memory with vector search.
 *
 * KPR-122 port: in-process via `createSdkMcpServer`. Tool handlers close over
 * the shared engine `Db` instead of opening a per-subprocess MongoClient. The
 * stdio shim at the bottom is preserved for the publish-ready bundle path.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ObjectId, type Db } from "mongodb";
import { MemoryStore } from "./memory-store.js";
import { MemoryEmbedder } from "./memory-embedder.js";
import type { MemoryType, MemoryImportance, MemoryTier, PurgeFilters } from "./memory-types.js";

export interface StructuredMemoryTurnContext {
  channelId?: string;
  threadId?: string;
}

/**
 * KPR-241: write-time guard thresholds. Defaults are conservative; operators
 * can tune via hive.yaml memory.writeGuards.*.
 */
export interface StructuredMemoryGuardConfig {
  burst: { enabled: boolean; windowMinutes: number; similarityThreshold: number; topK: number };
  oversize: { enabled: boolean; maxChars: number };
  rawDump: { enabled: boolean; jsonTokenThreshold: number; monolithCharThreshold: number };
}

const GUARD_DEFAULTS: StructuredMemoryGuardConfig = {
  burst: { enabled: true, windowMinutes: 1440, similarityThreshold: 0.92, topK: 5 },
  oversize: { enabled: true, maxChars: 6000 },
  rawDump: { enabled: true, jsonTokenThreshold: 300, monolithCharThreshold: 2000 },
};

export interface StructuredMemoryToolDeps {
  db: Db;
  agentId: string;
  /**
   * Mutable ref — runner mutates `.current` before each query() so the
   * channel/thread tagging on saved memories reflects the active turn.
   */
  context: { current: StructuredMemoryTurnContext };
  qdrantUrl?: string;
  ollamaUrl?: string;
  /**
   * KPR-213: optional invalidation hook plumbed into MemoryStore.setOnMutate.
   * Fired after any structured-memory mutation that may affect this agent's
   * hot-tier composition (save, update, delete, pin, unpin, set-tier, purge,
   * supersede, summarize, flag-for-review). Bulk-id paths fire `null` agent
   * → caller invalidates all.
   */
  onMutate?: (agentId: string | null, reason: string) => void;
  /** KPR-241: optional write-guard config; defaults to GUARD_DEFAULTS. */
  guardConfig?: StructuredMemoryGuardConfig;
}

const VALID_TYPES = ["fact", "task", "interaction", "preference", "decision", "summary"] as const;
const VALID_IMPORTANCE = ["critical", "high", "medium", "low"] as const;

export function buildStructuredMemoryTools(deps: StructuredMemoryToolDeps) {
  const { db, agentId, context } = deps;
  const store = new MemoryStore(db);
  // KPR-213: wire the prefix-cache invalidation hook into the MCP-owned store.
  // The store is per-MCP (one per AgentRunner), so the agentId parameter
  // forwarded by MemoryStore.setOnMutate is always this agent or `null`
  // (bulk path) — both mapped at the listener.
  if (deps.onMutate) store.setOnMutate(deps.onMutate);
  // Lazy init — schema/index creation happens on first use, not at module load,
  // so test harnesses without a real Mongo can still import the module.
  let initPromise: Promise<void> | null = null;
  function ensureInit(): Promise<void> {
    if (!initPromise) initPromise = store.init();
    return initPromise;
  }

  const embedder = new MemoryEmbedder(deps.qdrantUrl, deps.ollamaUrl);

  return [
    tool(
      "memory_save",
      "Save a new structured memory record. Use this to remember facts, tasks, interactions, preferences, decisions, or summaries.",
      {
        content: z.string().describe("The memory content — a fact, note, task, preference, or decision"),
        type: z.enum(VALID_TYPES).describe("Memory type: fact, task, interaction, preference, or decision"),
        topic: z.string().describe('Freeform topic tag, e.g. "customer:jones", "project:kitchen-reno"'),
        importance: z.enum(VALID_IMPORTANCE).describe("Importance level: critical, high, medium, or low"),
        sourceRef: z
          .string()
          .optional()
          .describe(
            "Pointer to system of record (Linear URL, GitHub link, Slack permalink, CRM record). URL form preferred. Add this when the memory references a fact that lives somewhere authoritative.",
          ),
      },
      async ({ content, type, topic, importance, sourceRef }) => {
        try {
          await ensureInit();
          const guard = deps.guardConfig ?? GUARD_DEFAULTS;

          // Oversize guard
          if (guard.oversize.enabled && content.length > guard.oversize.maxChars) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `memory_save error: content too long (${content.length} chars; limit ${guard.oversize.maxChars}). ` +
                    `Memory should be a digest, not a paste. Break into smaller records with a shared topic, ` +
                    `or save a digest + sourceRef pointing to the full source.`,
                },
              ],
            };
          }

          // Raw-fact-dump heuristic
          if (guard.rawDump.enabled && !sourceRef) {
            const isJsonLike = /^[{[]/.test(content.trim());
            const tokenEst = Math.ceil(content.length / 4);
            const tableLines = (content.match(/^\s*\|.*\|.*$/gm) ?? []).length;
            const isMonolith = !content.includes("\n") && content.length > guard.rawDump.monolithCharThreshold;
            const isJsonDump = isJsonLike && tokenEst > guard.rawDump.jsonTokenThreshold;
            const isTableDump = tableLines > 3;
            if (isJsonDump || isTableDump || isMonolith) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      `memory_save error: content looks like a raw dump from an external system. ` +
                      `Memory should hold a digest plus a sourceRef pointing to the original ` +
                      `(Linear URL, GitHub link, Slack permalink, CRM record).`,
                  },
                ],
              };
            }
          }

          // Burst guard — Qdrant-dependent, fail open on outage.
          if (guard.burst.enabled) {
            try {
              const recentSimilar = await embedder.search(content, agentId, {
                topic,
                limit: guard.burst.topK,
              });
              const cutoff = Date.now() - guard.burst.windowMinutes * 60_000;
              for (const sr of recentSimilar) {
                if (sr.score < guard.burst.similarityThreshold) continue;
                const existing = await store.getById(new ObjectId(sr.mongoId));
                if (!existing) continue;
                if (existing.createdAt.getTime() < cutoff) continue;
                if (existing.topic !== topic) continue;
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text:
                        `memory_save error: too similar to existing record [${existing._id}] in topic "${topic}" ` +
                        `(similarity ${sr.score.toFixed(2)}). Use memory_update on the existing record, ` +
                        `or add a sourceRef to distinguish if these are different sources.`,
                    },
                  ],
                };
              }
            } catch (err) {
              // KPR-241: fail open — Qdrant outage skips burst check only, save proceeds.
              process.stderr.write(`memory_save burst-guard skipped: ${String(err)}\n`);
            }
          }

          // All guards passed (or skipped on outage). Save.
          const pointId = crypto.randomUUID();
          const record = await store.save(
            agentId,
            { content, type: type as MemoryType, topic, importance: importance as MemoryImportance, sourceRef },
            pointId,
            context.current.channelId,
            context.current.threadId,
          );

          embedder
            .upsert(pointId, content, {
              agentId,
              mongoId: record._id!.toString(),
              type,
              topic,
              tier: "hot",
              importance,
              createdAt: Math.floor(record.createdAt.getTime() / 1000),
            })
            .catch((err) => {
              process.stderr.write(`memory_save embed error: ${err}\n`);
            });

          return {
            content: [
              {
                type: "text",
                text: `Saved memory [${record._id}] — type:${type} topic:"${topic}" importance:${importance}`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_save error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_recall",
      "Search your memories semantically. Returns the most relevant memories across all tiers (hot, warm, cold). Use this before starting tasks to find relevant context.",
      {
        query: z.string().describe("What to search for — natural language query"),
        type: z
          .enum([...VALID_TYPES, "summary"])
          .optional()
          .describe("Filter by memory type"),
        topic: z.string().optional().describe("Filter by topic tag"),
        tier: z.enum(["hot", "warm", "cold"]).optional().describe("Filter by tier"),
        importance: z.enum(VALID_IMPORTANCE).optional().describe("Filter by importance"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
      async ({ query, type, topic, tier, importance, limit }) => {
        try {
          await ensureInit();
          // KPR-241: must_not filter to hide cold from default recall.
          const extraMustNot = tier === undefined ? [{ key: "tier", match: { value: "cold" } }] : [];
          const searchResults = await embedder.search(
            query,
            agentId,
            {
              type: type as MemoryType,
              topic,
              tier: tier as MemoryTier,
              importance: importance as MemoryImportance,
              limit,
            },
            extraMustNot,
          );

          if (searchResults.length === 0) {
            return { content: [{ type: "text", text: "No matching memories found." }] };
          }

          const ids = searchResults.map((r) => new ObjectId(r.mongoId));
          // KPR-241: hide summarized originals from normal recall.
          const allRecords = await store.getByIds(ids, { excludeSummarized: true });
          const recordMap = new Map(allRecords.map((r) => [r._id!.toString(), r]));

          const records: string[] = [];
          for (const sr of searchResults) {
            const record = recordMap.get(sr.mongoId);
            if (!record) continue;
            const pinLabel = record.pinned ? " [pinned]" : "";
            const date = record.updatedAt.toISOString().split("T")[0];
            records.push(
              `**[${record._id}]** (${record.type}/${record.importance}, ${record.tier}${pinLabel}, ${date}, relevance: ${sr.score.toFixed(2)})\n` +
                `Topic: ${record.topic}\n${record.content}`,
            );
          }

          await store.touchAccess(ids);

          if (records.length === 0) {
            return { content: [{ type: "text", text: "No matching memories found." }] };
          }
          return { content: [{ type: "text", text: records.join("\n\n---\n\n") }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_recall error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_update",
      "Update an existing memory record's content and/or importance. Resets recency.",
      {
        id: z.string().describe("Memory record ID (from memory_recall results)"),
        content: z.string().describe("Updated content"),
        importance: z.enum(VALID_IMPORTANCE).optional().describe("Updated importance level"),
      },
      async ({ id, content, importance }) => {
        try {
          await ensureInit();
          let objectId: ObjectId;
          try {
            objectId = new ObjectId(id);
          } catch {
            return { isError: true, content: [{ type: "text", text: `Invalid memory ID: ${id}` }] };
          }

          const existing = await store.getById(objectId);
          if (!existing || existing.agentId !== agentId) {
            return { isError: true, content: [{ type: "text", text: `Memory not found: ${id}` }] };
          }

          const updated = await store.update(objectId, content, importance);
          if (!updated) {
            return { isError: true, content: [{ type: "text", text: `Failed to update memory: ${id}` }] };
          }

          embedder
            .upsert(updated.qdrantPointId, content, {
              agentId,
              mongoId: id,
              type: updated.type,
              topic: updated.topic,
              tier: updated.tier,
              importance: updated.importance,
              createdAt: Math.floor(updated.createdAt.getTime() / 1000),
            })
            .catch((err) => {
              process.stderr.write(`memory_update embed error: ${err}\n`);
            });

          return { content: [{ type: "text", text: `Updated memory [${id}]` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_update error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_pin",
      "Pin a memory to the hot tier. Pinned memories are always included in your context. Use for critical facts that must never be forgotten.",
      {
        id: z.string().describe("Memory record ID to pin"),
      },
      async ({ id }) => {
        try {
          await ensureInit();
          let objectId: ObjectId;
          try {
            objectId = new ObjectId(id);
          } catch {
            return { isError: true, content: [{ type: "text", text: `Invalid memory ID: ${id}` }] };
          }

          const existing = await store.getById(objectId);
          if (!existing || existing.agentId !== agentId) {
            return { isError: true, content: [{ type: "text", text: `Memory not found: ${id}` }] };
          }

          await store.pin(objectId);
          return { content: [{ type: "text", text: `Pinned memory [${id}] — will stay in your active context` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_pin error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_unpin",
      "Remove pin from a memory, returning it to normal lifecycle scoring. It may be demoted to warm/cold on the next sweep.",
      {
        id: z.string().describe("Memory record ID to unpin"),
      },
      async ({ id }) => {
        try {
          await ensureInit();
          let objectId: ObjectId;
          try {
            objectId = new ObjectId(id);
          } catch {
            return { isError: true, content: [{ type: "text", text: `Invalid memory ID: ${id}` }] };
          }

          const existing = await store.getById(objectId);
          if (!existing || existing.agentId !== agentId) {
            return { isError: true, content: [{ type: "text", text: `Memory not found: ${id}` }] };
          }

          await store.unpin(objectId);
          return { content: [{ type: "text", text: `Unpinned memory [${id}] — will be scored normally` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_unpin error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_forget",
      "Permanently delete a memory. Use when information is no longer relevant or was saved in error.",
      {
        id: z.string().describe("Memory record ID to delete"),
      },
      async ({ id }) => {
        try {
          await ensureInit();
          let objectId: ObjectId;
          try {
            objectId = new ObjectId(id);
          } catch {
            return { isError: true, content: [{ type: "text", text: `Invalid memory ID: ${id}` }] };
          }

          const existing = await store.getById(objectId);
          if (!existing || existing.agentId !== agentId) {
            return { isError: true, content: [{ type: "text", text: `Memory not found: ${id}` }] };
          }

          await store.delete(objectId);

          embedder.remove(existing.qdrantPointId).catch((err) => {
            process.stderr.write(`memory_forget embed error: ${err}\n`);
          });

          return { content: [{ type: "text", text: `Forgotten memory [${id}]` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_forget error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_purge",
      "Bulk soft-delete memories by filter. Purged records become invisible immediately and are permanently deleted after the retention period (default 7 days). At least one filter is required. Pinned records are never purged — unpin them first.",
      {
        topic: z.string().optional().describe('Exact match on topic tag, e.g. "pipeline-review"'),
        type: z
          .enum(VALID_TYPES)
          .optional()
          .describe("Filter by memory type: fact, task, interaction, preference, decision, or summary"),
        importance: z.enum(VALID_IMPORTANCE).optional().describe("Filter by importance level"),
        tier: z.enum(["hot", "warm", "cold"]).optional().describe("Filter by current tier"),
        olderThan: z
          .string()
          .optional()
          .describe("ISO 8601 date string — purge records with updatedAt before this date"),
      },
      async ({ topic, type, importance, tier, olderThan }) => {
        try {
          await ensureInit();
          const hasFilter =
            topic !== undefined ||
            type !== undefined ||
            importance !== undefined ||
            tier !== undefined ||
            olderThan !== undefined;

          if (!hasFilter) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "At least one filter is required (topic, type, importance, tier, or olderThan). Provide a filter to avoid an accidental full purge.",
                },
              ],
            };
          }

          const filters: PurgeFilters = {};
          if (topic !== undefined) filters.topic = topic;
          if (type !== undefined) filters.type = type as MemoryType;
          if (importance !== undefined) filters.importance = importance as MemoryImportance;
          if (tier !== undefined) filters.tier = tier as MemoryTier;
          if (olderThan !== undefined) {
            const parsed = new Date(olderThan);
            if (isNaN(parsed.getTime())) {
              return {
                isError: true,
                content: [{ type: "text", text: `Invalid date for olderThan: "${olderThan}"` }],
              };
            }
            filters.olderThan = parsed;
          }

          const count = await store.purge(agentId, filters);

          const parts: string[] = [];
          if (filters.topic !== undefined) parts.push(`topic:"${filters.topic}"`);
          if (filters.type !== undefined) parts.push(`type:${filters.type}`);
          if (filters.importance !== undefined) parts.push(`importance:${filters.importance}`);
          if (filters.tier !== undefined) parts.push(`tier:${filters.tier}`);
          if (filters.olderThan !== undefined) parts.push(`olderThan:${filters.olderThan.toISOString()}`);

          const summary = parts.join(" ");
          const noun = count === 1 ? "memory" : "memories";
          return { content: [{ type: "text", text: `Purged ${count} ${noun} matching ${summary}` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_purge error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_review",
      "Returns all your hot-tier memories with staleness signals for review. Use this during scheduled memory-review tasks to audit your knowledge. For stale or outdated records, use memory_purge (bulk) or memory_forget (single). For records that need correction, use memory_update.",
      {},
      async () => {
        try {
          await ensureInit();
          const records = await store.getHotTierWithStats(agentId);

          if (records.length === 0) {
            return { content: [{ type: "text", text: "No hot-tier memories to review." }] };
          }

          const STALE_THRESHOLD_DAYS = 14;
          const lines: string[] = [`Your hot-tier memories (${records.length} records):`, ""];

          for (const r of records) {
            const id = String(r._id);
            const flags: string[] = [];
            if (r.pinned) flags.push("📌 pinned");
            if (r.daysSinceAccess >= STALE_THRESHOLD_DAYS) flags.push(`⚠ Not accessed in ${r.daysSinceAccess} days`);

            lines.push(
              `[ID: ${id}] topic:"${r.topic}" type:${r.type} importance:${r.importance}`,
              `  Created: ${r.createdAt.toISOString().slice(0, 10)} | Last accessed: ${r.lastAccessedAt.toISOString().slice(0, 10)} | Access count: ${r.accessCount}`,
              `  Content: "${r.content.length > 120 ? r.content.slice(0, 120) + "..." : r.content}"`,
            );
            if (flags.length > 0) lines.push(`  ${flags.join(" | ")}`);
            lines.push("");
          }

          lines.push(
            "Review each memory. For stale or outdated records, use memory_purge (bulk by filter) or memory_forget (single by ID).",
          );
          lines.push("For records that need correction, use memory_update.");

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_review error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createStructuredMemoryMcpServer(deps: StructuredMemoryToolDeps) {
  return createSdkMcpServer({
    name: "structured-memory",
    version: "1.0.0",
    tools: buildStructuredMemoryTools(deps),
  });
}

/**
 * KPR-216 scaffolding — NOT wired in. `AgentManager.spawnTurn` reuses
 * `AgentRunner` per spawn, which keeps the existing `*ContextRef` path.
 * Kept for KPR-220 when `AgentRunner` retires.
 */
export interface StructuredMemoryTurnDeps {
  db: Db;
  agentId: string;
  channelId?: string;
  threadId?: string;
  qdrantUrl?: string;
  ollamaUrl?: string;
  onMutate?: (agentId: string | null, reason: string) => void;
}

export function buildStructuredMemoryMcpForTurn(deps: StructuredMemoryTurnDeps) {
  const contextRef: { current: StructuredMemoryTurnContext } = {
    current: { channelId: deps.channelId, threadId: deps.threadId },
  };
  return createSdkMcpServer({
    name: "structured-memory",
    version: "1.0.0",
    tools: buildStructuredMemoryTools({
      db: deps.db,
      agentId: deps.agentId,
      context: contextRef,
      qdrantUrl: deps.qdrantUrl,
      ollamaUrl: deps.ollamaUrl,
      onMutate: deps.onMutate,
    }),
  });
}
