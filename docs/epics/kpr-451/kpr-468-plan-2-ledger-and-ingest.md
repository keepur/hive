# KPR-468 plan — chunk 2: the ledger, its nine indexes, the cursor, and ingest

Implements design **D1** (the two collections), **D2** (the document and its indexes), **D3** (the cursor, the ordering, the apply-if-strictly-newer watermark), **D4** (clearing application, renewal, creation) and **D8(b)**'s *ingest* containment rule. Two tasks, two commits.

**Read D3, D4 and D8(b) in full before writing `applyEvent`.** Three things in them are decided against a named alternative and must not be re-derived at the keyboard:

1. **Idempotence is apply-if-strictly-newer over `(publishedAt, _id)`, not `latestEventId` equality.** D12's own phrasing is insufficient against C17 and the spec says so at the point of use. The equality test passes for the *older* of two touches of one `dedupeKey` inside a replayed page and double-counts `eventCount`.
2. **Clearing is applied to every row on the cleared `dedupeKey`, across all subscriptions, independent of `e.matchedSubscriptionIds`.** A clearing reason is `informational` and normally matches **zero** subscriptions, so a match-scoped clearing would clear nothing and D12's own guarantee that recovering `resource` conditions fall silent on their own would be false.
3. **Ingest's unit of containment is the EVENT, not the row.** "Per-row `try`/`catch`, counted, continue" is the *delivery* rule (chunk 3) and is **wrong** here: it would leave the faulting event permanently unnotified, uncounted, and invisible to `eventsBehind` — not *behind* the cursor but *under* it.

**And one rule that governs every write in this chunk and the next two:** `$set` and `$unset` never name the same path in one update. Real MongoDB rejects it ("Updating the path 'X' would create a conflict at 'X'"); the repo's double applies `$set` first and `$unset` second and silently resolves it (`src/obligations/testing/fake-db.ts:293-294`). Task 3 Step 2 makes the double reject it instead, which is what turns this rule from prose into a test.

---

### Task 3: `OpsNotificationStore` and the harness extension

**Files:**

- Create: `src/ops/notification-store.ts`
- Modify: `src/ops/testing/fake-db.ts` (KPR-454's double)
- Create: `src/ops/notification-store.test.ts`

- [ ] **Step 1:** Re-verify KPR-454's three integration points against the **merged** code, before writing anything.

This plan was written against KPR-454 as planned, not as built. Three facts it depends on:

```bash
# 1. OpsStore's read surface — the notifier constructs its own and calls only these.
grep -n "readonly events\|readonly subscriptions\|readonly reasons\|async loadReasons\|async loadSubscriptions" src/ops/store.ts
# 2. The ops_events cursor index, in the (publishedAt, _id) order the ingest sort needs.
grep -n "publishedAt: 1, _id: 1" src/ops/store.ts
# 3. The matchedSubscriptionIds stamp on the stored envelope.
grep -n "matchedSubscriptionIds" src/ops/types.ts src/ops/publisher.ts
```

Expected: (1) three collection handles plus both loaders; (2) one `createIndex({ publishedAt: 1, _id: 1 })` call; (3) `matchedSubscriptionIds: string[]` on `OpsEvent` and one write site in the accept path. **A divergence on any of the three is a plan-revision trigger, not something to work around in an implementation file** — say so and stop. Chunk 6's AC-suite asserts the cursor index's presence rather than re-creating it (integration point 2).

- [ ] **Step 2:** Extend `src/ops/testing/fake-db.ts` — four additive changes, nothing removed.

The double is KPR-454's, created in that ticket's chunk 3 Task 4 Step 1 with real `ObjectId` minting and a `sort`-honouring `findOne`. Four things it does not yet do, each needed by this child. First read what is actually there, because two of the four may already be satisfied:

```bash
grep -n "countDocuments\|private unique\|case \"\$lt\"\|case \"\$gt\"" src/ops/testing/fake-db.ts
```

**(a) `countDocuments` must honour `options.limit`.** KPR-454's plan copies this method from `src/obligations/testing/fake-db.ts:271-278`, which returns `…filter(...).length` and never consults a limit, while `find()`'s cursor does (`:266`). Every saturation assertion in this ticket — `eventsBehind` and the four gauges — is unfalsifiable without it and would pass while asserting nothing.

```typescript
  async countDocuments(filter: Row = {}, options: Row = {}): Promise<number> {
    return this.owner.operation(this.name, "countDocuments", { filter, options }, () => {
      const matched = this.visible(options).filter((row) => matchesFilter(row, filter));
      // KPR-468: the real driver's `limit` option SATURATES the count. Without
      // this, every "read as at least N" assertion in the notifier's heartbeat
      // is untestable and a test written against it passes vacuously.
      const limit = typeof options.limit === "number" ? options.limit : Number.MAX_SAFE_INTEGER;
      return Math.min(matched.length, limit);
    });
  }
```

**(b) `updateOne` must reject an update naming one path in both `$set` and `$unset`.** Insert at the top of the `updateOne` action, before any mutation:

```typescript
      // KPR-468: real MongoDB REJECTS an update naming one path in both $set
      // and $unset ("Updating the path 'X' would create a conflict at 'X'").
      // The obligations original applies $set then $unset and silently
      // resolves it, which makes the delivery phase's no-interval branch — the
      // SHIPPED-DEFAULT path, the most common write there is — green in test
      // and throwing in production on the first tick.
      for (const key of Object.keys(update.$unset ?? {})) {
        if (Object.prototype.hasOwnProperty.call(update.$set ?? {}, key)) {
          throw new Error(`Updating the path '${key}' would create a conflict at '${key}'`);
        }
      }
```

**(c) Unique-index enforcement on `insertOne` must be present.** The obligations original has it (`private unique(row, replacing?)`, throwing `{ code: 11000 }`, called from `insertOne`); KPR-454's harness requirement list does not promise it, and D4's write depends on the duplicate-key error **being** the race detector. If the grep in this step shows it missing, port it verbatim from `src/obligations/testing/fake-db.ts:199-210` along with `createIndex`'s recording of `unique` in the `indexes` array.

**(d) Comparison operands that are `ObjectId`s must be coerced with `String(...)`.** The originals compare raw (`:38-45`). The ledger sidesteps this entirely — every event reference it stores is a 24-char lowercase hex **string** — but the ingest page filter compares `_id` on `ops_events` documents directly (`{ _id: { $gt: new ObjectId(...) } }`), so the coercion is needed there:

```typescript
// in `predicate`, before the switch:
const cmp = (a: any) => (a !== null && typeof a === "object" && typeof a.toHexString === "function" ? String(a) : a);
// then in each of $lt/$lte/$gt/$gte: compare cmp(actual) against cmp(value)
```

**Nothing is removed and KPR-454's own suites must stay green.** That is why `src/ops/publisher.integration.test.ts`, `src/ops/acceptance.integration.test.ts` and `src/ops/capture-points.integration.test.ts` are in this plan's Commands list — run them in Step 6 of this task, not only at the end.

- [ ] **Step 3:** Create `src/ops/notification-store.ts`.

```typescript
/**
 * KPR-468 D1/D2/D3: the acknowledgement ledger's collections, its nine
 * indexes, the D12 sweep cursor and the operator policy read.
 *
 * Shaped on src/obligations/store.ts. Every durable write carries the same
 * { w: "majority", wtimeoutMS: 5000 } that file uses (:20, receipts.ts:70,
 * sweeper.ts:374) — D3's durability ordering is only NOMINAL if the ledger
 * upserts run at the driver default and a majority-durable cursor can then
 * outlive the writes it claims to trail.
 */
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_POLICY_COLLECTION,
  OPS_POLICY_ID,
  type OpsNotification,
  type OpsPolicy,
} from "./notification-types.js";

const log = createLogger("ops-notification-store");

export const WRITE = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 } };

/** D12's cursor: a position in ops_events's (publishedAt, _id) total order. */
export interface SweepCursor {
  publishedAt: Date;
  /** The event's `_id` hex string, or null for a clock-initialized cursor. */
  eventId: string | null;
}

export const SWEEP_CURSOR_KIND = "ops_sweep_cursor";
export const NOTIFIER_STATS_KIND = "ops_notifier_stats";

export class OpsNotificationStore {
  readonly notifications: Collection<OpsNotification>;
  readonly policy: Collection<OpsPolicy>;
  /**
   * D3: the cursor and the heartbeat are SEPARATE documents in the same
   * engine-written, TTL-free, upserted-per-kind collection, so overwriting
   * stats can never clobber the cursor.
   */
  readonly telemetry: Collection;

  constructor(db: Db) {
    this.notifications = db.collection<OpsNotification>(OPS_NOTIFICATIONS_COLLECTION);
    this.policy = db.collection<OpsPolicy>(OPS_POLICY_COLLECTION);
    this.telemetry = db.collection("telemetry");
  }

  /**
   * D2/D10. The posture is SPLIT and differs from KPR-454's blanket one by
   * exactly one line: the (subscriptionId, dedupeKey) UNIQUE index carries a
   * CORRECTNESS role — it is the only thing preventing two rows for one
   * condition under a racing insert, and it is what makes D4's
   * conditional-update-then-insert a race DETECTOR rather than a duplicate
   * factory — so its failure leaves the notifier UNSTARTED and the singleton
   * UNSET (D10). Every other index is performance or housekeeping and is
   * contained individually.
   *
   * NO INDEX HERE IS `sparse`, and that is a correction rather than an
   * omission: a COMPOUND sparse index over ascending keys indexes a document
   * containing AT LEAST ONE of the keys, so {stalledReason, state} and
   * {lastOutcome, state} would index every row (every row has `state`) and
   * {forceDeliver, nextNudgeAt} would index every working row. What actually
   * delivers every boundedness property claimed in D2 is the EQUALITY BOUND ON
   * THE LEADING KEY plus MongoDB's type bracketing. `partialFilterExpression`
   * would deliver what `sparse` was claimed to and is declined for one
   * measured reason: under the shipped default every working row is
   * cadence-stalled and every attempted row carries a lastOutcome, so the set
   * it would exclude is nearly empty in the deployment that matters.
   */
  async ensureIndexes(): Promise<{ uniqueOk: boolean; failures: number }> {
    let failures = 0;
    let uniqueOk = true;
    const create = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        failures += 1;
        log.warn("ops notification index creation failed — continuing without it", {
          index: label,
          error: String(err),
        });
      }
    };

    // 1. Row identity. The duplicate-key error IS the race detector (D4).
    try {
      await this.notifications.createIndex({ subscriptionId: 1, dedupeKey: 1 }, { unique: true });
    } catch (err) {
      uniqueOk = false;
      failures += 1;
      log.error("ops_notifications identity index failed — the notifier will not start", { error: String(err) });
    }
    // 2. Clearing application fans out across every subscription holding the
    //    key, so it cannot use the compound index above.
    await create("ops_notifications.dedupe", () => this.notifications.createIndex({ dedupeKey: 1 }));
    // 3. Delivery ARM 1 — the guaranteed first delivery. Equality on
    //    attemptCount: 0 means an already-attempted row is not in this index's
    //    scanned prefix AT ALL, which is what makes arm 1 structurally immune
    //    to a stall backlog rather than merely ordered ahead of one.
    await create("ops_notifications.arm1", () =>
      this.notifications.createIndex({ state: 1, attemptCount: 1, nextNudgeAt: 1 }),
    );
    // 4. Delivery ARM 2 — the two non-cadence re-delivery triggers. The
    //    equality bound on forceDeliver: true confines the scan; the
    //    cadence-stall backlog carries no forceDeliver at all (step 5 consumes
    //    it), so it is not in this bucket. The absent `state` key is NOT an
    //    omission: no NON-WORKING row carries a nextNudgeAt (D5's scoping of
    //    the never-unset rule), so this index's range holds only
    //    pending/delivered rows by type bracketing rather than by a filter.
    await create("ops_notifications.arm2", () =>
      this.notifications.createIndex({ forceDeliver: 1, nextNudgeAt: 1 }),
    );
    // 5. Delivery ARM 3 — ordinary cadence nudges.
    await create("ops_notifications.arm3", () => this.notifications.createIndex({ state: 1, nextNudgeAt: 1 }));
    // 6. The three standing stall gauges, as bounded saturating counts.
    //    `state` is IN THE INDEX rather than a residual filter over it because
    //    a saturating `limit` over a residual filter does not saturate — it
    //    scans until it has found `limit` matches.
    await create("ops_notifications.stallGauge", () =>
      this.notifications.createIndex({ stalledReason: 1, state: 1 }),
    );
    // 7. The rowsUnknownOutcome gauge. REQUIRED rather than nice: without it
    //    this is an unindexed collection scan on every 30 s tick over a ledger
    //    whose working-state rows never TTL.
    await create("ops_notifications.unknownGauge", () =>
      this.notifications.createIndex({ lastOutcome: 1, state: 1 }),
    );
    // 8. The snooze-expiry scan.
    await create("ops_notifications.snooze", () => this.notifications.createIndex({ state: 1, snoozedUntil: 1 }));
    // 9. D9's state-dependent retention. A TTL on `stateAt` would delete
    //    WORKING rows; the conditional lives in the field, not the index.
    await create("ops_notifications.ttl", () =>
      this.notifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    );
    return { uniqueOk, failures };
  }

  /** D3. `null` means no cursor exists; a storage fault THROWS and is the caller's to contain. */
  async readCursor(): Promise<SweepCursor | null> {
    const doc = await this.telemetry.findOne({ kind: SWEEP_CURSOR_KIND });
    if (!doc || !(doc.publishedAt instanceof Date)) return null;
    return { publishedAt: doc.publishedAt, eventId: typeof doc.eventId === "string" ? doc.eventId : null };
  }

  async writeCursor(cursor: SweepCursor): Promise<void> {
    await this.telemetry.updateOne(
      { kind: SWEEP_CURSOR_KIND },
      { $set: { kind: SWEEP_CURSOR_KIND, publishedAt: cursor.publishedAt, eventId: cursor.eventId } },
      { upsert: true, ...WRITE },
    );
  }

  /**
   * D5. `findOne → null` (nothing registered) and `findOne → throw` (a
   * transient storage fault) are DISTINGUISHABLE at the driver and must stay
   * so: resolving a throw as "no policy" would mark every working row
   * cadence-stalled on that tick and turn a two-second Mongo blip into a full
   * re-check interval of silence for every subscriber. The throw propagates.
   */
  async readPolicy(): Promise<OpsPolicy | null> {
    return this.policy.findOne({ _id: OPS_POLICY_ID });
  }

  async writeHeartbeat(doc: Record<string, unknown>): Promise<void> {
    await this.telemetry.updateOne(
      { kind: NOTIFIER_STATS_KIND },
      { $set: { kind: NOTIFIER_STATS_KIND, ...doc } },
      { upsert: true, ...WRITE },
    );
  }
}

/** The duplicate-key signal D4 step 2 depends on. */
export function isDuplicateKey(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: unknown }).code === 11000;
}
```

- [ ] **Step 4:** Create `src/ops/notification-store.test.ts`.

The index cases assert the **exact `createIndex` specs that were requested**, read off the double's `indexes` array. That is the honest limit of what any double can check: it models neither index selection nor index options, so **every index-*property* claim in D2 and D5 is unfalsifiable here** and is carried instead by AC7's behavioural starvation case (chunk 6). Say so in the file header so nobody upgrades these into a claim about a planner.

```typescript
import { describe, it, expect } from "vitest";
import { FakeDb } from "./testing/fake-db.js";
import { OpsNotificationStore, SWEEP_CURSOR_KIND } from "./notification-store.js";
import { OPS_NOTIFICATIONS_COLLECTION, OPS_POLICY_COLLECTION } from "./notification-types.js";

// SCOPE NOTE: the double models neither index selection nor index options, so
// these cases pin the index SHAPES that were requested and nothing about how a
// planner uses them. D2/D5's boundedness claims are carried behaviourally by
// AC7's starvation case, not here.

describe("OpsNotificationStore.ensureIndexes (D2, D10)", () => {
  it("creates exactly the nine indexes, none sparse, with the unique one first", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    const result = await store.ensureIndexes();
    expect(result).toEqual({ uniqueOk: true, failures: 0 });

    const created = db
      .collection(OPS_NOTIFICATIONS_COLLECTION)
      .indexes.filter((i) => i.name !== "_id_")
      .map((i) => ({ key: i.key, unique: Boolean(i.unique), sparse: Boolean(i.sparse), ttl: i.expireAfterSeconds }));

    expect(created).toEqual([
      { key: { subscriptionId: 1, dedupeKey: 1 }, unique: true, sparse: false, ttl: undefined },
      { key: { dedupeKey: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, attemptCount: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { forceDeliver: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { stalledReason: 1, state: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { lastOutcome: 1, state: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, snoozedUntil: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { expiresAt: 1 }, unique: false, sparse: false, ttl: 0 },
    ]);
  });

  it("reports uniqueOk: false when the identity index fails, and contains every other failure", async () => {
    const db = new FakeDb();
    db.failNext(OPS_NOTIFICATIONS_COLLECTION, "createIndex"); // the identity index is created first
    const store = new OpsNotificationStore(db.db);
    const result = await store.ensureIndexes();
    expect(result.uniqueOk).toBe(false);
    expect(result.failures).toBe(1);
    // Contained: the remaining eight still exist.
    expect(db.collection(OPS_NOTIFICATIONS_COLLECTION).indexes.length).toBe(1 /* _id_ */ + 8);
  });

  it("keeps uniqueOk: true when a non-identity index fails", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    db.failNth(OPS_NOTIFICATIONS_COLLECTION, "createIndex", 3); // arm 1
    const result = await store.ensureIndexes();
    expect(result).toEqual({ uniqueOk: true, failures: 1 });
  });
});

describe("the D12 cursor lives in db.telemetry (D3)", () => {
  it("round-trips a position and never shares a document with the heartbeat", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    expect(await store.readCursor()).toBeNull();

    const at = new Date("2026-01-01T00:00:00.000Z");
    await store.writeCursor({ publishedAt: at, eventId: "65a1b2c3d4e5f60718293a4b" });
    await store.writeHeartbeat({ state: "ok", eventsBehind: 0 });

    expect(await store.readCursor()).toEqual({ publishedAt: at, eventId: "65a1b2c3d4e5f60718293a4b" });
    const docs = [...db.collection("telemetry").rows.values()];
    expect(docs.map((d) => d.kind).sort()).toEqual(["ops_notifier_stats", "ops_sweep_cursor"]);
    // Overwriting stats must never clobber the cursor.
    expect(docs.find((d) => d.kind === SWEEP_CURSOR_KIND)?.state).toBeUndefined();
  });

  it("writes the cursor with majority write concern", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    await store.writeCursor({ publishedAt: new Date(0), eventId: null });
    const op = db.operations.filter((o) => o.collection === "telemetry" && o.operation === "updateOne").at(-1);
    // The double records the option; it does not honour it. That is the honest
    // limit of the assertion and is why it is written as "was passed".
    expect(op?.context.options).toMatchObject({ writeConcern: { w: "majority", wtimeoutMS: 5000 } });
  });
});

describe("readPolicy distinguishes absent from faulted (D5)", () => {
  it("returns null when nothing is registered", async () => {
    const db = new FakeDb();
    expect(await new OpsNotificationStore(db.db).readPolicy()).toBeNull();
  });

  it("THROWS on a storage fault rather than resolving it as 'no policy'", async () => {
    // Resolving a throw as absent would mark every working row cadence-stalled
    // on that tick — a two-second blip turned into a full re-check interval of
    // silence for every subscriber (D5).
    const db = new FakeDb();
    db.failNext(OPS_POLICY_COLLECTION, "findOne");
    await expect(new OpsNotificationStore(db.db).readPolicy()).rejects.toBeTruthy();
  });
});
```

(The two collection-name constants are imported rather than spelled inline so a rename is a compile error here, not a silently-passing test against a collection nobody writes.)

⚠ **`failNext` / `failNth` are the double's fault-injection spelling; use whatever KPR-454's file actually exports** (its plan promises "a `failNext` / `failAll` switch per operation"). If only `failNext` exists, drive the third-index case by calling it twice with the first two succeeding, or add `failNth` as a fifth additive change in Step 2 and say so in the commit body.

- [ ] **Step 5:** Verify.

```bash
npx vitest run src/ops/notification-store.test.ts
npx vitest run src/ops/publisher.integration.test.ts src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts
npx tsc --noEmit
```

Expected: the new suite passes; **KPR-454's three suites still pass** — that is the whole verification of Step 2's harness edits, and a regression there means an additive change was not additive.

- [ ] **Step 6:** Commit.

```bash
git add src/ops/notification-store.ts src/ops/notification-store.test.ts src/ops/testing/fake-db.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): ops_notifications store — nine indexes, the sweep cursor, ops_policy

D1/D2/D3/D10: the two collections this child creates, the nine indexes
(none sparse — boundedness rests on leading-key equality plus type
bracketing), the D12 cursor as one db.telemetry document beside but never
merged with the heartbeat, and the ops_policy read that distinguishes
"nothing registered" from a storage fault. The identity index carries a
correctness role, so its failure alone leaves the notifier unstarted.

Extends KPR-454's test double additively: countDocuments honours limit
(without which every saturating-count assertion is vacuous), updateOne
rejects a $set/$unset path conflict as real MongoDB does, and ObjectId
comparison operands are String-coerced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `IngestPhase`

**Files:**

- Create: `src/ops/ingest.ts`
- Create: `src/ops/ingest.integration.test.ts`

`IngestPhase` is constructed with `(events, store, counters, subscriptionsRef, retentionDays)` and **nothing else** — deliberately, so it does not depend on `OpsNotifier`, which chunk 3 creates. Task 4 must be verifiable before Task 5 exists.

- [ ] **Step 1:** Create `src/ops/ingest.ts`.

```typescript
/**
 * KPR-468 D3/D4/D8(b): the event-driven phase — the cursor, clearing
 * application, row creation and D7-rule-4 renewal.
 *
 * THIS MODULE NEVER IMPORTS src/ops/match.ts AND NEVER RE-EVALUATES A MATCH
 * (D12, C2, AC2). Re-evaluation would let a subscription registered after
 * accept acquire a past event, contradicting D5, and would make the stored
 * count a lie.
 */
import { ObjectId, type Collection, type Filter } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { OpsEvent, OpsSubscription } from "./types.js";
import {
  GAUGE_COUNT_LIMIT,
  INGEST_EVENT_BUDGET,
  INGEST_PAGE_SIZE,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  type OpsNotification,
  type OpsNotifierCounters,
} from "./notification-types.js";
import { isDuplicateKey, WRITE, type OpsNotificationStore, type SweepCursor } from "./notification-store.js";

const log = createLogger("ops-ingest");

export interface IngestResult {
  ok: boolean;
  cursorAt: Date;
  /** Saturating at GAUGE_COUNT_LIMIT; read as "at least N". */
  eventsBehind: number;
  /** ALWAYS reported on a non-drained stop, never silently omitted (D5). */
  oldestUnappliedAt: Date | null;
}

/**
 * D3: the position filter over ops_events's (publishedAt, _id) total order.
 * The `_id` half is the ONE place this child compares ObjectIds directly —
 * every reference the ledger STORES is a hex string instead.
 */
export function strictlyAfter(cursor: SweepCursor): Filter<OpsEvent> {
  if (cursor.eventId === null) return { publishedAt: { $gt: cursor.publishedAt } };
  const id = new ObjectId(cursor.eventId);
  return {
    $or: [{ publishedAt: { $gt: cursor.publishedAt } }, { publishedAt: cursor.publishedAt, _id: { $gt: id } }],
  };
}

/**
 * D3: apply-if-strictly-newer, the precondition on EVERY ledger application.
 * A strengthening of D12's `latestEventId`-equality phrasing, not a departure
 * from it: equality guards an exact replay of the LAST event only, so a page
 * in which one dedupeKey is touched twice replays the OLDER touch, passes the
 * equality test, and double-counts eventCount — a direct C17 failure.
 */
export function newerThan(e: OpsEvent): Filter<OpsNotification> {
  const id = String(e._id);
  return {
    $or: [
      { appliedThroughAt: { $lt: e.publishedAt } },
      { appliedThroughAt: e.publishedAt, appliedThroughId: { $lt: id } },
    ],
  } as Filter<OpsNotification>;
}

/**
 * D4/D8: the provenance test, decided by the CLEARED row's snapshotted class
 * and restricted to what the envelope makes checkable — this component judges
 * nothing.
 *
 * The same-producer clause is NOT defence-in-depth; it closes a case
 * publish-time validation genuinely misses. D4 requires clearsReasonIds to
 * name reasons of the same producer and C19 enforces that at publish — but
 * the enforcement is over the REASONID COMPONENT ONLY (KPR-454's accept path
 * tests reasonIdOfDedupeKey(input.clears) for membership). dedupeKey is
 * producer:subjectKind:subjectId:reasonId:generation, so the PRODUCER
 * component of a `clears` key is never constrained, and a clears naming
 * another producer's key whose reasonId happens to collide passes publish
 * intact. This clause is the only check that catches it.
 */
export function clearingProvenanceOk(row: OpsNotification, e: OpsEvent): boolean {
  if (e.producer !== row.producer) return false;
  switch (row.class) {
    case "resource":
      return true;
    case "judgment":
    case "integrity":
      return e.evidence.length >= 1;
    case "informational":
    default:
      return false;
  }
}

export class IngestPhase {
  constructor(
    private readonly events: Collection<OpsEvent>,
    private readonly store: OpsNotificationStore,
    private readonly counters: OpsNotifierCounters,
    private readonly subscriptions: () => Map<string, OpsSubscription>,
    private readonly retentionDays: number,
  ) {}

  async run(now: Date): Promise<IngestResult> {
    let cursor = await this.store.readCursor();
    if (!cursor) {
      // D3's cold-start rule, deliberate in BOTH directions. Forward: KPR-454
      // ships ahead of this child and accumulates, and a notifier that woke up
      // and delivered weeks of backlog would be exactly the flood this epic
      // exists to remove — worse, it would re-mint rows for conditions whose
      // ledger rows had already aged out, resurrecting long-dead
      // acknowledgements. Backward: events published while no cursor existed
      // are never notified, bounded by one sweep interval.
      cursor = { publishedAt: now, eventId: null };
      await this.store.writeCursor(cursor);
      this.counters.cursorReinitialized += 1;
      log.warn("ops sweep cursor absent — initializing to the server clock; no backfill", {
        at: now.toISOString(),
      });
      return { ok: true, cursorAt: cursor.publishedAt, eventsBehind: 0, oldestUnappliedAt: null };
    }

    let applied = 0;
    let ok = true;
    let drained = false;
    let advanced: SweepCursor | undefined;

    pages: while (true) {
      const page = await this.events
        .find(strictlyAfter(cursor))
        .sort({ publishedAt: 1, _id: 1 })
        .limit(INGEST_PAGE_SIZE)
        .toArray();
      if (page.length === 0) {
        drained = true;
        break;
      }
      for (const e of page) {
        try {
          await this.applyEvent(e, now);
        } catch (err) {
          // D8(b): the unit of containment is the EVENT, not the row. A fault
          // anywhere in applying `e` — its clearing fan-out, or any one of its
          // per-subscription renewals — means `e` is not fully applied, so the
          // phase STOPS AT `e` and the cursor advances no further than its
          // predecessor. PER-ROW CONTINUE IS FORBIDDEN HERE: applying 6…N and
          // advancing the cursor to N would leave `e` permanently unnotified,
          // uncounted, and invisible to eventsBehind — not BEHIND the cursor
          // but UNDER it. Re-reading the page is safe and cheap because every
          // application is a CAS'd apply-if-newer write, so the rows that did
          // apply are total no-ops on the retry.
          this.counters.ingestFaults += 1;
          log.error("ops ingest fault — stopping this tick at the faulting event", {
            eventId: String(e._id),
            error: String(err),
          });
          ok = false;
          break pages;
        }
        advanced = { publishedAt: e.publishedAt, eventId: String(e._id) };
        cursor = advanced;
        applied += 1;
        this.counters.eventsApplied += 1;
      }
      if (page.length < INGEST_PAGE_SIZE) {
        drained = true;
        break;
      }
      // The budget is checked BETWEEN pages, deliberately: it removes D5's
      // two-branch oldestUnappliedAt entirely in favour of one always-paid
      // bounded findOne below.
      if (applied >= INGEST_EVENT_BUDGET) break;
    }

    // D3: the cursor is written ONLY after the page's ledger writes are
    // acknowledged (each was awaited above), with majority write concern. It
    // is written once at the end of the tick rather than per page, which is
    // strictly safer — a crash re-processes more, never less.
    if (advanced) await this.store.writeCursor(advanced);

    if (drained && ok) return { ok, cursorAt: cursor.publishedAt, eventsBehind: 0, oldestUnappliedAt: null };

    // D5: ALWAYS reported, never silently omitted. One extra bounded indexed
    // read on the same {publishedAt, _id} index the page sort uses.
    //
    // ⚠ On the FAULT branch this can return an event that has ALREADY been
    // applied: D8(b) permits a mid-page fault to leave the cursor where the
    // tick found it, so the cursor names a position AT OR BEFORE the last
    // fully-applied event. The consequence is one-directional — the reported
    // age is an UPPER BOUND, never an under-report — which is the safe
    // direction for the one gap this figure exists to expose, since it errs
    // toward alarm rather than toward silence.
    const first = await this.events.findOne(strictlyAfter(cursor), { sort: { publishedAt: 1, _id: 1 } });
    const eventsBehind = await this.events.countDocuments(strictlyAfter(cursor), { limit: GAUGE_COUNT_LIMIT });
    return { ok, cursorAt: cursor.publishedAt, eventsBehind, oldestUnappliedAt: first?.publishedAt ?? null };
  }

  /** D4: two INDEPENDENT applications, in this order. */
  private async applyEvent(e: OpsEvent, now: Date): Promise<void> {
    if (e.clears) await this.applyClearing(e, now);
    await this.applyRenewal(e, now);
  }

  /**
   * D4(a). Every row whose dedupeKey equals e.clears — ACROSS ALL
   * SUBSCRIPTIONS, INDEPENDENT OF e.matchedSubscriptionIds. This scope is not
   * an optimization and reversing it breaks the contract: a clearing reason is
   * `informational` and normally matches ZERO subscriptions, so a match-scoped
   * clearing would clear nothing, every `resource` condition would nudge
   * forever, and D12's assertion that recovering resource conditions fall
   * silent on their own would be false.
   *
   * Per-row CAS'd updateOne, NEVER an updateMany — the watermark is a PER-ROW
   * precondition and two rows on one dedupeKey can sit at different positions.
   * AC8 asserts no code path issues an updateMany against ops_notifications.
   */
  private async applyClearing(e: OpsEvent, now: Date): Promise<void> {
    const rows = await this.store.notifications.find({ dedupeKey: e.clears! }).toArray();
    if (rows.length === 0) {
      // Nobody was listening. D8 answers openness from the LOG, not the ledger.
      this.counters.clearNoRow += 1;
      return;
    }
    for (const row of rows) {
      if (!clearingProvenanceOk(row, e)) {
        // Already stored by the publisher — it is a fact that someone tried —
        // and it does not transition the row.
        this.counters.clearRefused += 1;
        continue;
      }
      // D4: stateAt on every SYSTEM transition is the TICK's now, never the
      // event's publishedAt. expiresAt derives from stateAt, so a backlogged
      // sweep applying an hours-old clearing event would otherwise set a
      // retention horizon measured from that older instant and could TTL the
      // row before any reader saw it close. The event's own instant is not
      // lost: it is on lastEventAt and stateEventId already.
      const res = await this.store.notifications.updateOne(
        // `state: { $ne: "cleared" }` keeps a newer clearing fact from
        // extending an already-closed row's retention horizon, and makes a
        // replay a matchedCount-0 no-op rather than a silent TTL extension.
        { _id: row._id, state: { $ne: "cleared" }, ...newerThan(e) },
        {
          $set: {
            state: "cleared",
            stateAt: now,
            principal: OPS_SYSTEM_PRINCIPAL,
            principalAt: now,
            stateEventId: String(e._id),
            expiresAt: expiresAtFor("cleared", now, this.retentionDays)!,
            appliedThroughAt: e.publishedAt,
            appliedThroughId: String(e._id),
          },
          // D4: forceDeliver, stalledAt/stalledReason and snoozedUntil are
          // deliberately LEFT ALONE and there is no fourth write arm for them.
          // All three are PROVABLY inert on a cleared row: nextNudgeAt is
          // unset so no delivery arm's index range contains it; every stall
          // gauge's index carries state ∈ {pending, delivered}; and the expiry
          // scan keys on state: "snoozed". A reopen re-sets forceDeliver and
          // unsets the stall markers explicitly, so nothing is inherited
          // across the boundary either.
          $unset: { nextNudgeAt: "" },
        },
        WRITE,
      );
      if (res.matchedCount === 1) this.counters.rowsCleared += 1;
    }
  }

  /**
   * D4(b). Row creation and D7-rule-4 renewal for e's OWN dedupeKey, across
   * e.matchedSubscriptionIds — the stamped list, never a re-evaluation.
   *
   * The write is TWO STEPS rather than an aggregation-pipeline update, and the
   * conditional update carries NO `upsert`: the (subscriptionId, dedupeKey)
   * unique index must remain the race detector, and the repo's double supports
   * neither pipeline updates nor an upsert whose filter carries operators.
   */
  private async applyRenewal(e: OpsEvent, now: Date): Promise<void> {
    const advance = {
      latestEventId: String(e._id),
      lastEventAt: e.publishedAt,
      latestDetail: e.detail,
      latestEvidence: e.evidence,
      appliedThroughAt: e.publishedAt,
      appliedThroughId: String(e._id),
    };
    for (const subscriptionId of e.matchedSubscriptionIds) {
      const sub = this.subscriptions().get(subscriptionId);
      // D4/D12: a stamped subscription that is absent, disabled, or whose
      // target its registered adapter rejected yields NO ROW — and the event's
      // stored matchedSubscriptions count STILL STANDS. It was honest for the
      // set that existed at accept and was never a delivery promise.
      if (!sub) continue;

      // Arm A — reopen a `cleared` row (D7 rule 4). forceDeliver is what makes
      // "the design errs toward a duplicate rather than a gap" TRUE under the
      // shipped default: attemptCount is monotonic and a reopen does not reset
      // it, so without the flag a condition that demonstrably came back would
      // fail an `attemptCount === 0 ∨ cadence` gate and never be delivered.
      const reopened = await this.store.notifications.updateOne(
        { subscriptionId, dedupeKey: e.dedupeKey, state: "cleared", ...newerThan(e) },
        {
          $set: {
            ...advance,
            state: "pending",
            stateAt: now,
            stateEventId: String(e._id),
            principal: OPS_SYSTEM_PRINCIPAL,
            principalAt: now,
            nextNudgeAt: now,
            forceDeliver: true,
          },
          $inc: { eventCount: 1 },
          $unset: { expiresAt: "", stalledAt: "", stalledReason: "" },
        },
        WRITE,
      );
      if (reopened.matchedCount === 1) {
        this.counters.rowsRenewed += 1;
        continue;
      }

      // Arm B — advance any non-cleared row. nextNudgeAt is deliberately NOT
      // reset: a repeat must not restart the cadence clock, or a flapping
      // producer nudges on its own schedule instead of the operator's.
      const renewed = await this.store.notifications.updateOne(
        { subscriptionId, dedupeKey: e.dedupeKey, state: { $ne: "cleared" }, ...newerThan(e) },
        { $set: advance, $inc: { eventCount: 1 } },
        WRITE,
      );
      if (renewed.matchedCount === 1) {
        this.counters.rowsRenewed += 1;
        continue;
      }

      // Arm C — insert. Arms A and B both missing means EITHER the row does
      // not exist OR it exists and the event is not newer; a duplicate-key
      // error resolves that ambiguity in favour of the second and is a NO-OP,
      // not a fault (D4 step 2).
      try {
        await this.store.notifications.insertOne(this.freshRow(e, sub, now), WRITE);
        this.counters.rowsCreated += 1;
      } catch (err) {
        if (isDuplicateKey(err)) {
          this.counters.renewalStale += 1;
          continue;
        }
        throw err;
      }
    }
  }

  private freshRow(e: OpsEvent, sub: OpsSubscription, now: Date): OpsNotification {
    return {
      subscriptionId: sub._id,
      subscriberId: sub.subscriberId,
      dedupeKey: e.dedupeKey,
      producer: e.producer,
      reasonId: e.reasonId,
      class: e.class,
      waiting: e.waiting,
      retry: e.retry,
      subject: e.subject,
      generation: e.generation,
      firstEventId: String(e._id),
      latestEventId: String(e._id),
      eventCount: 1,
      firstSeenAt: e.publishedAt,
      lastEventAt: e.publishedAt,
      state: "pending",
      stateAt: now,
      principal: OPS_SYSTEM_PRINCIPAL,
      principalAt: now,
      attempts: [],
      attemptCount: 0,
      nudgeCount: 0,
      // D5: first delivery IS the first nudge, so a fresh row is due now and
      // there is exactly one delivery code path.
      nextNudgeAt: now,
      appliedThroughAt: e.publishedAt,
      appliedThroughId: String(e._id),
      latestDetail: e.detail,
      latestEvidence: e.evidence,
    };
  }
}
```

⚠ **Two facts about this file that a reviewer will question and that are deliberate.**

- **The clearing fan-out is unbounded in principle.** `find({ dedupeKey })` returns one row per subscription holding that key, so it is bounded by the operator's subscriber count — not by traffic — and the spec accepts that shape. It is the one read in this chunk with no `limit`, and adding one would silently leave rows uncleared, which is strictly worse than a read sized by a number the operator chose.
- **`clearingProvenanceOk`'s `informational` arm returns `false` after the same-producer check has already run.** The two are not redundant: chunk 6's mutation 2b deletes the producer clause and the `resource` arm must then be the one that goes green-to-red, which requires the producer check to be a separate, earlier conjunct rather than folded into each class arm.

- [ ] **Step 2:** Create `src/ops/ingest.integration.test.ts`.

Cover, at minimum, each of the following as a named case. Chunk 6 re-drives the subset that maps to an acceptance criterion; these are the module's own.

- `strictlyAfter` with a null-`eventId` cursor returns only events published strictly after it, and with a real `eventId` breaks a `publishedAt` tie on `_id`.
- A fresh event with one stamped subscription creates one `pending` row with `nextNudgeAt = now`, `attemptCount: 0`, `eventCount: 1`, `appliedThrough*` at the event's position, and `principal = OPS_SYSTEM_PRINCIPAL`.
- A stamped id absent from the loaded map creates **no** row and leaves the event document byte-identical.
- Renewal on `pending` advances `latestEventId` / `lastEventAt` / `eventCount` / `latestDetail` / `latestEvidence` and **does not** reset `nextNudgeAt`.
- Renewal on `seen` and on `dismissed` advances and sends nothing new (state unchanged, `nextNudgeAt` still unset).
- Renewal on `snoozed` advances and leaves `snoozedUntil` untouched.
- Renewal on `cleared` reopens to `pending` with `forceDeliver: true`, `nextNudgeAt = now`, `stateEventId` = the renewing event, and `expiresAt` / `stalledAt` / `stalledReason` all unset.
- The watermark: applying the same event twice leaves `eventCount` at 1; applying an **older** event after a newer one changes nothing.
- Clearing with zero `matchedSubscriptionIds` clears rows on the named key across two different subscriptions.
- The four provenance rows (`resource` clears same-producer; `judgment`/`integrity` need `evidence.length >= 1`; `informational` never clears), plus `dismissed` clears and `cleared` is a no-op, plus the cross-producer refusal.
- A clearing event naming a `dedupeKey` with no row increments `clearNoRow` and nothing else.
- The cursor advances to the last fully-applied event and is written **once**, with majority write concern.
- An absent cursor initializes to `now`, counts `cursorReinitialized`, and creates **zero** rows over a log seeded with 50 pre-existing events.
- Event-level containment: a fault on the third of five leaves the cursor at the second, events 3–5 unapplied, `ingestFaults` at 1, `ok: false`; the next tick applies 3, 4 and 5.
- `eventsBehind` saturates at `GAUGE_COUNT_LIMIT` and `oldestUnappliedAt` is non-null on every non-drained stop.

- [ ] **Step 3:** Verify and commit.

```bash
npx vitest run src/ops/ingest.integration.test.ts src/ops/notification-store.test.ts
npx tsc --noEmit
```

Expected: all cases pass, `tsc` exits 0.

**Also assert the structural prohibition by hand, before chunk 6 automates it:**

```bash
grep -rn "match.js\|match\.ts" src/ops/ingest.ts src/ops/notification-store.ts || echo "OK — no match evaluator import"
```

```bash
git add src/ops/ingest.ts src/ops/ingest.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): ingest — clearing fan-out, renewal, the apply-if-newer watermark

D3/D4/D8(b): the cursor loop over ops_events's (publishedAt, _id) order,
clearing applied to every row on the cleared dedupeKey INDEPENDENT of the
clearing event's own matches, the per-class provenance test including the
same-producer clause that closes C19's reasonId-only publish check, and
D7-rule-4 renewal as a conditional-update-then-insert whose duplicate-key
error is the race detector.

Every application is CAS'd apply-if-strictly-newer over (publishedAt,
_id), which is what makes ANY prefix replay a total no-op and what keeps
eventCount counting distinct events rather than sweep attempts (C17).
Ingest's unit of containment is the EVENT: a fault stops the phase at it
and the cursor advances no further than its predecessor. Per-row continue
is forbidden here and is the delivery phase's rule instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
