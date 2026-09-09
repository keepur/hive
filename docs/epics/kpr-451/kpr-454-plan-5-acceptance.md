# KPR-454 plan — chunk 5: the AC1–AC16 acceptance suite

One task, one commit. Every criterion in the spec's "Conformance and acceptance criteria" section becomes a **named test**, not a paraphrase. Several of them specify exact scenarios that must be **driven** rather than asserted in prose — AC3's reject-vs-omit pinning, AC8's negative-verify with a throwing publisher, AC9's `R1 · F · R2` interleaving, AC13's boot-order anchors, AC15's outcome-published-never-inferred — and those are called out per case below.

Some criteria are already covered by earlier tasks (AC4 by Task 1, AC12/AC11/AC8 partly by Task 5, AC13/AC14 by Task 6). Where that is so, this task adds the AC-numbered `describe` that **references** the existing case rather than duplicating it, so the suite reads as a complete map from criterion to test and a reviewer can check coverage in one file.

---

### Task 7: `src/ops/acceptance.integration.test.ts`

**Files:**
- Create: `src/ops/acceptance.integration.test.ts`

Structure the file as sixteen `describe` blocks named `AC1 (C1, C4) — …` through `AC16 (C16) — …`, in order.

- [ ] **Step 1:** AC1–AC3 — the envelope, the zero-match fact, and reject-versus-omit.

**AC1 (C1, C4) — the exact stored key set.**

```typescript
it("stores exactly D9's key set and nothing else", async () => {
  // …publish one tool-failed…
  const doc = await db.collection("ops_events").findOne({});
  expect(Object.keys(doc!).sort()).toEqual([
    "_id", "class", "dedupeKey", "detail", "evidence", "generation",
    "matchedSubscriptionIds", "matchedSubscriptions", "producer", "publishedAt",
    "reasonId", "retry", "schemaVersion", "subject", "waiting",
  ]);
  expect(doc!.schemaVersion).toBe(1);
  expect(doc!.publishedAt).toBeInstanceOf(Date);
  // C1/D2's explicitly-absent list, asserted by exclusion above AND named
  // here so a reviewer sees the intent:
  for (const forbidden of ["owner", "escalatedTo", "assignee", "severity", "loudness", "priority", "destination", "channel", "recipient"]) {
    expect(doc).not.toHaveProperty(forbidden);
  }
});

it("stamps class and retry from the registry row, and the observe API cannot supply them", () => {
  // Structural half of C4: OpsPublishInput has no `class`/`retry` field.
  // Assert at the type level via a compile-time expectTypeOf, and at runtime
  // by publishing with an input object carrying a stray `class` and asserting
  // the stored value equals the ROW's, not the input's.
});

it("carries clears/clearsFamily on a tool-recovered and neither on a tool-failed", () => { /* … */ });

it("pins evidence CONTENTS, not merely its presence (D6)", () => {
  // [{kind:"workItem", id}] on a failure carrying a work item;
  // [] on a failure without one;
  // [] on every tool-recovered.
  // `evidence` is ALWAYS present — [] is written, never omitted — so this
  // assertion is unconditional and `clears`/`clearsFamily` remain the only
  // genuinely conditional pair.
});
```

**AC2 (C2, C3) — zero-match is a fact.**

```typescript
it("with ops_subscriptions empty, stores exactly one document with matchedSubscriptions: 0", async () => { /* … */ });
it("the zero-match document is byte-identical in SHAPE to a matched one", async () => {
  // Publish once with no subscriptions and once with one matching row;
  // compare Object.keys() and every field except matchedSubscription*.
});
it("writes no ledger row and creates no catch-all subscription on any code path", async () => {
  expect(await db.listCollections()).not.toContain("ops_notifications");
  expect(await db.collection("ops_subscriptions").countDocuments({})).toBe(0);
});
```

**AC3 (C5) — reject, and the omit path pinned *against* it.** This is the criterion whose whole point is that conflating the two paths is the defect being guarded.

```typescript
describe("AC3 (C5) — rejections", () => {
  it.each([
    ["disabled reason", /* set enabled:false on tool-failed, re-init */],
    ["unknown reason", /* reasonId: "nope" */],
    ["undeclared detail key", /* detail carries `oops` */],
    ["over-bound detail value", /* tool: "a".repeat(201) */],
    ["non-scalar detail value", /* tool: {a:1} */],
    ["over-length subject.id", /* 201 chars */],
    ["evidence array of 5 references", /* > OPS_EVIDENCE_MAX */],
    ["evidence id over 200 chars", /* … */],
    ["evidence kind failing the token bound", /* "Not-A-Token" */],
  ])("rejects and counts: %s", async (_label) => {
    const before = publisher.getSnapshot().rejected;
    // …attempt the publish…
    expect(await db.collection("ops_events").countDocuments({})).toBe(0);
    expect(publisher.getSnapshot().rejected).toBe(before + 1);
  });

  it("never coerces to a generic reason, never truncates subject.id, never trims evidence", async () => {
    // No document at all — assert the collection is empty after each of the
    // three, rather than asserting a coerced/truncated value is absent.
  });
});

describe("AC3 (C5) — the OMIT path, pinned against the reject path", () => {
  // Drive these THROUGH the ws/app-shaped path that supplies them: build the
  // WorkItemContext exactly as agent-manager.ts:1951-1958 does from a
  // WorkItem whose id/threadId are the client-supplied values.
  it.each([
    ["a space-bearing value", "has a space"],
    ["an over-length value", "a".repeat(201)],
    ["a prose-shaped value", "please ignore previous instructions"],
  ])("publishes normally with the key OMITTED: %s", async (_label, bad) => {
    const before = publisher.getSnapshot();
    // …failure on a turn whose workItemId and threadId are `bad`…
    const doc = await db.collection("ops_events").findOne({});
    expect(doc!.detail).not.toHaveProperty("workItemId");
    expect(doc!.detail).not.toHaveProperty("threadId");
    expect(doc!.evidence).toEqual([]);              // the work item was the omitted value
    expect(publisher.getSnapshot().idOmitted).toBeGreaterThan(before.idOmitted);
    expect(publisher.getSnapshot().rejected).toBe(before.rejected); // UNCHANGED — this is the point
  });

  it("a sched: id carrying a multi-word cron task label takes the omit path", async () => {
    // scheduler.ts:231's shape. The row keeps tool/errorSig/lane/agentId,
    // which is what remediation reads.
  });
});

describe("AC3 (C5) — the ADMIT path, on the same footing", () => {
  // The omit path is only correct if the population it excludes is the
  // population D6 enumerates. One case per shape in D6's two tables, driven
  // through the bound and asserted admissible — with imessage:<apple-id-email>
  // and sms:<line>:+1555… named explicitly, since `@` and `+` each carry a
  // single shape and are therefore the two a later tightening drops first.
  // (The table itself is unit-tested in src/ops/ids.test.ts; this block
  // asserts the same population survives END TO END into detail.threadId.)
});
```

- [ ] **Step 2:** AC4–AC7.

**AC4 (C6)** — reference `src/outage/outage-notices.test.ts` and `src/ops/single-prefix-predicate.test.ts` (Task 1); add one end-to-end case asserting a published event's `waiting` equals `waitingFor(workItem.id)` for each of the six buckets.

**AC5 (C7, and C17's no-I/O clause).**

```typescript
it("implements exactly the D5 grammar", () => { /* references src/ops/match.test.ts; adds an end-to-end match */ });

it("match evaluation performs NO I/O", async () => {
  // C17's other half, PINNED rather than asserted in prose: load a
  // subscription set into the publisher, then swap the Db handle for the
  // throwing variant, and evaluate. The match must return its result with the
  // handle untouched.
  //
  // Practical shape: call the exported evaluateMatches directly with the
  // loaded set — it takes no Db — AND assert structurally that match.ts
  // imports nothing from mongodb or from ./store.js:
  const source = readFileSync(new URL("./match.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from "mongodb"|from "\.\/store\.js"/);
});

it("loads the subscription set from the COLLECTION, not from a fixture constant", async () => {
  // AC16 leans on this: insert a row, reload, and assert the matcher sees it.
});
```

**AC6 (C13) — nothing but tokens.**

```typescript
it("no substring of a token-shaped or path-shaped error reaches the document", async () => {
  const nasty = "auth failed for sk-ant-api03-DEADBEEFCAFE at /Users/mokie/services/hive/.env";
  // …drive a failure whose error text is `nasty`…
  const serialized = JSON.stringify(await db.collection("ops_events").findOne({}));
  for (const fragment of ["sk-ant", "DEADBEEF", "/Users/mokie", ".env"]) {
    expect(serialized).not.toContain(fragment);
  }
});

it("covers the untrusted-id path — where C13 was not previously true by construction", async () => {
  // A failure on a turn whose ws/app-supplied workItemId and threadId carry
  // prose: no substring of either appears anywhere in the document. The key
  // is OMITTED rather than stored under a length bound.
});

it("stores no tool_input, tool_response, raw Error, stack, URL or path", async () => {
  // Structural: the detail key set of both rows is closed and neither
  // declares such a key; the observe API has no parameter for one. Assert the
  // published detail's keys are a subset of the row's detailKeys.
});
```

**AC7 (C14) — the ops path publishes nothing about itself.**

```typescript
it("a publish fault, rejection or overflow produces a log line and a counter and NO document", async () => { /* … */ });
it("no code path in this diff spawns a turn", () => {
  // Structural scan over src/ops/**: no runWorkItemTurn, no spawnTurn, no
  // dispatch(, no agentManager import.
  for (const file of globSync("src/ops/**/*.ts", { cwd: root })) {
    if (file.endsWith(".test.ts")) continue;
    const s = readFileSync(`${root}/${file}`, "utf8");
    for (const forbidden of ["runWorkItemTurn", "spawnTurn", "agent-manager", "dispatcher"]) {
      expect(s, `${file} references ${forbidden}`).not.toContain(forbidden);
    }
  }
});
```

- [ ] **Step 3:** AC8–AC10 — containment, the epoch rule, and clearing legality. These three carry the driven scenarios.

**AC8 (C15) — negative-verify, both faults, both lanes.**

```typescript
it("a throwing publisher leaves a Claude-lane RunResult byte-identical", async () => { /* … */ });
it("a throwing publisher leaves a Lane B RunResult byte-identical", async () => { /* … */ });
it("a publisher whose Mongo write always rejects does the same on both lanes", async () => { /* … */ });
it("the turn's own error/abort classification is unchanged", async () => {
  // Assert the RunResult's error/aborted/timedOut fields, not just its text —
  // KPR-398's observed-progress classification runs downstream of these
  // fields and a shifted classification would move a turn between the
  // breaker-trips and breaker-inconclusive rows.
});
```
Negative-verify (required, recorded in the implementation report): delete the `try` from `observeToolFailure`, confirm the Lane B case fails, restore.

**AC9 (C18) — the epoch rule, including the interleaving.**

```typescript
it("a repeated identical failure leaves generation unchanged and appends a second event", async () => { /* … */ });

it("failure -> success -> failure advances generation by exactly one, with exactly one tool-recovered between", async () => {
  // The recovery carries waiting:"nobody" and generation:0 and does NOT run
  // the epoch resolver (D9 step 5) — assert the resolver's read count is
  // unchanged across the recovery.
});

it("two successive recoveries share a dedupeKey, and a third failure's generation is unaffected by how many preceded it", async () => { /* … */ });

it("a burst of N successes before the recovery drains yields one tool-recovered and N-1 recoveryCoalesced", async () => { /* … */ });

it("R1 · F · R2 — the superseded recovery is dropped, not published", async () => {
  // D8's EXACT interleaving. Drive it by holding the drainer: enqueue R1 from
  // a success whose map read happened first, then F, then R2 carrying the
  // stale openSeq, and release.
  //
  //   queue:  R1{clears:K0, openSeq:7}   F3   R2{clears:K0, openSeq:7}
  //   drain:  R1 -> accept; clearing fact for K0; entry removed
  //           F3 -> resolver sees that clearing as more recent -> generation 1;
  //                 entry CREATED at openSeq 8, dedupeKey K1
  //           R2 -> entry.openSeq (8) !== job.openSeq (7) -> DROP
  //
  // Four assertions, one per harm the identity check prevents:
  expect(clearingFactsNaming("K0")).toHaveLength(1);      // not two; no second clearing fact for the dead key
  expect(publisher.getSnapshot().recoverySuperseded).toBe(1);
  expect(openEntryFor(family)?.openSeq).toBe(8);          // the LIVE entry survives the drop
  // a following plain repeat leaves generation unchanged (no C18 flood)
  // the next success on that tool STILL enqueues a recovery (no permanent silence)
});

it("a recovery job whose publish faults leaves the family open, so the next success re-enqueues", async () => { /* … */ });

it("a success with no open condition performs no database access at all", async () => {
  // Against the throwing-db variant.
});
```
Negative-verify (required): change the drainer's identity test to a bare `this.open.has(job.family)` and confirm the `R1 · F · R2` case fails on at least the `recoverySuperseded` and surviving-entry assertions. Restore.

**AC10 (C19) — clearing provenance.**

```typescript
it("tool-recovered carries clears and clearsFamily", async () => { /* … */ });
it("a clears published under tool-failed is rejected", async () => {
  // tool-failed declares no clearsReasonIds.
});
it("a clears naming a reason outside the declared list is rejected", async () => { /* … */ });
it("the boot gate refuses to leave tool-failed enabled if no registered row clears it", () => {
  // References src/ops/reasons.test.ts; asserted here at the init() boundary
  // too, so the criterion has an integration-level home.
});
```

- [ ] **Step 4:** AC11–AC16.

**AC11 (lane parity)** — references Task 5's case; add the long-name variant explicitly (a name past the Lane B sanitization threshold must still yield the canonical `subject.id` on both lanes).

**AC12 (abort discipline)** — references Task 5's cases; assert here that own-abort publishes nothing **on either lane**, a foreign interrupt publishes `errorSig: "interrupted"`, and a guardrail deny publishes nothing.

**AC13 (boot order, boot survival, hook placement)** — references `src/boot-order.test.ts` (Task 6) for the three lists and the no-`.start(` case; adds here:

```typescript
it("with the publisher unset, both capture points are no-ops and no turn is affected", async () => { /* … */ });
it("an init() whose every createIndex rejects still yields a wired, publishing publisher", async () => { /* … */ });
it("an init() whose registry upsert rejects throws, so index.ts leaves the publisher unset", async () => { /* … */ });
it("a thrown archetype build still leaves both observers registered", () => { /* references Task 5 */ });
it("a thrown observer registration still leaves the fail-closed deny-all matcher installed", () => { /* … */ });
```

**AC14 (documentation)** — a text assertion over `CLAUDE.md`, so the doc cannot silently drift out:

```typescript
it("CLAUDE.md's engine-written collections list names all three collections", () => {
  const md = readFileSync(new URL("../../CLAUDE.md", import.meta.url), "utf8");
  for (const name of ["ops_events", "ops_subscriptions", "ops_reasons"]) {
    expect(md).toContain(name);
  }
  // and NOT ops_notifications — that is KPR-468's, per D12's boot-order split.
  expect(md).not.toContain("ops_notifications");
});
```

**AC15 (C12) — outcome is published, never inferred.**

```typescript
it("a successful tool call publishes no tool-failed regardless of duration or turn cost", async () => {
  // Drive a success with a very long duration_ms and a turn whose costUsd is
  // 0 (the literal every Lane B turn returns — turn-scaffold.ts:353, the
  // measurement that invalidated the brief's proposed oracle).
});

it("PostToolUse publishes only tool-recovered, and only when the map holds an open condition", async () => { /* … */ });

it("no code path in this diff reads costUsd, a duration threshold, or a tool_response to decide failure", () => {
  // Structural, over src/ops/**/*.ts plus the two capture-point hunks:
  for (const s of opsSources) {
    expect(s).not.toContain("costUsd");
    expect(s).not.toContain("tool_response");
  }
  // durationMs is READ (it is a declared detail key) but never COMPARED —
  // assert no relational operator appears against it in src/ops/**.
});

it("activity_log is neither read nor written here", () => {
  for (const s of opsSources) expect(s).not.toContain("activity_log");
});
```

**AC16 (C16) — data, not an engine change.**

```typescript
it("a second reason and a second producer publish through the same accept path", async () => {
  // BOTH rows are inserted into ops_reasons BEFORE the publisher's init(),
  // since that is where the reason map is loaded and there is no reload (D5).
  await db.collection("ops_reasons").insertOne({
    _id: "hive-runtime:some-other-reason", producer: "hive-runtime", reasonId: "some-other-reason",
    class: "informational", retry: "transient", remediationTemplate: "none",
    detailKeys: [{ key: "thing", type: "string", maxLength: 40 }], enabled: true,
  });
  await db.collection("ops_reasons").insertOne({
    _id: "florist:bloom-stalled", producer: "florist", reasonId: "bloom-stalled",
    class: "informational", retry: "transient", remediationTemplate: "check {stage}",
    detailKeys: [{ key: "stage", type: "string", maxLength: 40 }], enabled: true,
  });
  await publisher.init();
  // …publish against both…
  // Each is STORED, stamped with ITS OWN row's class/retry, and validated
  // against ITS OWN detailKeys — with no edit to the envelope, the filter
  // grammar or the observe API.
});

it("producer and reasonId are validated by the D2 pattern bound, never against a hardcoded list", () => {
  // The only legitimate occurrence of the literal "hive-runtime" is in this
  // producer's own code-resident rows — never in a validator.
  const validators = ["src/ops/publisher.ts", "src/ops/ids.ts", "src/ops/match.ts"];
  for (const f of validators) {
    expect(readFileSync(`${root}/${f}`, "utf8"), `${f} hardcodes a producer`).not.toContain("hive-runtime");
  }
});

it("a subscriber is added by inserting a row and waiting one reload", async () => {
  await db.collection("ops_subscriptions").insertOne({ /* … */ });
  await publisher.reloadSubscriptions();
  // …publish…  matchedSubscriptions === 1, matchedSubscriptionIds === [id]
});
```

⚠ The `hive-runtime`-not-in-a-validator assertion is worth writing even though it looks trivial: it is the single cheapest guard against the most likely regression in this whole file, which is someone adding a fast-path `if (input.producer === "hive-runtime")` to the accept path.

- [ ] **Step 5:** Verify the whole suite and the full gate.

Run:
```
npx vitest run src/ops
npx vitest run src/outage src/boot-order.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
npm run check:bundle
git diff --check
```
Expected: exit 0 everywhere, no skipped new contract cases. Record actual test totals; do not invent them.

- [ ] **Step 6:** Commit.

```bash
git add src/ops/acceptance.integration.test.ts
git commit -m "test(KPR-454): AC1-AC16 acceptance suite

Sixteen named describe blocks, one per acceptance criterion, each mapped to a
KPR-458 criterion. The driven scenarios rather than asserted ones: AC3's omit
path pinned against the reject path with the rejection counter asserted
UNCHANGED, AC8's negative-verify with a throwing publisher and a rejecting
Mongo on both lanes, AC9's exact R1 · F · R2 interleaving with one assertion
per harm the openSeq identity check prevents, AC13's boot-survival postures,
AC15's structural proof that no path reads costUsd, a duration threshold or a
tool_response to decide failure, and AC16's second-producer row inserted
before init().

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Coverage map — criterion to test

For the plan reviewer, and for the implementer's final self-check.

| AC | KPR-458 criterion | Home |
| --- | --- | --- |
| AC1 | C1, C4 | `acceptance.integration.test.ts` |
| AC2 | C2, C3 | `acceptance.integration.test.ts` |
| AC3 | C5 | `acceptance.integration.test.ts` (reject + omit + admit), `ids.test.ts` (the bound itself) |
| AC4 | C6 | `outage-notices.test.ts` (Task 1), `single-prefix-predicate.test.ts` (Task 1), end-to-end `waiting` in `acceptance` |
| AC5 | C7, C17 | `match.test.ts`, `acceptance.integration.test.ts` (no-I/O) |
| AC6 | C13 | `error-tokens.test.ts` (classifier closure), `acceptance.integration.test.ts` (end-to-end + untrusted ids) |
| AC7 | C14 | `acceptance.integration.test.ts` (counters + structural no-turn-spawn scan) |
| AC8 | C15 | `capture-points.integration.test.ts` (Task 5), `acceptance.integration.test.ts` |
| AC9 | C18 | `publisher.integration.test.ts` (mechanism), `acceptance.integration.test.ts` (`R1 · F · R2`, bursts, faults) |
| AC10 | C19 | `reasons.test.ts` (gate), `acceptance.integration.test.ts` (publish-time legality) |
| AC11 | lane parity | `capture-points.integration.test.ts` (Task 5) + long-name variant in `acceptance` |
| AC12 | abort discipline | `capture-points.integration.test.ts` (Task 5), restated in `acceptance` |
| AC13 | boot order / survival / hook placement | `boot-order.test.ts` (Task 6), `capture-points.integration.test.ts`, `acceptance` |
| AC14 | documentation | `acceptance.integration.test.ts` (text assertion over `CLAUDE.md`) |
| AC15 | C12 | `acceptance.integration.test.ts` + Task 5 Step 6's probe (report, not CI) |
| AC16 | C16 | `acceptance.integration.test.ts` |
