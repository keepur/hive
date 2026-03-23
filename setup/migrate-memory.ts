#!/usr/bin/env node

/**
 * Memory Migration Script — converts legacy memory.md blobs to structured records.
 *
 * Usage: npx tsx setup/migrate-memory.ts [--dry-run] [--agent <id>]
 *
 * Reads from legacy `memory` collection, classifies via local Ollama model,
 * writes to `agent_memory` + Qdrant.
 *
 * Requires: Ollama running with qwen2.5:3b (or override via MIGRATE_MODEL env var)
 */

import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { MemoryEmbedder } from "../src/memory/memory-embedder.js";
import type { MemoryRecordInput, MemoryType, MemoryImportance } from "../src/memory/memory-types.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.MIGRATE_MODEL ?? "qwen2.5:3b";
const VALID_TYPES = new Set(["fact", "task", "interaction", "preference", "decision"]);
const VALID_IMPORTANCE = new Set(["critical", "high", "medium", "low"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;
const skipPaths = new Set(args.includes("--skip") ? args[args.indexOf("--skip") + 1].split(",") : []);

console.log(`Memory migration${dryRun ? " (DRY RUN)" : ""}${agentFilter ? ` for agent: ${agentFilter}` : ""}`);
console.log(`Using model: ${OLLAMA_MODEL} at ${OLLAMA_URL}`);

// Verify Ollama is running and model is available
try {
  const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!tagsRes.ok) throw new Error(`Ollama not responding: ${tagsRes.status}`);
  const tags = await tagsRes.json();
  const available = tags.models?.map((m: any) => m.name) ?? [];
  if (!available.some((n: string) => n.startsWith(OLLAMA_MODEL.split(":")[0]))) {
    console.error(`Model ${OLLAMA_MODEL} not found. Available: ${available.join(", ")}`);
    console.error(`Run: ollama pull ${OLLAMA_MODEL}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Cannot connect to Ollama at ${OLLAMA_URL}. Is it running?`);
  process.exit(1);
}

async function classifyWithOllama(text: string, filename: string): Promise<MemoryRecordInput[]> {
  const prompt = [
    "You are classifying agent memory entries. Split the text into individual memories.",
    "",
    "TYPE DEFINITIONS (pick the BEST match):",
    "- fact: Durable knowledge — a person's role, a system's capability, a business model, a target market, a product description, a strategy statement, a data point. MOST entries are facts.",
    '- decision: A choice that was made, with rationale — "we chose X because Y"',
    "- preference: How something should be done — a routing rule, a style guide, a communication approach",
    "- interaction: Something that HAPPENED on a specific date — a status report, a completed action, a conversation. ONLY use for dated events.",
    "- task: A FUTURE action someone must take — only if there's a clear owner and deadline.",
    "",
    "WHEN IN DOUBT: choose fact. Strategy, positioning, target user profiles, business models, and product descriptions are ALL facts.",
    "",
    "EXAMPLES:",
    '- "Hive is a product we\'re building and selling" → fact (durable knowledge about the product)',
    '- "Target user: VP to C-suite executives, $300-600K+" → fact (market/user knowledge)',
    '- "Business model: $500/mo per subscriber" → fact (business data point)',
    '- "We chose to position Hive as identity restoration, not time savings" → decision (strategic choice with rationale)',
    '- "Zhitong completed JOB-1717 on 3/20" → interaction (event that happened on a date)',
    '- "JOB-1731 is overdue since 3/19" → interaction (reporting current state at a point in time)',
    '- "Follow up with Jones by Friday" → task (future action with deadline)',
    '- "Homeowners assigned to Lauren, all others to Corey" → preference (routing rule)',
    '- "No hard sell on social — mention DodiHome when appropriate" → preference (communication style)',
    "",
    "For each entry:",
    "- content: 1-2 sentence summary",
    "- type: fact, task, interaction, preference, or decision",
    `- topic: short tag (e.g. "ops:production", "sales:pipeline", "team:people")`,
    "- importance: critical, high, medium, low",
    "",
    `Source file: ${filename}`,
    "",
    "Return ONLY a JSON array. No markdown fences, no explanation.",
    "",
    "Text:",
    text,
  ].join("\n");

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`);
  const data = await res.json();
  const responseText = (data.response ?? "").trim();

  // Parse JSON, stripping markdown fences if present
  const cleaned = responseText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Response is not a JSON array");

  // Validate and sanitize each entry
  return parsed
    .filter((e: any) => e.content && typeof e.content === "string")
    .map((e: any) => ({
      content: e.content.trim(),
      type: VALID_TYPES.has(e.type) ? e.type : "fact",
      topic: typeof e.topic === "string" ? e.topic : "general",
      importance: VALID_IMPORTANCE.has(e.importance) ? e.importance : "medium",
    }));
}

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

let totalMigrated = 0;
let totalSkipped = 0;

for (const doc of legacyDocs) {
  const pathParts = doc.path.split("/");
  const agentId = pathParts[1];
  const filename = pathParts.slice(2).join("/");

  if (skipPaths.has(filename) || skipPaths.has(doc.path)) {
    console.log(`\nSkipping: ${doc.path} (in skip list)`);
    totalSkipped++;
    continue;
  }

  console.log(`\nProcessing: ${doc.path} (${doc.content.length} chars)`);

  const content = doc.content;
  if (!content || content.trim().length === 0) {
    console.log("  Skipping — empty content");
    totalSkipped++;
    continue;
  }

  // Chunk if content is large (>16K chars ≈ 4K tokens)
  const chunks: string[] = [];
  if (content.length > 16000) {
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
    let entries: MemoryRecordInput[];
    try {
      entries = await classifyWithOllama(chunk, filename);
    } catch (err) {
      console.log(`  Failed to classify chunk — ${err}`);
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
      const pointId = randomUUID();
      const record = await store.save(
        agentId,
        {
          content: entry.content,
          type: entry.type as MemoryType,
          topic: entry.topic,
          importance: entry.importance as MemoryImportance,
        },
        pointId,
      );

      await embedder.upsert(pointId, entry.content, {
        agentId,
        mongoId: record._id!.toString(),
        type: entry.type,
        topic: entry.topic,
        tier: "hot",
        importance: entry.importance,
        createdAt: Math.floor(Date.now() / 1000),
      });

      totalMigrated++;
      console.log(`    ✓ [${entry.type}/${entry.importance}] ${entry.topic}`);
    }
  }
}

console.log(`\nMigration complete: ${totalMigrated} records created, ${totalSkipped} files skipped`);
await store.close();
await mongo.close();
process.exit(0);
