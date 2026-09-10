# KPR-455 chunk 4b — Acceptance suite, continued

**Task 4 of 5, continued.** Read [the plan index](kpr-455-plan.md) and all eight chunk files before starting. **This chunk continues chunk 4's task: chunks 4 and 4b are ONE task and ONE commit**, and the commit block is at the end of this file. Read [chunk 4](kpr-455-plan-4-acceptance.md) first — the file this chunk appends to is created there, and every fixture these steps use (`ready`, `view`, `fixedClock`, `seedEvent`, `collectKeys`) is defined in its Step 1.

**Files**

- Modify: `src/cli/ops.integration.test.ts` — append AC10, AC11 and AC14
- Read-only: `src/ops/testing/fake-db.ts`, `src/ops/testing/notifier-harness.ts`, `src/cli/testing/ops-cli-fixtures.ts` (chunk 2b)

**Tier: `capable`.** AC10 is here, and it is the criterion the spec asks a reviewer to press hardest: it drives the edge against KPR-468's **real** intake and its real CAS across two notifier instances over one database, and it is the criterion most able to go green while asserting nothing.

---

## Task 4: the criteria, continued

- [ ] **Step 9:** Append AC10, AC11 and AC14, then run NV2 and NV3.

```typescript
describe("AC10 — intake reached across processes, against the REAL CAS", () => {
  /**
   * ONE LEDGER ROW, because one is all this criterion needs — NOT because a
   * second would break it. MEASURED at this tree (mongodb 7.6.0): `predicate`
   * routes an `ObjectId` expected-value to `same()`
   * (src/obligations/testing/fake-db.ts:23-27, copied into the ops double), and
   * `same()`'s object branch compares enumerable own keys — an ObjectId's are
   * `["buffer"]`, a `Uint8Array` compared elementwise — so `same(a, b)` is
   * `false` for two distinct ids and `true` for two spellings of one. A
   * `{ _id: X }` filter DISCRIMINATES correctly, and a second subscription or a
   * second event is a legitimate (and stronger) fixture for a later case. The
   * only thing that would need widening first is the `[...rows.values()][0]`
   * read in the case below, which assumes a single row rather than resolving
   * the handle.
   */
  async function ledgerRow() {
    const h = await harness({ subscriptions: [sub("s1")] });
    const event = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", event.dedupeKey);
    const handle = String(row._id);
    // ⚠ The gate that keeps this criterion from going green while asserting
    // nothing: intake resolves a handle through parseHandle, which admits ONLY
    // a 24-character ObjectId-valid hex string that round-trips
    // (kpr-468-plan-4-intake.md:78-82). Against a degraded `_id` — a `copy`
    // that is bare structuredClone, i.e. KPR-468's fake-db extension (f)
    // missing — this is "[object Object]", every accept below returns
    // `refused: "unknown-handle"`, and the CAS this test exists to prove is
    // never reached.
    expect(handle).toMatch(/^[0-9a-f]{24}$/);
    return { h, handle };
  }

  /** Moves the CAS precondition out from under intake, `times` times: an
   *  after-hook on the ledger's own findOne flips `state` between the two
   *  working values, so the row intake READ is not the row it writes against. */
  function jostle(db: FakeDb, times: number): void {
    for (let i = 0; i < times; i += 1) {
      const gate = db.pause("ops_notifications", "findOne", () => true, true);
      void gate.reached.then(() => {
        const rows = db.collection("ops_notifications").rows;
        for (const [id, row] of rows) rows.set(id, { ...row, state: row.state === "pending" ? "delivered" : "pending" });
        gate.release();
      });
    }
  }

  it("returns unavailable after exactly one retry inside intake, with no partial write", async () => {
    const { h, handle } = await ledgerRow();
    const before = h.db.operations.filter((o) => o.collection === "ops_notifications" && o.operation === "updateOne").length;
    jostle(h.db, 2);
    const outcome = await h.notifier.accept({ handle, act: "seen", actorId: "U1", at: NOW });
    expect(outcome).toEqual({ state: "unavailable" });
    const attempts =
      h.db.operations.filter((o) => o.collection === "ops_notifications" && o.operation === "updateOne").length - before;
    expect(attempts).toBe(2); // the first CAS plus intake's ONE retry
    const row = [...h.db.collection("ops_notifications").rows.values()][0]!;
    expect(row.lastAckKey).toBeUndefined();
    expect(row.lastAckAt).toBeUndefined();
    expect(["pending", "delivered"]).toContain(row.state);
    await h.notifier.stop();
  });

  it("the EDGE re-issues the identical tuple and the act lands once the interference stops", async () => {
    const { h, handle } = await ledgerRow();
    const f = fixture();
    stampSentinel(h.db, f.selection);
    jostle(h.db, 2); // consumes both findOnes of the edge's FIRST accept call
    const d = deps(h.db, f.selection, {
      clock: fixedClock(),
      // The second process: the CLI constructs KPR-468's OWN notifier against
      // the same database and calls accept(...) on it. Not the singleton — that
      // lives in the engine.
      makeNotifier: (db, days) => new OpsNotifier(db, days),
    });
    const exit = await runOps(
      ["ops", "ack", handle, "--act", "seen", "--actor", "U1", "--config", f.path, "--json"],
      d,
    );
    const payload = JSON.parse(d.emitted.at(-1)!);
    expect(exit).toBe(0);
    expect(payload.result).toBe("applied");
    expect(payload.rowState).toBe("seen");
    expect(payload.attempts).toBe(2);
    await h.notifier.stop();
  });

  it("a landed first write makes the identical re-issue a noop, not a second transition", async () => {
    const { h, handle } = await ledgerRow();
    const applied = await h.notifier.accept({ handle, act: "seen", actorId: "U1", at: NOW });
    expect(applied).toMatchObject({ state: "applied", rowState: "seen" });
    const f = fixture();
    stampSentinel(h.db, f.selection);
    const d = deps(h.db, f.selection, { clock: fixedClock(), makeNotifier: (db, days) => new OpsNotifier(db, days) });
    const exit = await runOps(["ops", "ack", handle, "--act", "seen", "--actor", "U1", "--config", f.path, "--json"], d);
    const payload = JSON.parse(d.emitted.at(-1)!);
    expect(exit).toBe(0);
    expect(payload).toMatchObject({ result: "noop", reason: "already-applied", confirmed: true });
    await h.notifier.stop();
  });

  it("a REAL notifier on an EMPTY ledger refuses unknown-handle — never unavailable — and its init() materialises the collection", async () => {
    // Spec edge case 2, and the critical flow the plan index names: `hive ops
    // ack` on an instance where KPR-468 has never run. init() creates
    // `ops_notifications` and its indexes — the sibling's schema, by the
    // sibling's own idempotent code — the handle then resolves to nothing, and
    // the answer distinguishes "your handle is wrong" from "intake is dead". A
    // cold instance must NEVER read as `unavailable`. This is the only case in
    // the plan that drives KPR-468's real intake against an EMPTY ledger; every
    // other real-notifier case above runs against a seeded row.
    const { f, db } = await ready();
    const before = db.operations.length;
    const d = deps(db, f.selection, {
      clock: fixedClock(),
      makeNotifier: (client, days) => new OpsNotifier(client, days),
    });
    const exit = await runOps(
      ["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1", "--config", f.path, "--json"],
      d,
    );
    const payload = JSON.parse(d.emitted.at(-1)!);
    expect(exit).toBe(1);
    expect(payload).toMatchObject({ result: "refused", reason: "unknown-handle" });
    expect(payload.result).not.toBe("unavailable");
    // A refusal is terminal: the retry budget is spent only on `unavailable`.
    expect(payload.attempts).toBe(1);
    // init() ran on a cold database and created the ledger's own indexes.
    const created = db.operations
      .slice(before)
      .filter((o) => o.operation === "createIndex" && o.collection === "ops_notifications");
    expect(created.length).toBeGreaterThan(0);
  });
});

describe("AC11 — ten distinguishable outcomes, their exit codes and one JSON document", () => {
  const HANDLE = "65a1b2c3d4e5f60718293a4b";
  const outcomes: Array<[string, Parameters<ProgrammedNotifier["accept"]> extends never ? never : any, number, (p: any) => void]> = [
    ["applied", { state: "applied", rowState: "seen" }, 0, (p) => expect(p.rowState).toBe("seen")],
    ["noop/already-applied", { state: "noop", reason: "already-applied" }, 0, (p) => expect(p.reason).toBe("already-applied")],
    ["noop/superseded", { state: "noop", reason: "superseded" }, 0, (p) => expect(p.reason).toBe("superseded")],
    ["refused/unknown-handle", { state: "refused", reason: "unknown-handle" }, 1, (p) => expect(p.reason).toBe("unknown-handle")],
    ["refused/unattributed", { state: "refused", reason: "unattributed" }, 1, (p) => expect(p.reason).toBe("unattributed")],
    ["refused/row-cleared", { state: "refused", reason: "row-cleared" }, 0, (p) => expect(p.benign).toBe(true)],
    ["refused/integrity-dismissal", { state: "refused", reason: "integrity-dismissal" }, 1, (p) => expect(p.reason).toBe("integrity-dismissal")],
    ["refused/snooze-not-future", { state: "refused", reason: "snooze-not-future" }, 1, (p) => expect(p.reason).toBe("snooze-not-future")],
    ["refused/illegal-transition", { state: "refused", reason: "illegal-transition" }, 1, (p) => expect(p.reason).toBe("illegal-transition")],
    ["unavailable", { state: "unavailable" }, 1, (p) => expect(p.confirmed).toBe(false)],
  ];

  it.each(outcomes)("renders %s with the contract token verbatim and the right exit code", async (name, outcome, exit, extra) => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([outcome]);
    const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
    const actual = await runOps(
      ["ops", "ack", HANDLE, "--act", "seen", "--actor", "U1", "--config", f.path, "--json"],
      d,
    );
    expect(actual).toBe(exit);
    expect(d.emitted).toHaveLength(1);
    const payload = JSON.parse(d.emitted[0]!);
    extra(payload);
    // The contract token is DATA in the payload, never a thrown message that
    // src/cli.ts:178's /^[a-z_]+$/ guard would swallow.
    if (outcome.reason) expect(JSON.stringify(payload)).toContain(outcome.reason);
  });

  it("counts ten outcomes, which is what the union actually has", () => {
    expect(outcomes).toHaveLength(10);
  });

  it("unavailable renders as UNKNOWN with the act, handle and fixed at", async () => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([{ state: "unavailable" }]);
    // ⚠ A MOVING CLOCK, not `fixedClock()`, and NV7 is why: under a fixed clock
    // every read returns NOW, the rendered `at` is unchanged whether it was
    // minted once or re-minted per attempt, and this case CANNOT go red for
    // that mutation. `steppingClock()`'s start is NOW by construction (both are
    // 2026-01-10T12:00:00.000Z — keep them equal), so the assertion below still
    // reads NOW under the correct implementation and reads the third attempt's
    // instant under the mutation.
    const d = deps(db, f.selection, { clock: steppingClock(), makeNotifier: () => notifier });
    const exit = await runOps(
      ["ops", "ack", HANDLE, "--act", "seen", "--actor", "U1", "--config", f.path, "--json"],
      d,
    );
    const payload = JSON.parse(d.emitted[0]!);
    expect(exit).toBe(1);
    expect(payload.message).toContain("UNKNOWN");
    expect(payload.message).toContain("MAY have applied");
    expect(payload.message).toContain("NOT CONFIRMED");
    expect(payload.at).toBe(NOW.toISOString());
    expect(payload.handle).toBe(HANDLE);
    expect(payload.act).toBe("seen");
  });
});

describe("AC14 — the doctor section is informational and complete", () => {
  it("is re-driven in full by src/cli/ops-doctor.test.ts, and pinned here on the two properties that matter", async () => {
    const { renderOpsPipelineSection, OPS_PIPELINE_SECTION_TITLE } = await import("./doctor.js");
    // (1) It returns nothing, so no caller can route it into allPassed.
    expect(renderOpsPipelineSection(null, 90, () => {})).toBeUndefined();
    // (2) The config-not-loaded else-branch prints the SAME title the renderer
    //     does — the entry a new section reliably forgets.
    const doctor = readFileSync("src/cli/doctor.ts", "utf8");
    expect(doctor.split("OPS_PIPELINE_SECTION_TITLE").length - 1).toBeGreaterThanOrEqual(3);
    expect(OPS_PIPELINE_SECTION_TITLE.length).toBeGreaterThan(0);
  });
});
```

**NV2 — the class-legality switch.** Replace `clearingIsLegal`'s `switch` body with `return condition.class !== "informational";`, then run `npx vitest run src/cli/ops.integration.test.ts -t "AC16"`.

**Predicted failure — exactly three of AC16's six cases red:** `judgment: cleared only with evidence, open with none` (the zero-evidence half reports `[]` where one row was expected), `integrity: cleared only with evidence, open with none` (same), and `an unrecognized class stays OPEN and renders class: unknown` (`rows` is `[]`, so the `toHaveLength(1)` fails before the `toMatchObject`). **Predicted green:** the `resource` case and the `informational` case (the mutation agrees with the rule on both) and — the prediction that separates NV2 from NV3 — `a clearing fact from a DIFFERENT producer does not clear`, because the producer test sits ABOVE the switch and this mutation does not touch it.

**Restore**, re-run, then **NV3 — the same-producer clause.** Delete `if (clearing.producer !== condition.producer) return false;` and run the same command.

**Predicted failure — exactly one case red:** `AC16 › a clearing fact from a DIFFERENT producer does not clear`, with `rows` reporting `[]`. **Predicted green: every other AC16 case**, including the two evidence cases the deleted clause is `&&`-ed with — dropping one conjunct of a passing test leaves it passing.

**Restore** and re-run before committing.

- [ ] **Step 10:** Verify the whole suite.

```bash
npx tsc --noEmit
npx vitest run src/cli/ops.integration.test.ts
npx vitest run src/cli src/ops
npx vitest run src/boot-order.test.ts
npx prettier --check src/cli/ops.integration.test.ts
npx eslint src/cli/ops.integration.test.ts
```

**Expected:** `tsc` exits 0. The acceptance file passes with **fifteen criterion `describe` blocks** (AC1–AC14 and AC16; AC15 lands in chunk 5), zero skipped. `src/cli` and `src/ops` pass entire — the second is the standing evidence that this child changed neither sibling's behaviour through the shared doubles. `boot-order.test.ts` passes unchanged. Record actual test counts; do not invent them.

- [ ] **Step 11:** Commit.

```bash
git add src/cli/ops.integration.test.ts
git commit -m "$(cat <<'EOF'
test(KPR-455): AC1–AC16 acceptance suite

Fifteen criterion blocks (AC15 lands with the docs commit, since its assertion
is about a file Task 5 writes). AC10 is the one to read first: it drives the
edge against KPR-468's REAL intake and its real CAS across two notifier
instances over one database — a moved precondition returns unavailable after
exactly one retry inside intake with no partial write, the edge re-issues the
identical tuple, and a landed first write makes that re-issue a noop. It guards
itself with a handle-shape assertion, without which a degraded `_id` in the
shared double would make the whole criterion green while asserting nothing.

Six of the plan's nine negative-verify points are confirmed here (NV1–NV7 less
NV8/NV9, which run in chunks 2 and 3).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
