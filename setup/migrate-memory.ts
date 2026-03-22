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
