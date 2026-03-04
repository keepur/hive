#!/usr/bin/env npx tsx
/**
 * HubSpot Data Extraction — Stage 1 of ETL
 *
 * Pulls raw data from HubSpot API into staging collections.
 * Supports incremental extraction using per-object watermarks.
 *
 * Usage:
 *   npx tsx src/hubspot/hubspot-extract.ts [options]
 *
 * Options:
 *   --dry-run       Preview counts without writing
 *   --full          Force full re-extraction (ignore watermarks)
 *   --objects TYPE   Extract specific type only: contacts|companies|deals|tasks|engagements
 *
 * Env vars:
 *   HUBSPOT_API_KEY    — required
 *   MONGODB_ATLAS_URI  — staging DB (Atlas cluster)
 */

import dotenv from "dotenv";
dotenv.config();

import { MongoClient, type Db, type ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { HubSpotClient } from "./hubspot-client.js";

const log = createLogger("hubspot-extract");

// ── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const after = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const dryRun = has("--dry-run");
  const full = has("--full");
  const objects = after("--objects");

  const VALID_OBJECTS = [
    "contacts", "companies", "deals", "tasks",
    "notes", "calls", "communications", "emails", "meetings",
    "tickets", "feedback_submissions",
    "form_submissions", "files",
    "engagements",
  ];
  if (objects && !VALID_OBJECTS.includes(objects)) {
    log.error("Invalid --objects value", { objects });
    process.exit(1);
  }

  return { dryRun, full, objects };
}

// ── Property lists (request all useful fields) ──────────────────────────────

const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "phone", "mobilephone",
  "address", "city", "state", "zip", "country",
  "website", "company", "jobtitle",
  "lifecyclestage", "hs_lead_status", "contact_type",
  "hubspot_owner_id", "notes_last_updated",
  "lastmodifieddate", "createdate",
];

const COMPANY_PROPERTIES = [
  "name", "email", "phone", "domain", "industry",
  "address", "city", "state", "zip", "country",
  "numberofemployees", "annualrevenue", "description",
  "type", "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const DEAL_PROPERTIES = [
  "dealname", "dealstage", "pipeline", "amount",
  "deal_currency_code", "closedate",
  "hs_deal_stage_probability", "hs_analytics_source",
  "hubspot_owner_id", "description",
  "lastmodifieddate", "createdate",
];

const TASK_PROPERTIES = [
  "hs_task_subject", "hs_task_body", "hs_task_status",
  "hs_task_priority", "hs_task_type", "hs_timestamp",
  "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const NOTE_PROPERTIES = [
  "hs_note_body", "hs_timestamp", "hs_attachment_ids",
  "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const CALL_PROPERTIES = [
  "hs_call_title", "hs_call_body", "hs_call_status",
  "hs_call_direction", "hs_call_disposition", "hs_call_duration",
  "hs_call_recording_url", "hs_call_callee_object_id",
  "hs_call_from_number", "hs_call_to_number",
  "hs_timestamp", "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const COMMUNICATION_PROPERTIES = [
  "hs_communication_channel_type", "hs_communication_body",
  "hs_communication_logged_from",
  "hs_timestamp", "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const EMAIL_PROPERTIES = [
  "hs_email_subject", "hs_email_text", "hs_email_html",
  "hs_email_direction", "hs_email_status",
  "hs_email_sender_email", "hs_email_to_email",
  "hs_timestamp", "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const MEETING_PROPERTIES = [
  "hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome",
  "hs_meeting_start_time", "hs_meeting_end_time",
  "hs_meeting_location", "hs_meeting_external_url",
  "hs_internal_meeting_notes",
  "hs_timestamp", "hubspot_owner_id",
  "lastmodifieddate", "createdate",
];

const TICKET_PROPERTIES = [
  "subject", "content", "hs_ticket_priority",
  "hs_pipeline", "hs_pipeline_stage",
  "source_type", "hs_resolution",
  "hubspot_owner_id",
  "closed_date", "lastmodifieddate", "createdate",
];

const FEEDBACK_PROPERTIES = [
  "hs_survey_type", "hs_survey_channel",
  "hs_content", "hs_rating", "hs_response",
  "hs_sentiment", "hs_object_id",
  "hs_submission_timestamp",
  "lastmodifieddate", "createdate",
];

// ── Types ───────────────────────────────────────────────────────────────────

type Watermarks = Record<string, string>;

interface ExtractionResult {
  count: number;
  watermark: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dryRun, full, objects } = parseArgs();
  const startTime = Date.now();

  log.info("HubSpot extraction starting", { dryRun, full, objects: objects ?? "all" });

  // Validate env
  const hubspotApiKey = process.env.HUBSPOT_API_KEY;
  if (!hubspotApiKey) {
    log.error("Missing HUBSPOT_API_KEY");
    process.exit(1);
  }

  const atlasUri = process.env.MONGODB_ATLAS_URI;
  if (!atlasUri && !dryRun) {
    log.error("Missing MONGODB_ATLAS_URI");
    process.exit(1);
  }

  // Connect
  const client = new HubSpotClient(hubspotApiKey);
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  if (atlasUri) {
    mongo = new MongoClient(atlasUri);
    await mongo.connect();
    db = mongo.db();
    log.info("Connected to Atlas staging DB");
  } else {
    log.info("No Atlas URI — dry run without DB connection");
  }

  // ── Determine extraction mode ───────────────────────────────────────────

  let previousWatermarks: Watermarks = {};
  let incremental = false;

  if (db) {
    // Warn about stuck runs
    const stuckRuns = await db.collection("staging_runs")
      .find({ status: "running" })
      .toArray();
    if (stuckRuns.length > 0) {
      log.warn("Found previous runs stuck in 'running' state", {
        count: stuckRuns.length,
        runIds: stuckRuns.map(r => r._id.toString()),
      });
    }

    if (!full) {
      const meta = await db.collection("staging_meta").findOne({ _id: "extraction" as any });
      if (meta?.watermarks) {
        previousWatermarks = meta.watermarks;
        incremental = true;
      }
    }
  }

  const modeLabel = full
    ? "full (forced)"
    : incremental
      ? "incremental"
      : "full (no prior watermarks)";
  log.info(`Extraction mode: ${modeLabel}`, { watermarks: previousWatermarks });

  // ── Create run record ───────────────────────────────────────────────────

  let runId: ObjectId | null = null;
  if (!dryRun && db) {
    const runResult = await db.collection("staging_runs").insertOne({
      startedAt: new Date(),
      status: "running",
      mode: incremental ? "incremental" : "full",
      objects: objects ?? "all",
    });
    runId = runResult.insertedId;
    log.info("Run record created", { runId: runId.toString() });
  }

  const shouldExtract = (type: string) => !objects || objects === type;
  const counts: Record<string, number> = {};
  const watermarks: Watermarks = {};

  // ── Extract owners (upsert by id) ─────────────────────────────────────────

  log.info("Fetching owners...");
  const owners = await client.listOwners();
  if (!dryRun && db && owners.length > 0) {
    const ownersCol = db.collection("staging_owners");
    const ops = owners.map(owner => ({
      updateOne: {
        filter: { id: owner.id },
        update: { $set: { ...owner, extractedAt: new Date() } },
        upsert: true,
      },
    }));
    await ownersCol.bulkWrite(ops, { ordered: false });
  }
  counts.owners = owners.length;
  log.info("Owners extracted", { count: owners.length });

  // ── Extract pipelines (upsert by id) ──────────────────────────────────────

  log.info("Fetching pipelines...");
  const pipelines = await client.listPipelines();
  if (!dryRun && db && pipelines.length > 0) {
    const pipelinesCol = db.collection("staging_pipelines");
    const ops = pipelines.map(pipeline => ({
      updateOne: {
        filter: { id: pipeline.id },
        update: { $set: { ...pipeline, extractedAt: new Date() } },
        upsert: true,
      },
    }));
    await pipelinesCol.bulkWrite(ops, { ordered: false });
  }
  counts.pipelines = pipelines.length;
  counts.stages = pipelines.reduce((sum, p) => sum + p.stages.length, 0);
  log.info("Pipelines extracted", { pipelines: pipelines.length, stages: counts.stages });

  // ── Extract CRM objects ─────────────────────────────────────────────────

  const objectExtractions: Array<[string, string[]]> = [
    ["contacts", CONTACT_PROPERTIES],
    ["companies", COMPANY_PROPERTIES],
    ["deals", DEAL_PROPERTIES],
    ["tasks", TASK_PROPERTIES],
    ["notes", NOTE_PROPERTIES],
    ["calls", CALL_PROPERTIES],
    ["communications", COMMUNICATION_PROPERTIES],
    ["emails", EMAIL_PROPERTIES],
    ["meetings", MEETING_PROPERTIES],
    ["tickets", TICKET_PROPERTIES],
    ["feedback_submissions", FEEDBACK_PROPERTIES],
  ];

  for (const [objectType, properties] of objectExtractions) {
    if (!shouldExtract(objectType)) continue;
    const watermark = incremental ? previousWatermarks[objectType] : undefined;
    try {
      const result = await extractObjects(client, db, objectType, properties, dryRun, watermark);
      counts[objectType] = result.count;
      if (result.watermark) {
        watermarks[objectType] = result.watermark;
      }
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("MISSING_SCOPES")) {
        log.warn(`Skipping ${objectType} — API key lacks required scopes`);
        continue;
      }
      throw err;
    }
  }

  // ── Extract form submissions ───────────────────────────────────────────

  if (shouldExtract("form_submissions")) {
    log.info("Extracting form submissions...");
    try {
      const forms = await client.listForms();
      if (!dryRun && db) {
        const formsCol = db.collection("staging_forms");
        for (const form of forms) {
          await formsCol.updateOne(
            { id: form.id },
            { $set: { ...form, extractedAt: new Date() } },
            { upsert: true },
          );
        }
      }
      counts.forms = forms.length;
      log.info("Forms extracted", { count: forms.length });

      let submissionCount = 0;
      const submissionsCol = db?.collection("staging_form_submissions");
      if (!dryRun && submissionsCol) {
        await submissionsCol.createIndex({ formId: 1, submittedAt: 1 });
      }

      for (let i = 0; i < forms.length; i++) {
        try {
          const submissions = await client.listFormSubmissions(forms[i].id);
          if (!dryRun && submissionsCol && submissions.length > 0) {
            const ops = submissions.map(sub => ({
              updateOne: {
                filter: { formId: forms[i].id, submittedAt: sub.submittedAt },
                update: { $set: { ...sub, formId: forms[i].id, formName: forms[i].name, extractedAt: new Date() } },
                upsert: true,
              },
            }));
            await submissionsCol.bulkWrite(ops, { ordered: false });
          }
          submissionCount += submissions.length;
        } catch (err: any) {
          log.warn(`Form submissions fetch error`, { formId: forms[i].id, error: err.message });
        }

        if ((i + 1) % 10 === 0 || i === forms.length - 1) {
          log.info(`Forms: ${i + 1}/${forms.length} scanned, ${submissionCount} submissions`);
        }
      }
      counts.form_submissions = submissionCount;
      log.info("Form submissions extracted", { count: submissionCount });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("MISSING_SCOPES")) {
        log.warn("Skipping form submissions — API key lacks required scopes");
      } else {
        throw err;
      }
    }
  }

  // ── Extract files ─────────────────────────────────────────────────────

  if (shouldExtract("files")) {
    log.info("Extracting files from file manager...");
    try {
      const filesCol = db?.collection("staging_files");
      if (!dryRun && filesCol) {
        await filesCol.createIndex({ id: 1 }, { unique: true });
      }

      let fileCount = 0;
      for await (const batch of client.listAllFiles()) {
        if (!dryRun && filesCol && batch.length > 0) {
          const ops = batch.map(file => ({
            updateOne: {
              filter: { id: file.id },
              update: { $set: { ...file, extractedAt: new Date() } },
              upsert: true,
            },
          }));
          await filesCol.bulkWrite(ops, { ordered: false });
        }
        fileCount += batch.length;
        log.info(`  files: ${fileCount.toLocaleString()} extracted`);
      }
      counts.files = fileCount;
      log.info("Files extracted", { count: fileCount });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("MISSING_SCOPES")) {
        log.warn("Skipping files — API key lacks required scopes");
      } else {
        throw err;
      }
    }
  }

  // ── Extract associations (requires DB for previously-extracted IDs) ──────

  const ACTIVITY_TYPES = ["notes", "calls", "communications", "emails", "meetings", "tasks", "tickets"];

  if (db && !dryRun) {
    log.info("Extracting associations...");
    const assocCol = db.collection("staging_associations");

    await assocCol.createIndex({ fromType: 1, fromId: 1, toType: 1 });
    await assocCol.createIndex({ toType: 1, toId: 1 });

    let assocCount = 0;

    // Helper: batch-extract associations and upsert
    const extractAssoc = async (fromType: string, toType: string) => {
      if (!shouldExtract(fromType)) return 0;
      const fromIds = await getExtractedIds(db, fromType);
      if (fromIds.length === 0) return 0;

      try {
        const assocMap = await client.getBatchAssociations(fromType, fromIds, toType);
        const docs = [];
        for (const [fromId, toIds] of assocMap) {
          for (const toId of toIds) {
            docs.push({ fromType, fromId, toType, toId, extractedAt: new Date() });
          }
        }
        if (docs.length > 0) {
          await assocCol.deleteMany({ fromType, toType });
          await assocCol.insertMany(docs);
        }
        log.info(`${fromType}→${toType} associations`, { count: docs.length });
        return docs.length;
      } catch (err: any) {
        log.warn(`Skipping ${fromType}→${toType} associations`, { error: err.message });
        return 0;
      }
    };

    // Core entity links
    assocCount += await extractAssoc("contacts", "companies");
    assocCount += await extractAssoc("deals", "contacts");
    assocCount += await extractAssoc("deals", "companies");
    assocCount += await extractAssoc("tickets", "contacts");
    assocCount += await extractAssoc("tickets", "companies");

    // Activity → Contact links (the key relationships for agent context)
    for (const activityType of ACTIVITY_TYPES) {
      assocCount += await extractAssoc(activityType, "contacts");
    }

    counts.associations = assocCount;
  } else if (!db) {
    log.info("Skipping associations (no DB connection in dry run)");
  }

  // ── Save extraction metadata ──────────────────────────────────────────────

  const durationMs = Date.now() - startTime;

  if (!dryRun && db) {
    // Update run record
    if (runId) {
      await db.collection("staging_runs").updateOne(
        { _id: runId },
        { $set: { status: "completed", completedAt: new Date(), counts, durationMs } },
      );
    }

    // Merge new watermarks with previous (so partial --objects runs preserve other watermarks)
    const mergedWatermarks = { ...previousWatermarks, ...watermarks };

    // Update the quick-lookup pointer
    await db.collection("staging_meta").updateOne(
      { _id: "extraction" as any },
      {
        $set: {
          lastRun: runId,
          extractedAt: new Date(),
          counts,
          durationMs,
          watermarks: mergedWatermarks,
        },
      },
      { upsert: true },
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info("=== Extraction Summary ===");
  log.info(`Mode: ${modeLabel}`);
  log.info(`Duration: ${elapsed}s${dryRun ? " (DRY RUN)" : ""}`);
  for (const [type, count] of Object.entries(counts)) {
    log.info(`  ${type}: ${count.toLocaleString()}`);
  }
  if (Object.keys(watermarks).length > 0) {
    log.info("Watermarks:", watermarks);
  }

  if (mongo) await mongo.close();
  log.info("Done.");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function extractObjects(
  client: HubSpotClient,
  db: Db | null,
  objectType: string,
  properties: string[],
  dryRun: boolean,
  watermark?: string,
): Promise<ExtractionResult> {
  const modeLabel = watermark ? `incremental (since ${watermark})` : "full";
  log.info(`Extracting ${objectType} [${modeLabel}]...`);
  const col = db?.collection(`staging_${objectType}`);

  if (!dryRun && col) {
    await col.createIndex({ id: 1 }, { unique: true });
  }

  // Build incremental filter: only records modified after the watermark
  const filterGroups = watermark
    ? [{
        filters: [{
          propertyName: "lastmodifieddate",
          operator: "GT",
          value: String(new Date(watermark).getTime()),
        }],
      }]
    : undefined;

  let count = 0;
  let maxModified = "";

  for await (const batch of client.listAll(objectType, properties, filterGroups)) {
    if (!dryRun && col) {
      const ops = batch.map(record => ({
        updateOne: {
          filter: { id: record.id },
          update: { $set: { ...record, extractedAt: new Date() } },
          upsert: true,
        },
      }));
      await col.bulkWrite(ops, { ordered: false });
    }

    // Track the highest lastmodifieddate seen
    for (const record of batch) {
      const mod = record.properties.lastmodifieddate ?? record.updatedAt;
      if (mod && mod > maxModified) maxModified = mod;
    }

    count += batch.length;
    log.info(`  ${objectType}: ${count.toLocaleString()} extracted`);
  }

  log.info(`${objectType} extraction complete`, { count, watermark: maxModified || undefined });
  return { count, watermark: maxModified };
}

async function getExtractedIds(db: Db, objectType: string): Promise<string[]> {
  const col = db.collection(`staging_${objectType}`);
  const docs = await col.find({}, { projection: { id: 1 } }).toArray();
  return docs.map(d => d.id as string);
}

main().catch((err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
