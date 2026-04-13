import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMigrations } from "./run-migrations.js";
import type { Db, Collection } from "mongodb";
import type { Migration } from "./run-migrations.js";

// ---------------------------------------------------------------------------
// In-memory migrations collection fake
// ---------------------------------------------------------------------------

type MigrationRecord = { _id: string; ranAt: Date };

function makeMigrationsCollection(initial: MigrationRecord[] = []) {
  const docs: MigrationRecord[] = [...initial];

  return {
    _docs: docs,
    async findOne(filter: Record<string, unknown>) {
      const id = filter["_id"];
      return docs.find((d) => d._id === id) ?? null;
    },
    async insertOne(doc: MigrationRecord) {
      docs.push(doc);
      return { insertedId: doc._id };
    },
  };
}

function makeDb(migrationsColl: ReturnType<typeof makeMigrationsCollection>): Db {
  return {
    collection(_name: string) {
      return migrationsColl as unknown as Collection;
    },
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMigration(id: string, runFn?: () => Promise<void>): Migration {
  return {
    id,
    run: vi.fn(runFn ?? (() => Promise.resolve())),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runMigrations", () => {
  let migColl: ReturnType<typeof makeMigrationsCollection>;
  let db: Db;

  beforeEach(() => {
    migColl = makeMigrationsCollection();
    db = makeDb(migColl);
  });

  it("runs migrations in order", async () => {
    const order: string[] = [];
    const a = makeMigration("a", async () => {
      order.push("a");
    });
    const b = makeMigration("b", async () => {
      order.push("b");
    });

    await runMigrations(db, [a, b]);

    expect(order).toEqual(["a", "b"]);
  });

  it("skips already-applied migrations", async () => {
    // Pre-seed migration a as already run
    migColl = makeMigrationsCollection([{ _id: "a", ranAt: new Date() }]);
    db = makeDb(migColl);

    const a = makeMigration("a");
    const b = makeMigration("b");

    await runMigrations(db, [a, b]);

    expect(a.run).not.toHaveBeenCalled();
    expect(b.run).toHaveBeenCalledOnce();
  });

  it("inserts a marker record after successful migration", async () => {
    const a = makeMigration("a");

    await runMigrations(db, [a]);

    const record = await migColl.findOne({ _id: "a" });
    expect(record).not.toBeNull();
    expect(record!.ranAt).toBeInstanceOf(Date);
  });

  it("does NOT insert a marker when the migration throws", async () => {
    const a = makeMigration("a", async () => {
      throw new Error("migration blew up");
    });

    await expect(runMigrations(db, [a])).rejects.toThrow("migration blew up");

    const record = await migColl.findOne({ _id: "a" });
    expect(record).toBeNull();
  });
});
