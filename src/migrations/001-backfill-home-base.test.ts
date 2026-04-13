import { describe, it, expect, vi, beforeEach } from "vitest";
import { migration001BackfillHomeBase } from "./001-backfill-home-base.js";
import type { Db, Collection } from "mongodb";

// ---------------------------------------------------------------------------
// Minimal in-memory Mongo fake
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function makeCollection(initial: Doc[] = []) {
  const docs: Doc[] = [...initial];

  return {
    _docs: docs,
    find(filter: Record<string, unknown>) {
      // Only handle the { homeBase: { $exists: false } } filter pattern
      const filtered = docs.filter((d) => {
        if ("homeBase" in filter) {
          const cond = filter["homeBase"] as Record<string, boolean>;
          if ("$exists" in cond) {
            return cond["$exists"] ? "homeBase" in d : !("homeBase" in d);
          }
        }
        return true;
      });
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < filtered.length) return { value: filtered[i++], done: false };
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      const id = filter["_id"];
      const idx = docs.findIndex((d) => d["_id"] === id);
      if (idx !== -1) {
        const set = (update["$set"] as Record<string, unknown>) ?? {};
        Object.assign(docs[idx], set);
      }
      return { matchedCount: idx !== -1 ? 1 : 0, modifiedCount: idx !== -1 ? 1 : 0 };
    },
  };
}

function makeDb(agentDefs: ReturnType<typeof makeCollection>): Db {
  return {
    collection(_name: string) {
      return agentDefs as unknown as Collection;
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

describe("migration001BackfillHomeBase", () => {
  let log: ReturnType<typeof makeLog>;

  beforeEach(() => {
    log = makeLog();
  });

  it("DodiHome-style: sets homeBase to the agent- channel", async () => {
    const coll = makeCollection([{ _id: "jasper", channels: ["agent-jasper", "general"] }]);
    const db = makeDb(coll);

    await migration001BackfillHomeBase.run(db, log as never);

    expect(coll._docs[0]["homeBase"]).toBe("agent-jasper");
  });

  it("personal-style: falls back to channels[0] when no agent- channel exists", async () => {
    const coll = makeCollection([{ _id: "vp-engineering", channels: ["remy", "dev"] }]);
    const db = makeDb(coll);

    await migration001BackfillHomeBase.run(db, log as never);

    expect(coll._docs[0]["homeBase"]).toBe("remy");
  });

  it("preserves existing homeBase — $exists:false filter excludes it", async () => {
    const coll = makeCollection([
      { _id: "mokie", channels: ["agent-mokie"], homeBase: "mokie-huang" },
    ]);
    const db = makeDb(coll);

    await migration001BackfillHomeBase.run(db, log as never);

    // homeBase untouched because doc has homeBase already
    expect(coll._docs[0]["homeBase"]).toBe("mokie-huang");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("emits a warn and skips when channels is empty", async () => {
    const coll = makeCollection([{ _id: "orphan", channels: [] }]);
    const db = makeDb(coll);

    await expect(migration001BackfillHomeBase.run(db, log as never)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("no channels"),
      expect.objectContaining({ agentId: "orphan" }),
    );
    expect("homeBase" in coll._docs[0]).toBe(false);
  });

  it("is idempotent — second run is a no-op", async () => {
    const coll = makeCollection([{ _id: "jasper", channels: ["agent-jasper", "general"] }]);
    const db = makeDb(coll);

    await migration001BackfillHomeBase.run(db, log as never);

    // After first run, homeBase exists — the find filter excludes it
    const updateOneSpy = vi.spyOn(coll, "updateOne");

    await migration001BackfillHomeBase.run(db, log as never);

    expect(updateOneSpy).not.toHaveBeenCalled();
  });
});
