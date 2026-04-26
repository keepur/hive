#!/usr/bin/env node
/**
 * KPR-79: Migrate contacts collection — backfill `category`, dedupe by
 * lowercase email, archive stale rows, delete obvious test rows.
 *
 * Usage:
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --dry-run
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --apply
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --apply --team-emails-file=team.txt
 *
 * Idempotent: re-running on already-migrated data is a no-op.
 *
 * Caveat (step 2): only collapses records with identical-after-lowercase
 * emails. Typo-distinct emails (e.g. cotry@ vs corey@) are NOT merged —
 * fix manually before/after.
 *
 * Restore: --dry-run writes the diff to /tmp/kpr-79-migration-<ts>.diff;
 * --apply writes the same diff for post-hoc reference. Step 1 (test-row
 * delete) is the only true delete; step 2 (dedupe) sets category="archived"
 * to retain audit history.
 */

import { MongoClient, ObjectId } from "mongodb";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_EMAIL_PATTERNS = [/^layna\+test/i];
const STALE_TEAM_NAMES = new Set(["Konstantin"]); // former Director of Operations

const DODI_TEAM_EMAILS = new Set([
  "may@dodihome.com",
  "corey@dodihome.com",
  "aaron@dodihome.com",
  "angus@dodihome.com",
  "angela@dodihome.com",
  "lauren@dodihome.com",
  "zhitong@dodihome.com",
  "mike@dodihome.com",
]);

interface DiffEntry {
  op: "delete" | "archive" | "set-category" | "set-name-archived";
  id: string;
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface Args {
  instance: string;
  dryRun: boolean;
  apply: boolean;
  teamEmails: Set<string>;
}

/** Pure helper: pick the category for a contact given the team-email allowlist. */
export function categorizeContact(
  contact: { email: string | null; source: string },
  teamEmails: Set<string>,
): "team-human" | "customer" {
  const lcEmail = contact.email?.toLowerCase() ?? null;
  if (lcEmail && teamEmails.has(lcEmail)) return "team-human";
  if (contact.source === "hubspot") return "customer";
  return "customer";
}

/** Pure helper: pick the keeper from a duplicate group (most recently updated). */
export function pickKeeper<T extends { updatedAt?: Date }>(rows: T[]): T {
  const sorted = [...rows].sort((a, b) => {
    const ta = a.updatedAt?.getTime() ?? 0;
    const tb = b.updatedAt?.getTime() ?? 0;
    return tb - ta;
  });
  return sorted[0];
}

function parseArgs(argv: string[]): Args {
  if (argv.length < 1) usage();
  const instance = argv[0];
  const flags = new Set(argv.slice(1).filter((a) => !a.includes("=")));
  const kv = Object.fromEntries(
    argv.slice(1).filter((a) => a.includes("=")).map((a) => a.split("=")),
  );
  const dryRun = flags.has("--dry-run");
  const apply = flags.has("--apply");
  if (dryRun === apply) {
    console.error("Pass exactly one of --dry-run or --apply.");
    process.exit(2);
  }
  let teamEmails = DODI_TEAM_EMAILS;
  if (kv["--team-emails-file"]) {
    const path = kv["--team-emails-file"];
    if (!existsSync(path)) {
      console.error(`team-emails-file not found: ${path}`);
      process.exit(2);
    }
    teamEmails = new Set(
      readFileSync(path, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
  }
  return { instance, dryRun, apply, teamEmails };
}

function usage(): never {
  console.error("Usage: migrate-contacts-categories <instance> --dry-run|--apply [--team-emails-file=<path>]");
  process.exit(2);
}

async function loadInstanceMongoUri(instance: string): Promise<{ uri: string; dbName: string }> {
  // Read from ~/services/hive/<instance>/.hive/dist or env. Mirror the agent-id
  // migration script's approach: prefer MONGODB_URI env, otherwise default
  // mongodb://localhost:27017 + db name `hive_<instance>` (matches multi-instance convention).
  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB ?? `hive_${instance}`;
  return { uri, dbName };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { uri, dbName } = await loadInstanceMongoUri(args.instance);
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const contacts = db.collection("contacts");
    const diff: DiffEntry[] = [];

    // Step 1: delete obvious test rows.
    const testRows = await contacts
      .find({
        $or: TEST_EMAIL_PATTERNS.map((p) => ({ email: { $regex: p } })),
      })
      .toArray();
    for (const r of testRows) {
      diff.push({ op: "delete", id: String(r._id), before: r });
    }

    // Step 2: dedupe by lowercase email (keep most recently updated).
    // Excludes already-archived rows so re-runs are idempotent.
    const allWithEmail = await contacts
      .find({
        email: { $ne: null },
        category: { $ne: "archived" },
      })
      .toArray();
    const groups = new Map<string, Array<Record<string, unknown> & { _id: unknown; email: string; updatedAt?: Date }>>();
    for (const r of allWithEmail) {
      const email = r.email as string | null;
      if (!email) continue;
      const key = email.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r as never);
    }
    const archiveIds = new Set<string>();
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;
      const keeper = pickKeeper(rows);
      for (const r of rows) {
        if (r === keeper) continue;
        archiveIds.add(String(r._id));
        diff.push({
          op: "archive",
          id: String(r._id),
          before: { email: r.email, category: r.category },
          after: { category: "archived" },
        });
      }
    }

    // Step 3: backfill category, first-match-wins precedence.
    const remaining = await contacts.find({}).toArray();
    for (const r of remaining) {
      // Skip records pending delete or archive
      const email = r.email as string | null;
      if (TEST_EMAIL_PATTERNS.some((p) => email && p.test(email))) continue;
      if (archiveIds.has(String(r._id))) continue;
      // Skip if category is already set (idempotent)
      if (r.category) continue;

      const next = categorizeContact(
        { email: email ?? null, source: (r.source as string) ?? "" },
        args.teamEmails,
      );
      diff.push({
        op: "set-category",
        id: String(r._id),
        before: { category: r.category, source: r.source, email: r.email },
        after: { category: next },
      });
    }

    // Step 4: archive stale named team members. Skip if already archived
    // (idempotency — re-runs produce no diff once cleaned).
    const staleByName = await contacts
      .find({
        name: { $in: [...STALE_TEAM_NAMES] },
        category: { $ne: "archived" },
      })
      .toArray();
    for (const r of staleByName) {
      if (archiveIds.has(String(r._id))) continue;
      diff.push({
        op: "set-name-archived",
        id: String(r._id),
        before: { name: r.name, category: r.category },
        after: { category: "archived" },
      });
    }

    // Write diff
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const diffPath = `/tmp/kpr-79-migration-${ts}.diff`;
    writeFileSync(diffPath, JSON.stringify(diff, null, 2));
    console.log(`Diff written: ${diffPath}`);
    console.log(`Operations queued: ${diff.length}`);
    const counts = diff.reduce((acc: Record<string, number>, e) => {
      acc[e.op] = (acc[e.op] ?? 0) + 1;
      return acc;
    }, {});
    console.log("Breakdown:", counts);

    if (args.dryRun) {
      console.log("--dry-run: no writes performed.");
      return;
    }

    // Apply
    for (const e of diff) {
      const _id = new ObjectId(e.id);
      if (e.op === "delete") {
        await contacts.deleteOne({ _id });
      } else if (e.op === "archive" || e.op === "set-name-archived") {
        await contacts.updateOne({ _id }, { $set: { category: "archived", updatedAt: new Date() } });
      } else if (e.op === "set-category") {
        await contacts.updateOne(
          { _id },
          { $set: { category: (e.after as { category: string }).category, updatedAt: new Date() } },
        );
      }
    }
    console.log(`--apply: ${diff.length} operations committed.`);
  } finally {
    await client.close();
  }
}

// Only run when invoked directly (not when imported by tests).
// Compares the resolved entrypoint URL to the module URL.
const entryUrl = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === entryUrl) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
