#!/usr/bin/env npx tsx
/**
 * HubSpot Embedding Pipeline — Stage 2 of ETL
 *
 * Reads from staging collections (populated by hubspot-extract.ts),
 * builds embedding text for each record, calls Voyage AI to generate
 * vector embeddings, and stores them in rag_* collections for
 * Atlas Vector Search.
 *
 * Usage:
 *   npx tsx src/hubspot/hubspot-embed.ts [options]
 *
 * Options:
 *   --dry-run       Preview counts and sample texts without calling Voyage
 *   --reembed       Force re-embed all records (ignore existing embeddings)
 *   --objects TYPE   Embed specific type only
 *
 * Env vars:
 *   VOYAGE_API_KEY     — Voyage AI API key
 *   MONGODB_ATLAS_URI  — Atlas cluster (staging + RAG collections)
 */

import dotenv from "dotenv";
dotenv.config();

import { MongoClient, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("hubspot-embed");

// ── Config ──────────────────────────────────────────────────────────────────

const VOYAGE_MODEL = "voyage-4-lite";
const EMBED_DIMENSIONS = 1024;
const EMBED_BATCH_SIZE = 128;
const EMBED_TEXT_MAX = 2000;
const MAX_RETRIES = 3;

// ── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const after = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const dryRun = has("--dry-run");
  const reembed = has("--reembed");
  const objects = after("--objects");

  const VALID_OBJECTS = [
    "contacts", "companies", "deals", "tasks",
    "notes", "calls", "communications", "emails", "meetings",
    "form_submissions",
  ];
  if (objects && !VALID_OBJECTS.includes(objects)) {
    log.error("Invalid --objects value", { objects, valid: VALID_OBJECTS });
    process.exit(1);
  }

  return { dryRun, reembed, objects };
}

// ── Embedding Text Builders ─────────────────────────────────────────────────

function truncate(text: string | null | undefined, max = EMBED_TEXT_MAX): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function contactEmbedText(props: Record<string, any>): string {
  const name = [props.firstname, props.lastname].filter(Boolean).join(" ") || "Unknown";
  const parts = [`Contact: ${name}`];
  if (props.email) parts.push(`Email: ${props.email}`);
  if (props.phone) parts.push(`Phone: ${props.phone}`);
  if (props.company) parts.push(`Company: ${props.company}`);
  if (props.jobtitle) parts.push(`Title: ${props.jobtitle}`);
  const tags = [props.lifecyclestage, props.hs_lead_status, props.contact_type].filter(Boolean);
  if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);
  const location = [props.city, props.state].filter(Boolean).join(", ");
  if (location) parts.push(`Location: ${location}`);
  return parts.join(". ") + ".";
}

function companyEmbedText(props: Record<string, any>): string {
  const parts = [`Company: ${props.name || "Unknown"}`];
  if (props.domain) parts.push(`Domain: ${props.domain}`);
  if (props.industry) parts.push(`Industry: ${props.industry}`);
  if (props.description) parts.push(`Description: ${truncate(props.description, 500)}`);
  const location = [props.city, props.state].filter(Boolean).join(", ");
  if (location) parts.push(`Location: ${location}`);
  return parts.join(". ") + ".";
}

function dealEmbedText(props: Record<string, any>): string {
  const parts = [`Deal: ${props.dealname || "Unknown"}`];
  if (props.amount) parts.push(`Amount: $${parseFloat(props.amount).toLocaleString()}`);
  if (props.dealstage) parts.push(`Stage: ${props.dealstage}`);
  if (props.pipeline) parts.push(`Pipeline: ${props.pipeline}`);
  if (props.closedate) parts.push(`Close: ${props.closedate.split("T")[0]}`);
  if (props.description) parts.push(`Description: ${truncate(props.description, 500)}`);
  return parts.join(". ") + ".";
}

function taskEmbedText(props: Record<string, any>): string {
  const parts = [`Task: ${props.hs_task_subject || "(no subject)"}`];
  if (props.hs_task_status) parts.push(`Status: ${props.hs_task_status}`);
  if (props.hs_task_priority) parts.push(`Priority: ${props.hs_task_priority}`);
  if (props.hs_task_body) parts.push(`Body: ${truncate(props.hs_task_body, 1000)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  return parts.join(". ") + ".";
}

function noteEmbedText(props: Record<string, any>): string {
  const parts = [`Note: ${truncate(props.hs_note_body, 1500) || "(empty)"}`];
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  return parts.join(". ") + ".";
}

function callEmbedText(props: Record<string, any>): string {
  const dir = props.hs_call_direction ?? "";
  const parts = [`Call${dir ? ` (${dir})` : ""}: ${props.hs_call_title || "(no title)"}`];
  if (props.hs_call_duration) parts.push(`Duration: ${Math.round(parseInt(props.hs_call_duration) / 1000)}s`);
  if (props.hs_call_disposition) parts.push(`Disposition: ${props.hs_call_disposition}`);
  if (props.hs_call_body) parts.push(`Body: ${truncate(props.hs_call_body, 1000)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  return parts.join(". ") + ".";
}

function communicationEmbedText(props: Record<string, any>): string {
  const channel = props.hs_communication_channel_type ?? "SMS";
  const parts = [`${channel}: ${truncate(props.hs_communication_body, 1500) || "(empty)"}`];
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  return parts.join(". ") + ".";
}

function emailEmbedText(props: Record<string, any>): string {
  const dir = props.hs_email_direction ?? "";
  const parts = [`Email${dir ? ` (${dir})` : ""}: ${props.hs_email_subject || "(no subject)"}`];
  if (props.hs_email_sender_email) parts.push(`From: ${props.hs_email_sender_email}`);
  if (props.hs_email_to_email) parts.push(`To: ${props.hs_email_to_email}`);
  // Use plain text, not HTML
  if (props.hs_email_text) parts.push(`Body: ${truncate(props.hs_email_text, 1000)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  return parts.join(". ") + ".";
}

function meetingEmbedText(props: Record<string, any>): string {
  const parts = [`Meeting: ${props.hs_meeting_title || "(no title)"}`];
  if (props.hs_meeting_outcome) parts.push(`Outcome: ${props.hs_meeting_outcome}`);
  if (props.hs_meeting_location) parts.push(`Location: ${props.hs_meeting_location}`);
  if (props.hs_meeting_start_time) parts.push(`Start: ${props.hs_meeting_start_time.split("T")[0]}`);
  const body = props.hs_meeting_body || props.hs_internal_meeting_notes;
  if (body) parts.push(`Notes: ${truncate(body, 1000)}`);
  return parts.join(". ") + ".";
}

function formSubmissionEmbedText(doc: Record<string, any>): string {
  const parts = [`Form submission: ${doc.formName || "Unknown form"}`];
  if (doc.submittedAt) parts.push(`Date: ${new Date(doc.submittedAt).toISOString().split("T")[0]}`);
  // Flatten form field values
  const values = doc.values ?? [];
  if (Array.isArray(values) && values.length > 0) {
    const fields = values
      .filter((v: any) => v.name && v.value)
      .map((v: any) => `${v.name}=${v.value}`)
      .join(", ");
    if (fields) parts.push(`Fields: ${truncate(fields, 1000)}`);
  }
  return parts.join(". ") + ".";
}

// ── Object Type Configuration ───────────────────────────────────────────────

interface ObjectConfig {
  stagingCollection: string;
  ragCollection: string;
  objectType: string;
  buildText: (doc: Record<string, any>) => string;
  propsPath: "properties" | "root"; // where to find data fields
}

const OBJECT_CONFIGS: ObjectConfig[] = [
  { stagingCollection: "staging_contacts", ragCollection: "rag_contacts", objectType: "contact", buildText: (d) => contactEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_companies", ragCollection: "rag_contacts", objectType: "company", buildText: (d) => companyEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_deals", ragCollection: "rag_deals", objectType: "deal", buildText: (d) => dealEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_tasks", ragCollection: "rag_activities", objectType: "task", buildText: (d) => taskEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_notes", ragCollection: "rag_activities", objectType: "note", buildText: (d) => noteEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_calls", ragCollection: "rag_activities", objectType: "call", buildText: (d) => callEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_communications", ragCollection: "rag_activities", objectType: "communication", buildText: (d) => communicationEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_emails", ragCollection: "rag_activities", objectType: "email", buildText: (d) => emailEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_meetings", ragCollection: "rag_activities", objectType: "meeting", buildText: (d) => meetingEmbedText(d.properties ?? {}), propsPath: "properties" },
  { stagingCollection: "staging_form_submissions", ragCollection: "rag_activities", objectType: "form_submission", buildText: (d) => formSubmissionEmbedText(d), propsPath: "root" },
];

// Map --objects flag to staging collection name
const OBJECTS_FLAG_MAP: Record<string, string> = {
  contacts: "staging_contacts",
  companies: "staging_companies",
  deals: "staging_deals",
  tasks: "staging_tasks",
  notes: "staging_notes",
  calls: "staging_calls",
  communications: "staging_communications",
  emails: "staging_emails",
  meetings: "staging_meetings",
  form_submissions: "staging_form_submissions",
};

// ── Voyage AI ───────────────────────────────────────────────────────────────

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          input: texts,
          input_type: "document",
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          data: { embedding: number[] }[];
          usage: { total_tokens: number };
        };
        return data.data.map((d) => d.embedding);
      }

      // Retryable errors
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < MAX_RETRIES) {
        // Respect Retry-After header for 429s, otherwise exponential backoff
        const retryAfter = res.headers.get("retry-after");
        const backoffMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : res.status === 429
            ? Math.min(20_000 * 2 ** attempt, 120_000) // 429: start at 20s, up to 2min
            : Math.min(1000 * 2 ** attempt, 10_000);   // 502/503: start at 1s
        log.warn("Voyage API transient error, retrying", { status: res.status, attempt: attempt + 1, backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      const text = await res.text();
      throw new Error(`Voyage AI ${res.status}: ${text}`);
    } catch (err: any) {
      if (err.message?.startsWith("Voyage AI")) throw err;
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
        log.warn("Voyage API network error, retrying", { error: err.message, attempt: attempt + 1, backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Voyage AI: max retries exceeded");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dryRun, reembed, objects } = parseArgs();
  const startTime = Date.now();

  log.info("Embedding pipeline starting", { dryRun, reembed, objects: objects ?? "all" });

  const voyageKey = process.env.VOYAGE_API_KEY;
  if (!voyageKey && !dryRun) {
    log.error("Missing VOYAGE_API_KEY");
    process.exit(1);
  }

  const atlasUri = process.env.MONGODB_ATLAS_URI;
  if (!atlasUri) {
    log.error("Missing MONGODB_ATLAS_URI");
    process.exit(1);
  }

  const mongo = new MongoClient(atlasUri);
  await mongo.connect();
  const db = mongo.db();
  log.info("Connected to Atlas");

  const configs = objects
    ? OBJECT_CONFIGS.filter((c) => c.stagingCollection === OBJECTS_FLAG_MAP[objects])
    : OBJECT_CONFIGS;

  const counts: Record<string, { total: number; embedded: number; skipped: number }> = {};
  let totalTokensEstimate = 0;

  for (const config of configs) {
    const result = await embedObjectType(db, config, voyageKey!, dryRun, reembed);
    counts[config.objectType] = result;
    totalTokensEstimate += result.tokensEstimate;
  }

  // ── Create Atlas Vector Search indexes ──────────────────────────────────

  if (!dryRun) {
    const ragCollections = [...new Set(configs.map((c) => c.ragCollection))];
    for (const colName of ragCollections) {
      await ensureVectorIndex(db, colName);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info("=== Embedding Summary ===");
  log.info(`Duration: ${elapsed}s${dryRun ? " (DRY RUN)" : ""}`);
  log.info(`Model: ${VOYAGE_MODEL} (${EMBED_DIMENSIONS} dimensions)`);
  for (const [type, result] of Object.entries(counts)) {
    log.info(`  ${type}: ${result.embedded.toLocaleString()} embedded, ${result.skipped.toLocaleString()} skipped (of ${result.total.toLocaleString()})`);
  }
  log.info(`Estimated tokens: ~${totalTokensEstimate.toLocaleString()}`);

  await mongo.close();
  log.info("Done.");
}

// ── Per-object-type embedding ───────────────────────────────────────────────

async function embedObjectType(
  db: Db,
  config: ObjectConfig,
  voyageKey: string,
  dryRun: boolean,
  reembed: boolean,
): Promise<{ total: number; embedded: number; skipped: number; tokensEstimate: number }> {
  const stagingCol = db.collection(config.stagingCollection);
  const ragCol = db.collection(config.ragCollection);

  // Get total count
  const total = await stagingCol.countDocuments();
  if (total === 0) {
    log.info(`${config.objectType}: no staging records, skipping`);
    return { total: 0, embedded: 0, skipped: 0, tokensEstimate: 0 };
  }

  log.info(`${config.objectType}: processing ${total.toLocaleString()} records...`);

  if (!dryRun) {
    await ragCol.createIndex({ hubspotId: 1, objectType: 1 });
  }

  // Get existing embedded IDs (unless reembed)
  const existingIds = new Set<string>();
  if (!reembed) {
    const existing = await ragCol
      .find({ objectType: config.objectType }, { projection: { hubspotId: 1 } })
      .toArray();
    for (const doc of existing) {
      existingIds.add(doc.hubspotId);
    }
    if (existingIds.size > 0) {
      log.info(`  ${config.objectType}: ${existingIds.size.toLocaleString()} already embedded`);
    }
  }

  let embedded = 0;
  let skipped = 0;
  let tokensEstimate = 0;

  // Buffer for batching
  let batch: { hubspotId: string; text: string; properties: Record<string, any> }[] = [];

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const texts = batch.map((b) => b.text);

    // Rough token estimate: ~4 chars per token
    tokensEstimate += texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

    if (dryRun) {
      embedded += batch.length;
      batch = [];
      return;
    }

    const embeddings = await embedBatch(texts, voyageKey);

    const ops = batch.map((item, i) => ({
      updateOne: {
        filter: { hubspotId: item.hubspotId, objectType: config.objectType },
        update: {
          $set: {
            hubspotId: item.hubspotId,
            objectType: config.objectType,
            embeddingText: item.text,
            embedding: embeddings[i],
            properties: item.properties,
            embeddedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    await ragCol.bulkWrite(ops, { ordered: false });

    embedded += batch.length;
    batch = [];
  };

  const cursor = stagingCol.find({});

  for await (const doc of cursor) {
    const hubspotId = doc.id as string;

    // Skip if already embedded
    if (!reembed && existingIds.has(hubspotId)) {
      skipped++;
      continue;
    }

    const text = truncate(config.buildText(doc));
    if (!text || text.length < 5) {
      skipped++;
      continue;
    }

    const properties = config.propsPath === "properties" ? (doc.properties ?? {}) : doc;

    batch.push({ hubspotId, text, properties });

    if (batch.length >= EMBED_BATCH_SIZE) {
      await flushBatch();
      if ((embedded + skipped) % 1000 === 0) {
        log.info(`  ${config.objectType}: ${embedded.toLocaleString()} embedded, ${skipped.toLocaleString()} skipped`);
      }
    }
  }

  // Flush remaining
  await flushBatch();

  log.info(`${config.objectType}: done — ${embedded.toLocaleString()} embedded, ${skipped.toLocaleString()} skipped`);
  return { total, embedded, skipped, tokensEstimate };
}

// ── Atlas Vector Search Index ───────────────────────────────────────────────

async function ensureVectorIndex(db: Db, collectionName: string): Promise<void> {
  const col = db.collection(collectionName);

  try {
    const indexes = await col.listSearchIndexes().toArray();
    const hasVectorIndex = indexes.some((idx: any) => idx.name === "vector_index");

    if (hasVectorIndex) {
      log.info(`Vector index already exists on ${collectionName}`);
      return;
    }

    log.info(`Creating vector search index on ${collectionName}...`);
    await col.createSearchIndex({
      name: "vector_index",
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBED_DIMENSIONS, similarity: "cosine" },
          { type: "filter", path: "objectType" },
        ],
      },
    });
    log.info(`Vector search index created on ${collectionName}`);
  } catch (err: any) {
    // Atlas free/shared tier may not support programmatic index creation
    log.warn(`Could not create vector index on ${collectionName}`, { error: err.message });
    log.warn("You may need to create the vector search index manually in the Atlas UI");
  }
}

main().catch((err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
