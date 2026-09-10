# KPR-455 operational reader implementation plan

> **For agentic workers:** Execute this plan through the epic implementation lane (`dodi-dev:implement-ticket`). Read this index and all seven chunk files as one plan before starting Task 1. **KPR-454 and KPR-468 must both be merged first** — see "Ordering dependency" below; this plan is unimplementable before they land.

**Goal:** Ship the surface a human uses to see what the ops record already knows, and the one edge that turns an operator act into an acknowledgement. Three read-only subcommands (`hive ops health`, `hive ops stalled`, `hive ops ack`), one informational `hive doctor` section, and nothing else: no collection of this child's own, no periodic sweep, no `index.ts` wiring, no policy row. Never assert health from absence; never render a raw error string, a message body, or a credential-shaped value.

**Architecture:** Two new modules under `src/cli/`, both out of process from the engine. `src/cli/ops-views.ts` holds the bounds, the pure resolvers (the `(tool, errorSig)` rollup, the open-condition view and its class-legality predicate, the quiet-turn shaping, the cursor codec) and the three bounded reads that feed them. `src/cli/ops.ts` is the `runObligations`-shaped shell: `selectInstance` → `verifySentinel` → `WriteGuard`/`guardDb` → one JSON document on stdout. The two read paths call **no** `init()` and issue **no** write. The `ack` path constructs KPR-468's own `OpsNotifier` against the same database, calls its `init()` (which materialises `ops_notifications` and its indexes — the sibling's schema, by the sibling's code) and then `accept(...)` — one act per invocation, `at` minted once, retried only as the identical tuple. The doctor section is one fetcher on the `outageQueueStatsForDoctor` shape plus one renderer that never touches `allPassed`.

**Tech Stack:** Existing TypeScript strict / Node 22–24, MongoDB driver 7, `zod` (already a dependency — the cursor codec), Vitest. No dependency addition. No `hive.yaml` key. No new collection, index or TTL of this child's own.

**Approved input:** [KPR-455 design](kpr-455-design.md), clean at spec-review round 5, commit `92580eb` on `epic/kpr-451`. Contract: [KPR-458 design](kpr-458-design.md) D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12 and C1–C19, with **C3, C9, C10, C11, C12, C13 and C14** the criteria this child is measured against. Producer: [KPR-454 design](kpr-454-design.md) + its [plan index](kpr-454-plan.md) and chunks [1](kpr-454-plan-1-prefix-table.md), [2](kpr-454-plan-2-contract.md), [2b](kpr-454-plan-2b-contract-tests.md), [3](kpr-454-plan-3-publisher.md), [4](kpr-454-plan-4-capture-and-boot.md), [5](kpr-454-plan-5-acceptance.md). Notifier: [KPR-468 design](kpr-468-design.md) + its [plan index](kpr-468-plan.md) and chunks [1](kpr-468-plan-1-types.md), [1b](kpr-468-plan-1b-slack-transport.md), [2](kpr-468-plan-2-ledger-and-ingest.md), [2b](kpr-468-plan-2b-ingest.md), [3](kpr-468-plan-3-delivery.md), [3b](kpr-468-plan-3b-notifier.md), [4](kpr-468-plan-4-intake.md), [5](kpr-468-plan-5-boot.md), [6](kpr-468-plan-6-acceptance.md).

**Epic Decision Register canon** (read from the spec's own consultation, which read it live from KPR-451 at draft time). **KPR-456's tenth entry binds hardest and is followed with exactly two named divergences**: "A bounded independent 30-second sweep and read-only CLI expose evidence, notice state, freshness, and backlog **without invoking agents**. Preserve lifecycle ordering and explicit operator enrollment; **no default recipient, severity, escalation, production registration, prompt rollout, or new policy dependency** is supplied." This child supplies none of those, invokes no agents, spawns no turn and registers zero rows of KPR-458 D11's third column. The two divergences, both carried from the spec and both stated where they land: it ships **no sweep at all** (D3 — a timer here would have no legal output, and KPR-468 owns the epic's only ops sweep), and it adds **one informational `hive doctor` section** where KPR-456 shipped a CLI alone (D2). KPR-453's four entries bind indirectly: `detail.workItemId` and `evidence` render as references a responder opens, never as join keys. No canon entry is contradicted; none is amended.

**Known-stale sibling artifact, not a contradiction to resolve:** `kpr-458-design.md`'s D12 and D6 still read "chartered to no child". `kpr-458-plan.md:13` carries the operator's scoping resolution (matcher–deliverer ⇒ KPR-468, inbound acknowledgement edge ⇒ **KPR-455**), and KPR-458's own Task 2 appends the addendum. This plan is written against the resolution. Do not "fix" the design body from here.

**Cross-child fact carried forward, not re-decided:** KPR-468 D8's "cross-process concurrency is out of model" is **overridden** by this child's edge, deliberately, with the argument in the spec's Scope and authority and D8. The three mechanisms that sentence names stay absent (no new work identity, no lease, no elapsed-time reclamation); what is introduced is concurrency, and the property that survives it is intake's CAS, not the in-process latch. **AC10 is what drives that claim against the real CAS**, and it is the single thing a reviewer should press hardest.

**Delivery tier (writer's assessment): `capable`** for the plan as a whole; per-chunk assessments are in the chunk table. The diff is small, but three of its properties are ones a standard-tier pass plausibly gets subtly wrong: the recovery-key asymmetry (a recovery clears **every** `errorSig` row for its tool), the `at`-minted-once retry rule (a retry must not become a second act), and the stale⇒`unknown` direction (absence must never render as health).

---

## Ordering dependency — KPR-454 and KPR-468 are both hard blockers

**Neither is implemented. `src/ops/` does not exist on disk at `9344e6c`.** Every module this plan consumes is _specified_ in a sibling's design and plan and is _not yet written_. Every reference below is written as "KPR-45x delivers X at path P" and must be read that way. **This child merges after both**, and the rebase expectation is stated at the end of this section.

| KPR-454 delivers | at path | consumed here for |
| --- | --- | --- |
| `OpsEvent`, `OpsClass`, `OpsRetry`, `Waiting`, `OpsSubject`, `OpsEvidence`, `OpsDetail`, `OPS_EVENTS_COLLECTION` | `src/ops/types.ts` | the event envelope the two read paths project (type-only plus one collection-name constant) |
| the `{ publishedAt: 1, _id: 1 }` index on `ops_events` | `src/ops/store.ts` `ensureIndexes()` | the reverse-walked scan order both read paths use (integration point 2) |
| the `{ producer, subject.kind, subject.id, reasonId, publishedAt: -1, _id: -1 }` index | same | D4's per-key latest read; named so the implementer does not add one |
| the `hive-runtime` `tool-failed` / `tool-recovered` reason rows, `subject: { kind: "tool", id: <canonical tool name> }`, `detail.tool` / `detail.errorSig` / `detail.lane` | `src/ops/reasons.ts` (code-resident table) | the rollup's key and its scoping (D4) |
| the in-memory Mongo double — real `ObjectId` minting, `sort`-honouring `findOne`, `find().sort().limit()`, an `operations` log, `pause`, `countDocuments`, programmable faults | `src/ops/testing/fake-db.ts` | **every integration test in this plan** |

| KPR-468 delivers | at path | consumed here for |
| --- | --- | --- |
| `OpsAcknowledgement`, `OpsAck`, `OpsIntakeRefusal`, `OpsIntakeResult`, `OpsNotificationState` | `src/ops/notification-types.ts` | the edge's input and its ten rendered outcomes |
| `OpsNotifier` — `constructor(db, activityRetentionDays, clock?, sleep?)`, `init()`, `accept(input)` | `src/ops/notifier.ts` | the edge hosts intake in its own process (D8) |
| `NOTIFIER_STATS_KIND = "ops_notifier_stats"` | `src/ops/notification-store.ts` | the heartbeat the read paths and the doctor section read for freshness |
| the heartbeat document's field set — `timestamp`, `lastSuccessfulSweep`, `cursorAt`, `eventsBehind`, `oldestUnappliedAt`, the three exact row gauges, the four saturating gauges, the counters (`ingestFaults`, `sweepFaults`, …), `state: ok \| backlog \| degraded` | `src/ops/notifier.ts` `writeHeartbeat` call (`kpr-468-plan-3b-notifier.md:424-460`) | the doctor section and `pipeline` in both read payloads |
| the six additive extensions to `src/ops/testing/fake-db.ts` — item **(f)**, `copy` preserving `ObjectId`, is the one AC10 depends on | `kpr-468-plan-2-ledger-and-ingest.md` Task 3 Step 2 | AC10's handle must round-trip through `parseHandle`, which admits only a 24-character `ObjectId`-valid hex string (`kpr-468-plan-4-intake.md:78-82`) |
| `harness(...)`, `sub()`, `t()`, `BASE`, `FakeTransport` | `src/ops/testing/notifier-harness.ts` | AC10 mints a **real** ledger row through real ingest rather than hand-writing an `OpsNotification` |

**Nothing under `src/ops/` is modified by this child, and no file is added there.** Both siblings run structural source scans over `src/ops/**`; a module of this child's placed in that directory would land inside them. Everything this ticket writes lives in `src/cli/`.

**Re-verify before writing Task 1.** If either sibling's implementation diverged from its plan on (a) the `ops_events` stored key set, (b) the heartbeat field names above, (c) `OpsNotifier`'s constructor arity or `init()`'s throw posture, or (d) the six fake-db extensions, that divergence lands on this plan's integration points. Chunk 1 Task 1 Step 1 is an explicit re-verification step for exactly those four.

### ⚠ Rebase expectation

This child touches **neither** `src/index.ts` **nor** `src/boot-order.test.ts` (AC2), which is where both siblings conflict with each other — so the merge conflicts they warn about do not apply here. What *will* have moved by the time this lands are the line numbers this plan quotes inside `src/cli/doctor.ts` and `src/cli/doctor-checks.ts` if any unrelated change touches them. **Every anchor in Chunk 3 is quoted as a literal string as well as a line number; key on the string.** The one file whose content is genuinely uncertain at write time is `src/ops/testing/fake-db.ts` — re-read it, do not assume the six extensions landed verbatim.

---

## Review chunks and file structure

Each chunk file is under 1,000 lines. **Two chunks are split, and every split is recorded here as this plan's own bound requires** (the KPR-454 chunk 2 / 2b and KPR-468 chunk 3 / 3b precedent):

| split | seam | why |
| --- | --- | --- |
| **1 / 1b** | Task 1 Step 2 \| Step 3 | the combined file ran to ~1,250 lines |
| **2 / 2b** | Task 2 Step 3 \| Step 4 | ~1,100 lines once the shared fixture module and the suite landed beside the CLI |

**Both are STEP seams, not task seams, and that is the recorded exception.** Each pair is **one task and one commit**, and the commit block is at the end of the `b` half. Splitting either at a task boundary would leave an intermediate commit that does not deserve to exist: a module with no coverage, or an operator-facing dispatch case with no suite. Read 1 and 1b as one unit, and 2 and 2b as one unit.

Chunk 5 is small on purpose — it is the docs commit plus the whole-repo verification and the NV confirmation checklist, which is the one place all nine mutations are counted in one list. Chunk 4 stayed under the bound only because AC15 moved into chunk 5, which it had to do anyway: its subject is a file Task 5 writes.

**Why these five seams.** They are the spec's own natural task order (Assumptions, "Plan shape": the read commands and their fixtures; the doctor section; the edge and its result rendering; documentation) with one adjustment. The spec says the surface "has not outgrown one chunk, and splitting it would separate the three read paths from the `CliDependencies` seam they all share." **That is followed in substance and not in letter:** the three read paths and the seam stay in **one task** (Task 2 writes `src/cli/ops.ts` whole, all three subcommands, one commit) — nothing is separated. What chunk 1 lifts out ahead of it is not a *path* but the pure **resolvers and bounds** those paths call, because AC3, AC4, AC5 and AC16 are properties of those functions and nothing else, and driving them through argv plumbing would make four of the sixteen criteria harder to falsify rather than easier. The alternative — one ~1,500-line chunk — breaches this plan's own line bound.

| Chunk | Plan file | Task | Responsibility | Tier |
| ----- | --------- | ---- | -------------- | ---- |
| 1 | [Views, bounds and resolvers](kpr-455-plan-1-views.md) | 1 | `src/cli/ops-views.ts` — every resolved bound, the position comparator, the class-legality predicate, the tool-health resolver, the open-condition resolver, the quiet-turn read and its shaping, the pipeline-freshness read, the cursor codec | `capable` |
| 1b | [The view module's unit suite](kpr-455-plan-1b-view-tests.md) | 1 | `src/cli/ops-views.test.ts`, the two empirical harness-divergence confirmations, the NV2 rehearsal. **Same task and commit as chunk 1.** | `capable` |
| 2 | [The CLI and the acknowledgement edge](kpr-455-plan-2-cli.md) | 2 | `src/cli/ops.ts` — `runOps`, `setLogLevel("error")`, the strict `parseArgs` table, the identity guard, all three subcommands including the edge and its ten rendered outcomes; `src/cli.ts` dispatch + usage | `capable` |
| 2b | [The CLI's fixtures and its own suite](kpr-455-plan-2b-cli-tests.md) | 2 | `src/cli/testing/ops-cli-fixtures.ts` (a plain module, shared with chunk 4), `src/cli/ops.test.ts`, NV8. **Same task and commit as chunk 2.** | `capable` |
| 3 | [The doctor section](kpr-455-plan-3-doctor.md) | 3 | `opsPipelineForDoctor` in `src/cli/doctor-checks.ts`; `renderOpsPipelineSection` in `src/cli/doctor.ts` + the post-check call + the `config not loaded` else-branch line; `src/cli/ops-doctor.test.ts` | `capable` |
| 4 | [Acceptance suite](kpr-455-plan-4-acceptance.md) | 4 | `src/cli/ops.integration.test.ts` — AC1–AC16 as named tests, including AC10 against KPR-468's real CAS and AC11's ten outcomes | `capable` |
| 5 | [Docs and final verification](kpr-455-plan-5-docs.md) | 5 | `CLAUDE.md` — the three subcommands in Commands, one Common Gotchas bullet; the whole-repo verification; the NV1–NV9 confirmation checklist | `standard` |

Code fences carry complete new-file payloads or exact insertion/replacement blocks. Apply repository formatting (`npm run format`); formatting changes are not design changes.

### Production files to create

- `src/cli/ops-views.ts` — the bounds table as named `const`s, `isAfter`, `clearingIsLegal`, `resolveToolHealth`, `resolveOpenConditions`, `scanOpsEvents`, `readOpsLogPresence`, `readQuietTurns`, `readPipeline`, `encodeOpsCursor` / `decodeOpsCursor`, `resolveActivityRetentionDays`. No writes, no `init()`, no `OpsStore`, no `OpsNotifier`.
- `src/cli/ops.ts` — `runOps(argv, deps): Promise<number>` (the exit code), the `OpsNotifierLike` seam, the three subcommand bodies and the ten-outcome result renderer.

### Production files to modify

- `src/cli.ts` — one `case "ops":` beside `case "obligations":` (`:173-181`), and three usage lines beside `:140-143`. Additive.
- `src/cli/doctor-checks.ts` — one `opsPipelineForDoctor(uri, dbName)` on the `outageQueueStatsForDoctor` shape (`:585-608`). Additive.
- `src/cli/doctor.ts` — one `renderOpsPipelineSection(...)` beside `renderOutageQueueSection` (`:252-273`), one call in the post-check block after the outage-queue section (`:770-774`), and **one line in the `config not loaded` else-branch** (`:794-814`). Never contributes to `allPassed`.
- `CLAUDE.md` — three `hive ops` lines in Commands beside the `hive obligations` block (`:156-160`), one Common Gotchas bullet.

### Files this child must NOT touch

- `src/index.ts` and `src/boot-order.test.ts` — **untouched, asserted by AC2 as a text assertion.** Nothing here is a per-spawn read: the CLI is a separate process and the doctor is a separate process. The boot-order rule is satisfied vacuously rather than by care, and a reader sweeping the epic for this child's anchors will correctly find none.
- Anything under `src/ops/` — read-only. If a needed read is not exposed, this child performs it directly against the collection rather than modifying a sibling (D10 point 5).
- `src/obligations/**` — `selectInstance`, `CliSelection`, `CliDependencies` and `ObligationError` are **imported unchanged** from `src/cli/obligations.ts`; nothing there is edited, and the retention resolution this child needs is a local helper rather than a new field on `CliSelection`.
- `activity_log`, `ops_events`, `ops_subscriptions`, `ops_reasons`, `agent_events` — read-only, and no index is added to any of them.

### Test-support files to create

- `src/cli/testing/ops-cli-fixtures.ts` — **a plain module, not an export from a `.test.ts`**: `fixture()`, `cleanupFixtures()`, `stampSentinel()`, `ProgrammedNotifier`, `steppingClock()`, `deps()`. Imported by `src/cli/ops.test.ts` and `src/cli/ops.integration.test.ts`. Vitest re-registers an imported test file's suites and file-scope hooks into the importer (KPR-454's measured probe, and the reason `src/ops/testing/notifier-harness.ts` exists), so the two suites cannot share helpers through the first one; a plain module additionally gets `tsc --noEmit` coverage, which `tsconfig.json` excludes `.test.ts` files from, and it is excluded from both siblings' source scans by their existing `/testing/` filters. It fabricates no Mongo behaviour.

### Test files to create

- `src/cli/ops-views.test.ts` — the pure resolvers, the class-legality table, the bounds, the cursor codec, the two harness-divergence guards.
- `src/cli/ops.test.ts` — argv parsing under `strict: true`, dispatch, the identity guard, `setLogLevel`, the ten-outcome rendering and exit codes, the `at`-minted-once rule.
- `src/cli/ops-doctor.test.ts` — the fetcher's null posture and the renderer's five branches including all three `state` values.
- `src/cli/ops.integration.test.ts` — AC1–AC16 as named criterion blocks over the two siblings' doubles.

---

## Numeric bounds resolved at plan time

The spec (Assumptions, `⚠ Delegated`) fixes the behaviour and leaves the values here. All live as named `const`s in `src/cli/ops-views.ts`; **no `hive.yaml` key ships for any of them** (standing "no preemptive levers" preference, and both siblings ship none), so each is a code change. Every horizon is also a flag, and **the flag's direction is what makes the default safe: past the horizon the answer is `unknown`, so a shorter horizon yields more `unknown` and no setting can manufacture a `healthy`** (D6).

| Constant | Value | Reasoning |
| --- | --- | --- |
| `TOOL_HEALTH_STALE_AFTER_MINUTES` | `1440` (24 h) | A tool condition **renews on every repeat** — KPR-454 keys on the tool and increments `eventCount` per failure — so a genuinely broken tool republishes every time it is called. The horizon therefore has to exceed the interval between a tool's *uses*, not between its failures: a tool exercised once a day by a cron would read `unknown` under a shorter one even while broken. 24 h spans a full working day plus the overnight crons, so an operator arriving in the morning still sees yesterday afternoon's breakage as `failing`; a fact older than a day is honestly stale. Well inside the event TTL (`config.activity.retentionDays`, default 90 d), so the horizon binds before retention in the default deployment — the reverse is edge case 7 and is labelled, not silently truncated. |
| `WORK_STATUS_STALE_AFTER_MINUTES` | `4320` (72 h) | Deliberately **not** the same number, which is the whole point of D8 making the horizon a property of the view. A `workItem`-shaped condition has no renewal rhythm: it can be published once and stay open for days with nothing republished, so the tool horizon would render every genuinely open condition `unknown` inside a day. Three days spans a weekend, which is the shortest span over which "still open" and "nobody has looked at it" are the same observation. |
| `QUIET_TURN_WINDOW_MINUTES` | `1440` (24 h) | The scope addition's evidence is a trailing-7 d ratio, but the operational question — *what started and went quiet* — is a today question. `activity_log` on the measured instance carries ~1 480 turn rows per 7 d ⇒ ~210/day, of which ~19 match the union, so a 24 h window is a few hundred documents behind a `timestamp` range bound. 7 d is one `--window 10080` away. |
| `DISCOVERY_WINDOW_FLOOR_MS` | `7 * 86_400_000` | **The key space is enumerated over a wider bound than the horizon, and this is that bound.** Without it "the latest fact is older than the horizon" (⇒ `unknown`) and "the key does not appear at all" (⇒ absent) are the same observation, and AC3's second and third limbs collapse into one. The effective window is `max(DISCOVERY_WINDOW_FLOOR_MS, staleAfterMs × DISCOVERY_HORIZON_MULTIPLIER)`, so it can never be narrower than the horizon it qualifies. Its cost is stated rather than hidden: absence means "published no fact in the discovery window", not "never", and the payload says so in its own words. The direction is safe — a narrower discovery window can only turn an `unknown` into an absence, and absence is explicitly labelled *not health*. |
| `DISCOVERY_HORIZON_MULTIPLIER` | `3` | With the shipped horizons the floor wins (24 h × 3 = 72 h < 7 d); the multiplier only takes over for an operator who widens `--stale-after` past ~56 h, and it then keeps the discovery window comfortably wider than the horizon instead of pinning it at a fixed 7 d and silently re-collapsing the two limbs. |
| `OPS_EVENT_SCAN_CAP` | `5_000` | Bounds the **documents read**, which `--limit` does not (D4's honesty clause: `--limit` caps output rows, and a caller narrowing it does not narrow the work). The scan walks `{ publishedAt: 1, _id: 1 }` in reverse, so the cap truncates the *older tail* only: each key's **latest fact — and therefore every rendered outcome — is exact under the cap**, and only `eventCount` and `firstAt` become lower bounds, which the payload labels. 5 000 is ~25× the measured weekly tool-failure volume and is a single bounded `find`. |
| `ACTIVITY_MATCH_CAP` | `2_000` | Bounds arm 2's grouping read. ~100× the measured daily matched volume (19/day) and ~15× a 7 d window at that rate. Exact totals do not depend on it — they come from two `countDocuments` — so a breach costs only the per-`(agentId, channelKind)` grouping, which is flagged `groupsTruncated: true` rather than silently short. |
| `DEFAULT_LIMIT` / `MAX_LIMIT` | `20` / `100` | Verbatim the `hive obligations` precedent (`src/cli/obligations.ts:111`, `:121-122`), so an operator learns one pair of numbers for both commands rather than two. |
| `ACK_ATTEMPTS` | `3` (the first call plus two retries) | The edge does **not** meet the deterministic 11 s delivery-latch path — that latch is in-process and this edge hosts its own notifier in a second process (spec D7's mechanism note) — it meets the **lost CAS**, which clears as soon as the colliding tick's write lands, i.e. inside one round trip. Two retries cover a collision and its immediate successor. A budget sized to outlast an 11 s latch would be the wrong shape for a path that never meets one, and each attempt already carries intake's own 5 s `INTAKE_DEADLINE_MS`, so three attempts is a ~16 s worst case against genuinely absent storage — the honest ceiling, and the one printed in `--help`. |
| `ACK_BACKOFF_MS` | `[250, 750]` | Sub-second, because the contended write it is waiting on is one `updateOne`. Two distinct values rather than a constant so a second collision is not retried at the same phase as the first. |
| `HEARTBEAT_STALE_MS` | `120_000` | `src/obligations/reader.ts:47-57`'s threshold and the one every existing doctor section uses (`src/cli/doctor.ts:117`). Not a delegated call; restated so the implementer does not look for one. |
| `RETENTION_FRACTION_WARN` | `0.5` | The doctor warns when `oldestUnappliedAt`'s age exceeds half of `config.activity.retentionDays` — KPR-468 D5's TTL-outrun measure, an age against an age, which is the one form of that signal a **single sample** can see. Half leaves an operator the same margin again to act before events age out unapplied. |
| `UNKNOWN_ERROR_SIG` | `"(unset)"` | The rollup key for a condition event carrying no `detail.errorSig`. Under the shipped producer this is unreachable (`errorSig` is a required `detailKey` on `tool-failed`), so it exists to keep the reducer total rather than to be seen; the parenthesised form cannot collide with a real token, which `OPS_TOKEN_RE` bounds to `^[a-z][a-z0-9-]{0,39}$`. |

**Two values the spec fixes and this plan restates so the implementer has one table:** the rollup's producer scope is `hive-runtime` (KPR-458 D8's own scoping — see the assumption below), and `--stale-after` is expressed in **minutes** on every command so the two horizons and the one window share a unit.

---

## Two harness divergences this plan designs around, both verified in-tree

Both are properties of `src/obligations/testing/fake-db.ts`, which KPR-454's plan copies "verbatim" into `src/ops/testing/fake-db.ts` for exactly these methods, so both carry into the double this plan tests against. Each is guarded by a test in chunk 1, because a query whose semantics differ between the double and MongoDB is how a green test comes to assert nothing.

1. **`$ne: null` matches a MISSING field in the double and does not in MongoDB.** `predicate`'s `$ne` arm is `!same(actual, value)` (`src/obligations/testing/fake-db.ts:34-35`) and `same(undefined, null)` falls through to `a === b` ⇒ `false` (`src/obligations/types.ts:216-237`), so `{ error: { $ne: null } }` **matches every row with no `error` field at all**. Against MongoDB it excludes them. Arm 2's error disjunct is therefore written **`{ error: { $exists: true, $ne: null } }`**, which is correct in both engines: the double's `$exists` arm is exact (`:30-31`), and the two operators are ANDed by `predicate`'s `every`. Without this, every successful turn in a fixture would be reported as a failing one and AC6's cost limb would pass for the wrong reason.
2. **`find().project()` is a no-op in the double** (`src/obligations/testing/fake-db.ts:252-254`), so no redaction claim may rest on a projection. The projection stays in the production query as a bandwidth measure — and it deliberately **includes** `error`, because the *flag* is derived from it — but the string is converted to a boolean inside `readQuietTurns`, in the same function that reads it, so it never escapes `ops-views.ts`. AC7's substring assertion is what pins that, and it is checked against the un-projected rows the double hands back, which is the stronger test.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `clearingIsLegal` over all four `class` values plus the two negative limbs (different producer; an unrecognized `class`); `isAfter`'s `(publishedAt, _id)` total order including the tie; `resolveToolHealth`'s outcome mapping, its recovery-key asymmetry and its stale⇒`unknown` branch; `resolveOpenConditions`'s clearing test, its staleness branch and its exclusion of clearing events from the condition key space; the quiet-turn row mapper (flags in, `error` string out); the cursor codec's round trip and its four rejections; the resolved bounds' relationships (`discoveryWindow ≥ horizon`; `MAX_LIMIT ≥ DEFAULT_LIMIT`); `resolveActivityRetentionDays`'s precedence chain.
  - Reason: each is a pure total function whose **closure** is the correctness property. A `clearingIsLegal` that returns `true` for an unrecognized class renders a stale condition as cleared, which is the "absence is not health" defect wearing a different hat; a rollup that joins recoveries on `errorSig` renders every recovered tool as permanently `failing`; a row mapper that copies `error` puts an arbitrary string into text an operator pastes into a chat window (C13). None is happy-path CRUD.
  - Minimum assertions: `clearingIsLegal` asserted per class — `resource` ⇒ legal; `judgment` and `integrity` ⇒ legal **only** with `evidence.length >= 1` and illegal at zero; `informational` ⇒ never; a same-`dedupeKey` clearing from a **different producer** ⇒ never; a `class` outside the four ⇒ never (fail-open-as-open). The rollup: one recovery resolves **both** `errorSig` rows of its tool; a fact one millisecond inside the horizon resolves `failing`/`recovered` and the same fact one millisecond outside resolves `unknown`; a key absent from the scan is absent from the output **and** the payload's `notes.absenceIsNotHealth` string is present. The cursor: a round trip returns `after`; a cursor for another `section`, another `owner`, a non-base64url string and one over 500 characters each fail `invalid_cursor`.

- Integration: **required**
  - Scope: the two read commands end to end through `runOps` over KPR-454's in-memory double — seeded `ops_events` and `activity_log` fixtures, the identity guard, the `--json` shape, paging, the three emptinesses and the retention-truncation label; the `ack` edge end to end against KPR-468's **real** `OpsNotifier` and its real CAS, plus the ten rendered outcomes over an injected notifier; the write-confinement and no-`init()`-on-read-paths assertions read off the double's `operations` log.
  - Reason: every criterion that matters here is a property of a **whole invocation** over durable state — that no write is issued, that `init()` runs on exactly one of three paths, that a lost CAS returns `unavailable` after exactly one retry inside intake and that the edge's re-issue of the identical tuple then reports `already-applied`, that stdout carries exactly one JSON document while `init()` is emitting registry-audit warnings. None is provable by call-count mocks on a single function.
  - Harness: **setup-required, and every part of it is a sibling's** — `src/ops/testing/fake-db.ts` (KPR-454, extended by KPR-468) and `src/ops/testing/notifier-harness.ts` (KPR-468, chunk 3b Step 4). **This plan creates no new double and extends neither.** If a read this plan needs is not expressible against them, that is a blocker to report, not a local fork. No live Mongo, no Slack token, no Anthropic key.
  - Minimum assertions: AC1–AC16 as enumerated in chunk 4, each as a named test, plus the per-module coverage chunks 1–3 carry.

- E2E: **not-required**
  - Scope: a deployed instance with a live `ops_events`, a real notifier heartbeat and a real acknowledgement round trip.
  - Reason: the two read paths are pure reads whose every branch is drivable from a fixture, and the one genuinely external property — that `accept(...)` behaves as its contract says across a process boundary — is exercised against the sibling's **real** intake code and its real CAS in AC10, which is stronger than a live run against a database with no ledger rows in it. With zero `ops_subscriptions` rows the notifier creates no row and delivers nothing (KPR-468 D13's intended steady state), so a live instance would have no handle to acknowledge and the E2E would assert the empty case that AC3 and AC12 already drive.
  - Harness: not-applicable.
  - Minimum assertions: not applicable; no assertion is waived from the integration group.

### Critical Flows

- `hive ops health` against an instance with **no `ops_events` collection** → exit 0, one JSON document, `log.present: false`, `summary.emptiness: "no-ops-event-log"`, `tools: []`, and the `absenceIsNotHealth` string present. Never an empty rollup that reads as clean.
- Two `tool-failed` events for one tool under **different** `errorSig` values, then one `tool-recovered` for that tool → **both** rows `recovered`, each carrying the recovery instant.
- The same fixture with the recovery moved one millisecond **before** the newest failure → both rows `failing`; the recovery is not rendered as an outcome it does not have.
- One `tool-failed` inside the discovery window but outside the horizon → the key is listed with outcome **`unknown`**; the same tool with no event in the discovery window is **absent** and the payload says absence is not health.
- A `resource` condition and a same-producer clearing fact published after it → absent from `stalled`'s `openConditions`. The same clearing fact under a **different producer** → the condition is still listed.
- An `integrity` condition and a same-producer clearing fact carrying **zero** `evidence` → still listed. With one `evidence` reference → cleared.
- A condition whose stored `class` is a value this reader does not recognize, plus a same-producer clearing fact → still listed, `class: "unknown"`, `state: "open"`.
- An `activity_log` window holding 3 `timedOut: true, error: null` rows, 2 `aborted: true` rows, 1 `error: "boom"` row and 40 clean rows, one of which is a `recordKind: "delivery_receipt"` document → `matched: 6`, `recent` carries the flags that were set, **no substring of `"boom"` appears anywhere in the payload**, and the receipt produces no row.
- The same window with the collection absent or empty → `measurable: false` with the window stated, never "no failures".
- `hive ops ack <handle> --act seen --actor U1` against a row a concurrent writer moves between intake's read and its CAS, twice → intake returns `{ state: "unavailable" }` after exactly one internal retry, the edge re-issues the **identical** `(actorId, act, at)` tuple, and once the interference stops the act applies. A landed first write makes the re-issue `{ state: "noop", reason: "already-applied" }`.
- `hive ops ack` on an instance with no `ops_notifications` collection → `init()` **creates** it and its indexes, the handle resolves to nothing, and the answer is `refused: "unknown-handle"`, exit 1 — never `unavailable`.
- `hive ops ack` where `init()` **throws** (the unique identity index is unavailable) → `notifier_init_failed`, exit 1, **no `accept(...)` call made**, and never `unknown-handle`.
- `hive ops ack --act snoozed` with no `--until` → `until_required` before any connection is opened. With a `--until` in the past → passed through and refused by intake as `snooze-not-future`.
- Any subcommand against a database whose sentinel does not verify → `identity_unverified` before any read and before any `accept(...)`.
- `hive doctor` with a `state: "backlog"` heartbeat → the backlog renders informationally with `eventsBehind` as "at least N" and `oldestUnappliedAt` beside it, **no warn**, exit code untouched. The same heartbeat with `oldestUnappliedAt` past half the activity retention → **warn**, exit code still untouched.
- `hive doctor` with no config loaded → the Ops event pipeline section prints its own `○ skipped: config not loaded` line.

### Regression Surface

- **`hive obligations` is untouched.** `selectInstance`, `CliSelection`, `CliDependencies`, `ObligationError` and `runObligations` are imported or left alone; none is edited, re-exported or refactored. `src/cli/obligations.test.ts` must stay green.
- **KPR-454 and KPR-468 are read-only.** No file under `src/ops/` is created or modified. `OpsStore.ensureIndexes()` and `upsertReasons()` are never called; `ops_events`, `ops_subscriptions` and `ops_reasons` are never written. The **only** ledger write in the entire diff is intake's own CAS, performed by KPR-468's code, on the `ack` path.
- **`src/index.ts` and `src/boot-order.test.ts` gain nothing** — no import of `cli/ops`, no wiring, no anchor in any of the guard's three lists. `src/boot-order.test.ts` must stay green **unchanged**.
- `src/cli/doctor.ts`'s existing sections and their order; `allPassed` is reachable only from the check loop and the Datastore identity section (KPR-296 canon). `src/cli/doctor.test.ts` and `src/cli/doctor-checks.test.ts` must stay green.
- `activity_log`'s writer, its two indexes and `TURN_ACTIVITY_FILTER`'s definition; `agent_events`, the scheduler, KPR-456's obligation path and KPR-457's Beekeeper sender.
- Worker/scribe containment: no MCP server is added, so both KPR-390 standing obligations are inapplicable — there is no `buildToolTransportInventory` descriptor to push and no `suppressAutoInjectedServers` gate to extend (D12).
- No change to `hive.yaml`, `src/config.ts`, or any collection's indexes.

### Commands

Run from the child implementation worktree on Node 22 or 24 (CLAUDE.md: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher). A missing install is setup, not a skipped test.

- Setup: `node --version` (expect v22.x or v24.x); `npm ci`
- Unit: `npx vitest run src/cli/ops-views.test.ts src/cli/ops.test.ts src/cli/ops-doctor.test.ts`
- Integration: `npx vitest run src/cli/ops.integration.test.ts`
- Sibling regression (the doubles are shared): `npx vitest run src/ops`
- CLI regression: `npx vitest run src/cli`
- Boot regression (must pass **unchanged**): `npx vitest run src/boot-order.test.ts`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Hygiene: `git diff --check`
- Expected results: exit 0, all selected Vitest tests pass, no skipped new contract cases, no TypeScript/ESLint/Prettier errors. Record actual totals; do not invent expected test counts.

### Harness Requirements

- `src/ops/testing/fake-db.ts` — **KPR-454's double, extended by KPR-468, used here unchanged.** This plan adds nothing to it. Two of KPR-468's six extensions are load-bearing for this child and are re-verified in chunk 1 Task 1 Step 1: **(f)** `copy` preserving `ObjectId`, without which AC10's handle cannot round-trip through `parseHandle` and the test returns `refused: "unknown-handle"` while asserting nothing; and **(c)** unique-index enforcement, which AC12's throwing-`init()` limb drives.
- `src/ops/testing/notifier-harness.ts` — **KPR-468's shared harness, imported, never extended.** AC10 uses `harness({ subscriptions: [sub("s1")], reasons: [...] })`, `seedEvent`, `tick` and `row` to mint a **real** ledger row through real ingest; hand-writing an `OpsNotification` would pin this plan to a row shape it does not own.
- `src/cli/testing/ops-cli-fixtures.ts` — this plan's own fixture module (chunk 2b Step 4), enumerated under "Test-support files to create" above: `{ connect, clock, emit, makeNotifier, sleep }` over a supplied `FakeDb`, capturing every emitted string, plus the instance fixture, the sentinel stamp and the programmed notifier. It is a **fixture, not a double** — it fabricates no Mongo behaviour, and it is a plain module for the vitest reason stated there.
- A fixed clock threaded through `deps.clock()`, so every horizon, window and `at` is drivable without timers. **`deps.clock` must be callable more than once and must be able to return a different value each call** — that is how AC9 proves `at` is minted exactly once.
- No live MongoDB, no Slack token, no Anthropic API key for any test in this plan. `npm run check` needs the three Slack env stubs above (`reference_npm_check_env_stubs`).

### Non-Required Rationale

- E2E: stated above. The acknowledgement round trip is driven against the sibling's real intake and its real CAS in AC10, which is the property the spec asks a reviewer to press hardest; a live instance in the intended steady state has zero ledger rows and therefore no handle to acknowledge, so an E2E there would exercise the empty case AC3 and AC12 already cover. Nothing in the integration group is waived on this ground.

### Verification Rules

- Missing harness is not a skip reason. Both doubles belong to siblings that must already be merged; if either is missing or diverged, report a concrete blocker — **do not fork a local copy**.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane rather than reinterpreting the spec here.
- **KPR-454 and KPR-468 must both be merged before Task 1.** Chunk 1 Task 1 Step 1 re-verifies the four integration points against the merged code. A divergence there is a plan-revision trigger, not something to work around in an implementation file.
- Negative-verify is required at **nine numbered points, NV1–NV9, which is nine mutations**. Each names the mutation, the tests that must fail, and — predicted for real, not asserted — exactly what the failure looks like, **including which tests stay green**. A mutation nobody has confirmed crosses a boundary is not evidence. **Restore after each**, and confirm the restore with the chunk's own command before moving on.

  **The ids exist so the count cannot drift. Reference these ids, never "the fourth rule".**

  | id | mutation | hosted in |
  | --- | --- | --- |
  | NV1 | the recovery-key asymmetry | chunk 4 Step 4 (AC4) |
  | NV2 | the class-legality switch | chunk 4 Step 9 (AC16), rehearsed in chunk 1b Step 6 |
  | NV3 | the same-producer clause | chunk 4 Step 9 (AC16) |
  | NV4 | stale ⇒ `unknown` | chunk 4 Step 3 (AC3) |
  | NV5 | `TURN_ACTIVITY_FILTER` | chunk 4 Step 6 (AC7) |
  | NV6 | the measured union | chunk 4 Step 5 (AC6) |
  | NV7 | `at` minted once | chunk 4 Step 8 (AC9) |
  | NV8 | `setLogLevel("error")` | **chunk 2b Step 7** |
  | NV9 | the doctor's `backlog` branch | **chunk 3 Step 7** |

  Chunk 4 hosts six of the nine; NV8 and NV9 run in their own chunks and are part of the same confirmation, and chunk 5 carries the checklist that counts all nine.

  **NV1 — the recovery-key asymmetry** (chunk 4 Step 4, AC4). In `resolveToolHealth`, key the `recoveries` map on `` `${tool} ${errorSig}` `` instead of on `tool` alone. Fails **exactly one** case: `AC4 › a recovery resolves every errorSig row for its tool` — both rows report `outcome: "failing"` and neither carries `recoveredAt`, because a `tool-recovered` event carries no `errorSig` (KPR-454 D5's `detailKeys` is `tool`, `lane`) so the mutated key is `` `${tool} (unset)` `` and matches neither condition row. Predict that `AC3`'s three limbs **stay green** — limb 1 is deliberately written against a `tool-failed` fact rather than a recovery, precisely so the two criteria fail independently — and that `AC5` stays green, since it seeds no recovery at all.
  **NV2 — the class-legality switch** (chunk 4 Step 9, AC16; rehearsed against the unit suite in chunk 1b Step 6). Replace `clearingIsLegal`'s `switch` body with `return condition.class !== "informational";`. Fails **exactly three** of AC16's six limbs: `judgment with zero evidence stays open`, `integrity with zero evidence stays open` and `an unrecognized class stays open` — each reports the condition **absent** from `openConditions` because the clearing fact is now accepted. Predict that the `resource` limb and the `informational` limb **stay green** (the mutation agrees with the rule on both) and that the **same-producer limb stays green**, because the producer test sits above the switch and the mutation does not touch it. That last prediction is what separates NV2 from NV3 in the report.
  **NV3 — the same-producer clause** (chunk 4 Step 9, AC16). Delete `if (clearing.producer !== condition.producer) return false;` from `clearingIsLegal`. Fails **exactly one** limb: `AC16 › a clearing fact from a different producer does not clear` — the condition disappears from `openConditions`. Predict that every other AC16 limb **stays green**, including the two evidence limbs the deleted clause is ANDed with: dropping one conjunct of a passing test leaves it passing.
  **NV4 — stale ⇒ `unknown`** (chunk 4 Step 3, AC3). In `resolveToolHealth`, delete the `latestAt < horizonAt` branch so the outcome falls through to `failing`/`recovered`. Fails **exactly one** case: `AC3 › a fact just outside the horizon reports unknown` — it reports `"failing"`. Predict limb 1 (inside the horizon) and limb 3 (absent key plus the `absenceIsNotHealth` string) **stay green**, and predict that `AC16`'s staleness limb — which drives the *other* view's horizon through `resolveOpenConditions` — also stays green, because the two resolvers hold their own branch. If that second prediction proves false, the two views have been collapsed onto one horizon and D8's "the horizon is a property of the view" has been violated; report it rather than adjusting the prediction.
  **NV5 — `TURN_ACTIVITY_FILTER`** (chunk 4 Step 6, AC7). Delete the `...TURN_ACTIVITY_FILTER` spread from both `readQuietTurns` filters. Fails **exactly one** case: `AC7 › a delivery receipt produces no row` — `matched` reports 7 instead of 6 and a receipt-shaped row appears in `recent`. ⚠ **That limb is only able to fail because its fixture receipt deliberately carries an `error` field.** A schema-faithful KPR-456 receipt (`recordKind`, `receiptId`, `obligationId`, `dueAt`, `producerAgentId`, `destination`, `providerMessageTs`, `acknowledgedAt`, `timestamp`, `schemaVersion` — `src/obligations/types.ts:145-158`) carries none of `error`/`aborted`/`timedOut`, so it fails the union test on its own and the limb would pass under the mutation while asserting nothing. The fixture is therefore a receipt **plus** an `error` field, which is the adversarial input that actually separates a filtered read from an unfiltered one; the companion structural assertion (the `operations` log's recorded filter contains `TURN_ACTIVITY_FILTER`) is what keeps the claim honest about the real shape. Predict the structural assertion goes red too, and record both.
  **NV6 — the measured union** (chunk 4 Step 5, AC6). Replace arm 2's `$or` with the single disjunct `{ error: { $exists: true, $ne: null } }`. Fails **exactly one** case: `AC6 › a fixture of timedOut: true, error: null turns yields a row for every one of them` — `matched` reports 1 instead of 6 and the three `timedOut` rows and two `aborted` rows vanish. Predict `AC6 › zero rows from cost alone` **stays green**: it asserts an absence, and a narrower filter cannot produce one.
  **NV7 — `at` minted once** (chunk 4 Step 8, AC9). Move `const at = deps.clock();` from the parse block into the retry loop in `runAck`. Fails **two** cases, and the report must name both: `AC9 › at is minted exactly once and every accept call carries an identical tuple` (the second call's `at` differs from the first) and `AC11 › unavailable renders as UNKNOWN with the act, handle and fixed at` (the rendered `at` is the *last* attempt's, not the invocation's). Predict that `AC9`'s other five limbs and every other AC11 outcome **stay green** — each of those resolves on the first call, where a re-minted `at` is indistinguishable from a minted-once one. That indistinguishability on the single-call path is exactly why AC9's tuple case is driven through a notifier programmed to return `unavailable`.
  **NV8 — `setLogLevel("error")`** (chunk 2b Step 7). Delete the `setLogLevel("error")` call at `runOps`'s entry. Fails **exactly one** case: `ops › stdout carries exactly one JSON document even when a dependency logs a warning` — the captured `process.stdout.write` calls contain a `{"ts":…,"level":"warn",…}` line beside the JSON document, so `JSON.parse` of the joined stdout throws. ⚠ **The assertion must spy on `process.stdout.write`, not on `deps.emit`** — the logger writes directly to `process.stdout` (`src/logging/logger.ts:22`) and never passes through the CLI's emit seam, so an `emit`-based assertion goes green under this mutation and proves nothing. Predict that every other case in `ops.test.ts` stays green: they assert the payload through `deps.emit`, which the mutation does not touch.
  **NV9 — the doctor's `backlog` branch** (chunk 3 Step 7). In `renderOpsPipelineSection`, delete the `state === "backlog"` exclusion from the warn condition so any state other than `"ok"` warns. Fails **exactly one** case: `doctor › state backlog renders informationally and produces no warn` — a `⚠` line appears in the captured output. Predict that `state degraded warns`, `a stale heartbeat warns`, `non-zero ingestFaults warns` and `a backlog past the retention fraction warns` all **stay green** — the mutation only widens the warn set, and every one of those four already expects a warn. That asymmetry is the reason the `backlog` case is written as a *negative* assertion on the warn count rather than as a positive assertion on the rendered line.

---

## Task and commit map

Five tasks, five commits, in **seven** chunk files (two chunks split — see "Review chunks"; **chunks 1 and 1b are one task and one commit, and so are 2 and 2b**). Tasks are strictly ordered.

| Task | Chunk | Commit subject |
| ---- | ----- | -------------- |
| 1 | 1 + 1b | `feat(KPR-455): ops view resolvers — tool health, open conditions, quiet turns` |
| 2 | 2 + 2b | `feat(KPR-455): hive ops CLI — health, stalled, and the acknowledgement edge` |
| 3 | 3 | `feat(KPR-455): informational ops event pipeline section in hive doctor` |
| 4 | 4 | `test(KPR-455): AC1–AC16 acceptance suite` |
| 5 | 5 | `docs(KPR-455): hive ops commands and the absence-is-not-health gotcha` |

Task 1's module is what makes Task 2 a shell rather than a second implementation — every rendered outcome in the CLI comes from a function Task 1 already pinned. Task 3 depends on Task 1 only for `HEARTBEAT_STALE_MS` and the freshness shape, so it could in principle precede Task 2; **do not reorder it there**, because `src/cli.ts`'s usage block and the doctor section are the two operator-facing surfaces and shipping the second before the first leaves a commit advertising a section for a command that does not exist. Task 4 pins the criteria across all three. Task 5 is documentation and the final gate.

---

## Assumptions carried into implementation

Each is one line; all are non-blocking, and the spec's own are marked as such.

- **Spec's own:** the CLI hosts KPR-468's intake in its own process, and the CAS — not the in-process latch — is what carries the no-blended-write property in both topologies. **The claim to review hardest**, driven by AC10.
- **Spec's own:** the CLI-path snooze clamp falls back to the contract-side hard ceiling, because no tick in this process has retained a policy copy. Vacuous while `ops_policy` ships zero rows; never unbounded.
- **Spec's own:** one edge ships; the Slack button edge is offered as a follow-up and is not built, because KPR-468's transport posts plain text with no `blocks`.
- **Spec's own:** no periodic sweep, because D10's invariants (a) and (b) leave a timer here no legal output.
- **Spec's own:** the reader applies KPR-458 D3's class-legality rule itself rather than borrowing KPR-468's `clearingProvenanceOk`, which reads a ledger row this child may not read. Pinned by AC16's six limbs. If KPR-468 later exports an event-shaped predicate, adopt it and delete this one.
- **Spec's own:** there is no push path for the ticket's part (a) — quiet turns are `activity_log` rows, nothing publishes them into `ops_events`, so no subscription can match them. Visible on demand and by no other means.
- **Spec's own:** arm 1 is specified and empty — no chartered child publishes `workItem`-subject conditions today.
- **Spec's own:** publisher liveness is unobservable out of process; `newestEventAt` is rendered as last-known publisher activity and explicitly labelled *not* a health signal.
- **Plan-writer's own — the rollup is scoped `producer: "hive-runtime"` and `subject.kind: "tool"`, with no flag.** KPR-458 D8 scopes the view to that producer and KPR-454 D4 fixes that subject; identifying the *clearing* events structurally by the presence of `clears` rather than by hardcoding the reason id `tool-recovered` is what keeps the resolver generic within the producer (C16). A second tool producer is a plan revision, not a flag.
- **Plan-writer's own — the key space is enumerated over a discovery window wider than the horizon**, without which "stale" and "absent" are the same observation and AC3's second and third limbs collapse. The payload labels it: absence means "no fact in the discovery window", never "never".
- **Plan-writer's own — `runOps` returns the exit code rather than throwing it.** `runObligations` signals only by throwing, and `src/cli.ts:178` prints a thrown message only when it matches `/^[a-z_]+$/`; KPR-468's refusal vocabulary is kebab-case (`row-cleared`, `integrity-dismissal`), which that guard swallows. Contract refusals are therefore **data in the JSON payload plus a returned exit code**, and the thrown path stays reserved for CLI-local snake_case tokens. This is the spec's D7 rule realized in a signature.
- **Plan-writer's own — arm 2's error disjunct is `{ error: { $exists: true, $ne: null } }`**, because `$ne: null` alone matches a missing field in the in-memory double while excluding it in MongoDB. Verified in-tree at `src/obligations/testing/fake-db.ts:34-35` and `src/obligations/types.ts:216-237`.
- **Plan-writer's own — the CLI resolves `activityRetentionDays` itself**, mirroring `selectInstance`'s own env → instance `.env` → `hive.yaml` precedence, rather than defaulting to 90. The `ack` path hands it to `OpsNotifier`'s constructor, where it determines the `expiresAt` KPR-468 writes on a `seen`/`dismissed` transition; defaulting it would retain a per-person behavioural record past an operator's own retention posture (KPR-458 D9). The read paths use the same value for edge case 7's retention-truncation label. **`selectInstance` is not modified** — the helper re-reads the config path `CliSelection` already carries.
- **Plan-writer's own, a stated departure from edge case 4's "copy verbatim" — the 120 s staleness coercion is applied to the heartbeat's `timestamp`, not to its `lastSuccessfulSweep`.** `ObligationReader.heartbeat()` coerces on `lastSuccessfulSweep` because that is its **only** liveness field; KPR-468's heartbeat splits the two — `timestamp` is written on every tick including a degraded one, `lastSuccessfulSweep` only after an all-ok tick (`kpr-468-plan-3b-notifier.md:352-357`, `:416`, `:424-426`). Coercing on the latter would report a *persistently degraded* notifier as `unknown` after two minutes, which makes AC14's `state: "degraded"` warn unreachable for exactly the wedge the section exists to catch. The precedent is copied on the field that carries the same meaning; both ages are rendered, and a fresh `timestamp` beside a stale `lastSuccessfulSweep` is itself surfaced as the running-but-never-succeeding signature. **Flagged for the reviewer.**
- **Plan-writer's own — an event carrying `clears` is a clearing fact and is never listed as an open condition of its own**, even though it mints its own `dedupeKey` family (KPR-454 D9 step 5). Listing recoveries as permanently-open `informational` conditions would be noise with no consumer.
- **Plan-writer's own — `informational` conditions ARE listed in arm 1** and are labelled, rather than filtered out. They can never be cleared (D3), so filtering them would be this child deciding they do not matter, which is a policy call it may not hold; a `notes.informationalNeverClears` string is the honest alternative.
- **Plan-writer's own — one `--cursor` per invocation, addressing one named section** (`pagedSection`: `tools` for `health`, `quietTurns.recent` for `stalled`). Arm 1 is capped by `--limit` and reports `truncated: true`. A second cursor for a second section on the same invocation would be two page tokens an operator has to keep straight for a list that is tens of rows long.
- The cursor reuses the obligations base64url shape (`src/obligations/reader.ts:19-39`) as a **local copy with its own section enum**, because `decodeCursor`'s zod enum is `"definitions" | "overdue" | "history"` and widening it would be an edit to KPR-456's module.
- `matchedSubscriptions` is rendered as `matchedAtPublish` **with the publishing instant**, never as a present-tense claim in either direction — a zero is not "nobody is on this" and a nonzero is not "claimed".
- Arm 2 renders **that a flag was set**, never `activity_log.error`'s content; a caller who needs the string reads the row in Mongo, deliberately.
