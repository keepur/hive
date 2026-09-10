# KPR-468 plan — chunk 2: the ledger, its nine indexes, the cursor, and the harness extension

Implements design **D1** (the two collections), **D2** (the document and its indexes) and **D10**'s split index posture, plus the test-double extension every later chunk is verified against. One task, one commit — **Task 4, `IngestPhase`, is in [chunk 2b](kpr-468-plan-2b-ingest.md)**, split off at the task seam because the combined file ran past this plan's 1,000-line bound (the chunk-1 / 1b precedent; recorded in the plan index).

The ledger store and the ingest phase are still **one review unit** and are meant to be read together: the index table is what makes the CAS bounded, and the CAS is what the unique index exists to detect. The split is a file bound, not a seam in the argument.

**Read D3, D4 and D8(b) in full before writing `applyEvent`** (chunk 2b). Three things in them are decided against a named alternative and must not be re-derived at the keyboard:

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
# 4. Real ObjectId minting in the double (KPR-454's deliberate divergence from
#    the obligations original's counter strings). `strictlyAfter` compares
#    ops_events `_id`s DIRECTLY — the one place this child does — and the
#    double's copy() is structuredClone (src/obligations/testing/fake-db.ts:6),
#    which degrades a class instance to a plain object. If minting is a string,
#    Step 2(d)'s `typeof a.toHexString === "function"` guard never fires and the
#    tie-break case tests nothing.
grep -n "new ObjectId()" src/ops/testing/fake-db.ts
```

Expected: (1) three collection handles plus both loaders; (2) one `createIndex({ publishedAt: 1, _id: 1 })` call; (3) `matchedSubscriptionIds: string[]` on `OpsEvent` and one write site in the accept path; (4) at least one `new ObjectId()` in `insertOne`'s id minting. **If (4) shows counter strings instead, do not proceed to Step 2(d)** — restore the divergence KPR-454's plan specifies (its chunk 3 Step 1, fourth harness bullet) as part of Step 2 and say so in the commit body, because a hex-string `_id` also inverts lexicographically at n ≥ 10. **A divergence on any of the three is a plan-revision trigger, not something to work around in an implementation file** — say so and stop. Chunk 6's AC-suite asserts the cursor index's presence rather than re-creating it (integration point 2).

- [ ] **Step 2:** Extend `src/ops/testing/fake-db.ts` — **five** additive changes, nothing removed.

The double is KPR-454's, created in that ticket's chunk 3 Task 4 Step 1 with real `ObjectId` minting and a `sort`-honouring `findOne`. Five things it does not yet do, each needed by this child. First read what is actually there, because two of the five may already be satisfied — and because Step 4 and the harness contract both read surfaces this grep must confirm exist rather than assume:

```bash
grep -n "countDocuments\|private unique\|case \"\$lt\"\|case \"\$gt\"" src/ops/testing/fake-db.ts
# The surfaces Step 4, the harness module (chunk 3b) and chunk 6 read directly.
# All five are present in the obligations original this file is copied from —
# createIndex recording {key, name, ...options} into a PUBLIC `indexes` array
# (:210-226 pushing, :168 declaring), the `operations` log (:73), `db` (:76),
# and each collection's `rows` Map (:166) — but this step's whole purpose is to
# read what is actually there, so confirm rather than assume.
grep -n "readonly indexes\|this.indexes.push\|readonly operations\|readonly db\|readonly rows" src/ops/testing/fake-db.ts
# The fault-injection SIGNATURE the plan writes against, verified rather than
# assumed: the original is `failNext(collection, operation, after = false, when
# = () => true)` (:107-117), i.e. two REQUIRED arguments plus an optional
# predicate. Everything this plan needs is expressed through it — see below.
grep -n "failNext(" src/ops/testing/fake-db.ts
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

**(e) A PERSISTENT fault and a fault reset.** `failNext` pushes a one-shot hook that is spliced out when it fires (`src/obligations/testing/fake-db.ts:98-105`), so the same operation cannot be made to fault on two successive ticks — which is exactly what AC13 limb 3's wedge signature needs, and it is the only limb that pins D8(b)'s "no automatic skip, no quarantine" ruling. Add a persistent list beside `hooks`, and a reset that clears both:

```typescript
  private persistentFaults: Array<Pick<Hook, "collection" | "operation" | "when">> = [];

  /**
   * KPR-468: a PERSISTENT fault — re-fires on every matching call until
   * clearFaults(), unlike failNext's one-shot hook. AC13 limb 3 needs the SAME
   * event to fault on two successive ticks; a one-shot cannot express it.
   */
  failAlways(collection: string, operation: string, when: Hook["when"] = () => true): void {
    this.persistentFaults.push({ collection, operation, when });
  }

  /** KPR-468: drop every armed fault, one-shot and persistent alike. */
  clearFaults(): void {
    this.persistentFaults = [];
    this.hooks = [];
  }
```

and in `operation(...)`, immediately after the existing `await this.hook(collection, operation, context, false);` and **before** the `localFaults` lookup:

```typescript
      if (
        this.persistentFaults.some((f) => f.collection === collection && f.operation === operation && f.when(context))
      ) {
        throw new Error("injected_persistent");
      }
```

**The two spellings this plan does NOT add, because `failNext`'s existing `when` predicate already expresses them.** Both are written as one-line helpers in the harness module (chunk 3, "Harness contract"), not as double API:

- **fault the *n*th call** — `let seen = 0; db.failNext(coll, op, false, () => ++seen === n)`. The predicate is evaluated once per matching call (`hook()`'s `findIndex`, `:98-101`) and the hook stays armed until it returns true, so the first `n − 1` calls pass and the *n*th throws.
- **fault a call matching a predicate** — `db.failNext(coll, op, false, (ctx) => …)` directly; `ctx` is `{filter?, update?, document?, options?}` (`:62`), so an `insertOne` is selected on `ctx.document`.

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

  /**
   * D3. `null` means no cursor exists; a storage fault THROWS and is the
   * CALLER's to contain — and the caller that contains it is named: chunk 3's
   * `OpsNotifier.run()` wraps its whole phase-and-gauge body so that a throw
   * from here (or from any other uncontained read: the ingest page `find`, the
   * six gauge counts) still attempts a best-effort `state: "degraded"`
   * heartbeat. Without that wrap this method's contract would be satisfied and
   * the spec's "Mongo unavailable for a tick ⇒ heartbeat degraded, no throw"
   * row would still be unsatisfiable.
   */
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
    // The nth-call fault, expressed through failNext's own `when` predicate
    // rather than through new double API (Step 2, "the two spellings this plan
    // does NOT add"): the hook stays armed until the predicate returns true, so
    // indexes 1 and 2 succeed and index 3 — arm 1 — throws.
    let seen = 0;
    db.failNext(OPS_NOTIFICATIONS_COLLECTION, "createIndex", false, () => (seen += 1) === 3);
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

(Fault injection above is `failNext(collection, operation, after, when)` — KPR-454's double as copied from the obligations original, whose signature Step 2's third grep verifies. Nothing in this file needs an nth-call or predicate variant of its own: both are the same call with a different `when`, and the only genuinely new capability this ticket needs — a **persistent** fault — is Step 2(e).)

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
rejects a $set/$unset path conflict as real MongoDB does, ObjectId
comparison operands are String-coerced, and failAlways/clearFaults add a
PERSISTENT fault the existing one-shot failNext cannot express — AC13's
wedge signature needs one event to fault on two successive ticks. The
nth-call and predicate-scoped faults need no new API: both are failNext's
existing `when` predicate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
