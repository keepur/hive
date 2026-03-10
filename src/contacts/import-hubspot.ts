#!/usr/bin/env npx tsx
/**
 * Import HubSpot CSV contacts into hive.contacts MongoDB collection.
 *
 * Usage:
 *   npx tsx src/contacts/import-hubspot.ts <csv-file> [--dry-run]
 *
 * Handles both the simple export (6 columns) and the full export (300+ columns).
 */

import { MongoClient } from "mongodb";
import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";

const CONTACT_TYPE_MAP: Record<string, string> = {
  Homeowner: "homeowner",
  "Professional Designer": "designer",
  "Contractor / Builder": "contractor",
  Realtor: "realtor",
  Other: "other",
  "Investor - Tier 1": "investor",
  "Project Manager": "project_manager",
  "Design and Build": "design_build",
};

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

function makePhoneEntry(raw: string, label: string): { number: string; formatted: string; label: string } | null {
  const e164 = normalizePhone(raw);
  if (!e164) return null;
  return { number: e164, formatted: formatPhone(e164), label };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const csvPath = args.find((a) => !a.startsWith("--"));

  if (!csvPath) {
    console.error("Usage: npx tsx src/contacts/import-hubspot.ts <csv-file> [--dry-run]");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB || "hive";

  console.log(`Reading ${csvPath}...`);
  const csv = readFileSync(csvPath, "utf-8");
  const records: any[] = parse(csv, { columns: true, skip_empty_lines: true });
  console.log(`${records.length} rows in CSV`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const contacts = db.collection("contacts");

  if (!dryRun) {
    // Create indexes (idempotent)
    await contacts.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
    await contacts.createIndex({ "phones.number": 1 });
    await contacts.createIndex({ name: "text", email: "text", company: "text" });
    await contacts.createIndex({ tags: 1 });
    await contacts.createIndex({ updatedAt: 1 });
  }

  const stats = { total: records.length, created: 0, updated: 0, skipped: 0, errors: 0 };

  for (const row of records) {
    const email = (row.Email || row.email)?.trim().toLowerCase();
    const firstName = (row["First Name"] || "").trim();
    const lastName = (row["Last Name"] || "").trim();
    const contactType = (row["Contact Type"] || "").trim();
    const rawPhone = (row["Phone Number"] || "").trim();
    const rawMobile = (row["Mobile Phone Number"] || "").trim();
    const hubspotId = (row["Record ID"] || "").trim();
    const company = (row["Company Name"] || row["Associated company"] || "").trim();
    const jobTitle = (row["Job Title"] || "").trim();
    const city = (row["City"] || "").trim();
    const state = (row["State/Region"] || "").trim();
    const leadStatus = (row["Lead Status"] || "").trim();

    if (!email && !firstName && !lastName && !rawPhone && !rawMobile) {
      stats.skipped++;
      continue;
    }

    // Build phone entries — deduplicate
    const phones: { number: string; formatted: string; label: string }[] = [];
    const seenPhones = new Set<string>();
    for (const [raw, label] of [
      [rawPhone, "Primary"],
      [rawMobile, "Mobile"],
    ] as const) {
      const entry = makePhoneEntry(raw, label);
      if (entry && !seenPhones.has(entry.number)) {
        phones.push(entry);
        seenPhones.add(entry.number);
      }
    }

    const tag = CONTACT_TYPE_MAP[contactType] || null;
    const name = [firstName, lastName].filter(Boolean).join(" ") || email?.split("@")[0] || "";

    const doc: Record<string, any> = {
      name,
      firstName,
      lastName,
      email: email || null,
      phones,
      tags: tag ? [tag] : [],
      source: "hubspot",
      sourceId: hubspotId || undefined,
      updatedAt: new Date(),
    };

    if (company) doc.company = company;
    if (jobTitle) doc.role = jobTitle;
    if (city || state) doc.location = [city, state].filter(Boolean).join(", ");
    if (leadStatus) doc.leadStatus = leadStatus;

    if (dryRun) {
      stats.created++;
      continue;
    }

    try {
      if (email) {
        const result = await contacts.updateOne(
          { email },
          {
            $set: doc,
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        );
        if (result.upsertedCount) stats.created++;
        else stats.updated++;
      } else {
        // No email — try to dedup by phone
        if (phones.length > 0) {
          const result = await contacts.updateOne(
            { "phones.number": phones[0].number },
            {
              $set: doc,
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
          );
          if (result.upsertedCount) stats.created++;
          else stats.updated++;
        } else {
          await contacts.insertOne({ ...doc, createdAt: new Date() });
          stats.created++;
        }
      }
    } catch (err: any) {
      console.error(`Error: ${email || name}: ${err.message}`);
      stats.errors++;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total:   ${stats.total}`);
  console.log(`Created: ${stats.created}`);
  console.log(`Updated: ${stats.updated}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors:  ${stats.errors}`);

  if (!dryRun) {
    const count = await contacts.countDocuments();
    console.log(`\nContacts in DB: ${count}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
