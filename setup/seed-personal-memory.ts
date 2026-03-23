#!/usr/bin/env node

/**
 * Seed structured memory for the personal instance.
 * Hand-classified from legacy memory.md blobs.
 *
 * Usage: HIVE_CONFIG=hive-personal.yaml npx tsx setup/seed-personal-memory.ts [--dry-run]
 */

import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { MemoryEmbedder } from "../src/memory/memory-embedder.js";
import type { MemoryType, MemoryImportance } from "../src/memory/memory-types.js";

const dryRun = process.argv.includes("--dry-run");

interface SeedEntry {
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
}

const AGENT_ID = "chief-of-staff";

const entries: SeedEntry[] = [
  // Product strategy — core thesis
  {
    content:
      "Hive is a product we're building and selling, not just internal infrastructure. The Mokie Huang persona is the living proof of concept — the 'stealth startup' IS Hive.",
    type: "decision",
    topic: "hive:product-strategy",
    importance: "critical",
  },
  {
    content:
      "Target user: accomplished executives (VP to C-suite, 15-25 years in, $300-600K+) who miss making things. They rose because they were exceptional ICs — now AI lets them build again.",
    type: "fact",
    topic: "hive:target-user",
    importance: "critical",
  },
  {
    content:
      'Core positioning: "You didn\'t get promoted because you were good at meetings. Give yourself a team that lets you build again." Identity restoration for high-achievers, not time savings.',
    type: "decision",
    topic: "hive:positioning",
    importance: "high",
  },
  {
    content:
      "Business model: $500/mo per subscriber. ~$200 to Anthropic (compute), ~$300 net. Target users won't blink at this price.",
    type: "decision",
    topic: "hive:business-model",
    importance: "high",
  },
  {
    content:
      "Why Hive beats DIY AI tools: curated and controlled, adult and safe (built for people with reputations), familiar role templates (COS, EA, SDR, PM, Engineering), private sandbox with no org politics.",
    type: "fact",
    topic: "hive:differentiation",
    importance: "high",
  },
  // Social strategy
  {
    content:
      "Mokie Huang operates across LinkedIn, Facebook, Instagram, Reddit, X. Primary goal: build narrative for Hive as a product. Secondary: drive Dodi awareness organically. Gradually surface the Hive story.",
    type: "decision",
    topic: "hive:social-strategy",
    importance: "medium",
  },
  {
    content:
      "Social framing: real person with genuine interests who happens to work in the space. Mention DodiHome when appropriate — no hard sell. Eventually: 'here's what I'm building, here's what my team looks like'.",
    type: "preference",
    topic: "hive:social-strategy",
    importance: "medium",
  },
  // Use cases by role
  {
    content:
      "CEO use case: test a marketing concept without 3-6 months of project planning through the org. CRO: follow through prep and engagement of key accounts. CTO: build out ideas properly — spec-driven, well-tested, shippable.",
    type: "fact",
    topic: "hive:use-cases",
    importance: "medium",
  },
  // Open questions
  {
    content:
      "Open questions for Hive product: TAM/SAM/SOM sizing, productization/packaging strategy, GTM channel strategy (LinkedIn obvious starting point), Mokie content narrative arc.",
    type: "task",
    topic: "hive:product-strategy",
    importance: "medium",
  },
];

console.log(`Seeding ${entries.length} structured memories for ${AGENT_ID}${dryRun ? " (DRY RUN)" : ""}`);

if (dryRun) {
  for (const e of entries) {
    console.log(`  [${e.type}/${e.importance}] ${e.topic}: ${e.content.slice(0, 80)}...`);
  }
  process.exit(0);
}

const store = new MemoryStore(config.mongo.uri, config.mongo.dbName);
await store.init();
const embedder = new MemoryEmbedder();

for (const entry of entries) {
  const pointId = randomUUID();
  const record = await store.save(
    AGENT_ID,
    {
      content: entry.content,
      type: entry.type,
      topic: entry.topic,
      importance: entry.importance,
    },
    pointId,
  );

  await embedder.upsert(pointId, entry.content, {
    agentId: AGENT_ID,
    mongoId: record._id!.toString(),
    type: entry.type,
    topic: entry.topic,
    tier: "hot",
    importance: entry.importance,
    createdAt: Math.floor(Date.now() / 1000),
  });

  console.log(`  ✓ [${entry.type}/${entry.importance}] ${entry.topic}`);
}

console.log(`\nSeeded ${entries.length} records into agent_memory + Qdrant`);
await store.close();
process.exit(0);
