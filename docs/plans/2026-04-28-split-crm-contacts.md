# Split CRM Contacts Collection — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Move HubSpot-synced contact records out of the shared `contacts` collection into a dedicated `crm_contacts` collection, leaving `contacts` as a clean team-roster store.

**Architecture:** A standard migrations-system entry handles the one-time data move (copy → delete); it runs automatically at next hive startup on every instance. `import-hubspot.ts` is updated to target `crm_contacts` for future CSV imports. No changes are needed to `contacts-mcp-server.ts` (it now serves a smaller, clean dataset), `crm-search-mcp-server.ts` (reads Qdrant/Atlas RAG — never touched `hive.contacts`), or `imessage-adapter.ts` (team-roster lookup only is correct behavior).

**Tech Stack:** TypeScript, MongoDB (Node driver), hive migrations system

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/migrations/002-split-crm-contacts.ts` | **Create** | One-time migration: copy `source=hubspot` records from `contacts` → `crm_contacts`, delete originals |
| `src/migrations/run-migrations.ts` | **Modify** (line 4, 20) | Register migration002 |
| `src/contacts/import-hubspot.ts` | **Modify** (line 75, collection ref) | Target `crm_contacts` for future imports |

---

## Task 1: Write the migration

**Files:**
- Create: `src/migrations/002-split-crm-contacts.ts`
- Test: `src/migrations/002-split-crm-contacts.test.ts`

- [ ] **Step 1:** Create `src/migrations/002-split-crm-contacts.ts`

```typescript
import type { Db } from "mongodb";
import type { createLogger } from "../logging/logger.js";

export const migration002SplitCrmContacts = {
  id: "002-split-crm-contacts",
  async run(db: Db, log: ReturnType<typeof createLogger>): Promise<void> {
    const contacts = db.collection("contacts");
    const crmContacts = db.collection("crm_contacts");

    // Create indexes on crm_contacts (idempotent)
    await crmContacts.createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: "string" } } },
    );
    await crmContacts.createIndex({ "phones.number": 1 });
    await crmContacts.createIndex(
      { name: "text", email: "text", company: "text" },
    );
    await crmContacts.createIndex({ tags: 1 });
    await crmContacts.createIndex({ updatedAt: 1 });
    await crmContacts.createIndex({ source: 1 });
    await crmContacts.createIndex({ sourceId: 1 }, { sparse: true });

    const cursor = contacts.find({ source: "hubspot" });
    let moved = 0;
    let skipped = 0;

    for await (const doc of cursor) {
      try {
        await crmContacts.replaceOne({ _id: doc._id }, doc, { upsert: true });
        await contacts.deleteOne({ _id: doc._id });
        moved++;
      } catch (err) {
        log.warn("Failed to move contact record", { id: doc._id, err });
        skipped++;
      }
    }

    log.info("Migration complete", {
      migration: "002-split-crm-contacts",
      moved,
      skipped,
    });
  },
};
```

- [ ] **Step 2:** Create `src/migrations/002-split-crm-contacts.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { migration002SplitCrmContacts } from "./002-split-crm-contacts.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("test");
const URI = "mongodb://localhost:27017";
const DB = "test_migration_002";

describe("migration002SplitCrmContacts", () => {
  let client: MongoClient;
  let db: Db;

  beforeEach(async () => {
    client = new MongoClient(URI);
    await client.connect();
    db = client.db(DB);
    await db.collection("contacts").deleteMany({});
    await db.collection("crm_contacts").deleteMany({});
  });

  afterEach(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it("moves hubspot records to crm_contacts and removes from contacts", async () => {
    await db.collection("contacts").insertMany([
      { name: "Jay M", email: "jay@example.com", source: "hubspot", phones: [], tags: [], createdAt: new Date(), updatedAt: new Date() },
      { name: "Team Member", email: "team@dodihome.com", source: "manual", phones: [], tags: [], createdAt: new Date(), updatedAt: new Date() },
    ]);

    await migration002SplitCrmContacts.run(db, log);

    const remaining = await db.collection("contacts").countDocuments();
    const moved = await db.collection("crm_contacts").countDocuments();
    expect(remaining).toBe(1);
    expect(moved).toBe(1);

    const teamMember = await db.collection("contacts").findOne({ source: "manual" });
    expect(teamMember?.name).toBe("Team Member");

    const crmContact = await db.collection("crm_contacts").findOne({ source: "hubspot" });
    expect(crmContact?.name).toBe("Jay M");
  });

  it("is idempotent — re-running does not double-move or error", async () => {
    await db.collection("contacts").insertOne({
      name: "Jay M", email: "jay@example.com", source: "hubspot",
      phones: [], tags: [], createdAt: new Date(), updatedAt: new Date(),
    });

    await migration002SplitCrmContacts.run(db, log);
    // Second run — contacts is empty, crm_contacts has the record
    await migration002SplitCrmContacts.run(db, log);

    expect(await db.collection("contacts").countDocuments()).toBe(0);
    expect(await db.collection("crm_contacts").countDocuments()).toBe(1);
  });

  it("leaves contacts collection unchanged when there are no hubspot records", async () => {
    await db.collection("contacts").insertOne({
      name: "Team Member", email: "team@dodihome.com", source: "manual",
      phones: [], tags: [], createdAt: new Date(), updatedAt: new Date(),
    });

    await migration002SplitCrmContacts.run(db, log);

    expect(await db.collection("contacts").countDocuments()).toBe(1);
    expect(await db.collection("crm_contacts").countDocuments()).toBe(0);
  });
});
```

- [ ] **Step 3:** Register in `src/migrations/run-migrations.ts`

At line 4 (after the existing `migration001` import) add:
```typescript
import { migration002SplitCrmContacts } from "./002-split-crm-contacts.js";
```

Change line 18 (the MIGRATIONS array):
```typescript
export const MIGRATIONS: Migration[] = [
  migration001BackfillHomeBase,
  migration002SplitCrmContacts,
];
```

- [ ] **Step 4:** Verify tests pass

```bash
cd ~/github/hive && npm test -- src/migrations/
```
Expected: `002-split-crm-contacts.test.ts (3 tests)` all green

- [ ] **Step 5:** Commit

```bash
git add src/migrations/002-split-crm-contacts.ts src/migrations/002-split-crm-contacts.test.ts src/migrations/run-migrations.ts
git commit -m "feat(migrations): 002 split HubSpot records from contacts into crm_contacts"
```

---

## Task 2: Update import-hubspot.ts

**Files:**
- Modify: `src/contacts/import-hubspot.ts` (line 75 — `db.collection("contacts")` → `db.collection("crm_contacts")`)

- [ ] **Step 1:** Change the collection reference in `src/contacts/import-hubspot.ts`

Find (around line 75):
```typescript
  const contacts = db.collection("contacts");
```

Replace with:
```typescript
  const contacts = db.collection("crm_contacts");
```

- [ ] **Step 2:** Add missing indexes to the index creation block in `import-hubspot.ts`. The existing 5-index block omits `source` and `sourceId` which the migration creates. After the collection rename, add these two lines after the existing index calls:

```typescript
    await contacts.createIndex({ source: 1 });
    await contacts.createIndex({ sourceId: 1 }, { sparse: true });
```

- [ ] **Step 3:** Update the script's doc-comment to reflect new target:

Find:
```
 * Import HubSpot CSV contacts into hive.contacts MongoDB collection.
```

Replace with:
```
 * Import HubSpot CSV contacts into hive.crm_contacts MongoDB collection.
```

- [ ] **Step 4:** Commit

```bash
git add src/contacts/import-hubspot.ts
git commit -m "feat(contacts): import-hubspot.ts targets crm_contacts collection"
```

---

## Task 3: Smoke test

- [ ] **Step 1:** Run the full check

```bash
cd ~/github/hive && npm run check
```
Expected: all tests pass, no type errors

- [ ] **Step 2:** Confirm migration runs correctly on dodi

After the migration lands and hive restarts (or `npm run dev`), check:
```bash
mongosh hive_dodi --quiet --eval "
  print('contacts total:', db.contacts.countDocuments());
  print('contacts hubspot:', db.contacts.countDocuments({source: 'hubspot'}));
  print('crm_contacts total:', db.crm_contacts.countDocuments());
  print('crm_contacts hubspot:', db.crm_contacts.countDocuments({source: 'hubspot'}));
"
```
Expected:
```
contacts total: ~6  (team roster only)
contacts hubspot: 0
crm_contacts total: ~7705
crm_contacts hubspot: ~7705
```

- [ ] **Step 3:** Confirm migration records inserted

```bash
mongosh hive_dodi --quiet --eval "db.migrations.find({_id: '002-split-crm-contacts'}).toArray()"
```
Expected: one document with `ranAt` timestamp

- [ ] **Step 4:** Confirm contacts-mcp-server still works

The contacts MCP server reads from `"contacts"` — verify with a quick agent query or:
```bash
mongosh hive_dodi --quiet --eval "db.contacts.find({source: {$ne: 'hubspot'}}).toArray()"
```
Expected: team roster only (May, Mokie, Corey, etc.)

---

## Notes

- The migration handles `_id` collision gracefully: `replaceOne` with `upsert: true` by `_id` — if the record already exists in `crm_contacts` (from a previous partial run), it's replaced (idempotent).
- Keepur has no HubSpot-sourced contacts, so the migration is a no-op on that instance (0 records moved, indexes created on empty collection).
- `crm-search-mcp-server.ts` is **not modified** — it reads Qdrant/Atlas RAG collections populated by the HubSpot sync pipeline, entirely separate from `hive.contacts`.
- `imessage-adapter.ts` is **not modified** — iMessage contact resolution looks up team members and manually-curated contacts, not the 7,700-record CRM dataset.
- `contacts-mcp-server.ts` is **not modified** — it correctly targets `"contacts"` and will automatically benefit from the smaller, cleaner dataset after migration.
