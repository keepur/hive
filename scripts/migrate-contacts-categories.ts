#!/usr/bin/env npx tsx
/**
 * One-time migration: backfill `category` on `contacts` records (KPR-139).
 *
 * Operations (idempotent, safe to re-run):
 *   1. Delete obvious test rows (matching test-email regex patterns).
 *   2. De-duplicate by lowercased email — keep the most recently updated, mark
 *      the rest `category: "archived"` (audit-preserving, NOT a hard delete).
 *   3. Backfill `category`:
 *      - team-email match (hardcoded list, see TEAM_EMAILS_DODI) → "team-human"
 *      - source: "hubspot" → "customer" (these were already moved to crm_contacts
 *        on dodi by KPR-114; this is for instances that haven't done that split)
 *      - everything else → "customer" (default; operator can re-categorize via
 *        contacts_update or admin UI)
 *
 * Usage:
 *   npm run migrate:contacts-categories             # dry-run, prints tally
 *   npm run migrate:contacts-categories -- --apply  # commit changes
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017), MONGODB_DB (default "hive")
 */

import { MongoClient, type ObjectId } from "mongodb";

// Hardcoded team emails — currently dodi-only. Other instances should either:
//   (a) edit this list before running, or
//   (b) skip this script entirely and use the contacts MCP (`contacts_create`)
//       to seed team-humans manually with `category: "team-human"` set up-front.
//
// Per spec: this match takes precedence over the "source: hubspot" rule, so a
// HubSpot-synced row whose email belongs to a team member is correctly
// recategorized as team-human (not customer).
//
// If you run this on a non-dodi instance without editing this list, every
// contact will be categorized as "customer" — see the warning emitted by the
// dry-run summary when zero team-emails match.
const TEAM_EMAILS_DODI = new Set(
  ["may", "mike", "corey", "angus", "aaron", "angela", "lauren", "zhitong"].map(
    (n) => `${n}@dodihome.com`,
  ),
);

const TEST_EMAIL_PATTERNS: RegExp[] = [
  /^layna\+test/i,
  /^test\+/i,
];

interface ContactDoc {
  _id: ObjectId;
  email: string | null;
  source?: string;
  category?: string;
  updatedAt?: Date;
}

function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return TEST_EMAIL_PATTERNS.some((re) => re.test(email));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB || "hive";

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const contacts = db.collection<ContactDoc>("contacts");

  const all = await contacts.find({}).toArray();

  // Step 1: identify test rows
  const testIds = all.filter((d) => isTestEmail(d.email)).map((d) => d._id);

  // Step 2: dedup by lowercased email — keep most recently updated
  const byEmail = new Map<string, ContactDoc[]>();
  for (const d of all) {
    if (!d.email || isTestEmail(d.email)) continue;
    const key = d.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(d);
  }
  const toArchiveIds: ObjectId[] = [];
  for (const dups of byEmail.values()) {
    if (dups.length <= 1) continue;
    dups.sort((a, b) => +new Date(b.updatedAt ?? 0) - +new Date(a.updatedAt ?? 0));
    for (const stale of dups.slice(1)) toArchiveIds.push(stale._id);
  }

  // Step 3: backfill category on remaining
  const ops: Array<{ updateOne: { filter: { _id: ObjectId }; update: { $set: { category: string } } } }> = [];
  let alreadyCategorized = 0;
  let toCategorize = 0;
  const archiveIdSet = new Set(toArchiveIds.map((id) => id.toHexString()));
  const testIdSet = new Set(testIds.map((id) => id.toHexString()));

  for (const d of all) {
    const idStr = d._id.toHexString();
    if (testIdSet.has(idStr)) continue;
    if (archiveIdSet.has(idStr)) {
      ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { category: "archived" } } } });
      continue;
    }
    if (d.category) {
      alreadyCategorized++;
      continue;
    }
    const email = (d.email ?? "").toLowerCase();
    const cat = TEAM_EMAILS_DODI.has(email) ? "team-human" : "customer";
    ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { category: cat } } } });
    toCategorize++;
  }

  // Sanity check: count how many would be matched as team-human under the
  // current TEAM_EMAILS_DODI list. If zero, warn loudly — almost certainly the
  // operator is running this on a non-dodi instance without editing the list.
  let teamMatches = 0;
  for (const d of all) {
    const email = (d.email ?? "").toLowerCase();
    if (TEAM_EMAILS_DODI.has(email)) teamMatches++;
  }

  console.log(`Plan against ${dbName}.contacts (total: ${all.length}):`);
  console.log(`  delete (test rows): ${testIds.length}`);
  console.log(`  archive (duplicate email): ${toArchiveIds.length}`);
  console.log(`  categorize (uncategorized): ${toCategorize}`);
  console.log(`  already categorized (skip): ${alreadyCategorized}`);
  console.log(`  team-human matches (current TEAM_EMAILS_DODI): ${teamMatches}`);

  if (teamMatches === 0 && all.length > 0) {
    console.warn(
      `\nWARNING: zero contacts match TEAM_EMAILS_DODI. If this isn't dodi, ` +
        `edit the hardcoded list in this script before running with --apply, ` +
        `or skip the script and seed team-humans via the contacts MCP.`,
    );
  }

  if (!apply) {
    console.log("\n(dry-run; pass --apply to commit)");
    await client.close();
    return;
  }

  if (testIds.length > 0) {
    const r = await contacts.deleteMany({ _id: { $in: testIds } });
    console.log(`Deleted: ${r.deletedCount}`);
  }
  if (ops.length > 0) {
    const r = await contacts.bulkWrite(ops);
    console.log(`Updates: matched=${r.matchedCount} modified=${r.modifiedCount}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
