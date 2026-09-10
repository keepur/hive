# KPR-454 plan — chunk 5: the AC1–AC16 acceptance suite

One task, one commit. Every criterion in the spec's "Conformance and acceptance criteria" section becomes a **named test**, not a paraphrase. Several of them specify exact scenarios that must be **driven** rather than asserted in prose — AC3's reject-vs-omit pinning, AC8's negative-verify with a throwing publisher, AC9's `R1 · F · R2` interleaving, AC13's boot-order anchors, AC15's outcome-published-never-inferred — and those are called out per case below.

Some criteria are already covered by earlier tasks (AC4 by Task 1, AC12/AC11/AC8 partly by Task 5, AC13/AC14 by Task 6). Where that is so, this task adds the AC-numbered `describe` that **references** the existing case rather than duplicating its specification — but a reference block still contains at least one real `it` that asserts here, driven through Task 5's exported harness. A `describe` whose body is prose is an empty suite, reports nothing, and round 1 found two of them (AC11 and AC12) plus one with no `it` at all (AC3's admit path).

---

### Task 7: `src/ops/acceptance.integration.test.ts`

**Files:**
- Create: `src/ops/acceptance.integration.test.ts`
- Imports (does not modify) `src/ops/testing/lane-harness.ts`, the plain module Task 5 creates — see "The shared lane harness" below

Structure the file as sixteen `describe` blocks named `AC1 (C1, C4) — …` through `AC16 (C16) — …`, in order. Every one of the sixteen is a real `describe` containing at least one real `it`; where a criterion's mechanism lives in another file this block holds a **reference case** that asserts something here, never a bare comment.

### Harness contract for this file — read before writing any case

**1. The drain barrier. Every publish→assert boundary in this file is `await publisher.__drainForTests()`.** `observeToolFailure` / `observeToolSuccess` are synchronous void calls, `enqueue()` fires `void this.drain()`, and roughly forty assertions below publish and then immediately read Mongo. Without the barrier they are racing the drainer and this suite — the one that decides whether the other four chunks are verified — is intermittently green, which is strictly worse than red. `stop()` is **not** a usable barrier: it sets `stopping`, so any publish later in the same scenario is silently dropped. The method is defined in chunk 3, Task 4, Step 3, beside `__openEntryForTests`.

**2. Open-condition entries are read with `publisher.__openEntryForTests(family)`.** `open` is private and `getSnapshot()` exposes only `openConditions: number`; this accessor (chunk 3, same step) is what makes AC9's live-entry assertion able to fail at all.

**3. Holding the drainer is `fakeDb.pause(collection, operation)`** — the `{reached, release}` shape copied from `src/obligations/testing/fake-db.ts:118` (chunk 3 Step 1). `await handle.reached` blocks until the drainer is inside that operation; `handle.release()` lets it continue. AC9's `R1 · F · R2` has no other construction.

**4. Counting reads is `fakeDb.operations`** — the log at `obligations/testing/fake-db.ts:73`, filtered by collection and operation name. Both "the resolver's read count is unchanged across the recovery" and "no database access at all" are assertions over this array, not over a spy.

**5. The repository-scan idiom** (`globSync` from `tinyglobby`, `root = fileURLToPath(new URL("../../", import.meta.url))`, `readFileSync`) is stated once in **chunk 1, Task 1, Step 5** — including that `root` ends with a slash, so every read here is `` `${root}${file}` `` and never `` `${root}/${file}` ``. Import it the same way there; both scans in this file (AC7, AC15) use it, and neither redefines `root`.

**6. The shared lane harness lives in a PLAIN MODULE, `src/ops/testing/lane-harness.ts`.** AC8, AC11 and AC12 need a real `AgentRunner` hook set and a real `ToolBridge`; Task 5 builds `buildClaudeLaneHarness(...)` and `buildLaneBHarness(...)` there (chunk 4, Files), and **both** this file and `capture-points.integration.test.ts` import from it. Neither test file imports the other.

⚠ **Do not "simplify" this by exporting from `capture-points.integration.test.ts`.** Measured on this tree (vitest 4.1.11): a consumer importing a `.test.ts` **re-registers that file's suites and file-scope hooks into the importer** — a probe showed the helper's own case running in both files, 3 tests across 2 files. Task 5's `beforeEach`/`vi.mock` would go active for this file's cases and the capture-point suite would run twice under different fixtures. The repository has **zero** cross-`.test.ts` imports, the established pattern is a plain module (`src/obligations/testing/{fake-db,harness,refusals}.ts`), and a plain module additionally gets `tsc --noEmit` coverage that `.test.ts` files do not. The point the earlier draft was right about stands: reconstructing a byte-identical `RunResult` baseline twice is the duplication that lets the two copies drift — one module, two importers.

**7. Two module-scope constants**, declared once at the top of the file rather than inside any `describe` — a `const` inside one `describe` is invisible to the others, and three of these blocks are in different `describe`s:

```typescript
const root = fileURLToPath(new URL("../../", import.meta.url)); // chunk 1 Step 5's idiom — ENDS WITH A SLASH
const opsSources = globSync("src/ops/**/*.ts", { cwd: root })
  // The PRODUCER's own sources: not the tests, and not the test doubles. The
  // `src/ops/testing/` exclusion is load-bearing, not tidiness — AC7 forbids
  // `dispatcher`/`agent-manager` and AC15 forbids `costUsd`/`tool_response`
  // in every file this list holds, and `lane-harness.ts` legitimately
  // constructs RunResult baselines mentioning them while driving real runner
  // machinery. Without the exclusion a correct harness fails a criterion it
  // was never about. (These scans constrain COMMENT text too — a bare word
  // written into a doc comment anywhere under `src/ops/**` trips them; chunk 3's
  // `stripGeneration` example is the first instance, which is why it uses a
  // neutral producer.)
  .filter((f) => !f.endsWith(".test.ts") && !f.replace(/\\/g, "/").startsWith("src/ops/testing/"))
  .map((f) => readFileSync(`${root}${f}`, "utf8"));
```

`opsSources` is read by AC2 (`ops_notifications`), AC7 (turn-spawn) and AC15 (`costUsd` / `tool_response` / `durationMs`).

**8. Per-test isolation.** A fresh `FakeDb` **and** a fresh `OpsPublisher` in `beforeEach`, and `__resetOpsPublisherForTests()` in `afterEach`. Roughly ten assertions below use a bare `findOne({})` with no filter and no sort, and many read absolute counter values (`rejected === 0`, `recoverySuperseded === 1`) rather than deltas — a document or a counter carried over from a prior case makes those pass or fail for the wrong reason, and `findOne({})` in particular will happily return a predecessor's row.

**9. The three drive helpers, named here because every table below uses them and none introduces them:** `failOnTurnWith({ workItemId, threadId, … })` drives one Claude-lane tool failure on a turn whose `WorkItemContext` is built exactly as `agent-manager.ts:1951-1958` does (it carries all 28 AC3 admit rows); `driveFailure(tool)` and `driveSuccess(tool)` are the bare failure/success pair AC9's interleavings are written in. Define all three once at module scope beside the constants above — **and with them the two names AC9's assertions read the publisher through**, which no other block introduces either:

```typescript
// The one family every AC9 case works in, built the way `observe.ts` builds it
// (chunk 3, Step 5) rather than hand-spelled — a hand-spelled family that
// drifts from the producer's own would make every AC9 entry assertion vacuous.
const family = familyOf({
  producer: HIVE_RUNTIME_PRODUCER,
  reasonId: REASON_TOOL_FAILED,
  subject: { kind: "tool", id: "Bash" },
});

// "How many clearing facts name this dedupeKey" — AC9's first assertion.
// ASYNC: it goes through the fake's `find`, which appends one
// `{collection: "ops_events", operation: "find"}` entry to `fakeDb.operations`,
// so call it after a case that asserts on `operations.length`, never inside
// one. Declared as an arrow reading the `beforeEach` binding, so it sees the
// fresh per-test `fakeDb` (harness contract item 8) and not a module-load copy.
const clearingFactsNaming = async (clears: string) =>
  fakeDb.collection("ops_events").find({ clears }).toArray();
```

`familyOf` imports from `./publisher.js`, `HIVE_RUNTIME_PRODUCER`/`REASON_TOOL_FAILED` from `./reasons.js` — the same modules chunk 3's `observe.ts` reads them from.

**10. `extractHunk(file, startMarker, endAnchor)` — the capture-point slicer AC15 reads through, declared here because AC15 is its only caller and nothing else introduces it.** It takes **two literal anchors, never one**. "From the marker to the end of the enclosing block" is not implementable under this plan's own rule — stated for the boot-order anchors and equally binding here — that *a brace has no stable textual form to search for, and an implementer left to find one will invent an anchor that reads green regardless*. So the end of each hunk is a **literal string that already exists in the target file**, verified at this tree:

| file | `startMarker` | `endAnchor` | verified |
| --- | --- | --- | --- |
| `src/agents/agent-runner.ts` | `"KPR-454 D2: runtime tool-failure observation"` | `"\n    return hooks;"` (four-space indent, the `buildHooks` tail chunk 4 Step 1 inserts above) | exactly **one** occurrence in the file today (`agent-runner.ts:1973`) |
| `src/agents/provider-adapters/tool-bridge.ts` | `"KPR-454 D3, the recovery half"` (precedes "the failure half" in the same catch/try pair — starting here covers BOTH Lane B insertions, not just the failure one) | `` "return `Tool execution failed (" `` — the last statement of the `catch` arm, which chunk 4 Step 4 leaves in place | exactly **one** occurrence of that literal (the `:302` comment mentions the phrase but not the `return`-plus-backtick prefix) |

Declare it at module scope beside the two constants of item 7 — it reads `root` from there:

```typescript
// Slice one KPR-454 insertion out of a capture-point module. TWO literal
// anchors: `agent-runner.ts` and `tool-bridge.ts` both legitimately mention
// the forbidden words elsewhere, so a whole-module scan would fail against
// correct code, and a "scan to the closing brace" would need an anchor that
// has no stable textual form. Both anchors are strings that exist in the
// tree; if either stops existing this throws rather than silently narrowing.
const extractHunk = (file: string, startMarker: string, endAnchor: string): string => {
  const source = readFileSync(`${root}${file}`, "utf8"); // item 7: `root` ENDS WITH A SLASH
  const start = source.indexOf(startMarker);
  expect(start, `${file}: start marker not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endAnchor, start);
  expect(end, `${file}: end anchor not found after the start marker`).toBeGreaterThan(start);
  const hunk = source.slice(start, end + endAnchor.length);
  // ABLE-TO-FAIL GUARDS, asserted HERE rather than at each call site so that
  // adding a third capture point cannot forget them. Without these, a hunk
  // that came back empty (anchors adjacent) or one that swallowed the whole
  // module would make every `not.toContain` in AC15 pass for the wrong
  // reason — the exact vacuous-green shape this whole harness contract
  // exists to prevent. 200 is comfortably below either real hunk (both run
  // past a kilobyte) and comfortably above any degenerate slice.
  expect(hunk.length, `${file}: hunk suspiciously short — anchors probably moved`).toBeGreaterThan(200);
  expect(hunk.length, `${file}: hunk is the whole module — end anchor is not bounding`).toBeLessThan(source.length);
  return hunk;
};
```

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

it("stamps class and retry from the registry row, and the observe API cannot supply them", async () => {
  // ⚠ NO `expectTypeOf`. A type assertion inside a `.test.ts` is INERT in
  // this repo: tsconfig.json excludes `src/**/*.test.ts` from `tsc --noEmit`
  // and vitest.config.ts enables no typecheck mode, so nothing in
  // `npm run check` ever evaluates it. It would read as a compile-time proof
  // and be worth exactly nothing. The runtime assertion below is the real
  // one, and it holds because chunk 3 builds `doc` field by field: a stray
  // `class` on the input has no path into the document.
  //
  // Both this case and AC3's non-scalar `{a:1}` detail value need a cast to
  // construct at all — `OpsPublishInput` has no `class` and `OpsDetail` is
  // `Record<string, string|number|boolean>` — so write
  // `publisher.enqueueFailure({ ...good, class: "integrity" } as unknown as OpsPublishInput)`.
  // The cast is the point: it demonstrates that a caller has to reach past
  // the type to even attempt this, which IS C4's structural half.
  publisher.enqueueFailure({ ...validInput, class: "integrity" } as unknown as OpsPublishInput);
  await publisher.__drainForTests();
  const doc = await db.collection("ops_events").findOne({});
  expect(doc!.class).toBe("resource");   // the tool-failed ROW's value
  expect(doc!.retry).toBe("transient");  // ditto
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
it("with ops_subscriptions empty, stores one document with matchedSubscriptions: 0 AND matchedSubscriptionIds: []", async () => {
  // BOTH fields. AC2 names the empty array as well as the zero, and the
  // count is derived from the array's length — so asserting only the count
  // leaves the field AC2 actually cares about unpinned.
  await publishOneFailure();
  await publisher.__drainForTests();
  const doc = await db.collection("ops_events").findOne({});
  expect(doc!.matchedSubscriptions).toBe(0);
  expect(doc!.matchedSubscriptionIds).toEqual([]);
});

it("the zero-match document is identical in SHAPE to a matched one", async () => {
  // Publish once with no subscriptions and once with one matching row.
  // Compare Object.keys(), then every field EXCEPT the named exclusions —
  // `_id` (minted per insert), `publishedAt` (a fresh Date per insert),
  // `generation` and `dedupeKey` (the second publish may sit in a later
  // epoch) and `matchedSubscriptions`/`matchedSubscriptionIds` (the variable
  // under test). "Every field except matchedSubscription*" as literally
  // written cannot pass; naming the exclusions is what makes this runnable.
  const SKIP = new Set(["_id", "publishedAt", "generation", "dedupeKey",
                        "matchedSubscriptions", "matchedSubscriptionIds"]);
  expect(Object.keys(zeroDoc).sort()).toEqual(Object.keys(matchedDoc).sort());
  for (const k of Object.keys(zeroDoc)) {
    if (SKIP.has(k)) continue;
    expect(zeroDoc[k], k).toEqual(matchedDoc[k]);
  }
});

it("writes no ledger row and creates no catch-all subscription on any code path", async () => {
  // `db.listCollections()` returns a CURSOR on the real driver and is not in
  // the fake's surface, so the earlier `expect(await db.listCollections())
  // .not.toContain(...)` could not run. Two assertions that can:
  //  (a) the fake's own collection map — nothing outside the three this
  //      producer owns was ever touched;
  expect([...fakeDb.collections.keys()].sort()).toEqual(["ops_events", "ops_reasons", "ops_subscriptions"]);
  //  (b) a source scan proving this diff contains no such collection name at
  //      all. This is the durable half: it survives a refactor that stops
  //      exercising a code path in this test.
  for (const s of opsSources) expect(s).not.toContain("ops_notifications");
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
    // ⚠ THE BARRIER IS REQUIRED HERE, and this is the one sketch in the file
    // where omitting it makes the test PASS rather than fail. Both assertions
    // below read state the DRAINER produces — the rejection is counted inside
    // accept(), which runs on the drain — so read before the drain, the count
    // assertion is vacuously true (nothing has been inserted yet either way)
    // and the counter assertion flakes. Harness contract item 1 states the
    // global rule; this is the sketch that gets copied.
    await publisher.__drainForTests();
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
    await publisher.__drainForTests();   // required — see the reject block above
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
  // population D6 enumerates, so this block is an `it.each` over the case
  // table, NOT prose. Round 1 found it as a `describe` with no `it` at all —
  // an empty suite naming two shapes and leaving the other ~26 to be
  // re-derived from the design at the keyboard, which is precisely the
  // sweep-versus-rule failure D6 spent four spec-review rounds eliminating.
  //
  // src/ops/ids.test.ts pins the BOUND over this same population. This block
  // pins that the population survives END TO END into detail.threadId /
  // detail.workItemId, driven through the ws/app-shaped WorkItemContext
  // construction at agent-manager.ts:1951-1958.

  // D6 table 1 — work-item id shapes. `admissible: false` rows are the two
  // deliberate sched:/scheduler: exclusions, asserted here so the tables stay
  // one population rather than two lists.
  const WORK_ITEM_IDS: ReadonlyArray<[label: string, id: string, admissible: boolean]> = [
    ["slack ts", "1725465600.123456", true],
    ["imessage row", "imsg-4471", true],
    ["quo message id", "MSG_01HQ8Z9", true],
    ["randomUUID (ws/voice fallback)", "3f2a1b7c-9d4e-4f8a-bc12-0e5d6a7b8c9d", true],
    ["callback", "callback:65a1b2c3d4e5f60718293a4b", true],
    ["event", "event:65a1b2c3d4e5f60718293a4b:agent-a", true],
    ["team", "team-65a1b2c3d4e5f60718293a4b", true],
    ["worker", "worker:65a1b2c3d4e5f60718293a4b", true],
    ["meeting", "meeting:bot_9912:1725465600000", true],
    ["code-task completion", "ct:65a1b2:done:1725465600000", true],
    ["bg-task completion", "bg:65a1b2:done:1725465600000", true],
    ["first boot", "system:first-boot:1725465600000", true],
    ["reflection (inherits its thread's verdict)", "reflection-slack:C123:1725465600.1-172546560000", true],
    ["KPR-402 continuation leg (inherits its base id's verdict)", "1725465600.123456#dl1", true],
    ["voice callId (Vapi-shaped)", "call_01HQ8Z9", true],
    ["sched: with a multi-word cron label", "sched:mokie:daily digest:1725465600000", false],
    ["scheduler: with the same label", "scheduler:mokie:daily digest:1725465600000", false],
  ];

  // D6 table 2 — threadId shapes. The two rows carrying the charset's
  // single-shape characters are marked, since `@` and `+` are what a later
  // tightening drops first.
  const THREAD_IDS: ReadonlyArray<[label: string, id: string, admissible: boolean]> = [
    ["slack", "slack:C0123ABCD:1725465600.123456", true],
    ["sms — THE `+` SHAPE", "sms:PN_9912:+15551234567", true],
    ["imessage, Apple ID — THE `@` SHAPE", "imessage:someone@icloud.com", true],
    ["imessage, SMS service", "imessage:+15551234567", true],
    ["app/ws device", "app:device-9912", true],
    ["ws team channel", "team:C0123ABCD", true],
    ["voice", "voice:call_01HQ8Z9", true],
    ["scheduler internal (inherits the embedded threadId)", "internal:C0123ABCD:slack:C1:1725465600.1", true],
    ["event delivery", "event:65a1b2:agent-a:1725465600000", true],
    ["first boot", "first-boot:1725465600000", true],
    ["scheduler: with a multi-word cron label", "scheduler:mokie:daily digest:1725465600000", false],
  ];

  it.each(WORK_ITEM_IDS)("workItemId end to end: %s", async (_label, id, admissible) => {
    await failOnTurnWith({ workItemId: id, threadId: "slack:C1:1.1" });
    await publisher.__drainForTests();
    const doc = await db.collection("ops_events").findOne({});
    if (admissible) {
      expect(doc!.detail.workItemId).toBe(id);
      expect(doc!.evidence).toEqual([{ kind: "workItem", id }]);
    } else {
      expect(doc!.detail).not.toHaveProperty("workItemId");
      expect(doc!.evidence).toEqual([]);
    }
    expect(publisher.getSnapshot().rejected).toBe(0); // omit is never reject
  });

  it.each(THREAD_IDS)("threadId end to end: %s", async (_label, id, admissible) => {
    await failOnTurnWith({ workItemId: "1725465600.123456", threadId: id });
    await publisher.__drainForTests();
    const doc = await db.collection("ops_events").findOne({});
    if (admissible) expect(doc!.detail.threadId).toBe(id);
    else expect(doc!.detail).not.toHaveProperty("threadId");
    expect(publisher.getSnapshot().rejected).toBe(0);
  });
});
```

The two tables above are the plan's copy of D6's; if the design's tables and these ever disagree, the design wins and this file is corrected — do not amend D6 from here.

- [ ] **Step 2:** AC4–AC7.

**AC4 (C6)** — reference `src/outage/outage-notices.test.ts` and `src/ops/single-prefix-predicate.test.ts` (Task 1); add one end-to-end case per bucket. **Assert the six LITERAL values, not `waitingFor(workItem.id)`** — the producer calls `waitingFor`, so comparing against it is a tautology that would pass even if both sides were wrong. Copy the literals from chunk 1's `WAITING` map:

```typescript
it.each([
  ["sched:a:b:1", "nobody"], ["callback:65a1", "nobody"], ["event:65a1:agent-a", "nobody"],
  ["team-65a1", "agent"], ["worker:65a1", "nobody"], ["1725465600.123456", "human-now"],
])("a failure on a %s turn publishes waiting: %s", async (id, expected) => { /* … */ });
```

**AC5 (C7, and C17's no-I/O clause).**

```typescript
it("implements exactly the D5 grammar", () => { /* references src/ops/match.test.ts; adds an end-to-end match */ });

it("match evaluation performs NO I/O", async () => {
  // C17's other half, PINNED rather than asserted in prose. ⚠ "Swap the Db
  // handle for the throwing variant" is not constructible: OpsPublisher
  // builds its OpsStore in the constructor and exposes no handle swap. The
  // workable shape is a FakeDb whose collections are armed to throw on any
  // access after init() has loaded the subscription set — then publish, and
  // assert from the `operations` log that the handle was untouched during
  // evaluation. Two assertions, one behavioural and one structural:
  //
  //  (a) with the armed fake, `evaluateMatches(draft, loadedSubscriptions)`
  //      returns its result and `fakeDb.operations` gains no entry;
  //  (b) match.ts imports nothing from mongodb or from ./store.js — the
  //      durable half, which survives a refactor that stops exercising (a).
  const source = readFileSync(`${root}src/ops/match.ts`, "utf8");
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
it("a publish fault, rejection or overflow produces a log line and a counter and NO document", async () => {
  // The log line needs a capture mechanism, and the repo has one precedent:
  // `vi.mock("../logging/logger.js", …)` returning a `createLogger` whose
  // methods are `vi.fn()`s — dispatcher.test.ts:23 and siblings. Use that
  // rather than spying on console. Assert the counter AND
  // `countDocuments({}) === 0` for each of the three; the counter alone
  // cannot distinguish "not published" from "published then miscounted".
});

it("no code path in this diff spawns a turn", () => {
  // `opsSources` is MODULE-scoped (harness contract item 7), not declared
  // here: AC2's scan is in an earlier describe and would not see a const
  // declared inside this one.
  for (const s of opsSources) {
    for (const forbidden of ["runWorkItemTurn", "spawnTurn", "agent-manager", "dispatcher"]) {
      expect(s, `an src/ops source references ${forbidden}`).not.toContain(forbidden);
    }
  }
});
```

- [ ] **Step 3:** AC8–AC10 — containment, the epoch rule, and clearing legality. These three carry the driven scenarios.

**AC8 (C15) — negative-verify, both faults, both lanes.** Driven here through Task 5's plain-module harness (harness contract item 6) — `import { buildClaudeLaneHarness, buildLaneBHarness } from "./testing/lane-harness.js"`. Do not rebuild a `RunResult` fixture in this file: two copies of a byte-comparison baseline drift, and the drift is invisible because both sides move together.

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
  // the epoch resolver (D9 step 5). Read count, from the fake's `operations`
  // log (harness contract item 4) — a spy on `findOne` would work too, but
  // the log is already there and is what the other read assertions use:
  const reads = () => fakeDb.operations.filter((o) => o.collection === "ops_events" && o.operation === "findOne").length;
  const before = reads();
  await driveSuccess("Bash");
  await publisher.__drainForTests();
  expect(reads()).toBe(before); // the recovery ran ZERO epoch reads
});

it("two successive recoveries share a dedupeKey, and a third failure's generation is unaffected by how many preceded it", async () => { /* … */ });

it("a burst of N successes before the recovery drains yields one tool-recovered and N-1 recoveryCoalesced", async () => { /* … */ });

it("R1 · F · R2 — the superseded recovery is dropped, not published", async () => {
  // D8's EXACT interleaving.
  //
  //   queue:  R1{clears:K0, openSeq:7}   F3   R2{clears:K0, openSeq:7}
  //   drain:  R1 -> accept; clearing fact for K0; entry removed
  //           F3 -> resolver sees that clearing as more recent -> generation 1;
  //                 entry CREATED at openSeq 8, dedupeKey K1
  //           R2 -> entry.openSeq (8) !== job.openSeq (7) -> DROP
  //
  // CONSTRUCTION — the mechanism, not "hold the drainer" in prose, and NOT
  // the sequence an earlier draft offered. Two things it got wrong, both
  // fatal: R2 cannot be minted after R1's accept has run (the map holds
  // nothing for the family — R1's accept ran `open.delete`, and F3's
  // `open.set` runs only AFTER `await this.accept(...)` returns — so
  // `enqueueRecoveryIfOpen` hits `if (!entry) return`, `recoverySuperseded`
  // stays 0, and three of the four assertions fail in a way that looks like a
  // code bug); and "enqueue R2 directly" is unbuildable, because `enqueue` is
  // private and chunk 3 ships only `__drainForTests`/`__openEntryForTests`, so
  // an implementer chasing green adds a stale-job injector or weakens the
  // assertions.
  //
  // THE SEQUENCE THAT WORKS (harness contract item 3):
  //
  //   await driveFailure("Bash");            // F1 — opens the family; without it
  //   await publisher.__drainForTests();     //      R1 has nothing to clear and
  //                                          //      enqueueRecoveryIfOpen no-ops
  //   const entry0 = publisher.__openEntryForTests(family)!;
  //   const k0 = entry0.dedupeKey;           // D8's "K0", CAPTURED not spelled
  //   const openBefore = entry0.openSeq;     // D8 narrates this as 7; on the
  //                                          //   harness's fresh publisher it is 1
  //   const gate = fakeDb.pause("ops_events", "insertOne");
  //   driveSuccess("Bash");    // R1 dequeued, stalls inside accept; entry still openSeq 7
  //   await gate.reached;      // the drainer is INSIDE R1's insert
  //   driveFailure("Bash");    // F3 queued
  //   driveSuccess("Bash");    // R2 minted at openSeq 7 (R1 has not deleted yet), queued behind F3
  //   gate.release();
  //   await publisher.__drainForTests();
  //
  // The drain then runs R1 (accept, entry deleted) -> F3 (generation 1, entry
  // recreated at openSeq 8) -> R2 (7 !== 8 => superseded, live entry survives)
  // — D8's exact narrative, with R2 both minted at 7 and drained after F3.
  //
  // The pause is what makes it deterministic; chunk 3's Step 6 sibling case
  // achieves the same state synchronously, relying on the recovery accept path
  // having no await before `insertOne`. Either is correct; this one does not
  // depend on that property, which is why AC9 uses it.
  //
  // ⚠ 7 and 8 above are D8's NARRATIVE epoch numbers, kept in the comments
  // because that is how the design reads. They are not this test's values: the
  // harness builds a fresh `OpsPublisher` per case (contract item 8) whose
  // `nextOpenSeq` starts at 1, so F1 opens at 1 and F3 re-opens at 2 — exactly
  // chunk 3's own worked example ("re-opens the family at `openSeq` 2"). Assert
  // the RELATION against the captured baseline; a literal 8 cannot pass.
  //
  // Four assertions, one per harm the identity check prevents:
  expect(await clearingFactsNaming(k0)).toHaveLength(1);  // not two; no second clearing fact for the dead key
  expect(publisher.getSnapshot().recoverySuperseded).toBe(1);
  expect(publisher.__openEntryForTests(family)?.openSeq).toBe(openBefore + 1); // the LIVE entry survives the drop
  // a following plain repeat leaves generation unchanged (no C18 flood);
  // and the next success on that tool STILL enqueues a recovery whose
  // `clears` is the LIVE entry's dedupeKey (D8's K1), not the captured `k0`
  // (no permanent silence) — assert both, since the second is the behavioural
  // restatement of the openSeq assertion above and holds even if the accessor
  // is ever removed.
});

it("a recovery job whose publish faults leaves the family open, so the next success re-enqueues", async () => { /* … */ });

it("a success with no open condition performs no database access at all", async () => {
  // Two forms, and both are worth having: with the fake armed via
  // `armThrowOnEveryAccess()` AFTER init() (nothing throws ⇒ nothing was
  // touched — chunk 3 Step 1; there is no `throwingDb()`, a publisher over one
  // cannot be constructed), and against the `operations` log
  // (`fakeDb.operations.length` unchanged across the success, which localises
  // the failure if it ever regresses).
});
```
**Negative-verify (required):** change the drainer's identity test from `entry.openSeq !== job.openSeq` to a bare `this.open.has(job.family)` membership test and confirm the `R1 · F · R2` case fails. Restore.

*Why it crosses the boundary:* under membership, R2 finds the family present (the entry F3 created at `openBefore + 1` — D8's 8, 2 on a fresh publisher), so it proceeds to `accept()` — `recoverySuperseded` stays 0 instead of 1, a **second** clearing fact naming the dead key `k0` is inserted, and `this.open.delete(family)` removes the **live** entry, so `__openEntryForTests(family)` returns `undefined` instead of the live entry. Three of the four assertions above fail, including both the ones this verify exists to protect. (This is the mutation chunk 3's Step 6 cross-references as living here.)

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

**AC11 (lane parity)** — Task 5 already specifies the mechanism case **including** the `applyNameAndCapEdges` truncation variant (chunk 4, Step 5), so this block does not re-specify it. It carries one real `it` that imports Task 5's harness from `./testing/lane-harness.js` and asserts the criterion here, so the sixteen-`describe` map is complete:

```typescript
it("AC11 — the same tool name yields one subject.id on both lanes, long names included", async () => {
  // Same underlying tool driven through buildClaudeLaneHarness and
  // buildLaneBHarness, including a name long enough to trigger Lane B's
  // applyNameAndCapEdges truncation. Assert the two stored docs' subject.id
  // are equal AND equal to the canonical pre-sanitization name.
});
```

**AC12 (abort discipline)** — same shape: three real `it`s here, driven through `./testing/lane-harness.js`, not prose references.

```typescript
it("AC12 — own-abort publishes nothing on EITHER lane", async () => { /* wasAborted; opts.signal.aborted */ });
it("AC12 — a foreign interrupt publishes errorSig: \"interrupted\"", async () => { /* is_interrupt, runner not aborted */ });
it("AC12 — a guardrail deny publishes nothing", async () => {
  // Lane B's {behavior:"deny"} returns before t0, so this half is provable
  // today. The CLAUDE-LANE deny is class 6 of Task 5 Step 6's probe and is
  // UNVERIFIED until that probe runs: if PostToolUseFailure fires for a
  // PreToolUse-denied call, this case must be extended to the Claude lane and
  // the matcher gains the deny-suppression Task 5 Step 6 specifies. Record
  // the probe's outcome here in a comment when it is run.
});
```

**AC13 (boot order, boot survival, hook placement)** — references `src/boot-order.test.ts` (Task 6) for the three lists and the no-`.start(` case; adds here:

```typescript
it("with the publisher unset, both capture points are no-ops and no turn is affected", async () => { /* … */ });
it("an init() whose every createIndex rejects still yields a wired, publishing publisher", async () => { /* … */ });
it("an init() whose registry upsert rejects throws, so index.ts leaves the publisher unset", async () => { /* … */ });
it("a thrown archetype build still leaves both observers registered", () => { /* references Task 5's real drive */ });
it("both observer registrations occur AFTER the archetype try/catch closes", () => {
  // The second direction of AC13's hook placement, asserted STRUCTURALLY —
  // chunk 4, Task 5, Step 5 states why: registration is straight-line
  // assignment of two array literals and cannot throw, and a vi.mock factory
  // throw kills the module import (taking AgentRunner with it), so no runtime
  // drive can observe the deny-all matcher surviving.
  //
  // ⚠ Anchor on a LITERAL, not on "the closing brace" — a brace has no stable
  // textual form and an implementer left to find one invents an anchor that
  // reads green regardless. The deny-all arm's permissionDecisionReason string
  // is confirmed to occur only inside the archetype catch (agent-runner.ts:1966).
  const src = readFileSync(`${root}src/agents/agent-runner.ts`, "utf8");
  const catchArm = src.indexOf("All tool calls blocked until the archetype is fixed.");
  expect(catchArm).toBeGreaterThan(0);
  for (const assignment of ["hooks.PostToolUseFailure =", "hooks.PostToolUse ="]) {
    expect(src.indexOf(assignment), assignment).toBeGreaterThan(catchArm);
    // …and at buildHooks's own statement indentation, which is what separates
    // "after the catch" from "inside it but textually later".
    expect(src).toContain(`\n    ${assignment}`);
  }
});

it("AC13 — src/ops/publisher.ts exposes no .start(-spelled method", () => {
  // boot-order.test.ts's (d) case scans index.ts, so it guards the CALL site
  // only; this is the other half of the same sentence. ⚠ Match a METHOD
  // DECLARATION, not the bare word: publisher.ts's own init() doc comment
  // contains the string ".start(" while stating that no such method exists,
  // so a `/\bstart\s*\(/` scan would fail against correct code.
  expect(readFileSync(`${root}src/ops/publisher.ts`, "utf8")).not.toMatch(
    /^\s*(public |private |protected )?(async )?start\s*\(/m,
  );
});
```

**AC14 (documentation)** — a text assertion over `CLAUDE.md`, so the doc cannot silently drift out:

```typescript
it("CLAUDE.md documents all three collections with their key, index and TTL posture", () => {
  const md = readFileSync(`${root}CLAUDE.md`, "utf8");
  for (const name of ["ops_events", "ops_subscriptions", "ops_reasons"]) {
    expect(md).toContain(name);
  }
  // AC14 says "each with its key, index and TTL posture", and name-presence
  // alone leaves exactly the part that drifts unpinned. These three phrases
  // come from chunk 4, Task 6, Step 5's text and are the assertable core of
  // that clause:
  expect(md).toContain("producer:subjectKind:subjectId:reasonId:generation"); // the dedupeKey shape
  expect(md).toContain("must be single-field");                               // why cursor and TTL are two indexes
  expect(md).toContain("$setOnInsert");                                       // the kill switch's mechanism
});
```

⚠ **The earlier `expect(md).not.toContain("ops_notifications")` clause is DROPPED, and must not be reinstated.** `ops_notifications` is **KPR-468's collection**, a sibling in this same epic, and KPR-468 will document it in this same `CLAUDE.md` — at which point that assertion fails for a correct change. A test in this ticket must not forbid another ticket's legitimate edit. The real invariant it was reaching for — *this diff creates no such collection* — is asserted where it belongs and where it stays true: the `src/ops/**` source scan in AC2 above.

**AC15 (C12) — outcome is published, never inferred.**

```typescript
it("a successful tool call publishes no tool-failed regardless of duration or turn cost", async () => {
  // Drive a success with a very long duration_ms and a turn whose costUsd is
  // 0 (the literal every Lane B turn returns — turn-scaffold.ts:353, the
  // measurement that invalidated the brief's proposed oracle).
});

it("PostToolUse publishes only tool-recovered, and only when the map holds an open condition", async () => { /* … */ });

it("no code path in this diff reads costUsd, a duration threshold, or a tool_response to decide failure", () => {
  for (const s of opsSources) {
    expect(s).not.toContain("costUsd");
    expect(s).not.toContain("tool_response");
  }

  // THE TWO CAPTURE-POINT HUNKS, which the AC and this case's own title both
  // name and which `opsSources` does not cover. They are the only places an
  // inference could plausibly be written, so leaving them unscanned scans the
  // wrong files. Scanning whole modules is not an option — `agent-runner.ts`
  // legitimately mentions `costUsd` elsewhere (it is not this ticket's field)
  // — so bound each hunk by its own anchor comment rather than the whole file.
  // The tool-bridge.ts hunk starts at "the recovery half" (which precedes "the
  // failure half" in the same try/catch pair), so one hunk covers BOTH Lane B
  // insertions, not just the failure one. Both hunks close on a literal that
  // already exists in the file — NOT on "the enclosing block", which has no
  // searchable textual form.
  // `extractHunk` (harness contract item 10) takes both anchors and carries
  // its own able-to-fail length guards, so neither is repeated here:
  for (const hunk of [extractHunk("src/agents/agent-runner.ts",
                                  "KPR-454 D2: runtime tool-failure observation",
                                  "\n    return hooks;"),
                      extractHunk("src/agents/provider-adapters/tool-bridge.ts",
                                  "KPR-454 D3, the recovery half",
                                  "return `Tool execution failed (")]) {
    expect(hunk).not.toContain("costUsd");
    expect(hunk).not.toContain("tool_response");
  }

  // `durationMs` is READ (a declared detail key) but never COMPARED AGAINST A
  // THRESHOLD — which is narrower than "never appears beside an operator", and
  // the difference is not academic: the blunt form (any relational OR equality
  // operator, either side) matches `obs.durationMs !== undefined` in chunk 3's
  // own `observe.ts` — an optional-key presence check, not a threshold — and so
  // fails against correct code. Two regexes, each named for what it forbids:
  //   - RELATIONAL: the four ORDERING operators, on either side. The lookbehind
  //     on the right-hand alternative excludes `=>`, so `(o) => o.durationMs`
  //     is not read as "something `>` durationMs".
  //   - NUMERIC_EQUALITY: `===`/`!==`/`==`/`!=` ONLY where the other operand is
  //     a numeric literal, which is the only equality shape a threshold can
  //     take. `!== undefined` and `=== undefined` never match; `durationMs === 0`
  //     and `30_000 !== obs.durationMs` both do.
  // Both are able to fail: point either at `if (obs.durationMs > 30_000)` or
  // `if (obs.durationMs === 0)` and the corresponding expectation trips.
  const RELATIONAL = /(durationMs\s*(?:<=|>=|<|>)|(?<![=!<>&|])(?:<=|>=|<|>)\s*[A-Za-z0-9_.]*durationMs)/;
  const NUMERIC_EQUALITY = /(durationMs\s*[!=]==?\s*-?\d|-?\d\s*[!=]==?\s*[A-Za-z0-9_.]*durationMs)/;
  for (const s of opsSources) {
    expect(s).not.toMatch(RELATIONAL);
    expect(s).not.toMatch(NUMERIC_EQUALITY);
  }
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
  // ⚠ Deliberately a DIFFERENT class and retry from the row above and from
  // hive-runtime's own. If both foreign rows were informational/transient,
  // "stamped with ITS OWN row's class/retry" would be asserted only against
  // tool-failed, and a publisher that stamped every event from the FIRST
  // loaded row would still pass. Differing values make a mis-stamp fail loudly.
  await db.collection("ops_reasons").insertOne({
    _id: "florist:bloom-stalled", producer: "florist", reasonId: "bloom-stalled",
    class: "judgment", retry: "deterministic", remediationTemplate: "check {stage}",
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
    expect(readFileSync(`${root}${f}`, "utf8"), `${f} hardcodes a producer`).not.toContain("hive-runtime");
  }
  // Note the exception this list encodes: `publisher.ts` IMPORTS
  // HIVE_RUNTIME_REASONS (for the boot upsert and the constructor gate) but
  // must never contain the literal string — that is the difference between
  // registering this producer's rows and special-casing them.
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
