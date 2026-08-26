import { describe, it, expect } from "vitest";
import { OutageQueueStore, type OutageQueueDoc, type OutageEnqueueInput } from "./outage-queue-store.js";
import type { Collection } from "mongodb";
import type { WorkItem } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// In-memory fake of the exact driver surface OutageQueueStore uses.
// Same mock-the-driver approach as scheduler.test.ts / doctor-checks.test.ts.
// ---------------------------------------------------------------------------

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$lt" in cond && !(val !== null && val < cond.$lt)) return false;
      if ("$gte" in cond && !(val !== null && val >= cond.$gte)) return false;
      if ("$in" in cond && !(cond.$in as unknown[]).includes(val)) return false;
    } else if (val instanceof Date && cond instanceof Date) {
      if (val.getTime() !== cond.getTime()) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc: Record<string, any>, update: Record<string, any>): void {
  for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
}

class FakeOutageCollection {
  docs: Record<string, any>[] = [];
  private nextId = 1;

  async createIndex(): Promise<string> {
    return "ok";
  }

  async updateOne(filter: any, update: any, options?: { upsert?: boolean }) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (doc) {
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (options?.upsert) {
      const fresh: Record<string, any> = { _id: `oid-${this.nextId++}` };
      // Equality filter fields become part of the inserted doc (Mongo upsert semantics).
      for (const [k, v] of Object.entries(filter)) {
        if (v === null || typeof v !== "object" || v instanceof Date) fresh[k] = v;
      }
      for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) fresh[k] = v;
      for (const [k, v] of Object.entries(update.$set ?? {})) fresh[k] = v;
      this.docs.push(fresh);
      return { matchedCount: 0, modifiedCount: 0 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async updateMany(filter: any, update: any) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (matches(doc, filter)) {
        applyUpdate(doc, update);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(filter: any, update: any, options?: { sort?: Record<string, 1 | -1> }) {
    let candidates = this.docs.filter((d) => matches(d, filter));
    if (options?.sort) {
      // KPR-400 (F2): multi-key sort, mirroring the ONE BSON type-ordering
      // fact claimNext relies on — a missing/null field sorts BEFORE any
      // string (documented Mongo behavior: null/missing < string), so
      // legacy docs without enqueueOrigin claim with top priority (⚠A5).
      const entries = Object.entries(options.sort);
      candidates = [...candidates].sort((a, b) => {
        for (const [key, dir] of entries) {
          const aMissing = a[key] === undefined || a[key] === null;
          const bMissing = b[key] === undefined || b[key] === null;
          if (aMissing !== bMissing) return (aMissing ? -1 : 1) * dir;
          if (aMissing && bMissing) continue;
          if (a[key] < b[key]) return -dir;
          if (a[key] > b[key]) return dir;
        }
        return 0;
      });
    }
    const doc = candidates[0];
    if (!doc) return null;
    applyUpdate(doc, update);
    return { ...doc };
  }

  async findOne(filter: any) {
    const doc = this.docs.find((d) => matches(d, filter));
    return doc ? { ...doc } : null;
  }

  async countDocuments(filter: any) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  find(filter: any) {
    const results = this.docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
    return { toArray: async () => results };
  }
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date("2026-07-07T10:00:00Z"),
    ...overrides,
  };
}

function makeInput(overrides: Partial<OutageEnqueueInput> = {}): OutageEnqueueInput {
  return {
    itemId: "msg-1",
    agentId: "agent-a",
    provider: "claude",
    workItem: makeWorkItem(),
    policy: "notify",
    enqueueOrigin: "fast-fail", // KPR-400 (F2): required input field; harness default
    ...overrides,
  };
}

function makeStore(nowMs = Date.parse("2026-07-07T12:00:00Z")) {
  const fake = new FakeOutageCollection();
  let clock = nowMs;
  const store = new OutageQueueStore(fake as unknown as Collection<OutageQueueDoc>, () => new Date(clock));
  return { store, fake, advance: (ms: number) => (clock += ms) };
}

describe("OutageQueueStore (KPR-307)", () => {
  it("enqueue is idempotent on the composite (itemId, agentId) key", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.enqueue(makeInput()); // double-enqueue same agent → no-op
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0]).toMatchObject({ itemId: "msg-1", agentId: "agent-a", status: "pending", attempts: 0 });
  });

  it("fan-out produces one independent doc per fanned agent for the same itemId", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput({ agentId: "agent-a" }));
    await store.enqueue(makeInput({ agentId: "agent-b" }));
    expect(fake.docs).toHaveLength(2);
    expect(fake.docs.map((d) => d.agentId).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("claimNext returns oldest-enqueuedAt pending doc and marks it replaying (atomic — no double claim)", async () => {
    const { store, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "older" }));
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "newer" }));

    const first = await store.claimNext();
    expect(first?.itemId).toBe("older");
    expect(first?.status).toBe("replaying");
    const second = await store.claimNext();
    expect(second?.itemId).toBe("newer"); // never the already-claimed doc
    expect(await store.claimNext()).toBeNull();
  });

  it("release: pending is non-terminal (attempts + doneAt untouched); done/expired are terminal with doneAt", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.claimNext();

    await store.release("msg-1", "agent-a", "pending", "circuit still open");
    expect(fake.docs[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      doneAt: null,
      lastError: "circuit still open",
    });

    await store.claimNext();
    await store.release("msg-1", "agent-a", "done");
    expect(fake.docs[0].status).toBe("done");
    expect(fake.docs[0].doneAt).toBeInstanceOf(Date);

    await store.enqueue(makeInput({ itemId: "msg-2" }));
    await store.release("msg-2", "agent-a", "expired", "agent disabled/deleted — will not be replayed");
    expect(fake.docs[1]).toMatchObject({
      status: "expired",
      lastError: "agent disabled/deleted — will not be replayed",
    });
    expect(fake.docs[1].doneAt).toBeInstanceOf(Date);
  });

  it("recordFailedAttempt increments attempts → pending below cap, terminal failed at cap", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());

    const a1 = await store.recordFailedAttempt("msg-1", "agent-a", "boom", 3);
    expect(a1).toMatchObject({ terminal: false });
    expect(fake.docs[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });

    await store.recordFailedAttempt("msg-1", "agent-a", "boom", 3);
    const a3 = await store.recordFailedAttempt("msg-1", "agent-a", "boom again", 3);
    expect(a3.terminal).toBe(true);
    expect(a3.doc?.attempts).toBe(3);
    expect(fake.docs[0].status).toBe("failed");
    expect(fake.docs[0].doneAt).toBeInstanceOf(Date);
  });

  it("recordFailedAttempt truncates lastError to 240 chars", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.recordFailedAttempt("msg-1", "agent-a", "x".repeat(500), 3);
    expect(fake.docs[0].lastError).toHaveLength(240);
  });

  it("expireOlderThan marks and returns only over-age pending docs", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "old-1" }));
    await store.enqueue(makeInput({ itemId: "old-2", agentId: "agent-b" }));
    advance(5 * 3600_000); // 5h later
    await store.enqueue(makeInput({ itemId: "fresh" }));

    const cutoff = new Date(Date.parse("2026-07-07T12:00:00Z") + 4 * 3600_000);
    const expired = await store.expireOlderThan(cutoff);
    expect(expired.map((d) => d.itemId).sort()).toEqual(["old-1", "old-2"]);
    expect(fake.docs.filter((d) => d.status === "expired")).toHaveLength(2);
    expect(fake.docs.find((d) => d.itemId === "fresh")?.status).toBe("pending");
    // Second pass: nothing left to expire.
    expect(await store.expireOlderThan(cutoff)).toEqual([]);
  });

  it("recoverStaleReplaying reverts only over-age replaying docs", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "stale" }));
    await store.claimNext(); // replaying at T0
    advance(400_000); // > 360s stale threshold
    await store.enqueue(makeInput({ itemId: "fresh-claim" }));
    await store.claimNext(); // replaying at T0+400s (fresh)

    const recovered = await store.recoverStaleReplaying();
    expect(recovered).toBe(1);
    expect(fake.docs.find((d) => d.itemId === "stale")?.status).toBe("pending");
    expect(fake.docs.find((d) => d.itemId === "fresh-claim")?.status).toBe("replaying");
  });

  it("statusOf reads the composite-keyed doc", async () => {
    const { store } = makeStore();
    await store.enqueue(makeInput({ agentId: "agent-a" }));
    await store.enqueue(makeInput({ agentId: "agent-b" }));
    await store.release("msg-1", "agent-b", "done");
    expect(await store.statusOf("msg-1", "agent-a")).toBe("pending");
    expect(await store.statusOf("msg-1", "agent-b")).toBe("done");
    expect(await store.statusOf("nope", "agent-a")).toBeNull();
  });
});

describe("OutageQueueStore — enqueue-origin replay ordering (KPR-400 F2)", () => {
  it("claimNext prefers fast-fail-class docs, oldest-first within class", async () => {
    // NEGATIVE-VERIFY prediction (Step 4): pre-fix claimNext sorts on
    // enqueuedAt alone (and enqueue writes no origin) — the burner (oldest)
    // claims first and this row fails.
    const { store, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "burner", enqueueOrigin: "post-turn-fault" })); // T0 — trip-crosser
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "ff-old", enqueueOrigin: "fast-fail" })); // T1
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "ff-new", enqueueOrigin: "fast-fail" })); // T2
    expect((await store.claimNext())?.itemId).toBe("ff-old"); // class first, then age
    expect((await store.claimNext())?.itemId).toBe("ff-new");
    expect((await store.claimNext())?.itemId).toBe("burner"); // deadline burner replays last
    expect(await store.claimNext()).toBeNull();
  });

  it("legacy doc (field absent) claims first — BSON missing < string (deploy-mid-outage window, ⚠A5)", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "ff", enqueueOrigin: "fast-fail" })); // T0
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "legacy" })); // T1 — then strip the field to simulate pre-KPR-400
    delete fake.docs.find((d) => d.itemId === "legacy")!.enqueueOrigin;
    expect((await store.claimNext())?.itemId).toBe("legacy"); // missing sorts before "fast-fail" despite being newer
    expect((await store.claimNext())?.itemId).toBe("ff");
  });

  it("constant-ordering pin: 'fast-fail' < 'post-turn-fault' as strings (load-bearing sort, ⚠A2)", () => {
    // The ascending index/sort on the origin string IS the class
    // preference. Renaming either literal breaks replay ordering silently —
    // this row makes it loud. (A numeric weight field is the sanctioned
    // substitution if a reviewer prefers it.)
    expect("fast-fail" < "post-turn-fault").toBe(true);
  });

  it("origin is $setOnInsert-immutable: double-enqueue and back-to-pending release never touch it", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput({ enqueueOrigin: "fast-fail" }));
    await store.enqueue(makeInput({ enqueueOrigin: "post-turn-fault" })); // same (itemId, agentId) — no-op
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0].enqueueOrigin).toBe("fast-fail");
    await store.claimNext();
    await store.release("msg-1", "agent-a", "pending", "circuit still open"); // fast-failed replay path
    expect(fake.docs[0].enqueueOrigin).toBe("fast-fail"); // spec §Edge-7: class survives release
  });
});
