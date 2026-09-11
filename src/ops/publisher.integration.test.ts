import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `store.ts`, `publisher.ts` and `observe.ts` each call `createLogger` at
// module load; the mock must hand back the SAME object every call so the
// anomaly case can count warn lines (vi.hoisted required — vi.mock factories
// are hoisted above top-level const declarations). Same pattern as
// `src/db/db-identity.integration.test.ts`.
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { FakeDb } from "./testing/fake-db.js";
import { OpsPublisher, familyOf } from "./publisher.js";
import { __resetOpsPublisherForTests, setOpsPublisher } from "./publisher-singleton.js";
import { observeToolFailure, observeToolSuccess, type ToolFailureObservation } from "./observe.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, REASON_TOOL_RECOVERED } from "./reasons.js";
import { OPS_CLEARS_MAX_LENGTH, OPS_ID_MAX_LENGTH } from "./ids.js";
import { OPS_EVENTS_COLLECTION, OPS_REASONS_COLLECTION } from "./types.js";

/**
 * KPR-454 chunk 3, Step 6 — mechanism-level coverage for the publisher the
 * commit introduces. Chunk 5's acceptance suite adds the AC-numbered cases;
 * these are the ones without which Task 4 ships its central invariants with no
 * coverage at all.
 *
 * Every publish→assert boundary uses `await publisher.__drainForTests()` as
 * its barrier. A bare `await` on the observe call proves nothing:
 * `enqueueFailure` is synchronous and returns before the drainer has run.
 */

const RETENTION_DAYS = 90;
const RECOVERED_ID = `${HIVE_RUNTIME_PRODUCER}:${REASON_TOOL_RECOVERED}`;
const FAILED_ID = `${HIVE_RUNTIME_PRODUCER}:${REASON_TOOL_FAILED}`;

let fakeDb: FakeDb;
let publisher: OpsPublisher;

const familyFor = (tool: string) =>
  familyOf({ producer: HIVE_RUNTIME_PRODUCER, reasonId: REASON_TOOL_FAILED, subject: { kind: "tool", id: tool } });

const driveFailure = (tool: string, extra: Partial<ToolFailureObservation> = {}) =>
  observeToolFailure({ tool, error: "boom", lane: "claude", ...extra });
const driveSuccess = (tool: string) => observeToolSuccess({ tool, lane: "claude" });

/** Direct fixture reads — deliberately NOT through the collection API, so they add no `operations` entry. */
const events = () => fakeDb.collection(OPS_EVENTS_COLLECTION).rows;
const reasons = () => fakeDb.collection(OPS_REASONS_COLLECTION).rows;
const opsEventInserts = () =>
  fakeDb.operations.filter((o) => o.collection === OPS_EVENTS_COLLECTION && o.operation === "insertOne").length;
const warnsMatching = (fragment: string) =>
  mockLog.warn.mock.calls.filter((call) => String(call[0]).includes(fragment)).length;

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb = new FakeDb();
  publisher = new OpsPublisher(fakeDb.db, RETENTION_DAYS);
  setOpsPublisher(publisher);
});

afterEach(async () => {
  await publisher.stop();
  __resetOpsPublisherForTests();
});

describe("OpsPublisher boot and registry", () => {
  it("constructs cleanly over the shipped table — the D5 enable gate is not inside init()'s failure surface", () => {
    // Chunk 2b's reasons.test.ts drives the gate's logic; here the only claim
    // is that it runs in the CONSTRUCTOR (no I/O, before any await) and that
    // the shipped table passes it.
    expect(() => new OpsPublisher(fakeDb.db, RETENTION_DAYS)).not.toThrow();
  });

  it("upserts both rows, in the shipped order, and a second init() does not overwrite an operator's enabled: false", async () => {
    await publisher.init();
    expect(
      reasons()
        .map((row) => row._id)
        .sort(),
    ).toEqual([FAILED_ID, RECOVERED_ID].sort());

    // The CALL-ORDER half of D5's load-bearing write order. reasons.test.ts
    // pins the array order and cannot see a writer that sorts or parallelises.
    const upserts = fakeDb.operations
      .filter((o) => o.collection === OPS_REASONS_COLLECTION && o.operation === "updateOne")
      .map((o) => o.context.filter?._id as string);
    expect(upserts).toEqual([RECOVERED_ID, FAILED_ID]);

    // The kill switch: an operator disables the row, and the next boot's
    // upsert leaves it disabled ($setOnInsert) while still rewriting the rest.
    const row = reasons().find((r) => r._id === FAILED_ID)!;
    row.enabled = false;
    row.remediationTemplate = "clobber me";
    await publisher.init();
    expect(reasons().find((r) => r._id === FAILED_ID)!.enabled).toBe(false);
    expect(reasons().find((r) => r._id === FAILED_ID)!.remediationTemplate).not.toBe("clobber me");

    // …and a disabled row rejects at accept-path step 1 rather than publishing.
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(events()).toHaveLength(0);
    expect(publisher.getSnapshot().rejected).toBe(1);
    expect(publisher.getSnapshot().published).toBe(0);
  });

  it("survives every createIndex rejecting — contained, counted, publisher still WIRED", async () => {
    fakeDb.failAll("*", "createIndex", new Error("IndexOptionsConflict"));
    await expect(publisher.init()).resolves.toBeUndefined();
    const attempts = fakeDb.operations.filter((o) => o.operation === "createIndex").length;
    expect(publisher.getSnapshot().indexFailures).toBe(attempts);
    // Pins the current inventory: 5 on ops_events + 1 on ops_subscriptions + 1 on ops_reasons.
    expect(attempts).toBe(7);
    // Wired: publishing still works.
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(events()).toHaveLength(1);
  });

  it("throws when the registry UPSERT rejects, so index.ts leaves the publisher unset", async () => {
    fakeDb.failAll(OPS_REASONS_COLLECTION, "updateOne");
    await expect(publisher.init()).rejects.toThrow();
  });

  it("throws when the registry READ-BACK rejects — a wired publisher over an empty map would spend `rejected` on a Mongo outage", async () => {
    fakeDb.failAll(OPS_REASONS_COLLECTION, "find");
    await expect(publisher.init()).rejects.toThrow();
    expect(publisher.getSnapshot().rejected).toBe(0);
  });

  it("loads and publishes an operator row this engine narrows — counted as an anomaly, never as a rejection", async () => {
    // Two anomalies in one row: an over-ceiling maxLength (clamped) and an
    // unrecognized type (compiled as boolean). Both fail closed, so the row
    // publishes; the point is that `reasonRowAnomalies` moves and `rejected`
    // does not.
    await fakeDb.collection(OPS_REASONS_COLLECTION).insertOne({
      _id: "acme:widget-stuck",
      producer: "acme",
      reasonId: "widget-stuck",
      class: "informational",
      retry: "transient",
      remediationTemplate: "unstick the widget",
      detailKeys: [
        { key: "note", type: "string", maxLength: 400 },
        { key: "flag", type: "date" },
      ],
      enabled: true,
    });
    await publisher.init();
    expect(publisher.getSnapshot().reasonRowAnomalies).toBe(2);
    expect(warnsMatching("ops reason row normalized")).toBe(2);

    publisher.enqueueFailure({
      producer: "acme",
      reasonId: "widget-stuck",
      waiting: "nobody",
      subject: { kind: "widget", id: "w-1" },
      detail: { note: "short", flag: true },
      evidence: [],
    });
    await publisher.__drainForTests();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.producer).toBe("acme");
    expect(publisher.getSnapshot().rejected).toBe(0);
  });

  it("skips a MALFORMED operator row and still loads the rest — one bad row never disables the producer", async () => {
    // `detailKeys` ABSENT. `ops_reasons` is operator- and foreign-producer-
    // writable by design and `OpsReason` is only a compile-time claim about a
    // runtime document, so this row is reachable; both `auditReasonRow` and
    // `compileDetailSchema` iterate `row.detailKeys` with `for…of` and throw
    // `TypeError: … is not iterable` on it. Inserted BEFORE init(), so it is
    // the FIRST row the loader sees — without per-row containment the throw
    // leaves loadReasons, leaves init(), and index.ts leaves the publisher
    // unset: every tool failure and recovery on both lanes unrecorded for the
    // whole boot.
    await fakeDb.collection(OPS_REASONS_COLLECTION).insertOne({
      _id: "acme:shapeless",
      producer: "acme",
      reasonId: "shapeless",
      class: "informational",
      retry: "transient",
      remediationTemplate: "fix the row",
      enabled: true,
    });

    await expect(publisher.init()).resolves.toBeUndefined();

    // Counted on the same counter as a normalization — a data-sourced row this
    // engine could not take at face value — and NOT as a rejection.
    expect(publisher.getSnapshot().reasonRowAnomalies).toBe(1);
    expect(publisher.getSnapshot().rejected).toBe(0);
    expect(warnsMatching("ops reason row unusable")).toBe(1);

    // C13: the row's _id and nothing else. Nothing from the row body reaches
    // the log line.
    const call = mockLog.warn.mock.calls.find((c) => String(c[0]).includes("ops reason row unusable"))!;
    expect(call[1]).toMatchObject({ id: "acme:shapeless" });
    expect(JSON.stringify(call[1])).not.toContain("fix the row");

    // The skipped row is absent from the map, so publishing under it fails
    // closed at accept step 1 rather than throwing…
    publisher.enqueueFailure({
      producer: "acme",
      reasonId: "shapeless",
      waiting: "nobody",
      subject: { kind: "widget", id: "w-1" },
      detail: {},
      evidence: [],
    });
    await publisher.__drainForTests();
    expect(events()).toHaveLength(0);
    expect(publisher.getSnapshot().rejected).toBe(1);

    // …and THE POINT: the engine's own rows loaded past it and still publish.
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.producer).toBe(HIVE_RUNTIME_PRODUCER);
  });

  it("log.errors once when the LOADED registry leaves an enabled class:resource reason unclearable", async () => {
    await publisher.init();
    // The healthy registry says nothing — the gate only speaks when breached.
    expect(mockLog.error).not.toHaveBeenCalled();

    // The foot-gun `assertReasonTableLegal` structurally cannot see: it is a
    // precondition over the CODE-RESIDENT table, where both rows are enabled.
    // Disabling the CLEARING row alone leaves `tool-failed` enabled and
    // unclearable — every recovery is refused at accept step 1 forever, so the
    // operator sees a climbing `rejected` (D9's mis-integrated-producer
    // signal) plus permanent silence, with nothing telling the two apart.
    reasons().find((r) => r._id === RECOVERED_ID)!.enabled = false;
    await publisher.init();

    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error.mock.calls[0]![1]).toMatchObject({ reasons: [FAILED_ID], count: 1 });
    // A diagnostic, not a gate: the publisher is still wired and still
    // publishes the condition.
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(events()).toHaveLength(1);
    // …and the recovery it can never clear is refused, which is the state the
    // log line exists to name.
    driveSuccess("Bash");
    await publisher.__drainForTests();
    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(0);
    expect(publisher.getSnapshot().rejected).toBe(1);
  });

  it("stays silent when BOTH rows are disabled — the condition is not enabled, so nothing is unclearable", async () => {
    await publisher.init();
    reasons().find((r) => r._id === RECOVERED_ID)!.enabled = false;
    reasons().find((r) => r._id === FAILED_ID)!.enabled = false;
    await publisher.init();
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});

describe("OpsPublisher accept path and epoch", () => {
  it("stores one document at generation 0 and opens one condition", async () => {
    await publisher.init();
    // No workItemId here on purpose — the admissible-id case (evidence
    // carrying a work-item reference) is asserted separately below.
    driveFailure("Bash", { agentId: "mokie", threadId: "T1", durationMs: 12 });
    await publisher.__drainForTests();

    expect(events()).toHaveLength(1);
    const doc = events()[0]!;
    expect(doc.generation).toBe(0);
    expect(doc.dedupeKey).toBe(`${familyFor("Bash")}:0`);
    expect(doc.class).toBe("resource");
    expect(doc.retry).toBe("transient");
    expect(doc.waiting).toBe("nobody");
    expect(doc.evidence).toEqual([]);
    expect(doc.detail).toEqual({
      tool: "Bash",
      errorSig: "unclassified",
      lane: "claude",
      agentId: "mokie",
      threadId: "T1",
      durationMs: 12,
    });
    expect(doc.clears).toBeUndefined();
    expect(doc.clearsFamily).toBeUndefined();

    const snapshot = publisher.getSnapshot();
    expect(snapshot.published).toBe(1);
    expect(snapshot.openConditions).toBe(1);
    const entry = publisher.__openEntryForTests(familyFor("Bash"))!;
    expect(entry.openSeq).toBe(1);
    expect(entry.dedupeKey).toBe(`${familyFor("Bash")}:0`);
  });

  // ⚠ Resolved contradiction, recorded for anyone diffing this file's history.
  // D6 (kpr-454-design.md:237) originally fixed this producer's ENTIRE
  // evidence `kind` vocabulary as the literal `workItem`, which does not
  // satisfy the same section's own `OPS_TOKEN_RE` bound two lines later
  // (`^[a-z][a-z0-9-]{0,39}$`, capital I) — a self-contradiction that would
  // have rejected EVERY tool failure carrying an admissible work-item id, the
  // producer's headline case. Corrected to `work-item` (same referent, no
  // semantic change — the vocabulary is this producer's own private key
  // space) via an append-only note in kpr-454-design.md, fixed directly in
  // `observe.ts` rather than demoted to spec (no product/architecture/scope
  // decision changes). Chunk 5's AC1/AC3 fences were corrected to match
  // before that chunk was dispatched.
  it("stores a work-item evidence reference on a failure carrying an admissible id", async () => {
    await publisher.init();
    driveFailure("Bash", { workItemId: "wi-1" });
    await publisher.__drainForTests();

    expect(events()).toHaveLength(1);
    expect(events()[0]!.evidence).toEqual([{ kind: "work-item", id: "wi-1" }]);
    expect(events()[0]!.detail.workItemId).toBe("wi-1");
    expect(publisher.getSnapshot().rejected).toBe(0);
  });

  it("a repeat appends a second document and leaves generation and the entry untouched", async () => {
    await publisher.init();
    driveFailure("Bash");
    await publisher.__drainForTests();
    const first = publisher.__openEntryForTests(familyFor("Bash"))!;

    driveFailure("Bash");
    await publisher.__drainForTests();

    expect(events()).toHaveLength(2);
    expect(events()[1]!.generation).toBe(0);
    expect(events()[1]!.dedupeKey).toBe(events()[0]!.dedupeKey);
    const second = publisher.__openEntryForTests(familyFor("Bash"))!;
    expect(second.openSeq).toBe(first.openSeq);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(second.firstFailureAt.getTime()).toBe(first.firstFailureAt.getTime());
    expect(publisher.getSnapshot().openConditions).toBe(1);
  });

  it("breaks an identical-publishedAt tie on `_id`, in both directions", async () => {
    // The assertion that depends on the harness minting REAL ObjectIds: both
    // documents share `publishedAt` to the millisecond, so only insertion
    // order can decide, and it decides through `String(_id)`.
    const family = familyFor("Bash");
    const stamp = new Date("2026-09-10T00:00:00.000Z");
    const condition = {
      schemaVersion: 1,
      publishedAt: stamp,
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      class: "resource",
      retry: "transient",
      waiting: "nobody",
      subject: { kind: "tool", id: "Bash" },
      generation: 0,
      dedupeKey: `${family}:0`,
      detail: { tool: "Bash", errorSig: "unclassified", lane: "claude" },
      evidence: [],
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    };
    const clearing = {
      ...condition,
      reasonId: REASON_TOOL_RECOVERED,
      class: "informational",
      generation: 0,
      dedupeKey: `${familyOf({ producer: HIVE_RUNTIME_PRODUCER, reasonId: REASON_TOOL_RECOVERED, subject: { kind: "tool", id: "Bash" } })}:0`,
      clears: `${family}:0`,
      clearsFamily: family,
    };

    // Clearing SECOND ⇒ more recent ⇒ the next failure opens a new epoch.
    await fakeDb.collection(OPS_EVENTS_COLLECTION).insertOne(condition);
    await fakeDb.collection(OPS_EVENTS_COLLECTION).insertOne(clearing);
    await publisher.init();
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(events().at(-1)!.generation).toBe(1);

    // Clearing FIRST ⇒ the condition is the more recent of the two ⇒ no
    // advance. Able-to-fail complement: a publishedAt-only comparison would
    // answer the same thing for both halves.
    const otherDb = new FakeDb();
    const other = new OpsPublisher(otherDb.db, RETENTION_DAYS);
    setOpsPublisher(other);
    await otherDb.collection(OPS_EVENTS_COLLECTION).insertOne(clearing);
    await otherDb.collection(OPS_EVENTS_COLLECTION).insertOne(condition);
    await other.init();
    driveFailure("Bash");
    await other.__drainForTests();
    expect(otherDb.collection(OPS_EVENTS_COLLECTION).rows.at(-1)!.generation).toBe(0);
    await other.stop();
  });

  it("falls back to the open-condition entry's generation when the resolver faults", async () => {
    await publisher.init();
    // Walk the family to generation 1 the honest way: F1, an accepted
    // recovery, then F2.
    driveFailure("Bash");
    await publisher.__drainForTests();
    driveSuccess("Bash");
    await publisher.__drainForTests();
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(publisher.__openEntryForTests(familyFor("Bash"))!.dedupeKey).toBe(`${familyFor("Bash")}:1`);

    fakeDb.failAll(OPS_EVENTS_COLLECTION, "findOne");
    driveFailure("Bash");
    await publisher.__drainForTests();

    expect(events().at(-1)!.generation).toBe(1);
    expect(events().at(-1)!.dedupeKey).toBe(`${familyFor("Bash")}:1`);
    expect(publisher.getSnapshot().epochResolveFaults).toBe(1);
  });

  it("falls back to 0 when the resolver faults and the family holds no entry", async () => {
    // A document at generation 5 exists for the family, so a WORKING resolver
    // would answer 5 — this case can fail.
    const family = familyFor("Grep");
    await fakeDb.collection(OPS_EVENTS_COLLECTION).insertOne({
      schemaVersion: 1,
      publishedAt: new Date("2026-09-10T00:00:00.000Z"),
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      class: "resource",
      retry: "transient",
      waiting: "nobody",
      subject: { kind: "tool", id: "Grep" },
      generation: 5,
      dedupeKey: `${family}:5`,
      detail: { tool: "Grep", errorSig: "unclassified", lane: "claude" },
      evidence: [],
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    });
    await publisher.init();
    expect(publisher.__openEntryForTests(family)).toBeUndefined();

    fakeDb.failAll(OPS_EVENTS_COLLECTION, "findOne");
    driveFailure("Grep");
    await publisher.__drainForTests();

    expect(events().at(-1)!.generation).toBe(0);
    expect(publisher.getSnapshot().epochResolveFaults).toBe(1);
  });
});

describe("OpsPublisher recovery and the openSeq identity", () => {
  it("publishes one clearing fact and removes the entry AFTER the accept, not before", async () => {
    await publisher.init();
    driveFailure("Bash");
    await publisher.__drainForTests();
    const family = familyFor("Bash");
    const openedKey = publisher.__openEntryForTests(family)!.dedupeKey;

    // Ordering proof: hold the drainer inside the clearing insert and read the
    // map while it is parked there.
    const gate = fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
    driveSuccess("Bash");
    await gate.reached;
    expect(publisher.__openEntryForTests(family)).toBeDefined();
    gate.release();
    await publisher.__drainForTests();

    expect(publisher.__openEntryForTests(family)).toBeUndefined();
    const clearingDoc = events().at(-1)!;
    expect(clearingDoc.reasonId).toBe(REASON_TOOL_RECOVERED);
    expect(clearingDoc.class).toBe("informational");
    expect(clearingDoc.waiting).toBe("nobody");
    expect(clearingDoc.generation).toBe(0);
    expect(clearingDoc.clears).toBe(openedKey);
    expect(clearingDoc.clearsFamily).toBe(family);
    expect(clearingDoc.evidence).toEqual([]);
    expect(publisher.getSnapshot().recoveryCoalesced).toBe(0);
    expect(publisher.getSnapshot().recoverySuperseded).toBe(0);
  });

  it("coalesces a sibling recovery for an interval a predecessor already closed", async () => {
    await publisher.init();
    driveFailure("Bash");
    await publisher.__drainForTests();
    const family = familyFor("Bash");

    // One synchronous block: R1's enqueue runs the drainer straight into R1's
    // `insertOne` await (a recovery accept reaches NO earlier await —
    // `resolveGeneration` is skipped for a clearing publish), so R2 is minted
    // against the still-live entry and only queued.
    // `insertsBefore` is read BEFORE the block: the fake logs an operation at
    // the TOP of `operation()`, so R1's insert is already in the log by the
    // time control returns to this test.
    const insertsBefore = opsEventInserts();
    driveSuccess("Bash");
    driveSuccess("Bash");
    await publisher.__drainForTests();

    expect(publisher.getSnapshot().recoveryCoalesced).toBe(1);
    expect(publisher.getSnapshot().recoverySuperseded).toBe(0);
    // R1 inserted; R2 inserted nothing.
    expect(opsEventInserts() - insertsBefore).toBe(1);
    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(1);
    expect(publisher.__openEntryForTests(family)).toBeUndefined();
  });

  it("drops a SUPERSEDED recovery and leaves the live interval's entry intact", async () => {
    await publisher.init();
    const family = familyFor("Bash");
    driveFailure("Bash");
    await publisher.__drainForTests();
    expect(publisher.__openEntryForTests(family)!.openSeq).toBe(1);

    // ⚠ THE CONSTRUCTION THIS FILE USES is the plan's synchronous `R1 · F · R2`
    // block, not `pause()`. Observed exactly as predicted: R1's enqueue drives
    // the drainer synchronously into R1's `insertOne` await, so F2 and R2 are
    // both minted against the openSeq-1 entry and merely queued; when the
    // microtask queue resumes, R1 accepts and deletes, F2 re-opens the family
    // at openSeq 2, and R2 finds 2 !== 1.
    //
    // That parking depends on a recovery accept having no earlier await. If a
    // later edit introduces one, this recipe silently degenerates into the
    // coalesced case above — which is why `recoverySuperseded` is asserted
    // directly rather than inferred from the surviving entry alone.
    driveSuccess("Bash"); // R1 — minted at openSeq 1
    driveFailure("Bash"); // F2 — queued behind R1
    driveSuccess("Bash"); // R2 — minted, STILL openSeq 1
    await publisher.__drainForTests();

    const snapshot = publisher.getSnapshot();
    expect(snapshot.recoverySuperseded).toBe(1);
    expect(snapshot.recoveryCoalesced).toBe(0);
    // Nothing published for R2: exactly one clearing fact, from R1.
    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(1);
    // The live entry survives — the worst of D8's three harms is permanent
    // silence, and this is the assertion that would catch it.
    const entry = publisher.__openEntryForTests(family)!;
    expect(entry.openSeq).toBe(2);
    expect(entry.dedupeKey).toBe(`${family}:1`);
  });

  it("leaves the family open when a recovery's publish faults, so the next success re-enqueues", async () => {
    await publisher.init();
    const family = familyFor("Bash");
    driveFailure("Bash");
    await publisher.__drainForTests();

    fakeDb.failNext(OPS_EVENTS_COLLECTION, "insertOne");
    driveSuccess("Bash");
    await publisher.__drainForTests();
    expect(publisher.getSnapshot().publishFaults).toBe(1);
    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(0);
    expect(publisher.__openEntryForTests(family)).toBeDefined();

    driveSuccess("Bash");
    await publisher.__drainForTests();
    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(1);
    expect(publisher.__openEntryForTests(family)).toBeUndefined();
  });

  // `clears`/`clearsFamily` are the only strings this accept path STORES that
  // step 2 does not bound: step 2 covers subject/detail/evidence, and step 4's
  // legality test reads one component. Unreachable from this producer's own
  // capture points — `observe.ts` always passes a key this publisher minted —
  // but the accept path is the fail-closed gate AC16 drives with foreign rows.
  it("rejects an over-long `clears` rather than storing it verbatim", async () => {
    await publisher.init();
    // Legal in every OTHER respect: right producer, right cleared reasonId, a
    // declared clearer. Only the length is wrong — so before this bound
    // existed the whole string (and its derived, INDEXED clearsFamily) was
    // stored.
    const clears = `${HIVE_RUNTIME_PRODUCER}:tool:${"a".repeat(600)}:${REASON_TOOL_FAILED}:0`;
    expect(clears.length).toBeGreaterThan(OPS_CLEARS_MAX_LENGTH);
    publisher.enqueueFailure({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_RECOVERED,
      waiting: "nobody",
      subject: { kind: "tool", id: "Bash" },
      detail: { tool: "Bash", lane: "claude" },
      evidence: [],
      clears,
    });
    await publisher.__drainForTests();

    expect(events()).toHaveLength(0);
    expect(publisher.getSnapshot().rejected).toBe(1);
    expect(publisher.getSnapshot().published).toBe(0);
  });

  it("accepts a MAXIMAL legal key — the length bound must not refuse a long foreign one", async () => {
    // ⚠ THE COMPLEMENT THAT PINS THE CONSTANT. A dedupeKey's maximum legal
    // length under this producer's own bounds is three 40-char tokens + a
    // 200-char subject.id + four separators + the generation — over 324 — so a
    // bound derived from `OPS_ID_MAX_LENGTH` alone would reject this key, which
    // an out-of-engine producer (D4/AC16) can legitimately mint. Built from the
    // bounds rather than from a literal, so it tracks them.
    const token = `f${"o".repeat(39)}`; // 40 chars, satisfies OPS_TOKEN_RE
    await fakeDb.collection(OPS_REASONS_COLLECTION).insertOne({
      _id: `${token}:${token}`,
      producer: token,
      reasonId: token,
      class: "informational",
      retry: "transient",
      remediationTemplate: "none",
      detailKeys: [],
      clearsReasonIds: [token],
      enabled: true,
    });
    await publisher.init();

    const clears = `${token}:${token}:${"i".repeat(OPS_ID_MAX_LENGTH)}:${token}:0`;
    expect(clears.length).toBeGreaterThan(OPS_ID_MAX_LENGTH + 64); // the bound that would have been wrong
    expect(clears.length).toBeLessThanOrEqual(OPS_CLEARS_MAX_LENGTH);
    publisher.enqueueFailure({
      producer: token,
      reasonId: token,
      waiting: "nobody",
      subject: { kind: token, id: "x" },
      detail: {},
      evidence: [],
      clears,
    });
    await publisher.__drainForTests();

    expect(publisher.getSnapshot().rejected).toBe(0);
    expect(events()).toHaveLength(1);
    expect(events()[0]!.clears).toBe(clears);
  });

  it("rejects a `clears` naming ANOTHER producer's family", async () => {
    await publisher.init();
    // `tool-failed` IS in this row's clearsReasonIds, so the membership test
    // passes and only ownership refuses it: without this check one producer's
    // clearing reason could close — and advance the generation of — a family
    // belonging to a producer it has no standing over.
    publisher.enqueueFailure({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_RECOVERED,
      waiting: "nobody",
      subject: { kind: "tool", id: "Bash" },
      detail: { tool: "Bash", lane: "claude" },
      evidence: [],
      clears: `florist:tool:bloom:${REASON_TOOL_FAILED}:0`,
    });
    await publisher.__drainForTests();

    expect(events()).toHaveLength(0);
    expect(publisher.getSnapshot().rejected).toBe(1);
    // Nothing was written, so no foreign clearsFamily entered the index.
    expect(events().some((d) => d.clearsFamily !== undefined)).toBe(false);
  });

  it("still accepts a well-formed same-producer `clears` — the two bounds refuse nothing legitimate", async () => {
    await publisher.init();
    driveFailure("Bash");
    await publisher.__drainForTests();
    driveSuccess("Bash");
    await publisher.__drainForTests();

    expect(events().filter((d) => d.reasonId === REASON_TOOL_RECOVERED)).toHaveLength(1);
    expect(publisher.getSnapshot().rejected).toBe(0);
  });

  it("performs NO database access for a success with no open condition", async () => {
    await publisher.init();
    // The armed-to-throw mode, AFTER init(): a publisher over a `Db` whose
    // every access throws cannot be constructed, let alone initialized, so the
    // claim is about the STEADY state and is asserted on both surfaces.
    fakeDb.armThrowOnEveryAccess();
    const before = fakeDb.operations.length;
    expect(() => driveSuccess("Grep")).not.toThrow();
    await publisher.__drainForTests();
    expect(fakeDb.operations.length).toBe(before);
    expect(publisher.getSnapshot().queueDepth).toBe(0);
    expect(publisher.getSnapshot().published).toBe(0);
  });
});

describe("OpsPublisher queue, map and shutdown", () => {
  it("drops the OLDEST job on overflow and counts it", async () => {
    await publisher.init();
    // The drainer parks on the first job's epoch reads, so everything after it
    // in this synchronous loop accumulates in the queue. 1002 calls: the first
    // is shifted immediately, calls 2..1001 fill the queue to its depth, and
    // call 1002 evicts call 2.
    for (let i = 1; i <= 1002; i += 1) driveFailure(`tool-${i}`);

    expect(publisher.getSnapshot().queueOverflow).toBe(1);
    await publisher.__drainForTests();

    const published = new Set(events().map((d) => d.subject.id as string));
    expect(published.has("tool-1")).toBe(true);
    expect(published.has("tool-2")).toBe(false); // the oldest queued job, dropped
    expect(published.has("tool-3")).toBe(true);
    expect(published.has("tool-1002")).toBe(true);
    expect(published.size).toBe(1001);
  });

  it("evicts the oldest open-condition entry at the map cap", async () => {
    // The resolver is faulted throughout so each job is one insert rather than
    // two scans over a growing collection — the cap is independent of the
    // epoch, and 2001 honest resolutions would make this case quadratic.
    await publisher.init();
    fakeDb.failAll(OPS_EVENTS_COLLECTION, "findOne");
    for (let i = 1; i <= 2001; i += 1) {
      driveFailure(`tool-${i}`);
      // Batched below PUBLISH_QUEUE_DEPTH so overflow never confounds the cap.
      if (i % 400 === 0) await publisher.__drainForTests();
    }
    await publisher.__drainForTests();

    expect(publisher.getSnapshot().openConditions).toBe(2000);
    expect(publisher.__openEntryForTests(familyFor("tool-1"))).toBeUndefined();
    expect(publisher.__openEntryForTests(familyFor("tool-2"))).toBeDefined();
    expect(publisher.__openEntryForTests(familyFor("tool-2001"))).toBeDefined();
  });

  it("stop() clears the timer, drains within the bound, and stops accepting", async () => {
    await publisher.init();
    driveFailure("Bash");
    const clear = vi.spyOn(globalThis, "clearInterval");
    await publisher.stop();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();

    const snapshot = publisher.getSnapshot();
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.drainDropped).toBe(0);
    expect(events()).toHaveLength(1);

    // The stopping latch: a later enqueue is refused — and COUNTED. The latch
    // is set before a drain that can run for up to SHUTDOWN_DRAIN_MS while
    // turns are still producing observations, so an uncounted refusal here is
    // a shutdown loss `drainDropped`'s deadline arm cannot see.
    driveFailure("Grep");
    expect(publisher.getSnapshot().queueDepth).toBe(0);
    expect(publisher.getSnapshot().drainDropped).toBe(1);
    expect(events()).toHaveLength(1); // still nothing published for it
  });

  it("stop() drops and counts a queue it cannot drain inside the bound", async () => {
    await publisher.init();
    // Hold the drainer inside the first job's epoch read for longer than
    // SHUTDOWN_DRAIN_MS, so the two jobs behind it are still queued at the
    // deadline.
    const gate = fakeDb.pause(OPS_EVENTS_COLLECTION, "findOne");
    driveFailure("Bash");
    await gate.reached;
    driveFailure("Grep");
    driveFailure("Read");
    expect(publisher.getSnapshot().queueDepth).toBe(2);

    await publisher.stop();
    expect(publisher.getSnapshot().drainDropped).toBe(2);
    expect(publisher.getSnapshot().queueDepth).toBe(0);
    gate.release();
  });
});
