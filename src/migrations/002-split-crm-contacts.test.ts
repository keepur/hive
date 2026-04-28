import { describe, it, expect, vi, beforeEach } from "vitest";
import { migration002SplitCrmContacts } from "./002-split-crm-contacts.js";
import type { Db, Collection } from "mongodb";

// ---------------------------------------------------------------------------
// Minimal in-memory Mongo fake
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function makeCollection(initial: Doc[] = []) {
  const docs: Doc[] = initial.map((d) => ({ ...d }));

  return {
    _docs: docs,
    async createIndex(_keys: unknown, _opts?: unknown) {
      // no-op for tests
    },
    find(filter: Record<string, unknown>) {
      const filtered = docs.filter((d) => {
        for (const [key, val] of Object.entries(filter)) {
          if (d[key] !== val) return false;
        }
        return true;
      });
      // Return async iterable snapshot (copy so deletes don't affect iteration)
      const snapshot = [...filtered];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < snapshot.length) return { value: snapshot[i++], done: false };
              return { value: undefined as unknown, done: true as const };
            },
          };
        },
      };
    },
    async replaceOne(filter: Record<string, unknown>, replacement: Doc, opts?: { upsert?: boolean }) {
      const id = filter["_id"];
      const idx = docs.findIndex((d) => d["_id"] === id);
      if (idx !== -1) {
        docs[idx] = { ...replacement };
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      } else if (opts?.upsert) {
        docs.push({ ...replacement });
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    async deleteOne(filter: Record<string, unknown>) {
      const id = filter["_id"];
      const idx = docs.findIndex((d) => d["_id"] === id);
      if (idx !== -1) {
        docs.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    async countDocuments() {
      return docs.length;
    },
  };
}

function makeDb(
  contactsColl: ReturnType<typeof makeCollection>,
  crmContactsColl: ReturnType<typeof makeCollection>,
): Db {
  return {
    collection(name: string) {
      if (name === "contacts") return contactsColl as unknown as Collection;
      if (name === "crm_contacts") return crmContactsColl as unknown as Collection;
      throw new Error(`Unknown collection: ${name}`);
    },
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migration002SplitCrmContacts", () => {
  let log: ReturnType<typeof makeLog>;

  beforeEach(() => {
    log = makeLog();
  });

  it("moves hubspot records to crm_contacts and removes from contacts", async () => {
    const contactsColl = makeCollection([
      { _id: "a", name: "Jay M", email: "jay@example.com", source: "hubspot", phones: [], tags: [] },
      { _id: "b", name: "Team Member", email: "team@dodihome.com", source: "manual", phones: [], tags: [] },
    ]);
    const crmContactsColl = makeCollection([]);
    const db = makeDb(contactsColl, crmContactsColl);

    await migration002SplitCrmContacts.run(db, log as never);

    expect(await contactsColl.countDocuments()).toBe(1);
    expect(await crmContactsColl.countDocuments()).toBe(1);

    const remaining = contactsColl._docs[0];
    expect(remaining["source"]).toBe("manual");
    expect(remaining["name"]).toBe("Team Member");

    const moved = crmContactsColl._docs[0];
    expect(moved["source"]).toBe("hubspot");
    expect(moved["name"]).toBe("Jay M");
  });

  it("is idempotent — re-running does not double-move or error", async () => {
    const contactsColl = makeCollection([
      { _id: "a", name: "Jay M", email: "jay@example.com", source: "hubspot", phones: [], tags: [] },
    ]);
    const crmContactsColl = makeCollection([]);
    const db = makeDb(contactsColl, crmContactsColl);

    await migration002SplitCrmContacts.run(db, log as never);
    // Second run — contacts is empty, crm_contacts has the record
    await migration002SplitCrmContacts.run(db, log as never);

    expect(await contactsColl.countDocuments()).toBe(0);
    expect(await crmContactsColl.countDocuments()).toBe(1);
  });

  it("leaves contacts collection unchanged when there are no hubspot records", async () => {
    const contactsColl = makeCollection([
      { _id: "b", name: "Team Member", email: "team@dodihome.com", source: "manual", phones: [], tags: [] },
    ]);
    const crmContactsColl = makeCollection([]);
    const db = makeDb(contactsColl, crmContactsColl);

    await migration002SplitCrmContacts.run(db, log as never);

    expect(await contactsColl.countDocuments()).toBe(1);
    expect(await crmContactsColl.countDocuments()).toBe(0);
  });

  it("logs completion with moved/skipped counts", async () => {
    const contactsColl = makeCollection([
      { _id: "a", name: "Jay M", email: "jay@example.com", source: "hubspot", phones: [], tags: [] },
    ]);
    const crmContactsColl = makeCollection([]);
    const db = makeDb(contactsColl, crmContactsColl);

    await migration002SplitCrmContacts.run(db, log as never);

    expect(log.info).toHaveBeenCalledWith(
      "Migration complete",
      expect.objectContaining({ migration: "002-split-crm-contacts", moved: 1, skipped: 0 }),
    );
  });
});
