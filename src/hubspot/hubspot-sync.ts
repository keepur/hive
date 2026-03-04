#!/usr/bin/env npx tsx
/**
 * HubSpot Data Sync — Stage 2 of ETL
 *
 * Reads from staging collections (populated by hubspot-extract.ts),
 * transforms into dodi_v2 schemas, writes to dodi's MongoDB,
 * and generates vector embeddings in Atlas for RAG.
 *
 * Re-run this as many times as needed while tweaking field mappings.
 * It does NOT call the HubSpot API — all data comes from staging.
 *
 * Usage:
 *   npx tsx src/hubspot/hubspot-sync.ts [options]
 *
 * Options:
 *   --dry-run       Preview counts without writing
 *   --skip-embed    Skip vector embedding step
 *   --objects TYPE   Sync specific type: contacts|companies|deals|activities|tasks
 *   --clean         Drop target collections before sync (fresh start)
 *
 * Env vars:
 *   DODI_MONGODB_URI   — dodi_v2's MongoDB (target for structured data)
 *   MONGODB_ATLAS_URI  — Atlas cluster (source: staging, target: RAG collections)
 *   VOYAGEAI_API_KEY   — Voyage AI (for embeddings, optional with --skip-embed)
 */

import { MongoClient, type Db, type Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("hubspot-sync");

// ── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const after = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const dryRun = has("--dry-run");
  const skipEmbed = has("--skip-embed");
  const clean = has("--clean");
  const objects = after("--objects");

  if (objects && !["contacts", "companies", "deals", "activities", "tasks"].includes(objects)) {
    log.error("Invalid --objects value", { objects });
    process.exit(1);
  }

  return { dryRun, skipEmbed, clean, objects };
}

// ── Phone Utilities (from import-hubspot.ts patterns) ───────────────────────

function normalizePhone(raw: string): string | null {
  if (!raw?.trim()) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return `+1${digits}`;
}

function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function normalizeAndFormat(raw: string | null | undefined): string {
  if (!raw) return "";
  const e164 = normalizePhone(raw);
  if (!e164) return "";
  return formatPhone(e164);
}

// ── Data Transformations ────────────────────────────────────────────────────

function buildTags(props: Record<string, any>): string[] {
  const tags: string[] = [];
  if (props.lifecyclestage) tags.push(props.lifecyclestage);
  if (props.hs_lead_status) tags.push(props.hs_lead_status);
  if (props.contact_type) tags.push(props.contact_type);
  return tags.filter(Boolean);
}

function buildAddress(props: Record<string, any>): Record<string, any> | undefined {
  if (!props.city) return undefined;
  return {
    street1: props.address ?? "",
    vicinity: {
      city: props.city ?? "",
      state: props.state ?? "",
      zipcode: props.zip ?? "",
      state_name: props.state ?? "",
      county: "",
      timezone: "",
      label: [props.city, props.state].filter(Boolean).join(", "),
    },
  };
}

function transformContact(
  staging: Record<string, any>,
  ownerMap: Map<string, string>,
): Record<string, any> {
  const props = staging.properties ?? {};
  const firstName = props.firstname ?? "";
  const lastName = props.lastname ?? "";
  const phone = normalizePhone(props.phone ?? "");

  return {
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(" "),
    email: props.email?.toLowerCase() ?? null,
    phone: phone
      ? { number: formatPhone(phone), canReceiveText: true }
      : { number: "", canReceiveText: false },
    address: buildAddress(props),
    website: props.website ?? undefined,
    tags: buildTags(props),
    scope: "default",
    _hubspot: {
      id: staging.id,
      ownerId: props.hubspot_owner_id ?? null,
      ownerName: ownerMap.get(props.hubspot_owner_id ?? "") ?? null,
      importedAt: new Date(),
    },
  };
}

function transformCompany(staging: Record<string, any>): Record<string, any> {
  const props = staging.properties ?? {};
  return {
    name: props.name ?? "",
    email: props.email ?? "",
    phone: { number: normalizeAndFormat(props.phone), canReceiveText: false },
    website: props.domain ?? "",
    address: buildAddress(props),
    discriminator: 1, // OrgDiscriminator.Business
    tags: [props.industry].filter(Boolean),
    scope: "default",
    _hubspot: { id: staging.id, importedAt: new Date() },
  };
}

function mapDealSource(source: string | null | undefined): string {
  if (!source) return "unknown";
  const map: Record<string, string> = {
    ORGANIC_SEARCH: "organic",
    PAID_SEARCH: "paid_search",
    DIRECT_TRAFFIC: "direct",
    REFERRALS: "referral",
    SOCIAL_MEDIA: "social",
    EMAIL_MARKETING: "email",
    OTHER_CAMPAIGNS: "campaign",
    OFFLINE: "offline",
    PAID_SOCIAL: "paid_social",
  };
  return map[source] ?? source.toLowerCase();
}

function transformDeal(
  staging: Record<string, any>,
  stageMap: Map<string, { name: string; pipeline: string }>,
): Record<string, any> {
  const props = staging.properties ?? {};
  const stageInfo = stageMap.get(props.dealstage ?? "");
  return {
    name: props.dealname ?? "",
    docType: "deals",
    state: stageInfo?.name ?? props.dealstage ?? "LEAD",
    value: props.amount
      ? { amount: parseFloat(props.amount), uom: props.deal_currency_code ?? "USD" }
      : undefined,
    probability: props.hs_deal_stage_probability
      ? parseInt(props.hs_deal_stage_probability, 10)
      : undefined,
    expectedCloseDate: props.closedate ? new Date(props.closedate) : undefined,
    source: mapDealSource(props.hs_analytics_source),
    scope: "default",
    _hubspot: {
      id: staging.id,
      pipeline: stageInfo?.pipeline ?? props.pipeline ?? "",
      importedAt: new Date(),
    },
  };
}

function transformActivity(staging: Record<string, any>): Record<string, any> {
  const props = staging.properties ?? {};
  return {
    hubspotId: staging.id,
    engagementType: props.hs_engagement_type ?? "UNKNOWN",
    properties: props,
    _associatedContactId: staging._associatedContactId ?? null,
    timestamp: props.hs_timestamp ? new Date(props.hs_timestamp) : new Date(),
    syncedAt: new Date(),
  };
}

// ── Embedding text builders ─────────────────────────────────────────────────

const EMBED_BATCH_SIZE = 128;
const EMBED_TEXT_MAX = 2000;

function contactEmbedText(doc: Record<string, any>): string {
  const parts = [`Contact: ${doc.name || "Unknown"}`];
  if (doc.email) parts.push(`Email: ${doc.email}`);
  if (doc.tags?.length) parts.push(`Tags: ${doc.tags.join(", ")}`);
  if (doc.address?.vicinity?.label) parts.push(`Location: ${doc.address.vicinity.label}`);
  return parts.join(". ") + ".";
}

function companyEmbedText(doc: Record<string, any>): string {
  const parts = [`Company: ${doc.name || "Unknown"}`];
  if (doc.website) parts.push(`Domain: ${doc.website}`);
  if (doc.tags?.length) parts.push(`Industry: ${doc.tags.join(", ")}`);
  if (doc.address?.vicinity?.label) parts.push(`Location: ${doc.address.vicinity.label}`);
  return parts.join(". ") + ".";
}

function dealEmbedText(doc: Record<string, any>): string {
  const parts = [`Deal: ${doc.name || "Unknown"}`];
  if (doc.value?.amount) parts.push(`Amount: $${doc.value.amount.toLocaleString()}`);
  parts.push(`Stage: ${doc.state}`);
  if (doc._hubspot?.pipeline) parts.push(`Pipeline: ${doc._hubspot.pipeline}`);
  if (doc.expectedCloseDate) parts.push(`Close: ${doc.expectedCloseDate.toISOString().split("T")[0]}`);
  return parts.join(". ") + ".";
}

function activityEmbedText(doc: Record<string, any>): string {
  const type = doc.engagementType ?? "Note";
  const body = (doc.properties?.hs_body_preview ?? "").slice(0, EMBED_TEXT_MAX);
  const date = doc.timestamp instanceof Date ? doc.timestamp.toISOString().split("T")[0] : "";
  const parts = [`${type}: ${body || "(no body)"}`];
  if (date) parts.push(`Date: ${date}`);
  return parts.join(". ") + ".";
}

// ── Voyage AI ───────────────────────────────────────────────────────────────

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "voyage-3-lite", input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Voyage AI ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

// ── Sync helpers ────────────────────────────────────────────────────────────

interface Stats { created: number; updated: number; skipped: number; errors: number }
function newStats(): Stats { return { created: 0, updated: 0, skipped: 0, errors: 0 }; }

async function upsertDoc(
  col: Collection,
  hubspotId: string,
  doc: Record<string, any>,
  stats: Stats,
  dryRun: boolean,
): Promise<string | null> {
  if (dryRun) {
    stats.created++;
    return `dry-run-${hubspotId}`;
  }

  try {
    const result = await col.updateOne(
      { "_hubspot.id": hubspotId },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    if (result.upsertedCount && result.upsertedId) {
      stats.created++;
      return result.upsertedId.toString();
    } else {
      stats.updated++;
      const existing = await col.findOne({ "_hubspot.id": hubspotId }, { projection: { _id: 1 } });
      return existing?._id?.toString() ?? null;
    }
  } catch (err: any) {
    log.error("Upsert error", { hubspotId, error: err.message });
    stats.errors++;
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  const startTime = Date.now();

  log.info("HubSpot sync starting (from staging)", {
    dryRun: cliArgs.dryRun,
    skipEmbed: cliArgs.skipEmbed,
    clean: cliArgs.clean,
    objects: cliArgs.objects ?? "all",
  });

  // Validate env
  const dodiUri = process.env.DODI_MONGODB_URI;
  if (!dodiUri) { log.error("Missing DODI_MONGODB_URI"); process.exit(1); }

  const atlasUri = process.env.MONGODB_ATLAS_URI;
  if (!atlasUri) { log.error("Missing MONGODB_ATLAS_URI"); process.exit(1); }

  const voyageKey = process.env.VOYAGEAI_API_KEY;
  if (!voyageKey && !cliArgs.skipEmbed) {
    log.error("Missing VOYAGEAI_API_KEY (use --skip-embed to skip)");
    process.exit(1);
  }

  // Connect
  const dodiClient = new MongoClient(dodiUri);
  const atlasClient = new MongoClient(atlasUri);
  await Promise.all([dodiClient.connect(), atlasClient.connect()]);
  const dodiDb = dodiClient.db();
  const atlasDb = atlasClient.db();
  log.info("Connected to MongoDB (dodi + Atlas)");

  // Verify staging data exists
  const meta = await atlasDb.collection("staging_meta").findOne({ _id: "extraction" as any });
  if (!meta) {
    log.error("No staging data found. Run hubspot-extract.ts first.");
    process.exit(1);
  }
  log.info("Staging data found", { extractedAt: meta.extractedAt, counts: meta.counts });

  const shouldSync = (type: string) => !cliArgs.objects || cliArgs.objects === type;

  // Build owner map from staging
  const owners = await atlasDb.collection("staging_owners").find({}).toArray();
  const ownerMap = new Map<string, string>();
  for (const o of owners) {
    const name = [o.firstName, o.lastName].filter(Boolean).join(" ");
    ownerMap.set(o.id, name || o.email);
  }
  log.info("Owner map loaded", { count: ownerMap.size });

  // Build stage map from staging
  const pipelines = await atlasDb.collection("staging_pipelines").find({}).toArray();
  const stageMap = new Map<string, { name: string; pipeline: string }>();
  for (const p of pipelines) {
    for (const s of (p.stages ?? [])) {
      stageMap.set(s.id, { name: s.label, pipeline: p.label });
    }
  }
  log.info("Stage map loaded", { stages: stageMap.size });

  // ID mapping: hubspotId → dodiId
  const idMap = new Map<string, string>();
  const allStats: Record<string, Stats> = {};
  const embedQueue: { col: string; dodiId: string; hsId: string; type: string; text: string; props: Record<string, any> }[] = [];

  // ── Sync Contacts ───────────────────────────────────────────────────────

  if (shouldSync("contacts")) {
    log.info("Syncing contacts (staging → dodi Persons)...");
    const stats = newStats();
    allStats.contacts = stats;
    const personsCol = dodiDb.collection("Persons");
    const stagingCol = atlasDb.collection("staging_contacts");

    if (cliArgs.clean && !cliArgs.dryRun) {
      await personsCol.deleteMany({ "_hubspot.id": { $exists: true } });
      log.info("Cleaned Persons (HubSpot records)");
    }

    if (!cliArgs.dryRun) {
      await personsCol.createIndex({ "_hubspot.id": 1 }, { unique: true, sparse: true });
    }

    const cursor = stagingCol.find({});
    let count = 0;

    for await (const staging of cursor) {
      const doc = transformContact(staging, ownerMap);
      const dodiId = await upsertDoc(personsCol, staging.id, doc, stats, cliArgs.dryRun);
      if (dodiId) {
        idMap.set(`contact:${staging.id}`, dodiId);
        embedQueue.push({
          col: "rag_contacts", dodiId, hsId: staging.id, type: "contact",
          text: contactEmbedText(doc),
          props: staging.properties ?? {},
        });
      }
      count++;
      if (count % 500 === 0) log.info(`  contacts: ${count.toLocaleString()}`);
    }

    log.info("Contacts done", { count, ...stats });
  }

  // ── Sync Companies ──────────────────────────────────────────────────────

  if (shouldSync("companies")) {
    log.info("Syncing companies (staging → dodi Orgs)...");
    const stats = newStats();
    allStats.companies = stats;
    const orgsCol = dodiDb.collection("Orgs");
    const stagingCol = atlasDb.collection("staging_companies");

    if (cliArgs.clean && !cliArgs.dryRun) {
      await orgsCol.deleteMany({ "_hubspot.id": { $exists: true } });
      log.info("Cleaned Orgs (HubSpot records)");
    }

    if (!cliArgs.dryRun) {
      await orgsCol.createIndex({ "_hubspot.id": 1 }, { unique: true, sparse: true });
    }

    const cursor = stagingCol.find({});
    let count = 0;

    for await (const staging of cursor) {
      const doc = transformCompany(staging);
      const dodiId = await upsertDoc(orgsCol, staging.id, doc, stats, cliArgs.dryRun);
      if (dodiId) {
        idMap.set(`company:${staging.id}`, dodiId);
        embedQueue.push({
          col: "rag_contacts", dodiId, hsId: staging.id, type: "company",
          text: companyEmbedText(doc),
          props: staging.properties ?? {},
        });
      }
      count++;
      if (count % 500 === 0) log.info(`  companies: ${count.toLocaleString()}`);
    }

    log.info("Companies done", { count, ...stats });
  }

  // ── Resolve contact→company associations ────────────────────────────────

  if (shouldSync("contacts") || shouldSync("companies")) {
    log.info("Linking contacts to companies via staging associations...");
    const assocCol = atlasDb.collection("staging_associations");
    const personsCol = dodiDb.collection("Persons");

    const assocs = await assocCol.find({ fromType: "contacts", toType: "companies" }).toArray();
    let linked = 0;

    for (const assoc of assocs) {
      const personDodiId = idMap.get(`contact:${assoc.fromId}`);
      const orgDodiId = idMap.get(`company:${assoc.toId}`);
      if (!personDodiId || !orgDodiId || cliArgs.dryRun) continue;

      try {
        await personsCol.updateOne(
          { "_hubspot.id": assoc.fromId },
          { $set: { orgId: new ObjectId(orgDodiId) } },
        );
        linked++;
      } catch (err: any) {
        log.error("Association link error", { error: err.message });
      }
    }

    log.info("Contact→Company links", { total: assocs.length, linked });
  }

  // ── Sync Deals ──────────────────────────────────────────────────────────

  if (shouldSync("deals")) {
    log.info("Syncing deals (staging → dodi Deals)...");
    const stats = newStats();
    allStats.deals = stats;
    const dealsCol = dodiDb.collection("Deals");
    const stagingCol = atlasDb.collection("staging_deals");

    if (cliArgs.clean && !cliArgs.dryRun) {
      await dealsCol.deleteMany({ "_hubspot.id": { $exists: true } });
      log.info("Cleaned Deals (HubSpot records)");
    }

    if (!cliArgs.dryRun) {
      await dealsCol.createIndex({ "_hubspot.id": 1 }, { unique: true, sparse: true });
    }

    const cursor = stagingCol.find({});
    let count = 0;

    for await (const staging of cursor) {
      const doc = transformDeal(staging, stageMap);
      const dodiId = await upsertDoc(dealsCol, staging.id, doc, stats, cliArgs.dryRun);
      if (dodiId) {
        idMap.set(`deal:${staging.id}`, dodiId);
        embedQueue.push({
          col: "rag_deals", dodiId, hsId: staging.id, type: "deal",
          text: dealEmbedText(doc),
          props: staging.properties ?? {},
        });
      }
      count++;
      if (count % 500 === 0) log.info(`  deals: ${count.toLocaleString()}`);
    }

    // Resolve deal associations
    const assocCol = atlasDb.collection("staging_associations");
    const dealAssocs = await assocCol.find({ fromType: "deals" }).toArray();
    let dealLinked = 0;

    for (const assoc of dealAssocs) {
      const dealDodiId = idMap.get(`deal:${assoc.fromId}`);
      if (!dealDodiId || cliArgs.dryRun) continue;

      const field = assoc.toType === "contacts" ? "contactId" : "orgId";
      const refDodiId = assoc.toType === "contacts"
        ? idMap.get(`contact:${assoc.toId}`)
        : idMap.get(`company:${assoc.toId}`);
      if (!refDodiId) continue;

      try {
        await dealsCol.updateOne(
          { "_hubspot.id": assoc.fromId },
          { $set: { [field]: new ObjectId(refDodiId) } },
        );
        dealLinked++;
      } catch (err: any) {
        log.error("Deal link error", { error: err.message });
      }
    }

    log.info("Deals done", { count, ...stats, associationsLinked: dealLinked });
  }

  // ── Sync Activities (raw dump) ──────────────────────────────────────────

  if (shouldSync("activities")) {
    log.info("Syncing activities (staging → dodi raw dump)...");
    const stats = newStats();
    allStats.activities = stats;
    const activitiesCol = dodiDb.collection("hubspot_activities_raw");
    const stagingCol = atlasDb.collection("staging_engagements");

    if (cliArgs.clean && !cliArgs.dryRun) {
      await activitiesCol.deleteMany({});
      log.info("Cleaned hubspot_activities_raw");
    }

    if (!cliArgs.dryRun) {
      await activitiesCol.createIndex({ hubspotId: 1 }, { unique: true });
    }

    const cursor = stagingCol.find({});
    let count = 0;

    for await (const staging of cursor) {
      const doc = transformActivity(staging);

      // Resolve associations from staging
      const assocCol = atlasDb.collection("staging_associations");
      // Find what this engagement's associated contact links to
      const contactAssoc = staging._associatedContactId
        ? idMap.get(`contact:${staging._associatedContactId}`) : null;

      doc.dodiRefs = {
        personIds: contactAssoc ? [contactAssoc] : [],
        orgIds: [],
        dealIds: [],
      };

      if (cliArgs.dryRun) {
        stats.created++;
      } else {
        try {
          await activitiesCol.updateOne(
            { hubspotId: staging.id },
            { $set: doc },
            { upsert: true },
          );
          stats.created++;
        } catch (err: any) {
          if (err.code === 11000) { stats.skipped++; }
          else { log.error("Activity insert error", { error: err.message }); stats.errors++; }
        }
      }

      embedQueue.push({
        col: "rag_activities", dodiId: staging.id, hsId: staging.id, type: "activity",
        text: activityEmbedText(doc),
        props: staging.properties ?? {},
      });

      count++;
      if (count % 1000 === 0) log.info(`  activities: ${count.toLocaleString()}`);
    }

    log.info("Activities done", { count, ...stats });
  }

  // ── Sync Tasks (raw dump) ───────────────────────────────────────────────

  if (shouldSync("tasks")) {
    log.info("Syncing tasks (staging → dodi raw dump)...");
    const stats = newStats();
    allStats.tasks = stats;
    const tasksCol = dodiDb.collection("hubspot_tasks_raw");
    const stagingCol = atlasDb.collection("staging_tasks");

    if (cliArgs.clean && !cliArgs.dryRun) {
      await tasksCol.deleteMany({});
      log.info("Cleaned hubspot_tasks_raw");
    }

    if (!cliArgs.dryRun) {
      await tasksCol.createIndex({ hubspotId: 1 }, { unique: true });
    }

    const cursor = stagingCol.find({});
    let count = 0;

    for await (const staging of cursor) {
      const props = staging.properties ?? {};
      const doc = {
        hubspotId: staging.id,
        engagementType: "TASK",
        properties: props,
        timestamp: props.hs_timestamp ? new Date(props.hs_timestamp) : new Date(),
        syncedAt: new Date(),
        dodiRefs: { personIds: [], orgIds: [], dealIds: [] },
      };

      if (cliArgs.dryRun) {
        stats.created++;
      } else {
        try {
          await tasksCol.updateOne(
            { hubspotId: staging.id },
            { $set: doc },
            { upsert: true },
          );
          stats.created++;
        } catch (err: any) {
          if (err.code === 11000) { stats.skipped++; }
          else { log.error("Task insert error", { error: err.message }); stats.errors++; }
        }
      }

      embedQueue.push({
        col: "rag_activities", dodiId: staging.id, hsId: staging.id, type: "task",
        text: activityEmbedText(doc),
        props,
      });

      count++;
      if (count % 500 === 0) log.info(`  tasks: ${count.toLocaleString()}`);
    }

    log.info("Tasks done", { count, ...stats });
  }

  // ── Generate Embeddings ─────────────────────────────────────────────────

  if (!cliArgs.skipEmbed && voyageKey && embedQueue.length > 0) {
    log.info("Generating embeddings...", { total: embedQueue.length });

    // Group by target collection
    const byCol = new Map<string, typeof embedQueue>();
    for (const item of embedQueue) {
      const arr = byCol.get(item.col) ?? [];
      arr.push(item);
      byCol.set(item.col, arr);
    }

    let totalEmbedded = 0;

    for (const [colName, items] of byCol) {
      const ragCol = atlasDb.collection(colName);
      if (!cliArgs.dryRun) {
        await ragCol.createIndex({ hubspotId: 1 }, { unique: true });
      }

      for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
        const chunk = items.slice(i, i + EMBED_BATCH_SIZE);
        const texts = chunk.map(c => c.text.slice(0, EMBED_TEXT_MAX));

        if (cliArgs.dryRun) {
          totalEmbedded += chunk.length;
          continue;
        }

        try {
          const embeddings = await embedBatch(texts, voyageKey);
          for (let j = 0; j < chunk.length; j++) {
            await ragCol.updateOne(
              { hubspotId: chunk[j].hsId },
              {
                $set: {
                  dodiId: chunk[j].dodiId,
                  hubspotId: chunk[j].hsId,
                  objectType: chunk[j].type,
                  embeddingText: chunk[j].text,
                  embedding: embeddings[j],
                  properties: chunk[j].props,
                  syncedAt: new Date(),
                },
              },
              { upsert: true },
            );
          }
          totalEmbedded += chunk.length;
        } catch (err: any) {
          log.error("Embedding error", { col: colName, batch: i, error: err.message });
        }

        if (totalEmbedded % 500 === 0 || i + EMBED_BATCH_SIZE >= items.length) {
          log.info(`  embeddings: ${totalEmbedded.toLocaleString()}/${embedQueue.length.toLocaleString()}`);
        }
      }
    }

    log.info("Embeddings complete", { total: totalEmbedded });
  } else if (cliArgs.skipEmbed) {
    log.info("Skipping embeddings (--skip-embed)");
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info("=== Sync Summary ===");
  log.info(`Duration: ${elapsed}s${cliArgs.dryRun ? " (DRY RUN)" : ""}`);
  for (const [type, stats] of Object.entries(allStats)) {
    log.info(`  ${type}: created=${stats.created} updated=${stats.updated} skipped=${stats.skipped} errors=${stats.errors}`);
  }
  if (!cliArgs.skipEmbed) {
    log.info(`  embeddings: ${embedQueue.length}`);
  }

  await Promise.all([dodiClient.close(), atlasClient.close()]);
  log.info("Done.");
}

main().catch((err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
