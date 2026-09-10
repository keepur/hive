# KPR-468 plan — chunk 6: the AC1–AC17 acceptance suite

One task, one commit. Seventeen `describe` blocks in `src/ops/notifier-acceptance.integration.test.ts`, each named for its criterion and each carrying at least one real `it`, plus `src/ops/notifier-isolation.test.ts` for AC2's two source-tree scans.

**These are the criteria, not a second copy of the module suites.** Chunks 2–4 each carry their own unit and integration coverage; what is re-driven here is the subset a KPR-458 conformance criterion names, plus the **able-to-fail** cases the spec calls out — the ones written specifically so that a plausible-but-wrong implementation goes red. Six of those carry a negative-verify obligation and are marked ⛳ below; each names the mutation, the tests that must fail, and the predicted failure, and each must be **run**, not asserted.

**One standing rule for the whole file:** every publish→assert and sweep→assert boundary goes through `await notifier.__tickForTests()`. `start()` arms an interval, so an assertion after `start()` without the barrier is racing a timer.

---

### Task 8: AC1–AC17

**Files:**

- Create: `src/ops/notifier-isolation.test.ts`
- Create: `src/ops/notifier-acceptance.integration.test.ts`

- [ ] **Step 1:** Create `src/ops/notifier-isolation.test.ts` — AC2's two structural scans, plus the KPR-456 separation.

```typescript
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// The notifier's OWN file set — KPR-454's producer modules and every test
// double are excluded, because this constrains the notifier's sources rather
// than its siblings or its harness.
const NOTIFIER_FILES = [
  "notification-types.ts",
  "transport.ts",
  "slack-transport.ts",
  "notification-store.ts",
  "ingest.ts",
  "delivery.ts",
  "notifier.ts",
  "intake.ts",
  "notifier-singleton.ts",
].map((f) => join(here, f));

describe("AC2 — the notifier never evaluates a match and is off the turn path", () => {
  it("imports src/ops/match.ts from nowhere in its own file set (C2, C17)", () => {
    // Re-evaluation would let a subscription registered after accept acquire a
    // past event, contradicting D5, and would make the stored count a lie.
    for (const file of NOTIFIER_FILES) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+"\.\/match\.js"/);
    }
  });

  it("is imported by no turn-path module (containment (a))", () => {
    // "Off the turn path" is a CHECKED property here, not a claim.
    const turnPath = [
      "agents/agent-runner.ts",
      "agents/provider-adapters/tool-bridge.ts",
      "channels/dispatcher.ts",
      "agents/agent-manager.ts",
    ].map((rel) => readFileSync(join(here, "..", rel), "utf8"));
    for (const source of turnPath) {
      expect(source).not.toMatch(/from\s+"[^"]*ops\/(notifier|intake|delivery|ingest|transport|slack-transport|notification-)/);
    }
  });

  it("imports nothing from src/obligations/ (KPR-456 contract separation)", () => {
    // KPR-456's poster, its PostOutcome taxonomy and its NONACCEPTANCE set are
    // a separate contract epic canon preserves in force. The hardening is
    // COPIED into slack-transport.ts, never imported.
    for (const file of sources(here)) {
      if (file.includes("/testing/")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+"[^"]*obligations\//);
    }
  });
});

describe("AC15 — activity_log is not a failure oracle here (C12)", () => {
  it("reads no activity_log field and touches neither agent_events nor the scheduler", () => {
    for (const file of NOTIFIER_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/activity_log|costUsd|agent_events|EVENT_SCHEMAS|checkEvents/);
    }
  });
});
```

- [ ] **Step 2:** Begin `src/ops/notifier-acceptance.integration.test.ts` with the shared harness and **AC1**, **AC3**, **AC5**.

The harness builds a `FakeDb`, seeds `ops_events` / `ops_subscriptions` / `ops_reasons` directly (never through KPR-454's publisher — AC16 is the one case that uses the real accept path), constructs an `OpsNotifier` with a controllable clock, registers a `FakeTransport`, and exposes `tick()`.

- **AC1 (C2, C3)** — with `ops_subscriptions` empty, ingesting any number of events creates **zero** `ops_notifications` documents and attempts zero deliveries; the event documents are byte-identical afterwards. A grep-shaped companion: no code path in the notifier's file set creates a default subscription, a fallback recipient or a fallback adapter (assert `transports.size === 0` after `init()` with no `registerTransport`, and that a due row with an unbound adapter stalls rather than falling back).
- **AC3 (C17, the handoff)** — an event stamped `[s1]` while an **enabled** `s2` would also match its attributes creates a row for `s1` **only**. Second case: a stamped id whose subscription has since been disabled creates no row and leaves the event's `matchedSubscriptions` count untouched.
- **AC5 (C17, the cursor)** — the cursor advances only after the page's ledger writes are acknowledged, and a crash between them re-processes rather than skips (drive it by discarding the cursor write and re-running the tick; assert `eventCount` unchanged). An **absent** cursor initializes to the clock, counts `cursorReinitialized`, and creates **no** rows for events already in the log — the negative test is a log seeded with **50** pre-existing events, after which the ledger is empty.

- [ ] **Step 3:** ⛳ **AC4 — idempotence.** This is the criterion D12's own phrasing misses, so its able-to-fail case is written to distinguish *three* implementations.

```typescript
describe("AC4 — re-processing any prefix of the log is a total no-op (C17)", () => {
  it("leaves eventCount at 2 when a page holding TWO events for one dedupeKey is replayed", async () => {
    // ⚠ THE ABLE-TO-FAIL CASE. D12 offers `latestEventId` equality, which
    // guards an exact replay of the LAST event only. A crash mid-page
    // re-processes a page in which one dedupeKey was touched twice, and the
    // OLDER of the two touches then passes an equality test and double-counts.
    //
    // Both wrong implementations are PREDICTED, because a wrong predicted
    // number is what gets a genuine harness bug filed as an implementation bug:
    //   - unconditional $set of the event fields  ⇒ 4
    //     (the replay admits e1, which also REGRESSES latestEventId to e1, and
    //      then admits e2 as well)
    //   - refuse-to-regress latestEventId + equality ⇒ 3
    //     (e1 replays, leaving latestEventId at e2, whose own equality test
    //      then blocks it)
    const h = await harness({ subscriptions: [sub("s1")] });
    const e1 = await h.seedEvent({ dedupeKey: "p:tool:gog:tool-failed:0", publishedAt: t(0) });
    const e2 = await h.seedEvent({ dedupeKey: "p:tool:gog:tool-failed:0", publishedAt: t(1) });
    await h.tick();
    expect(await h.row("s1", "p:tool:gog:tool-failed:0")).toMatchObject({ eventCount: 2, latestEventId: String(e2._id) });

    // Simulate the crash D12 describes: rewind the cursor to before e1 and
    // re-run. Every ledger write from the first pass must be a no-op.
    await h.store.writeCursor({ publishedAt: t(-1), eventId: null });
    await h.tick();

    const row = await h.row("s1", "p:tool:gog:tool-failed:0");
    expect(row.eventCount).toBe(2);
    expect(row.latestEventId).toBe(String(e2._id));
    expect(row.attemptCount).toBe(1); // one delivery on the first tick, none added
    expect(row.nudgeCount).toBe(0);
  });

  it("discards an out-of-order (older) event rather than applying it", async () => { /* … */ });

  it("leaves state, attemptCount and nudgeCount byte-identical across a whole-prefix replay", async () => { /* … */ });
});
```

⛳ **Negative-verify (Verification Rule 1).** Replace `newerThan(e)` in both renewal arms and the clearing arm with `{ latestEventId: { $ne: String(e._id) } }` and make the `$set` of the event fields unconditional. Predict and confirm:

- `leaves eventCount at 2 …` fails reporting **4**.
- The half-strengthened variant (refuse to regress `latestEventId`, keep the equality test) reports **3**.
- The other two cases in this block also fail under the unconditional variant and **stay green** under the half-strengthened one — that asymmetry is why `eventCount === 2` is the load-bearing assertion.

Restore.

- [ ] **Step 4:** **AC13 — containment.** The two containment rules are asserted **separately**, because a single "per-row continue" implementation passes one and silently loses events on the other. Three ingest limbs, not one.

```typescript
describe("AC13 — a tick contains its own faults (D8(b))", () => {
  it("delivery and snooze expiry: a per-row fault is caught and counted, and the phase continues", async () => {
    // These phases have no cursor and no ordering obligation, so a skipped row
    // costs that row one tick and nothing else.
  });

  it("ingest limb 1 — a fault on the THIRD of a five-event page stops the phase at it", async () => {
    // ⚠ ABLE-TO-FAIL against the per-row-continue implementation, which applies
    // 4 and 5, advances the cursor to 5, and leaves event 3 permanently
    // unnotified, uncounted, and invisible to eventsBehind — not BEHIND the
    // cursor but UNDER it.
    const h = await harness({ subscriptions: [sub("s1")] });
    const events = await h.seedEvents(5);
    h.db.failOn("ops_notifications", "insertOne", (ctx) => ctx.document?.latestEventId === String(events[2]._id));
    await h.tick();

    const cursor = await h.store.readCursor();
    expect(cursor!.eventId).toBe(String(events[1]._id)); // at or before the SECOND
    expect(await h.ledgerCount()).toBe(2);
    expect(h.snapshot().ingestFaults).toBe(1);

    h.db.clearFaults();
    await h.tick();
    expect(await h.ledgerCount()).toBe(5); // 3, 4 and 5 applied on the next tick
  });

  it("ingest limb 2 — the unit is the EVENT: a fault in the second row of a clearing fan-out stops at that event", async () => {
    // The retry re-applies the whole event, with the already-cleared row a
    // no-op via the watermark.
  });

  it("ingest limb 3 — the WEDGE signature: a deterministic fault holds the cursor across two ticks", async () => {
    // ⚠ This is the only limb that asserts D8(b)'s "no automatic skip and no
    // quarantine" RULING rather than merely stating it. The able-to-fail case
    // is the bounded-quarantine implementation this spec declines, which
    // advances the cursor past the poison event on the second tick — limb 1
    // injects the fault once and so PASSES against it.
    //
    // Seed the cursor so the faulting event is the FIRST un-applied one, or
    // tick 1 advances legitimately over its predecessors and the byte-identity
    // assertion has to skip a tick.
    const h = await harness({ subscriptions: [sub("s1")] });
    const poison = await h.seedEvent({});
    h.db.failAlwaysOn("ops_notifications", "insertOne");
    const before = await h.store.readCursor();
    await h.tick();
    const after1 = await h.store.readCursor();
    await h.tick();
    const after2 = await h.store.readCursor();

    expect(after1).toEqual(before);
    expect(after2).toEqual(before);
    expect(h.snapshot().ingestFaults).toBe(2);
    expect(await h.heartbeat()).toMatchObject({ state: "degraded" });
    expect((await h.heartbeat()).oldestUnappliedAt).toEqual(poison.publishedAt);
  });

  it("ticks never overlap under a slow adapter", async () => {
    // A second sweepOnce() started while the first is in flight returns the
    // same promise and performs no second set of phase reads.
  });

  it("a per-row latch serializes an intake write against a tick on the same row", async () => {
    // The loser observes a CAS failure rather than a merged write.
  });
});
```

- [ ] **Step 5:** ⛳ **AC6 — clearing.**

```typescript
describe("AC6 — clearing (D4, D8)", () => {
  it("a clearing event with ZERO matchedSubscriptionIds clears every row on the named dedupeKey", async () => {
    // ⚠ ABLE-TO-FAIL against a match-scoped implementation. A clearing reason
    // is `informational` and normally matches NOBODY, so a match-scoped
    // clearing would clear nothing, every `resource` condition would nudge
    // forever, and D12's own guarantee that recovering resource conditions
    // fall silent on their own would be false.
    // Two subscriptions on one dedupeKey, so the fan-out is visible.
  });

  it("provenance: resource clears same-producer; judgment and integrity need evidence; informational never clears", async () => {
    // Four rows, driven as a table. Every FAILING case increments clearRefused
    // and transitions nothing.
  });

  it("a dismissed row CLEARS and a cleared row is a no-op", async () => { /* … */ });

  it("a clearing event from another producer does not clear, and increments clearRefused", async () => {
    // ⚠ ITS OWN ROW rather than riding along incidentally. C19 enforces
    // clearsReasonIds membership at publish over the REASONID COMPONENT ONLY
    // (KPR-454's accept path computes reasonIdOfDedupeKey(input.clears) and
    // tests membership), so a `clears` naming ANOTHER producer's dedupeKey
    // whose reasonId happens to collide passes publish intact. Seed exactly
    // that: producer B's clearing event naming a dedupeKey under producer A,
    // with a reasonId that IS in B's registered clearsReasonIds.
  });

  it("a clearing event naming a dedupeKey with no row is a counted no-op", async () => {
    // Openness is answered from the LOG, not the ledger (D8).
  });
});
```

⛳ **Negative-verify (Verification Rule 2).** Add `subscriptionId: { $in: e.matchedSubscriptionIds }` to the clearing fan-out filter. Predict and confirm: only the zero-match case fails — the row stays `pending`, `rowsCleared` is 0, and `clearRefused` is **unchanged at 0** (the row was never reached, so nothing refused it), which is the distinguishing signature against Rule 2b. The four provenance rows and the same-producer row **stay green**: they are seeded with a matching stamp, so a match-scoped implementation still reaches them.

⛳ **Negative-verify (Verification Rule 2b).** Delete `e.producer === row.producer` from `clearingProvenanceOk`. Predict and confirm: only `a clearing event from another producer does not clear` fails — the row transitions to `cleared` and `clearRefused` stays at 0. Every other AC6 row stays green, **including** the `judgment`/`integrity` evidence rows the deleted clause is `&&`-ed with: dropping one conjunct of a passing test leaves it passing.

Restore after each.

- [ ] **Step 6:** ⛳ **AC7 — delivery and nudging (C8, C10).**

Assertions: `accepted` transitions `pending → delivered`, records `deliveryReference`, and sets `nextNudgeAt` from the resolved cadence; `rejected` and `unknown` leave the state unchanged; `unknown` never reaches `delivered`; **no automatic resend follows an `unknown`** — drive the clock and prove the interval was the cadence's rather than a retry's; a nudge re-delivers the **same** row (the `ops_notifications` document count is unchanged across ten nudges) and `nudgeCount` excludes the first attempt; there is no attempt ceiling and no terminal give-up; `attempts[]` never exceeds `ATTEMPTS_RING_CAP` while `attemptCount` keeps counting.

```typescript
  it("a freshly-minted row is delivered on a tick where a large stall backlog is already due", async () => {
    // ⚠ THE STARVATION CASE, and it is its own able-to-fail limb because the
    // property is STRUCTURAL: a single-query implementation passes every other
    // assertion in this block.
    //
    // Seed more cadence-unresolved stalled rows than the delivery phase's
    // budget can touch, advance the clock past their re-check so they are ALL
    // due, then mint one fresh row and assert IT is delivered on that tick.
    // False of any implementation that serves one { state, nextNudgeAt } scan
    // in ascending order, since the stalled rows carry OLDER nextNudgeAt values
    // and sort ahead of it.
  });
```

⛳ **Negative-verify (Verification Rule 3).** Collapse the three arms into one `{ state: { $in: ["pending","delivered"] }, nextNudgeAt: { $lte: now } }` scan sorted `{ nextNudgeAt: 1 }`. Predict and confirm: **exactly one** case fails — the starvation case. Every other AC7 assertion stays green, because a single-scan implementation is correct for every property except starvation. That is the whole reason the case is written behaviourally rather than as an index assertion, which no test double can falsify.

Restore.

- [ ] **Step 7:** **AC9**, **AC12**, and AC15's runtime half.

- **AC9 (C14, D10 invariants)** — no code path in this diff publishes an `ops_event`, on success or on any fault: inject a fault into **every** phase and assert log lines, counter increments, heartbeat `degraded`, and **zero writes to `ops_events`** (count `insertOne` operations against that collection in the double's `operations` log — it must be 0 for the whole suite run). **The Slack transport registers every accepted post's `ts` through the echo callback** — assert `registerOutboundTs` was called with the returned channel and ts, because without it the post re-enters as a `WorkItem` and spawns a turn. No delivery synchronously spawns an agent turn (structural, carried by AC2's import scan).
- **AC12 (C13, redaction)** — no `ops_notifications` field contains message text, prompt or completion text, tool arguments, a raw error object, a URL, a credential, a file path or free-form prose. **Negative test:** drive a delivery whose transport fails with a **credential-shaped** (`xoxb-1234-secret`) and a **path-shaped** (`/Users/mokie/.env`) error and assert neither substring appears anywhere in the serialized row. Assert `remediation` is a registry template plus allow-listed parameters, rendered **in the adapter**, and that the ledger stores no rendered string (the row has no field holding the transport's message body).

- [ ] **Step 8:** ⛳ **AC10** and **AC11** — the clamp and the deployment gate.

**AC10 (C10, the clamp).** A snooze beyond the operator maximum is **applied clamped** and the clamped value is echoed; with no `ops_policy` registered it clamps to `HARD_SNOOZE_CEILING_MS`; a snooze arriving **before the first tick has run** likewise clamps to the hard ceiling (the cold path) and a companion assertion proves intake performed **no `ops_policy` read** (the double's `operations` log); an absent or non-future `snoozedUntil` is refused. **The able-to-fail case is a caller-supplied `at`:** a snooze whose `at` is far in the future is applied with `snoozedUntil` no later than `now + HARD_SNOOZE_CEILING_MS` — false of any implementation anchoring on `at`, which admits an arbitrarily distant pause, i.e. the terminal state D12 and C10 forbid. Drive it on an `integrity` row. Expiry returns the row to `delivered`/`pending` **and re-delivers it under no registered cadence**. A `seen` row snoozed through intake comes out with `expiresAt` **unset** — the able-to-fail case for D9's state invariant, which an enumeration of out-transitions omits and which would otherwise let a working row be TTL-deleted.

**AC11 (cadence sourcing).** With no `ops_policy`, a row is **attempted exactly once per occurrence** and never nudged between occurrences — **including after a `rejected` and after an `unknown` outcome, neither of which earns a re-attempt** — and registering a cadence resumes nudging within one stall re-check interval, without a restart. **Driven against the real scan predicate, not a stub**, with three able-to-fail limbs:

```typescript
  const DUE = (now: Date) => ({ state: { $in: ["pending", "delivered"] }, nextNudgeAt: { $lte: now } });

  it("limb 1 — never unset: between deliveries the row is still returned by the due-scan predicate", async () => {
    // False of any implementation that unsets the field. MongoDB's comparison
    // operators are TYPE-BRACKETED and fake-db.ts:40-41 reproduces it
    // (`case "$lte": return actual !== undefined && actual <= value`), so the
    // double fails it too — which is what makes this limb real rather than a
    // claim about the driver.
    const later = new Date(now.getTime() + STALL_RECHECK_MS * 1.5);
    expect(await h.db.collection("ops_notifications").countDocuments(DUE(later))).toBe(1);
  });

  it("limb 2 — pushed forward, not left due", async () => {
    // False of the "leave it at its due value" implementation, which parks an
    // ever-growing, never-TTL'd prefix at the head of the delivery scan.
    expect(await h.db.collection("ops_notifications").countDocuments(DUE(now))).toBe(0);
  });

  it("limb 3 — the two re-delivery triggers still fire under no ops_policy", async () => {
    // Both false of a two-disjunct `attemptCount === 0 ∨ cadence` gate, which
    // turns a demonstrated recurrence and an expired snooze into PERMANENT
    // SILENCE under the shipped default.
    // (a) a row cleared and then renewed is DELIVERED AGAIN (attemptCount 2);
    // (b) a row snoozed and then expired is DELIVERED AGAIN.
  });
```

Then: the row is re-observed across successive re-check intervals — `rowsCadenceUnresolved` counts it each time, derived from the `{stalledReason, state}` index rather than from the delivery pass — before the first re-check after a cadence is written **delivers**. A subscription naming a cadence profile uses that profile's interval and **never** the `(class, retry)` table; naming an **unknown** profile resolves no cadence and does **not** fall back to the table. A profile below the floor is clamped up and warned. **This child registers zero `ops_policy` rows** — assert the collection is empty after `init()` and `start()`.

⛳ **Negative-verify (Verification Rule 4).** On the delivery phase's no-interval branch, replace the `$set` of `nextNudgeAt = stallRecheckAt(now)` with `$unset: { nextNudgeAt: "" }`. Predict and confirm:

- **limb 1 fails** — the predicate returns nothing.
- **limb 2 also fails, but for the opposite reason**: an unset field is not "at its due value" either, so the `countDocuments === 0` assertion passes **vacuously** and the case fails only on its companion assertion. **Record which of the two assertions went red**, because a vacuous pass is not evidence.
- **limb 3 stays green** — the reopen and the expiry arms both re-set `nextNudgeAt = now` explicitly.

Restore.

- [ ] **Step 9:** ⛳ **AC8 — intake (C9).**

Every transition to `seen`/`dismissed`/`snoozed` arrives through `accept(...)`, records a stable actor id and instant, and is idempotent: replaying one act returns `noop` and leaves the row byte-identical. **The order test is explicit:** a duplicated `dismissed` returns `{ state: "noop", reason: "already-applied" }` and **not** `refused: "illegal-transition"`.

**The monotonicity guard gets its own able-to-fail case, because `lastAckKey` alone passes the duplicate test above and still fails this one:** apply `seen` at `t1`, then `snoozed` at `t2 > t1`, then replay the *`seen`* — it must return `{ state: "noop", reason: "superseded" }` and leave the row `snoozed` with its `snoozedUntil` and `expiresAt` byte-identical.

**A paired negative pins the anchor choice:** a system transition (a nudge, a snooze expiry) between a human's act and its callback must **not** supersede that callback — false of any implementation guarding on `principalAt`.

**Clock anchoring is asserted directly** (shared with AC10's able-to-fail case). **The system principal can never produce those three states, and the test drives the case that ESTABLISHES it rather than the case that assumes it:** an `accept(...)` whose `actorId` **is** `OPS_SYSTEM_PRINCIPAL` returns `refused: "unattributed"` and leaves the row byte-identical. A second, structural: the constant matches neither the agent-id shape nor the Slack user-id shape (already in `notification-types.test.ts`; re-referenced, not duplicated). `dismissed` on `integrity` is refused. Any act on a `cleared` row is refused.

**No bulk transition exists** — a source-tree assertion that no code path issues an `updateMany` against `ops_notifications`:

```typescript
  it("no code path issues an updateMany against ops_notifications", () => {
    // The apply-if-newer watermark is a PER-ROW precondition: two rows on one
    // dedupeKey can sit at different appliedThrough* positions, so a bulk
    // update cannot express "apply only where this row's watermark is older".
    // An implementer who reaches for updateMany in the clearing fan-out will
    // hit this and should read it as the design, not a harness bug.
    for (const file of NOTIFIER_FILES) expect(readFileSync(file, "utf8"), file).not.toContain("updateMany");
    // And at runtime, over the whole suite:
    expect(h.db.operations.filter((o) => o.operation === "updateMany")).toEqual([]);
  });
```

**And no sweep path can set `dismissed`** — assert every `state:` literal written by `ingest.ts` and `delivery.ts` is drawn from `{pending, delivered, cleared}`.

⛳ **Negative-verify (Verification Rule 6).** Two mutations, run in sequence:

- Delete the `lastAckAt` check from intake step 3 **and** its clause from the step-8 CAS. Predict and confirm: `a delayed duplicate of an older act is superseded` fails — the replayed `seen` applies, the row leaves `snoozed`, `snoozedUntil` is unset — while `a duplicated dismissal returns noop/already-applied` **stays green** (`lastAckKey` alone carries it).
- Restore, then guard on `principalAt` instead of `lastAckAt`. Predict and confirm the **inverse** pair: the delayed-duplicate case goes green again, and `a system transition between a human act and its callback does not supersede it` fails, with the callback returning `superseded` and a real act lost.

Restore.

- [ ] **Step 10:** **AC14**, **AC16**, **AC17**.

- **AC14 (boot order, drain, boot survival)** — the `boot-order.test.ts` half is chunk 5 Task 7 Steps 6–7 and is **not duplicated here**; this block carries the runtime half. A unique-index failure at `init()` leaves the notifier unstarted **with the singleton unset**, so `acceptOpsAcknowledgement(...)` returns `{ state: "unavailable" }`, and boot completes. A failure of any **other** index leaves it started. A first-subscription-load failure in `start()` leaves it unstarted with intake live. **The `init()`-side reason-map fault is pinned separately and resolves the other way:** `setOpsNotifier` still runs, the sweep never starts, and `accept(...)` on an existing row **applies** — because reasons feed only `remediation` at delivery and intake consumes none of them. **Intake availability is pinned to `init()`, not `start()`:** with `init()` complete and `start()` never called, `accept(...)` on an existing row **applies**; with the singleton unset, or after `stop()`, it returns `unavailable`. A separate assertion pins the load's placement — **no `ops_subscriptions` read occurs during `init()`** (the double's `operations` log), because a load that ran there would have no registered adapter to run `validateTarget` against and would unload every subscription on a warm restart.
- **AC16 (C16, D11 levers)** — adding a subscriber, a transport binding, a reason or a cadence value is **data** rather than an engine change: insert an `ops_subscriptions` row and an `ops_policy` document into an **already-initialized** notifier and, after one reload, publish an event **through KPR-454's real accept path** and observe a row created, delivered and scheduled — with no edit to the envelope, the filter grammar or the transport interface. This is the **one** case in the suite that uses `OpsPublisher` rather than seeding `ops_events` directly, and it is what makes the handoff an end-to-end claim rather than a fixture. The reverse: setting `enabled: false` on that row stops delivery and nudging within one reload while **retaining** the row, and re-enabling resumes.
- **AC17 (documentation)** — a text assertion over `CLAUDE.md`: it names `ops_notifications` and `ops_policy` in the engine-written collections list; the `telemetry` entry names **both** `ops_notifier_stats` **and** `ops_sweep_cursor`, with the latter marked as durable sweep progress rather than a heartbeat and the drop consequence stated; and a Common Gotchas bullet names the two levers, the no-cadence default in its precise **"attempted once per occurrence"** form, and the KPR-455 sequencing constraint.

```typescript
describe("AC17 — documentation", () => {
  const claude = readFileSync(join(here, "..", "..", "CLAUDE.md"), "utf8");
  it("documents both collections, both telemetry kinds and the operator-facing defaults", () => {
    expect(claude).toContain("ops_notifications");
    expect(claude).toContain("ops_policy");
    expect(claude).toContain("ops_notifier_stats");
    expect(claude).toContain("ops_sweep_cursor");
    expect(claude).toMatch(/attempted[^.]*once per occurrence/i);
    expect(claude).toContain("KPR-455");
  });
});
```

- [ ] **Step 11:** Full verification and commit.

```bash
node --version                       # expect v22.x or v24.x
npx vitest run src/ops
npx vitest run src/boot-order.test.ts
npx vitest run src/obligations src/slack
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
git diff --check
```

Expected: exit 0 throughout, no skipped new contract cases, seventeen `describe` blocks each with at least one real `it`. **Record actual totals; do not invent expected test counts.**

Confirm in the implementation report that **all six ⛳ negative-verify mutations were run**, with the observed failures compared against the predictions written above. A mutation nobody has confirmed crosses a boundary is not evidence, and a prediction that did not hold is a finding worth reporting whether or not the test is green.

```bash
git add src/ops/notifier-isolation.test.ts src/ops/notifier-acceptance.integration.test.ts
git commit -m "$(cat <<'EOF'
test(KPR-468): AC1–AC17 acceptance suite

Seventeen named criteria, plus AC2's structural scans (the notifier never
imports the match evaluator, is imported by no turn-path module, and
imports nothing from src/obligations/).

Six able-to-fail cases carry a negative-verify obligation and all six were
run: the apply-if-strictly-newer watermark (predicted 4 for the
unconditional variant, 3 for the half-strengthened one), the clearing
fan-out's scope and its same-producer clause, the three-armed scan's
starvation immunity, the never-unset nextNudgeAt rule, and intake's
lastAckAt monotonicity guard with its principalAt-anchor pair.

AC13 asserts the two containment rules SEPARATELY — a single per-row
continue implementation passes the delivery limb and silently loses
events on ingest — with three ingest limbs including the two-tick wedge
signature that pins D8(b)'s no-automatic-skip ruling.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
