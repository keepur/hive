#!/usr/bin/env npx tsx

/**
 * HubSpot Embedding Pipeline — Local Ollama + Qdrant
 *
 * Reads from local MongoDB staging collections (populated by marketing hubspot-extract),
 * builds embedding text for each record, calls local Ollama (bge-large) to generate
 * vector embeddings, and upserts them into local Qdrant.
 *
 * Replaces the old Voyage AI + Atlas pipeline.
 *
 * Usage:
 *   npx tsx scripts/hubspot-embed.ts [options]
 *
 * Options:
 *   --dry-run       Preview counts per object type, skip embedding and upsert
 *   --reembed       Ignore lastEmbedAt watermarks, process all records
 *   --objects TYPE   Only process the specified object type (e.g., --objects deal)
 *
 * Env vars:
 *   MONGODB_STAGING_URI  — Local MongoDB (default: mongodb://localhost:27017/hubspot)
 *   OLLAMA_URL           — Ollama API (default: http://localhost:11434)
 *   QDRANT_URL           — Qdrant API (default: http://localhost:6333)
 *   EMBED_MODEL          — Ollama model (default: bge-large)
 *   EMBED_DIMS           — Embedding dimensions (default: 1024)
 */

import { MongoClient, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large";
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS ?? "1024", 10);
const EMBED_BATCH_SIZE = 100;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const MONGODB_STAGING_URI = process.env.MONGODB_STAGING_URI ?? "mongodb://localhost:27017/hubspot";

const QDRANT_UPSERT_BATCH = 50;
const QDRANT_MAX_RETRIES = 5;
const QDRANT_RETRY_BASE_MS = 1000;
const QDRANT_RETRY_MAX_MS = 15_000;
const OLLAMA_MAX_RETRIES = 5;
const OLLAMA_RETRY_DELAY_MS = 5000;
const EMBED_TEXT_MAX = 1000;

// UUID v5 namespace (DNS namespace UUID)
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reembed = args.includes("--reembed");
const objectsIdx = args.indexOf("--objects");
const objectsFilter = objectsIdx !== -1 ? args[objectsIdx + 1] : null;

// ── UUID v5 (deterministic point IDs) ───────────────────────────────────────

function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();

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

// ── Ollama Embedding ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        const delay = OLLAMA_RETRY_DELAY_MS * attempt; // exponential-ish backoff
        console.warn(`  Ollama attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string | null | undefined, max = EMBED_TEXT_MAX): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function stripHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function elapsed(startMs: number): string {
  const secs = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${secs}s`;
}

// ── Enrichment Loaders ──────────────────────────────────────────────────────

async function loadContactNames(db: Db): Promise<Map<string, string>> {
  const contacts = db.collection("staging_contacts");
  const map = new Map<string, string>();
  const cursor = contacts.find({}, { projection: { id: 1, "properties.firstname": 1, "properties.lastname": 1 } });
  for await (const doc of cursor) {
    const name = [doc.properties?.firstname, doc.properties?.lastname].filter(Boolean).join(" ");
    if (name) map.set(doc.id, name);
  }
  console.log(`  Contact name map loaded: ${map.size} contacts`);
  return map;
}

async function loadActivityContactNames(
  db: Db,
  contactNames: Map<string, string>,
): Promise<Map<string, string[]>> {
  const assoc = db.collection("staging_associations");
  const map = new Map<string, string[]>();
  const cursor = assoc.find({ toType: "contacts" }, { projection: { fromId: 1, toId: 1 } });
  for await (const doc of cursor) {
    const name = contactNames.get(doc.toId);
    if (name) {
      const existing = map.get(doc.fromId);
      if (existing) {
        existing.push(name);
      } else {
        map.set(doc.fromId, [name]);
      }
    }
  }
  console.log(`  Activity→contact association map loaded: ${map.size} activities`);
  return map;
}

async function loadStageMap(db: Db): Promise<Map<string, { stageName: string; pipelineName: string }>> {
  const pipelines = await db.collection("staging_pipelines").find({}).toArray();
  const map = new Map<string, { stageName: string; pipelineName: string }>();
  for (const p of pipelines) {
    for (const s of (p.stages ?? [])) {
      map.set(s.id, { stageName: s.label, pipelineName: p.label });
    }
  }
  console.log(`  Stage map loaded: ${map.size} stages from ${pipelines.length} pipelines`);
  return map;
}

// ── Enrichment Context ──────────────────────────────────────────────────────

interface EnrichmentContext {
  contactNames: Map<string, string>;
  activityContactNames: Map<string, string[]>;
  stageMap: Map<string, { stageName: string; pipelineName: string }>;
}

// ── Text Builders ───────────────────────────────────────────────────────────

function contactText(props: Record<string, any>): string {
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

function companyText(props: Record<string, any>): string {
  const parts = [`Company: ${props.name || "Unknown"}`];
  if (props.domain) parts.push(`Domain: ${props.domain}`);
  if (props.industry) parts.push(`Industry: ${props.industry}`);
  if (props.description) parts.push(`Description: ${truncate(props.description, 500)}`);
  const location = [props.city, props.state].filter(Boolean).join(", ");
  if (location) parts.push(`Location: ${location}`);
  return parts.join(". ") + ".";
}

function dealText(
  props: Record<string, any>,
  contactNames?: string[],
  stageMap?: Map<string, { stageName: string; pipelineName: string }>,
): string {
  const parts = [`Deal: ${props.dealname || "Unknown"}`];
  if (props.amount) parts.push(`Amount: $${parseFloat(props.amount).toLocaleString()}`);
  const stageInfo = stageMap?.get(props.dealstage ?? "");
  parts.push(`Stage: ${stageInfo?.stageName ?? props.dealstage ?? "Unknown"}`);
  parts.push(`Pipeline: ${stageInfo?.pipelineName ?? props.pipeline ?? "Unknown"}`);
  if (props.closedate) parts.push(`Close: ${props.closedate.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  if (props.description) parts.push(`Description: ${truncate(props.description, 500)}`);
  return parts.join(". ") + ".";
}

function taskText(props: Record<string, any>, contactNames?: string[]): string {
  const parts = [`Task: ${props.hs_task_subject || "(no subject)"}`];
  if (props.hs_task_status) parts.push(`Status: ${props.hs_task_status}`);
  if (props.hs_task_priority) parts.push(`Priority: ${props.hs_task_priority}`);
  const taskBody = stripHtml(props.hs_task_body);
  if (taskBody) parts.push(`Body: ${truncate(taskBody, 1000)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function noteText(props: Record<string, any>, contactNames?: string[]): string {
  const parts = [`Note: ${truncate(stripHtml(props.hs_note_body), 800) || "(empty)"}`];
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function callText(props: Record<string, any>, contactNames?: string[]): string {
  const dir = props.hs_call_direction ?? "";
  const parts = [`Call${dir ? ` (${dir})` : ""}: ${props.hs_call_title || "(no title)"}`];
  if (props.hs_call_duration) parts.push(`Duration: ${Math.round(parseInt(props.hs_call_duration) / 1000)}s`);
  if (props.hs_call_disposition) parts.push(`Disposition: ${props.hs_call_disposition}`);
  const callBody = stripHtml(props.hs_call_body);
  if (callBody) parts.push(`Body: ${truncate(callBody, 1000)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function communicationText(props: Record<string, any>, contactNames?: string[]): string {
  const channel = props.hs_communication_channel_type ?? "SMS";
  const parts = [`${channel}: ${truncate(stripHtml(props.hs_communication_body), 800) || "(empty)"}`];
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function emailText(props: Record<string, any>, contactNames?: string[]): string {
  const dir = props.hs_email_direction ?? "";
  const parts = [`Email${dir ? ` (${dir})` : ""}: ${props.hs_email_subject || "(no subject)"}`];
  if (props.hs_email_sender_email) parts.push(`From: ${props.hs_email_sender_email}`);
  if (props.hs_email_to_email) parts.push(`To: ${props.hs_email_to_email}`);
  if (props.hs_email_text) parts.push(`Body: ${truncate(props.hs_email_text, 800)}`);
  if (props.hs_timestamp) parts.push(`Date: ${props.hs_timestamp.split("T")[0]}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function meetingText(props: Record<string, any>, contactNames?: string[]): string {
  const parts = [`Meeting: ${props.hs_meeting_title || "(no title)"}`];
  if (props.hs_meeting_outcome) parts.push(`Outcome: ${props.hs_meeting_outcome}`);
  if (props.hs_meeting_location) parts.push(`Location: ${props.hs_meeting_location}`);
  if (props.hs_meeting_start_time) parts.push(`Start: ${props.hs_meeting_start_time.split("T")[0]}`);
  const body = stripHtml(props.hs_meeting_body || props.hs_internal_meeting_notes);
  if (body) parts.push(`Notes: ${truncate(body, 800)}`);
  if (contactNames?.length) parts.push(`Contacts: ${contactNames.join(", ")}`);
  return parts.join(". ") + ".";
}

function formSubmissionText(doc: Record<string, any>): string {
  const parts = [`Form submission: ${doc.formName || "Unknown form"}`];
  if (doc.submittedAt) parts.push(`Date: ${new Date(doc.submittedAt).toISOString().split("T")[0]}`);
  const values = doc.values ?? [];
  if (Array.isArray(values) && values.length > 0) {
    const fields = values
      .filter((v: any) => v.name && v.value)
      .map((v: any) => `${v.name}=${v.value}`)
      .join(", ");
    if (fields) parts.push(`Fields: ${truncate(fields, 800)}`);
  }
  return parts.join(". ") + ".";
}

// ── Object Config ───────────────────────────────────────────────────────────

interface ObjectConfig {
  staging: string;
  qdrant: string;
  objectType: string;
  textBuilder: (doc: Record<string, any>, ctx: EnrichmentContext) => string;
}

const OBJECT_CONFIGS: ObjectConfig[] = [
  {
    staging: "staging_contacts",
    qdrant: "contacts",
    objectType: "contact",
    textBuilder: (doc) => contactText(doc.properties ?? {}),
  },
  {
    staging: "staging_companies",
    qdrant: "contacts",
    objectType: "company",
    textBuilder: (doc) => companyText(doc.properties ?? {}),
  },
  {
    staging: "staging_deals",
    qdrant: "deals",
    objectType: "deal",
    textBuilder: (doc, ctx) =>
      dealText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id), ctx.stageMap),
  },
  {
    staging: "staging_tasks",
    qdrant: "activities",
    objectType: "task",
    textBuilder: (doc, ctx) => taskText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_notes",
    qdrant: "activities",
    objectType: "note",
    textBuilder: (doc, ctx) => noteText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_calls",
    qdrant: "activities",
    objectType: "call",
    textBuilder: (doc, ctx) => callText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_communications",
    qdrant: "activities",
    objectType: "communication",
    textBuilder: (doc, ctx) =>
      communicationText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_emails",
    qdrant: "activities",
    objectType: "email",
    textBuilder: (doc, ctx) => emailText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_meetings",
    qdrant: "activities",
    objectType: "meeting",
    textBuilder: (doc, ctx) =>
      meetingText(doc.properties ?? {}, ctx.activityContactNames.get(doc.id)),
  },
  {
    staging: "staging_form_submissions",
    qdrant: "activities",
    objectType: "form_submission",
    textBuilder: (doc) => formSubmissionText(doc),
  },
];

// ── Payload Builders ────────────────────────────────────────────────────────

function buildContactPayload(doc: any, embeddingText: string): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.id),
    objectType: "contact",
    embeddingText,
    name: [props.firstname, props.lastname].filter(Boolean).join(" ") || "",
    email: props.email ?? "",
    phone: props.phone ?? "",
    company: props.company ?? "",
    lifecyclestage: props.lifecyclestage ?? "",
    city: props.city ?? "",
    state: props.state ?? "",
    domain: "",
    industry: "",
    syncedAt: new Date().toISOString(),
  };
}

function buildCompanyPayload(doc: any, embeddingText: string): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.id),
    objectType: "company",
    embeddingText,
    name: props.name ?? "",
    email: "",
    phone: props.phone ?? "",
    company: "",
    lifecyclestage: "",
    city: props.city ?? "",
    state: props.state ?? "",
    domain: props.domain ?? "",
    industry: props.industry ?? "",
    syncedAt: new Date().toISOString(),
  };
}

function buildDealPayload(
  doc: any,
  embeddingText: string,
  contactNames: string[],
  stageMap: Map<string, { stageName: string; pipelineName: string }>,
): Record<string, any> {
  const props = doc.properties ?? {};
  const stageInfo = stageMap.get(props.dealstage ?? "");
  return {
    hubspotId: String(doc.id),
    objectType: "deal",
    embeddingText,
    dealname: props.dealname ?? "",
    amount: props.amount != null ? Number(props.amount) : null,
    dealstage: stageInfo?.stageName ?? props.dealstage ?? "",
    pipeline: stageInfo?.pipelineName ?? props.pipeline ?? "",
    closedate: props.closedate ?? "",
    contactNames,
    syncedAt: new Date().toISOString(),
  };
}

function buildActivityPayload(
  doc: any,
  objectType: string,
  embeddingText: string,
  contactNames: string[],
): Record<string, any> {
  const props = doc.properties ?? {};
  return {
    hubspotId: String(doc.id),
    objectType,
    embeddingText,
    engagementType: objectType,
    timestamp: props.hs_timestamp ?? "",
    contactNames,
    syncedAt: new Date().toISOString(),
  };
}

function buildPayload(
  doc: any,
  objectType: string,
  embeddingText: string,
  ctx: EnrichmentContext,
): Record<string, any> {
  const contactNamesList = ctx.activityContactNames.get(doc.id) ?? [];

  switch (objectType) {
    case "contact":
      return buildContactPayload(doc, embeddingText);
    case "company":
      return buildCompanyPayload(doc, embeddingText);
    case "deal":
      return buildDealPayload(doc, embeddingText, contactNamesList, ctx.stageMap);
    default:
      return buildActivityPayload(doc, objectType, embeddingText, contactNamesList);
  }
}

// ── Qdrant Upsert ───────────────────────────────────────────────────────────

function isRetryableQdrantError(err: any): boolean {
  const msg = String(err?.message ?? "");
  const causeCode = err?.cause?.code ?? "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("EAI_AGAIN") ||
    causeCode === "ECONNRESET" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "ECONNREFUSED" ||
    causeCode === "UND_ERR_SOCKET"
  );
}

async function upsertWithRetry(
  qdrant: QdrantClient,
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  for (let attempt = 1; attempt <= QDRANT_MAX_RETRIES; attempt++) {
    try {
      await qdrant.upsert(collection, { wait: true, points });
      return;
    } catch (err: any) {
      if (attempt === QDRANT_MAX_RETRIES || !isRetryableQdrantError(err)) {
        throw err;
      }
      const delay = Math.min(QDRANT_RETRY_BASE_MS * 2 ** (attempt - 1), QDRANT_RETRY_MAX_MS);
      console.warn(
        `  Qdrant upsert attempt ${attempt}/${QDRANT_MAX_RETRIES} failed (${err.message}) — retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

async function upsertPoints(
  qdrant: QdrantClient,
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH) {
    const slice = points.slice(i, i + QDRANT_UPSERT_BATCH).map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    }));
    await upsertWithRetry(qdrant, collection, slice);
  }
}

// ── Main Processing ─────────────────────────────────────────────────────────

async function processObjectType(
  db: Db,
  qdrant: QdrantClient,
  config: ObjectConfig,
  ctx: EnrichmentContext,
): Promise<{ total: number; embedded: number; skipped: number }> {
  const { staging, qdrant: qdrantCol, objectType, textBuilder } = config;
  const metaCol = db.collection("embed_meta");
  const stagingCol = db.collection(staging);

  // Read watermark
  let query: Record<string, any> = {};
  if (!reembed) {
    const meta = await metaCol.findOne({ objectType });
    const lastEmbedAt = meta?.lastEmbedAt ?? null;
    if (lastEmbedAt) {
      query = { extractedAt: { $gt: lastEmbedAt } };
    }
  }

  const total = await stagingCol.countDocuments(query);
  console.log(`  ${objectType}: ${total} records to process`);

  if (total === 0) {
    return { total: 0, embedded: 0, skipped: 0 };
  }

  if (dryRun) {
    return { total, embedded: 0, skipped: 0 };
  }

  const cursor = stagingCol.find(query).sort({ extractedAt: 1 });
  let embedded = 0;
  let skipped = 0;
  let batch: { doc: any; text: string }[] = [];
  let maxExtractedAt: Date | null = null;
  const startMs = Date.now();

  const persistWatermark = async (at: Date) => {
    await metaCol.updateOne(
      { objectType },
      { $set: { lastEmbedAt: at, updatedAt: new Date() } },
      { upsert: true },
    );
  };

  const flushBatch = async () => {
    if (batch.length === 0) return;

    const texts = batch.map((b) => b.text);

    let embeddings: number[][];
    try {
      embeddings = await embedBatch(texts);
    } catch (err: any) {
      if (err.message?.includes("context length")) {
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

    const points = batch.map((item, i) => {
      const payload = buildPayload(item.doc, objectType, item.text, ctx);
      const id = pointId(objectType, String(item.doc.id));
      return { id, vector: embeddings[i]!, payload };
    });

    await upsertPoints(qdrant, qdrantCol, points);
    embedded += batch.length;
    batch = [];

    // Persist watermark after each successful flush so partial progress
    // survives crashes mid-run — next run resumes from here instead of
    // re-embedding everything.
    if (maxExtractedAt) {
      await persistWatermark(maxExtractedAt);
    }
  };

  for await (const doc of cursor) {
    const text = truncate(textBuilder(doc, ctx));
    if (!text || text.length < 5) {
      skipped++;
      continue;
    }

    batch.push({ doc, text });

    // Only advance the watermark for docs that actually make it into a
    // batch — skipped docs should remain revisitable on the next run in
    // case the skip was due to a transient text-build issue.
    if (doc.extractedAt && (!maxExtractedAt || doc.extractedAt > maxExtractedAt)) {
      maxExtractedAt = doc.extractedAt;
    }

    if (batch.length >= EMBED_BATCH_SIZE) {
      await flushBatch();
      if ((embedded + skipped) % 1000 === 0) {
        console.log(`    ${objectType}: ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
      }
    }
  }

  // Flush remaining
  await flushBatch();

  // Update watermark
  if (maxExtractedAt) {
    await metaCol.updateOne(
      { objectType },
      {
        $set: {
          lastEmbedAt: maxExtractedAt,
          recordCount: embedded,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  console.log(`  ${objectType}: done — ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
  return { total, embedded, skipped };
}

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log(`HubSpot Embed: staging → Ollama (${EMBED_MODEL}, ${EMBED_DIMS}d) → Qdrant`);
  console.log(`  MongoDB:   ${MONGODB_STAGING_URI}`);
  console.log(`  Ollama:    ${OLLAMA_URL}`);
  console.log(`  Qdrant:    ${QDRANT_URL}`);
  console.log(`  Batch:     ${EMBED_BATCH_SIZE}`);
  console.log(`  Mode:      ${dryRun ? "DRY RUN" : reembed ? "REEMBED ALL" : "INCREMENTAL"}`);
  if (objectsFilter) console.log(`  Filter:    --objects ${objectsFilter}`);

  // Verify Ollama is running
  if (!dryRun) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      console.log("  Ollama:    connected");
    } catch (err: any) {
      console.error(`Error: Cannot connect to Ollama at ${OLLAMA_URL}: ${err.message}`);
      process.exit(1);
    }
  }

  // Connect to Qdrant
  const qdrant = new QdrantClient({ url: QDRANT_URL });
  if (!dryRun) {
    try {
      await qdrant.getCollections();
      console.log("  Qdrant:    connected");
    } catch (err: any) {
      console.error(`Error: Cannot connect to Qdrant at ${QDRANT_URL}: ${err.message}`);
      process.exit(1);
    }
  }

  // Connect to MongoDB
  const mongo = new MongoClient(MONGODB_STAGING_URI);
  await mongo.connect();
  const db = mongo.db();
  console.log("  MongoDB:   connected");

  // Load enrichment data
  console.log("\nLoading enrichment data...");
  const contactNames = await loadContactNames(db);
  const activityContactNames = await loadActivityContactNames(db, contactNames);
  const stageMap = await loadStageMap(db);

  const ctx: EnrichmentContext = { contactNames, activityContactNames, stageMap };

  // Filter configs if --objects specified
  const configs = objectsFilter
    ? OBJECT_CONFIGS.filter((c) => c.objectType === objectsFilter)
    : OBJECT_CONFIGS;

  if (configs.length === 0) {
    console.error(`Error: Unknown object type "${objectsFilter}"`);
    console.error(`Valid types: ${OBJECT_CONFIGS.map((c) => c.objectType).join(", ")}`);
    await mongo.close();
    process.exit(1);
  }

  // Process each object type
  console.log("\nProcessing...");
  const results: Record<string, { total: number; embedded: number; skipped: number }> = {};

  for (const config of configs) {
    results[config.objectType] = await processObjectType(db, qdrant, config, ctx);
  }

  await mongo.close();

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Duration: ${elapsed(startTime)}${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Model: ${EMBED_MODEL} (${EMBED_DIMS} dims)`);
  let totalEmbedded = 0;
  let totalSkipped = 0;
  for (const [type, result] of Object.entries(results)) {
    console.log(`  ${type}: ${result.embedded} embedded, ${result.skipped} skipped (of ${result.total})`);
    totalEmbedded += result.embedded;
    totalSkipped += result.skipped;
  }
  console.log(`Total: ${totalEmbedded} embedded, ${totalSkipped} skipped`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
