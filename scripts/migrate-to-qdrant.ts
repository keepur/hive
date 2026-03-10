#!/usr/bin/env npx tsx

/**
 * Migration script: re-embed all HubSpot records from Atlas and load into local Qdrant.
 *
 * Reads from Atlas MongoDB (rag_contacts, rag_deals, rag_activities),
 * re-embeds each record's embeddingText via local Ollama (nomic-embed-text, 768 dims),
 * and upserts into local Qdrant (contacts, deals, activities).
 *
 * Usage: npx tsx scripts/migrate-to-qdrant.ts
 */

import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ATLAS_URI = process.env.MONGODB_ATLAS_URI;
if (!ATLAS_URI) {
  console.error("Error: MONGODB_ATLAS_URI environment variable is required");
  process.exit(1);
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large";
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS ?? "1024", 10);
const EMBED_BATCH_SIZE = 100;
const QDRANT_UPSERT_BATCH = 100;
const OLLAMA_MAX_RETRIES = 3;
const OLLAMA_RETRY_DELAY_MS = 2000;

// UUID v5 namespace (DNS namespace UUID)
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ---------------------------------------------------------------------------
// UUID v5 implementation (deterministic UUID from name string)
// ---------------------------------------------------------------------------

function uuidV5(name: string, namespace: string): string {
  // Parse namespace UUID into bytes
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");

  // Hash namespace + name with SHA-1
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();

  // Set version (5) and variant (RFC 4122) bits
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant RFC 4122

  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function pointId(objectType: string, hubspotId: string): string {
  return uuidV5(`${objectType}:${hubspotId}`, UUID_NAMESPACE);
}

// ---------------------------------------------------------------------------
// Ollama embedding
// ---------------------------------------------------------------------------

async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings;
    } catch (err: any) {
      if (attempt < OLLAMA_MAX_RETRIES) {
        console.warn(`  Ollama attempt ${attempt} failed: ${err.message} — retrying in ${OLLAMA_RETRY_DELAY_MS}ms`);
        await sleep(OLLAMA_RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Qdrant REST helpers (no SDK dependency — just fetch)
// ---------------------------------------------------------------------------

async function qdrantUpsert(
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant upsert ${res.status}: ${body}`);
  }
}

async function qdrantCount(collection: string): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant count ${res.status}: ${body}`);
  }
  const data = (await res.json()) as any;
  return data.result?.points_count ?? 0;
}

// ---------------------------------------------------------------------------
// Payload extractors per collection
// ---------------------------------------------------------------------------

function contactPayload(doc: any): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.hubspotId),
    objectType: doc.objectType ?? "contact",
    embeddingText: doc.embeddingText ?? "",
    name: [props.firstname, props.lastname].filter(Boolean).join(" ") || props.name || "",
    email: props.email ?? "",
    phone: props.phone ?? "",
    company: props.company ?? "",
    lifecyclestage: props.lifecyclestage ?? "",
    city: props.city ?? "",
    state: props.state ?? "",
    syncedAt: new Date().toISOString(),
  };
}

function dealPayload(doc: any): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.hubspotId),
    objectType: doc.objectType ?? "deal",
    embeddingText: doc.embeddingText ?? "",
    dealname: props.dealname ?? "",
    amount: props.amount != null ? Number(props.amount) : null,
    dealstage: props.dealstage ?? "",
    pipeline: props.pipeline ?? "",
    closedate: props.closedate ?? "",
    contactNames: props.contactNames ?? [],
    syncedAt: new Date().toISOString(),
  };
}

function activityPayload(doc: any): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.hubspotId),
    objectType: doc.objectType ?? "activity",
    embeddingText: doc.embeddingText ?? "",
    engagementType: props.hs_engagement_type ?? props.engagementType ?? doc.objectType ?? "",
    timestamp: props.hs_timestamp ?? props.timestamp ?? "",
    contactNames: props.contactNames ?? [],
    syncedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collection migration config
// ---------------------------------------------------------------------------

interface CollectionConfig {
  atlasCollection: string;
  qdrantCollection: string;
  payloadFn: (doc: any) => Record<string, any>;
}

const COLLECTIONS: CollectionConfig[] = [
  { atlasCollection: "rag_contacts", qdrantCollection: "contacts", payloadFn: contactPayload },
  { atlasCollection: "rag_deals", qdrantCollection: "deals", payloadFn: dealPayload },
  { atlasCollection: "rag_activities", qdrantCollection: "activities", payloadFn: activityPayload },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(startMs: number): string {
  const secs = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function migrateCollection(
  db: any,
  config: CollectionConfig,
): Promise<number> {
  const { atlasCollection, qdrantCollection, payloadFn } = config;
  console.log(`\n=== Migrating ${atlasCollection} -> ${qdrantCollection} ===`);

  const col = db.collection(atlasCollection);
  const totalCount = await col.countDocuments();
  console.log(`  Total records in Atlas: ${totalCount}`);

  const cursor = col.find({}, { projection: { _id: 0 } });

  let processed = 0;
  let skipped = 0;
  let batch: any[] = [];
  const startMs = Date.now();

  for await (const doc of cursor) {
    const text = doc.embeddingText;
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      skipped++;
      continue;
    }

    batch.push(doc);

    if (batch.length >= EMBED_BATCH_SIZE) {
      await processBatch(batch, qdrantCollection, payloadFn);
      processed += batch.length;
      batch = [];

      if (processed % 1000 === 0 || processed === totalCount) {
        console.log(`  ${qdrantCollection}: ${processed}/${totalCount} processed (${elapsed(startMs)}, ${skipped} skipped)`);
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await processBatch(batch, qdrantCollection, payloadFn);
    processed += batch.length;
  }

  console.log(`  ${qdrantCollection}: DONE — ${processed} embedded, ${skipped} skipped (${elapsed(startMs)})`);
  return processed;
}

async function processBatch(
  docs: any[],
  qdrantCollection: string,
  payloadFn: (doc: any) => Record<string, any>,
): Promise<void> {
  // bge-large context limit is 512 tokens (~1500 chars); truncate aggressively
  const texts = docs.map((d) => {
    const t = d.embeddingText as string;
    return t.length > 1000 ? t.slice(0, 1000) : t;
  });
  let embeddings: number[][];
  try {
    embeddings = await embedBatch(texts);
  } catch (err: any) {
    if (err.message?.includes("context length")) {
      // Fallback: embed one-by-one with extreme truncation
      console.warn(`  Batch too long, falling back to individual embeds (${texts.length} docs)`);
      embeddings = [];
      for (const t of texts) {
        const short = t.length > 500 ? t.slice(0, 500) : t;
        const [vec] = await embedBatch([short]);
        embeddings.push(vec!);
      }
    } else {
      throw err;
    }
  }

  const points = docs.map((doc, i) => {
    const payload = payloadFn(doc);
    const objectType = payload.objectType || "unknown";
    const id = pointId(objectType, String(doc.hubspotId));
    return { id, vector: embeddings[i]!, payload };
  });

  // Upsert in sub-batches if needed
  for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH) {
    const slice = points.slice(i, i + QDRANT_UPSERT_BATCH);
    await qdrantUpsert(qdrantCollection, slice);
  }
}

async function main(): Promise<void> {
  const totalStart = Date.now();
  console.log(`Migrate-to-Qdrant: Atlas -> Ollama (${EMBED_MODEL}, ${EMBED_DIMS}d) -> Qdrant`);
  console.log(`  Atlas URI: ${ATLAS_URI!.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`  Ollama:    ${OLLAMA_URL}`);
  console.log(`  Qdrant:    ${QDRANT_URL}`);
  console.log(`  Batch size: ${EMBED_BATCH_SIZE}`);

  // Verify Ollama is running
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    console.log("  Ollama: connected");
  } catch (err: any) {
    console.error(`Error: Cannot connect to Ollama at ${OLLAMA_URL}: ${err.message}`);
    process.exit(1);
  }

  // Verify Qdrant is running
  try {
    const res = await fetch(`${QDRANT_URL}/collections`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    console.log("  Qdrant: connected");
  } catch (err: any) {
    console.error(`Error: Cannot connect to Qdrant at ${QDRANT_URL}: ${err.message}`);
    process.exit(1);
  }

  // Connect to Atlas
  const client = new MongoClient(ATLAS_URI!);
  await client.connect();
  console.log("  Atlas:  connected");
  const db = client.db("hubspot");

  const skipCols = new Set((process.env.SKIP_RECREATE ?? "").split(",").filter(Boolean));

  // Recreate collections at correct dimensions
  for (const config of COLLECTIONS) {
    if (skipCols.has(config.qdrantCollection)) {
      console.log(`  Skipping recreation of: ${config.qdrantCollection}`);
      continue;
    }
    const col = config.qdrantCollection;
    // Delete existing collection
    try {
      await fetch(`${QDRANT_URL}/collections/${col}`, { method: "DELETE" });
      console.log(`  Deleted collection: ${col}`);
    } catch { /* doesn't exist, fine */ }
    // Create with correct dimensions
    const createRes = await fetch(`${QDRANT_URL}/collections/${col}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: EMBED_DIMS, distance: "Cosine" },
      }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Failed to create ${col}: ${body}`);
    }
    console.log(`  Created collection: ${col} (${EMBED_DIMS} dims, Cosine)`);
  }

  const skipMigrate = new Set((process.env.SKIP_MIGRATE ?? "").split(",").filter(Boolean));

  // Migrate each collection
  const results: Record<string, number> = {};
  for (const config of COLLECTIONS) {
    if (skipMigrate.has(config.qdrantCollection)) {
      console.log(`  Skipping migration of: ${config.qdrantCollection}`);
      continue;
    }
    results[config.qdrantCollection] = await migrateCollection(db, config);
  }

  await client.close();

  // Verify Qdrant counts
  console.log("\n=== Verification: Qdrant record counts ===");
  for (const config of COLLECTIONS) {
    const count = await qdrantCount(config.qdrantCollection);
    const migrated = results[config.qdrantCollection] ?? 0;
    console.log(`  ${config.qdrantCollection}: ${count} points (migrated ${migrated} this run)`);
  }

  console.log(`\nMigration complete in ${elapsed(totalStart)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
