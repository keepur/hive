#!/usr/bin/env npx tsx
/**
 * One-time operator script: move HubSpot-sourced records from `contacts` → `crm_contacts`.
 *
 * Run once after deploying the crm_contacts split (KPR-80). Safe to re-run — idempotent.
 *
 * Usage: npm run migrate:split-crm-contacts
 */

import { MongoClient } from "mongodb";

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const mongoDb = process.env.MONGODB_DB || "hive";

async function main() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  const contacts = db.collection("contacts");
  const crmContacts = db.collection("crm_contacts");

  // Create indexes on crm_contacts (idempotent)
  await crmContacts.createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: "string" } } },
  );
  await crmContacts.createIndex({ "phones.number": 1 });
  await crmContacts.createIndex({ name: "text", email: "text", company: "text" });
  await crmContacts.createIndex({ tags: 1 });
  await crmContacts.createIndex({ updatedAt: 1 });
  await crmContacts.createIndex({ source: 1 });
  await crmContacts.createIndex({ sourceId: 1 }, { sparse: true });

  const SOURCE = "hubspot";
  const cursor = contacts.find({ source: SOURCE });
  let moved = 0;
  let skipped = 0;

  for await (const doc of cursor) {
    try {
      await crmContacts.replaceOne({ _id: doc._id }, doc, { upsert: true });
      await contacts.deleteOne({ _id: doc._id });
      moved++;
    } catch (err) {
      console.warn(`  WARN: failed to move contact ${String(doc._id)}:`, err);
      skipped++;
    }
  }

  console.log(`\nMigration complete — moved: ${moved}, skipped: ${skipped}`);

  if (skipped > 0) {
    console.error(`ERROR: ${skipped} record(s) failed to move — fix errors above and re-run`);
    await client.close();
    process.exit(1);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
