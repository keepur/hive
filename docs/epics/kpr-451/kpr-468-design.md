# KPR-468 — The notifier: ledger, delivery, nudge, clearing and acknowledgement intake

## TL;DR

KPR-468 is the wire between KPR-454's publish and KPR-455's read. It owns `ops_notifications` — the acknowledgement ledger KPR-458 D7 specifies — and the bounded 30 s sweep that mints and renews rows from the stamped `matchedSubscriptionIds`, hands each to an `OpsTransport` adapter, nudges on an operator-registered cadence, expires snoozes, and applies clearing facts; plus **acknowledgement intake**, the one non-swept path, which is the seam KPR-455's inbound edge calls. It holds no policy: it re-evaluates no filter, authors no cadence, resolves no recipient, and ships zero rows of KPR-458 D11's third column. Two things make it safe to merge ahead of KPR-455 without contradicting D12's sequencing rule: with no subscription rows nothing is ever created, and with no registered cadence a row is delivered once and never nudged.

## Key Points

- **Two collections, not three.** `ops_notifications` (D1's third contract collection, this child's to create) and `ops_policy` (a single operator-written document holding the D8 cadence table, D5's named profiles, the minimum-nudge floor and the snooze maximum — **zero rows shipped**). The D12 sweep cursor is deliberately **not** a collection: it is one `db.telemetry` document (`kind: "ops_sweep_cursor"`), beside the sweep's own heartbeat (`kind: "ops_notifier_stats"`), which is the surface KPR-455 reads for freshness and backlog.
- **Idempotence is a watermark, not an event-id equality test — and the contract's own phrasing is not sufficient.** D12 says the upsert "is idempotent per `(row, event)` … a renewal applies only when the row's `latestEventId` is not already that event's id". That guards an exact replay of the *last* event only: a crash mid-page re-processes a page in which one `dedupeKey` was touched twice, and the older of the two touches then passes an equality test and double-counts `eventCount` against C17. Every ledger application is therefore CAS'd **apply-if-strictly-newer** over the same `(publishedAt, _id)` total order the cursor uses, recorded on the row as `appliedThroughAt`/`appliedThroughId`. This is a strict generalization of D12's rule, not a departure from it, and it is what makes *any* prefix replay a no-op (D3, AC4).
- **Clearing is applied to every row on the cleared `dedupeKey`, not to the clearing event's own matches** — and that is load-bearing, not a detail. A clearing reason is `informational` and normally matches **zero** subscriptions (D4); if clearing were scoped to `matchedSubscriptionIds`, a zero-match recovery would clear nothing and D12's own claim that "recovering `resource` conditions do fall silent on their own" would be false (D4, AC6).
- **One transport adapter ships: Slack** — a separate class from KPR-456's `SlackObligationPoster`, sharing its hardening discipline and its proven nonacceptance code list but **never merged with it** (the two contracts are canon-separate). It registers every posted `ts` through `SlackGateway.registerOutboundTs` (`src/slack/slack-gateway.ts:608`), which is the concrete mechanism by which D10 invariant (b) / C14 is true on this transport: an unregistered ops post lands in a channel the bot listens to, becomes a `WorkItem`, and spawns a turn (D6, AC9).
- **`rejected` schedules no retry, because D6 gives it nothing to schedule from.** The contract's `{ status: "rejected"; reason }` carries no retry hint, so this child ships **no retry ladder**: a `rejected` outcome is recorded on the row and the row's next attempt is its next ordinary nudge. `unknown` never re-sends and never reaches `delivered`; the row stays `pending` and `lastOutcome: unknown` is surfaced as uncertainty (C8). Retry ≠ nudge, and collapsing them is the review trap here.
- **First delivery *is* the first nudge.** A fresh or reopened row is created with `nextNudgeAt = now`, so delivery and nudging are literally one query and one code path (D8: "a nudge re-delivers the same ledger row through the same transport"). The consequence is the safe default that makes merging ahead of KPR-455 honest: with no `ops_policy` document, `nextNudgeAt` is unset after the first attempt and the row **never nudges**, resuming the instant an operator registers a cadence.
- **Intake's check order is load-bearing.** Resolve handle → require a stable actor id → **idempotence replay check** → `cleared` refusal → `integrity`-dismissal refusal → D7 transition legality → snooze validation and clamp → CAS. The replay check must precede legality, because `dismissed` is not a "from" state in D7's table: a duplicated dismissal callback must return `noop`, not `refused` (D7, AC8).
- **The snooze clamp always exists.** D12 makes the clamp mandatory, but its maximum is operator data this child ships none of, so intake clamps to `min(requested, at + min(HARD_SNOOZE_CEILING, registered maximum))` with a contract-side hard ceiling in code. A bound is not a cadence: without one, an unregistered deployment would admit an unbounded snooze, which is the terminal state ruling 2 forbids.
- **⚠ Delegated, all non-blocking:** the ledger TTL as `min(30 d, config.activity.retentionDays)` — the acknowledgement-silence horizon, D9's privacy call realized so the behavioural half always ages before the event log; the hard snooze ceiling (7 d); the `attempts[]` ring cap (5); sweep page sizes and per-phase wall-clock budgets; the `evidence`-reference requirement in the `judgment`/`integrity` provenance test; the 60 s subscription reload adopted from KPR-454 D9. **In scope:** the ledger and its indexes, the ingest/cursor handoff, delivery, nudging, snooze expiry, clearing application, intake, the transport interface, one Slack adapter, boot order, shutdown drain. **Out of scope:** match evaluation and the accept path (KPR-454), the inbound acknowledgement edge and every reader, view, CLI and `hive doctor` section (KPR-455), every row of D11's third column, any dashboard, any second transport, any escalation ladder, any de-escalation path.

## Scope and authority

Ticket: **KPR-468 — Notifier — deliver, nudge, clear and accept acknowledgements over the ops-event ledger**. Parent: KPR-451. Worktree baseline: `epic/kpr-451` at `272b17d`; every runtime fact below was read at that tree.

**Binding inputs.** `docs/epics/kpr-451/kpr-458-design.md` is the contract. **D12 is this child's scope statement and its "what it owns" list is exhaustive**; D6 is the transport interface and the inbound edge; D2/D3/D4/D5/D7/D8/D9/D10/D11 and C1–C19 bind, with C8/C9/C10/C14/C17 the criteria this child is measured against. This spec conforms to that contract; it does not amend it. Where D12's own phrasing is insufficient to satisfy a criterion it states (the `latestEventId` idempotence rule against C17, Key Points bullet 2), this spec strengthens the mechanism and says so at the point of use rather than silently.

**The stale-sibling note.** KPR-458's design body at this commit still reads "chartered to no child" for D12 and D6. That is a known-stale artifact, not a contradiction: `docs/epics/kpr-451/kpr-458-plan.md:13` carries the operator's scoping resolution (matcher–deliverer ⇒ **KPR-468**, inbound acknowledgement edge ⇒ **KPR-455**, recorded at KPR-455#comment-1b79ee1a), and that plan's Task 2 appends the addendum recording it. This spec is written against the resolution and does not edit KPR-458's body.

**Dependencies.** **KPR-454** (the producer) is `ready-to-implement` at this tree and is a hard blocker: this child consumes its `ops_events` envelope, its `src/ops/` module set, and its `matchedSubscriptionIds` stamp. **KPR-455** carries the inbound acknowledgement edge; per D12's closing paragraph and this ticket's own body, **KPR-468 must not ship without it** — see D11 for the two properties that make merging ahead of it honest rather than merely tolerable, and the residual that remains.

**Signoff model.** The epic carries `epic-signed-off` (Gate 1 delegation). Delegated calls are ⚠-flagged in the final section. Drafted at Capable tier under a standing operator ruling: `tier-degraded(fable@xhigh->opus@high,operator-choice)`.

**Epic Decision Register canon consulted.** KPR-453's four entries bind indirectly (this child stores no work-item identity of its own; the `evidence` references it renders come from the event, and KPR-453's "identity proves neither unique attempt nor task continuity" is why they are references a responder opens, never a join key). KPR-456's entries bind directly and are preserved: an engineering child supplies **no default recipient, severity, escalation, production registration, prompt rollout, or new policy dependency**, and KPR-456's own unknown/no-automatic-resend rule is **not** superseded by D6's three-outcome taxonomy — the two contracts agree in shape and remain separate in force. KPR-457's separate bounded-retry alert contract is likewise untouched. No canon entry is contradicted; none is amended.

## Verified runtime facts

Read at `272b17d`.

| Fact | Anchor | Note |
| --- | --- | --- |
| The spawn-capable boundary marker | `src/index.ts:474` | The above-boundary wiring block ends at `dispatcher.setMeetingAckEnabled(...)` (`:466`). |
| `boot-order.test.ts`'s three lists | `src/boot-order.test.ts:40` (a), `:64` (b), `:84` (c); `allowlist` at `:100`; the KPR-456 lifecycle block at `:134` | (c) sweeps `.start(`/`.scanOrphans(` occurring **before** `wiringStart = Math.max(...wiring anchors)`. |
| The `workerPool.start()` disjoint-range precedent | wiring `src/index.ts:430`/`:438`, `start()` at `:829` with the rationale comment at `:815-828` | Wiring above the boundary, `start()` deliberately below `dispatcher.registerAdapter(slackAdapter)`. |
| Slack adapter registration and start | `src/index.ts:632` (`dispatcher.registerAdapter(slackAdapter)`), `:634` (`await slackAdapter.start(`) | The earliest point a transport can be bound. |
| KPR-456's start-after-Slack precedent | `src/index.ts:639` — `await obligations.start(config.slack.botToken, (channel, ts) => slack.registerOutboundTs(channel, ts))` | Both the placement and the echo-registration shape this child reuses. |
| KPR-456's drain-before-Slack/Mongo ordering | `src/index.ts:943` (`await obligations.stop()`), `:975` (`await slackAdapter.stop()`), `:976` (`await mongoClient.close()`) | Pinned by `boot-order.test.ts:157-163`. |
| The bounded independent sweep shape | `src/obligations/sweeper.ts:21` (`INTERVAL = 30_000`), `:90-105` (`start`/`stop`), `:106-117` (`sweepOnce`'s single-flight `this.flight`), `:335-377` (`run()` + the `delivery_obligations_stats` heartbeat) | The precedent this child's sweep follows; per-phase `ok` flags feeding a `degraded` state are reused. |
| KPR-456's hardened Slack poster | `src/obligations/slack-post.ts:4-18` (`NONACCEPTANCE` code list), `:19-22` (its own outcome taxonomy), `:54-150` (fixed endpoint, `redirect: "error"`, `allowAbsoluteUrls: false`, origin-header check, `mrkdwn: false`/`parse: "none"`/no unfurl) | The discipline this child's Slack transport copies. Its `PostOutcome` type is **not** reused — different contract. |
| `SlackGateway.registerOutboundTs` / `isOutboundEcho` | `src/slack/slack-gateway.ts:608-614` | The self-echo suppression an ops post must go through, or C14 is false. |
| `config.activity.retentionDays` default | `src/config.ts:659` — `ACTIVITY_RETENTION_DAYS`, `hive.activity?.retentionDays ?? 90` | The event TTL KPR-454 binds; this child's ledger TTL composes against it (D9). |
| `db.telemetry` carries no TTL index and is upserted per `kind` | `src/index.ts:585`; KPR-456's heartbeat write at `src/obligations/sweeper.ts:358-376` | Why the cursor can live there (D3). |
| The obligations test double's update semantics | `src/obligations/testing/fake-db.ts:279-302` — `$set`/`$setOnInsert`/`$inc`/`$unset`/`$max`, `upsert`, unique-index enforcement, `matchedCount`; **no aggregation-pipeline updates**, and `upsert` builds the inserted row from `copy(filter)` | Why D4's write is a two-step conditional-update-then-insert rather than a pipeline update, and why the conditional update must **not** carry `upsert: true`. |

KPR-454's module surface is consumed as planned rather than as built (it is `ready-to-implement`, not merged): `src/ops/types.ts` (`OpsEvent`, `OpsClass`, `OpsRetry`, `Waiting`, `OpsSubject`, `OpsEvidence`, `OpsDetail`, `OpsReason`, `OpsSubscription`, `OPS_*_COLLECTION`), `src/ops/store.ts` (`OpsStore` with `events`/`subscriptions`/`reasons` handles, `loadReasons()`, `loadSubscriptions()`), `src/ops/publisher.ts` (`stripGeneration`, `generationOfDedupeKey`, `reasonIdOfDedupeKey`), and `src/ops/ids.ts`. Integration points are enumerated in full below; every one of them is **read-only or additive**.

## Goals and non-goals

**Goals.** Mint and renew one ledger row per `(subscriptionId, dedupeKey)` from the events KPR-454 stamped, without ever re-evaluating a match. Deliver each row once through a transport adapter and nudge it on an operator-registered cadence until it is acknowledged, snoozed, dismissed or cleared. Apply clearing facts after their D8 provenance test. Accept one attributed acknowledgement act at a time through a bounded, idempotent, attribute-or-refuse intake. Never fail, delay or alter a turn. Never publish anything about itself. Be inert until an operator registers subscriptions and cadence.

**Non-goals.** Match evaluation, the accept path, `ops_events`/`ops_subscriptions`/`ops_reasons` creation, and their above-boundary wiring (all KPR-454). The inbound acknowledgement edge, every reader, view, CLI surface, `hive doctor` section and dashboard (KPR-455, and Gate 1 forbids the dashboard). Any subscription row, transport binding, cadence value, nudge floor, snooze maximum, staleness horizon or reason row (D11 column 3, operator). A second transport. A retry ladder, an escalation ladder, a de-escalation or self-healing path, an attempt ceiling, a terminal give-up, or any automatic demotion. Any change to `agent_events`, the scheduler, `activity_log`, delivery routing, KPR-456's obligation path or KPR-457's Beekeeper sender. Any new `hive.yaml` key.

## Design

### D1. What this child owns, and the two collections it creates

D12's exhaustive list, restated as owned scope: (1) ledger row creation and D7-rule-4 renewal driven by the event's stamped `matchedSubscriptionIds`; (2) calling `deliver` on the bound adapter and recording the outcome; (3) the nudge sweep and snooze expiry; (4) applying a clearing event after its D8 provenance test; (5) acknowledgement intake; (6) counting its own faults. **Match evaluation is not here** and the notifier never imports KPR-454's `src/ops/match.ts` — a structural test pins that (AC2).

Two collections are created, indexed and documented in `CLAUDE.md` by this child (the KPR-452 precedent that a collection documented only in a spec is invisible to the next reader):

- **`ops_notifications`** — D1's third contract collection, the acknowledgement ledger. One document per `(subscriptionId, dedupeKey)`.
- **`ops_policy`** — one operator-written document, `_id: "ops"`, holding the D8 cadence table, D5's named cadence profiles, the minimum-nudge floor and the snooze maximum. **Zero rows ship.** It exists because D5 and D11 make those values operator-registered data and D1 named no home for them; the collection is created and indexed here, and its content is the deployment gate.

A third piece of durable state — D12's sweep cursor — is deliberately **not** a collection, per D12's own ruling that it "is not a fourth collection of this contract" and that its location is the implementing child's choice. See D3.

### D2. The `ops_notifications` document

D7's field list is contract and is carried verbatim; the engine-internal additions are enumerated here so a reader can tell contract from mechanism at a glance. Nothing on the row is a new *fact*: every addition is a watermark, a TTL derivation, or a snapshot of a value the accept path already validated against its registry allow-list (C13).

```
{ _id,                                            // ObjectId; its hex string is the D6 acknowledgement handle
  subscriptionId, subscriberId,

  // D7 snapshot, so a reader needs no join
  dedupeKey, producer, reasonId, class, waiting, retry, subject, generation,

  // D7 event linkage
  firstEventId, latestEventId, eventCount, firstSeenAt, lastEventAt,

  // D7 state
  state, stateAt, principal, principalAt, snoozedUntil?,

  // D7 delivery
  attempts[], attemptCount, lastOutcome, deliveryReference?,

  // D7 nudging
  nudgeCount, lastNudgeAt, nextNudgeAt?,

  // ── engine-internal, this child's ──
  appliedThroughAt, appliedThroughId,   // D3: the (publishedAt, _id) watermark that makes every application idempotent
  stateEventId?,                        // D7's table: the event evidencing a clear or a reopen
  latestDetail, latestEvidence,         // snapshot of the latest applied event's allow-listed detail/evidence, so delivery reads no event
  lastAckKey?,                          // D7/intake idempotence: `${actorId}:${act}:${at.toISOString()}` of the last applied act
  expiresAt? }                          // D9: set only while the row is stopped; the TTL index keys on it
```

`state` is D7's closed six: `pending` · `delivered` · `seen` · `dismissed` · `snoozed` · `cleared`. `principal` is a stable actor id for the three acknowledgement states and the **reserved system principal** — a fixed non-human id no person or agent may hold — for every unattended transition (D7 rule 5, D9). This spec fixes that reserved id as the constant `OPS_SYSTEM_PRINCIPAL`; its literal value is a plan-writer choice bounded only by being unambiguously non-human.

**`attempts[]` is a ring, `attemptCount` is the total.** D7 requires a contract-fixed cap chosen by the implementing child: **5**. Each entry is `{ at, outcome: "accepted" | "rejected" | "unknown", reason?, adapterId }` — never a rendered string, never a raw transport error (C13, and the KPR-457 canon that raw diagnostics stay out of allow-listed fields). `nudgeCount` increments on an attempt made when `attemptCount > 0` at attempt time, so the first delivery is an attempt but not a nudge even though it travels the nudge path (D5).

**Indexes**, created in `init()` on the `obligations/store.ts` shape, each individually contained and counted (D10):

| Collection | Index | Purpose |
| --- | --- | --- |
| `ops_notifications` | `{ subscriptionId: 1, dedupeKey: 1 }` **unique** | Row identity. This is what makes the D4 upsert idempotent under a concurrent or restarted sweep — the duplicate-key error *is* the race detector, not a nuisance. |
| `ops_notifications` | `{ dedupeKey: 1 }` | Clearing application, which fans out across every subscription holding the key and therefore cannot use the compound index above. |
| `ops_notifications` | `{ state: 1, nextNudgeAt: 1 }` | The delivery/nudge scan. |
| `ops_notifications` | `{ state: 1, snoozedUntil: 1 }` | The snooze-expiry scan. |
| `ops_notifications` | `{ expiresAt: 1 }`, `expireAfterSeconds: 0` | D9's state-dependent retention. A TTL on `stateAt` would delete *working* rows; the conditional lives in the field, not the index. |
| `ops_policy` | none beyond `_id` | One document. |

Unlike KPR-454's, **the unique index here carries a correctness role** — it is the only thing preventing two rows for one `(subscriptionId, dedupeKey)` under a racing insert — so it sits on the `MeetingWorkerPool.ensureIndexes()` side of the engine's own line rather than the `MeetingScribe` side. That does **not** make it boot-fatal (D10): a failure to create it leaves the publisher's own posture intact and the notifier **unstarted**, which is this child's defined safe state. The remaining indexes are performance or housekeeping and are contained individually.

### D3. The ingest handoff: cursor, ordering, and idempotence

**The sweep reads `matchedSubscriptionIds` and never re-evaluates matching** (D12, C2). Re-evaluation would let a subscription registered after accept acquire a past event, contradicting D5, and would make the stored count a lie.

**The cursor lives in `db.telemetry`, `kind: "ops_sweep_cursor"`**, holding `{ publishedAt, eventId }` — the position in `ops_events`'s `(publishedAt, _id)` total order through which every ledger application is durable. It is a cursor and not a record: it holds no facts, nothing but the sweep reads it, and it is not a collection of this contract. `db.telemetry` is chosen over a dedicated collection because it is already engine-written, carries no TTL, and is upserted per `kind` — and, critically, because losing it is nearly free under the initialization rule below. The heartbeat is a **separate** document (`kind: "ops_notifier_stats"`) so that overwriting stats can never clobber the cursor.

**A missing cursor initializes to the server clock, never to the beginning of the log**, with a counted warning. This is the cold-start rule and it is deliberate in both directions. Forward: KPR-454 ships ahead of this child and accumulates events for however long the epic takes, and a notifier that woke up and delivered weeks of backlog would be exactly the flood this epic exists to remove — worse, it would re-mint rows for conditions whose ledger rows had already aged out under D9, resurrecting long-dead acknowledgements. Backward: the cost of the rule is that events published while no cursor existed are never notified, which for a cursor lost at time *T* and re-initialized on the next tick is bounded by one sweep interval and is countable in the heartbeat's `eventsBehind`.

**Advance only after the writes are durable.** Each tick reads a bounded page of `ops_events` strictly after the cursor, sorted `{ publishedAt: 1, _id: 1 }` (the index KPR-454 creates for exactly this), applies each event **strictly in order**, and writes the cursor to the last fully-applied event's position with majority write concern only after the page's writes have been acknowledged. A crash between the two re-processes the page rather than skipping it (D12), which is safe because of the next rule. Ordering is what makes D12's guarantee that "a clearing event can never be applied before the condition event it clears" true by construction rather than by luck; an out-of-order application within a page would break it.

**Idempotence is apply-if-strictly-newer, which is a strengthening of D12's stated rule and the reason it is stated here.** D12 offers `latestEventId` equality — "a renewal applies only when the row's `latestEventId` is not already that event's id". That is sufficient for a replay of exactly one event and insufficient for the crash D12 itself describes: re-processing a page in which one `dedupeKey` appears twice replays the *older* touch against a row whose `latestEventId` names the newer one, the equality test passes, and `eventCount` increments a second time — a direct C17 failure. Every application therefore CAS's on

```
appliedThroughAt < e.publishedAt  ∨  (appliedThroughAt = e.publishedAt ∧ appliedThroughId < e._id)
```

and sets `appliedThroughAt`/`appliedThroughId` to the applied event's position in the same write. Consequences: replaying any prefix of the log is a total no-op; an out-of-order event is discarded rather than mis-applied; `eventCount` counts distinct events, never sweep attempts (C17); and a re-processed clearing event cannot re-clear a row that has since been reopened and re-cleared by a newer fact. The `(publishedAt, _id)` comparison is the same total order KPR-454's epoch resolver uses and rests on the same property — the publisher's serial drainer is the sole `_id` minter, so insertion order is publish order.

**Page sizes and per-phase budgets are delegated; the behaviour on breach is fixed.** A tick ingests successive pages until a page is short or a per-tick event budget is reached; leftover work is picked up on the next tick and is visible as `eventsBehind` in the heartbeat. Nothing is dropped and nothing is skipped.

**One honest gap, named rather than papered over.** If the sweep falls so far behind that events reach `ops_events`'s TTL horizon before it reaches them, those events are deleted and the cursor advances past a gap. The heartbeat's `eventsBehind` against the event TTL is the only signal, and it is the signal a reader (KPR-455) should surface. No mechanism prevents it, because the alternative — holding events past their retention — would contradict D9.

### D4. Row creation, renewal, and clearing application

For each event `e` in log order, two independent applications, in this order:

**(a) Clearing, when `e.clears` is present.** Every row whose `dedupeKey` equals `e.clears` — **across all subscriptions, independent of `e.matchedSubscriptionIds`**. This scope is not an optimization and reversing it breaks the contract: a clearing reason is `informational` and normally matches zero subscriptions (D4's example table and KPR-454's own `tool-recovered` row), so a match-scoped clearing would clear nothing, every `resource` condition would nudge forever, and D12's assertion that "recovering `resource` conditions do fall silent on their own — D4's enable gate guarantees every `resource` reason has a registered clearing reason" would be false.

The **provenance test is decided by the cleared row's snapshotted `class`** (D8, using D3's table), and it is restricted to what the envelope makes checkable — this component judges nothing:

| cleared row's `class` | test |
| --- | --- |
| `resource` | `e.producer === row.producer` — D3's "a clearing event from the same producer asserting the recorded predicate now holds". |
| `judgment` | same producer **and** `e.evidence.length >= 1` — D3's "an event recording a named human ruling"; the ruling's record is the reference. ⚠ delegated. |
| `integrity` | same producer **and** `e.evidence.length >= 1` — D3's "only a clearing event carrying the underlying authoritative evidence", read literally. ⚠ delegated. |
| `informational` | never clears (D3: "no clearing act"). |

The same-producer clause is already guaranteed upstream — D4 requires `clearsReasonIds` to name reasons of the *same* producer and C19 enforces it at publish — so it is a cheap defence-in-depth assertion here, not a second policy. A clearing event that fails its test **is already stored** (the publisher stored it; it is a fact that someone tried) and **does not transition the row**; the notifier counts `clearRefused` and moves on. A clearing event naming a `dedupeKey` with no row is a counted no-op — nobody was listening, which D8 says is answered from the log rather than from the ledger.

On a passing test the row transitions to `cleared` under the system principal with `stateEventId = e._id`, `expiresAt` set (D9), and `nextNudgeAt` unset. **A `dismissed` row does clear** — D7's table admits "any state → `cleared`", and that is correct: a dismissal stops nudging a subscriber, and a later clearing fact records that the condition genuinely resolved. **A `cleared` row is a no-op** by the D3 watermark.

**Epoch interaction, stated because it is the question a reviewer asks first.** The notifier is generation-blind by construction. `generation` is a component of `dedupeKey` (D2's formula), so a new epoch is a different key and therefore a different row: an advanced generation mints a fresh `pending` row beside the closed one and can never touch it. A clearing event carries an exact `dedupeKey` in `clears`, so it can only ever reach its own epoch's row. KPR-454 D8's named residual — a faulted epoch resolve attaching an event to a stale epoch's key — lands here as a clearing fact applied to a stale row that was already stale: a bounded mis-attachment of a notification, never a lost fact, exactly as that spec states.

**(b) Renewal or creation, for `e`'s own `dedupeKey`, across `e.matchedSubscriptionIds`.** Each stamped id is resolved against the loaded subscription map (D5). A stamped subscription that is absent, disabled, or whose target fails `validateTarget` yields **no row**, and the event's stored `matchedSubscriptions` count still stands — D12's exact rule: the count was honest for the set that existed at accept and was never a delivery promise. A clearing event also mints or renews its **own** rows here for any subscriber that deliberately subscribed to recoveries (D4); it never renews the cleared condition's row, which transitions by (a) alone.

The write is **two steps, not an aggregation-pipeline update**, because the `(subscriptionId, dedupeKey)` unique index must remain the race detector and the repo's test double supports neither pipeline updates nor an upsert whose filter carries operators (`fake-db.ts:279-302`):

1. `updateOne({ subscriptionId, dedupeKey, <apply-if-newer CAS> }, { $set: renewal, $inc: { eventCount: 1 }, ... })` — **no `upsert`**. `matchedCount === 1` ⇒ applied. `matchedCount === 0` ⇒ either the row does not exist, or it exists and the event is not newer.
2. On `matchedCount === 0`, `insertOne` a fresh row. A duplicate-key error means the row existed and the event was not newer — the second branch of step 1's ambiguity — and is a **no-op, not a fault**: caught, counted as `renewalStale`, never surfaced as an error.

Fresh rows are created `state: "pending"`, `principal: OPS_SYSTEM_PRINCIPAL`, `firstEventId`/`latestEventId` = `e._id`, `eventCount: 1`, `attemptCount: 0`, `nudgeCount: 0`, `nextNudgeAt: now` (D5), `appliedThrough*` at `e`'s position.

Renewal semantics are D7 rule 4 verbatim, applied against the existing state:

| row state | renewal effect |
| --- | --- |
| `pending`, `delivered` | `latestEventId`/`lastEventAt`/`eventCount`/`latestDetail`/`latestEvidence` advance. `nextNudgeAt` is **not** reset — a repeat must not restart the cadence clock, or a flapping producer nudges on its own schedule instead of the operator's. |
| `seen`, `dismissed` | advance and send nothing new. |
| `snoozed` | advance; the row still resumes on its own at `snoozedUntil`. |
| `cleared` | **reopen** to `pending` under the system principal with `stateEventId = e._id`, `nextNudgeAt = now`, `expiresAt` unset. The condition demonstrably came back while the producer did not, or could not, advance its epoch, and the design errs toward a duplicate rather than a gap. |

### D5. Cadence, the nudge sweep, and snooze expiry

**Cadence comes from the contract's data, never from this component.** The `ops_policy` document (D1), read once per tick — one small `findOne`, so it is always fresh and needs no reload timer:

```
{ _id: "ops",
  cadence?: { "<class>:<retry>": <intervalMs> },   // D8's table, keyed exactly as D8 keys it; at most 8 entries
  profiles?: { "<name>": <intervalMs> },           // D5's named cadence profiles
  minNudgeIntervalMs?: number,                     // D5's operator-set floor
  maxSnoozeMs?: number }                           // D8/D12's snooze maximum
```

Resolution for one row, and **the anti-merge rule is enforced rather than documented**:

- If the row's subscription names a `cadenceProfile`, the interval is `profiles[name]` and **the `(class, retry)` table is not consulted at all** — D5's "substitutes that profile wholesale", with no field-by-field merge, no per-attribute override, and no inheritance. An **unknown** profile name therefore does **not** fall back to the table: the row resolves no cadence, is counted `cadenceUnresolved`, and does not nudge. A fallback would be precisely the two-tables-and-an-implicit-precedence rules engine D5 refuses.
- Otherwise the interval is `cadence["<row.class>:<row.retry>"]`.
- Either way the interval is clamped up to `minNudgeIntervalMs` when set, and a profile below the floor is clamped up with a **warn-once per profile per load** — D5 says "loudly, at registration", and registration here is a Mongo write by an operator that no code path observes, so load time is the honest substitution.
- **No resolvable interval ⇒ `nextNudgeAt` is unset and the row does not nudge.** This is the deployment gate, not a failure: D11 makes cadence values operator-registered data that this child ships none of, and KPR-456 canon forbids an engineering child supplying a default policy dependency. A row resumes nudging on the first tick after a cadence is registered.

**First delivery is the first nudge.** A fresh or reopened row carries `nextNudgeAt = now`, so one query — `{ state: { $in: ["pending", "delivered"] }, nextNudgeAt: { $lte: now } }` — serves both, and there is exactly one delivery code path (D8: "A nudge re-delivers the same ledger row through the same transport; it never creates a second row"). `seen`, `dismissed` and `cleared` are not nudge-eligible; `snoozed` is suppressed until expiry.

**One attempt, per row, per tick:**

1. Resolve the subscription from the loaded map; unresolved ⇒ skip, counted (the operator kill switch, D11).
2. Resolve the adapter by `subscription.transport.adapterId`; unbound ⇒ skip, counted `transportUnbound`, row untouched.
3. Build the `NotificationView` (D6) and `await adapter.deliver(view)`, bounded by **the adapter's own deadline, not by the sweep's patience** (D12).
4. Record the outcome: push onto the `attempts[]` ring, `$inc attemptCount`, `$inc nudgeCount` when the row had already been attempted, set `lastNudgeAt`, set `lastOutcome`.
   - `accepted` ⇒ `state: "delivered"` (from `pending`) under the system principal, `deliveryReference` set, `nextNudgeAt = now + interval`.
   - `rejected` ⇒ state unchanged, `nextNudgeAt = now + interval`. **No retry ladder ships**, and the contract is what decides that: D6's `{ status: "rejected"; reason }` carries no retry hint, so this component has nothing to schedule a retry from and inventing a backoff schedule would be cadence policy by another name. C8 permits an automatic retry on `rejected`; it does not require one, and the row's next ordinary nudge *is* the retry, reusing the same row and incrementing the same counters exactly as D6 requires.
   - `unknown` ⇒ state unchanged (it never reaches `delivered`), `nextNudgeAt = now + interval`, and `lastOutcome` is what every reader must surface as **uncertainty, never as notified** (C8). This is KPR-456's rule preserved, not superseded: nothing is re-sent on the strength of an `unknown`; the later nudge is the condition's ordinary cadence, not a resend of the attempt.
   - An adapter that **throws** rather than returning an outcome is contained and recorded as `unknown` / `transport-fault`, counted, never escaping the tick.

**Delivery is spaced and budgeted.** Attempts within a tick are made one at a time with a minimum start spacing (the shape KPR-457 proved, adopted as a shape and not as its contract) and the phase stops on a wall-clock budget, deferring the remainder to the next tick with the backlog visible in the heartbeat. Values are ⚠ delegated; the behaviour on breach is fixed.

**Snooze expiry** is its own bounded phase: `{ state: "snoozed", snoozedUntil: { $lte: now } }` ⇒ **`delivered` if the row has a recorded `accepted` outcome, else `pending`** (D7's table verbatim), under the system principal, with `nextNudgeAt = now` and `snoozedUntil` unset. D7 is explicit that an expired row is not "eligible" but *is* nudge-eligible by that fact, so no special case exists downstream.

**Sweep cadence, boundedness and non-overlap.** A 30 s interval, the KPR-456 precedent (`sweeper.ts:21`), with `sweepOnce()`'s single in-flight promise (`:106-117`) so ticks never overlap. Each phase is independently contained: a fault in one row is caught, counted, and does not abort the tick or block the next one (D12 containment (b)). The tick checks its stopped latch between rows and phases so shutdown drains promptly.

**Honesty when behind.** Every tick upserts `db.telemetry` `kind: "ops_notifier_stats"`: `lastSuccessfulSweep`, `cursorAt`, `eventsBehind`, `rowsPending`, `rowsNudgeDue`, `rowsSnoozed`, `rowsUnknownOutcome`, `rowsTransportUnbound`, `rowsCadenceUnresolved`, the fault counters, and a `state` of `ok` | `backlog` | `degraded` on the KPR-456 pattern (all phases succeeded and no backlog ⇒ `ok`; all succeeded with backlog ⇒ `backlog`; any phase failed ⇒ `degraded`). This is the measurement surface KPR-455 reads. **No `hive doctor` section ships here** — the reader is KPR-455's charter.

### D6. The transport interface and the one adapter

The interface is KPR-458 D6 verbatim and is not amended:

```typescript
interface OpsTransport {
  readonly adapterId: string;
  validateTarget(target: unknown): boolean;
  deliver(n: NotificationView): Promise<DeliveryOutcome>;
}
```

`DeliveryOutcome`, `NonacceptanceReason` and `UncertaintyReason` are D6's closed sets, transcribed unchanged into `src/ops/transport.ts`. An adapter never extends them and maps everything it cannot prove to `unknown`.

**`NotificationView` is structured and carries the resolved target**, which is a faithful reading of D6 rather than an amendment: `deliver` takes exactly one argument, so the target the notifier resolved from `subscription.transport.target` must ride the view. D6 bars an adapter from *choosing or discovering* a recipient; being handed one is the whole point.

```typescript
interface NotificationView {
  handle: string;                                  // opaque; names one ledger row
  target: unknown;                                 // adapter-scoped, resolved by the notifier, opaque to it
  event: { producer; reasonId; class; retry; waiting; subject; generation;
           dedupeKey; publishedAt; detail; evidence };
  remediation?: { template: string; parameters: OpsDetail };
  ledger: { state; eventCount; nudgeCount; attemptCount; firstSeenAt; lastEventAt };
}
```

Never in the view: a rendered message string, a subscriber id, a channel or person name, a severity, an owner, or anything D2 lists as explicitly absent. The adapter owns rendering, because a Slack block, an SMS body and a push payload are different artifacts of the same fact.

**`remediation` is resolved from `ops_reasons`, read-only.** The notifier loads its own `(producer, reasonId) → OpsReason` map at `init()` through KPR-454's `OpsStore.loadReasons()` — the same no-reload posture the publisher takes, so **restart is the lever** and a template change lands at the next boot. An unknown reason omits `remediation` and never blocks delivery (counted `reasonUnknown`). A pure `renderRemediation(template, detail)` helper performs `{key}` substitution over allow-listed parameters only; adapters may call it, and it is offered rather than imposed.

**`validateTarget` is called at subscription load, not at code registration.** Subscriptions are operator-registered Mongo rows, so "registration time" for a target is the moment the notifier loads it. A target that fails validation makes that subscription **unloaded in memory** — never mutated in the database, because operator data is not the engine's to rewrite — warned once per subscription per load and counted.

**The subscription map** is loaded at `init()` and refreshed on a 60 s timer and on the existing `SIGUSR1` handler, mirroring KPR-454 D9 exactly (`unref()`ed, cleared in `stop()`, a fault leaves the previous set in place and counts, never empties it). D12 already rules that a reload lag means a just-registered subscription may miss an event by seconds, and D5 forbids retrospective enrolment either way.

**The one adapter: Slack.** `SlackOpsTransport`, `adapterId: "slack"`, registered only when Slack is configured. It is a **separate class from `SlackObligationPoster`** and the two are never merged: KPR-456's poster returns KPR-456's own `PostOutcome` taxonomy under a contract canon explicitly preserves, and a DRY-motivated unification would make one contract's change a silent change to the other. What is copied is the hardening, item for item (`slack-post.ts:54-150`): the fixed `chat.postMessage` endpoint, `allowAbsoluteUrls: false`, `redirect: "error"`, the `x-slack-req-id` origin check, HTTP 200 **plus** `ok: true` plus a channel/ts shape check, `mrkdwn: false` / `parse: "none"` / `link_names: false` / no unfurl, and a bounded body.

Its vendor mapping is **exactly** KPR-456's proven `NONACCEPTANCE` list (`slack-post.ts:4-18`) projected onto D6's set, with nothing added:

| Slack code | `NonacceptanceReason` |
| --- | --- |
| `not_authed`, `invalid_auth`, `token_expired`, `token_revoked` | `unauthenticated` |
| `missing_scope`, `no_permission`, `ekm_access_denied`, `restricted_action` | `unauthorized` |
| `channel_not_found` | `target-unknown` |
| `not_in_channel`, `is_archived` | `target-ineligible` |
| `rate_limited`, `ratelimited`, or an origin-verified HTTP 429 | `refused-rate-limit` |

`payload-rejected` is in the type and has **no Slack mapping**, deliberately: D6 (carrying KPR-456's rule into both contracts) admits a new nonacceptance mapping only with documented evidence that the response proves nonacceptance, plus a classifier test. Everything else — timeout, malformed body, unrecognized code, crash after submission — is `unknown`.

**The echo registration is a correctness requirement, not hygiene.** Every accepted post calls `SlackGateway.registerOutboundTs(channel, ts)` (`slack-gateway.ts:608`), exactly as KPR-456 wires it at `index.ts:639`. Without it, an ops notification posted into a channel the bot listens to is re-ingested as a `WorkItem` and **spawns an agent turn** — which is D10 invariant (b) and C14 violated, and worse, a turn that fails a tool republishes and the loop closes. `deliveryReference` is `{ kind: "slackMessage", id: "<channel>:<ts>" }` (a reference, never a URL — C13).

### D7. Acknowledgement intake — the seam KPR-455 calls

Intake is D12 item (5) and belongs here, not on the adapter: the ledger is the only thing an acknowledgement writes, D6 bars an adapter from touching it, and D7's rules are the same ones this component already enforces on every other transition. It is **the one part of this component that is not swept** — a direct, bounded write on the acknowledging caller's own path, because an acknowledgement that takes a sweep interval to register invites the operator to press the button twice.

**The API KPR-455's edge calls**, and the whole of the seam:

```typescript
type OpsAck = "seen" | "dismissed" | "snoozed";

interface OpsAcknowledgement {
  handle: string;          // the handle from the NotificationView; opaque, never parsed by the caller
  act: OpsAck;
  actorId: string;         // a stable id — a Slack user id, an agent slug; never a display name
  at: Date;                // the instant of the vendor act, not the edge's receipt time (see idempotence)
  snoozedUntil?: Date;     // required for "snoozed"
}

type OpsIntakeRefusal =
  | "unknown-handle" | "unattributed" | "row-cleared"
  | "integrity-dismissal" | "snooze-not-future" | "illegal-transition";

type OpsIntakeResult =
  | { state: "applied"; rowState: OpsNotificationState; snoozedUntil?: Date }  // clamped value echoed back
  | { state: "noop"; reason: "already-applied" }
  | { state: "refused"; reason: OpsIntakeRefusal }
  | { state: "unavailable" };                                                  // not started, stopping, or storage fault

accept(input: OpsAcknowledgement): Promise<OpsIntakeResult>   // never throws
```

**The handle** is the ledger row's `_id` rendered as a hex string. It is opaque by contract: no consumer parses it, and its derivation may change. It **names** a row and confers no authority — D9's model is attribution, not authorization, and every act records who performed it. ⚠ Named residual: a handle round-tripped through a vendor payload (a Slack action `value`) can in principle be altered by the actor, so a determined workspace member could acknowledge a row they were not shown. The act is still attributed to them, which is the contract's stated remedy; nothing here adds an authorization model, and doing so would be policy this component may not hold.

**The check order is load-bearing and is fixed here**, because two of its steps are order-sensitive in ways a natural implementation gets wrong:

1. **Resolve the handle** to exactly one row. Malformed or unresolvable ⇒ `refused: "unknown-handle"`.
2. **Attribute or refuse.** A missing, blank or non-string `actorId` ⇒ `refused: "unattributed"`. Never attributed to the adapter, to a service account, or to the reserved system principal — which by D7 rule 5 can never produce these three states at all.
3. **Idempotence replay check, before legality.** An incoming act whose `${actorId}:${act}:${at.toISOString()}` equals the row's `lastAckKey` ⇒ `{ state: "noop" }`. This must precede step 6 because `dismissed` is **not** a "from" state in D7's table: a duplicated dismissal callback checked in the other order returns `refused: "illegal-transition"`, which is a lie about a no-op and exactly the kind of error an inbound edge would then try to handle.
4. **`cleared` refusal.** Any act on a `cleared` row ⇒ `refused: "row-cleared"`. D7 admits no such transition, and this is the ordinary race in which a clearing fact lands between a delivery and the acknowledger's click. Nothing is recorded, and KPR-455's edge must treat this refusal as **benign** — a no-op for the acknowledger, not an error they must surface.
5. **`integrity` dismissal refusal.** `act === "dismissed"` on a row whose snapshotted `class` is `integrity` ⇒ `refused: "integrity-dismissal"` (D7 rule 3: if an integrity condition can be dismissed like an ordinary alert, someone eventually dismisses one and a gate is skipped).
6. **Transition legality** against D7's table: the from-state must be one of `pending`, `delivered`, `seen`, `snoozed`. Anything else ⇒ `refused: "illegal-transition"`.
7. **Snooze validation and the clamp.** `act === "snoozed"` with `snoozedUntil` absent or not strictly after `at` ⇒ `refused: "snooze-not-future"` (D12: "not a pause at all"). Otherwise the value is **clamped and applied, never refused** (D12: refusing would leave the row unpaused and nudging, the opposite of what the acknowledger asked for):

   ```
   snoozedUntil = min(requested, at + min(HARD_SNOOZE_CEILING, policy.maxSnoozeMs ?? HARD_SNOOZE_CEILING))
   ```

   **A clamp must always exist**, which is why a contract-side hard ceiling lives in code (⚠ 7 days, delegated). D12 makes intake the only place a `snoozedUntil` enters the system precisely so that an unclamped one cannot become "a terminal state by another name", and an unregistered `ops_policy` must not be the hole that reintroduces one. The operator's registered maximum can only tighten it. The clamped value is echoed in the result so the edge can tell the human what it actually did.

8. **Apply**, as one CAS conditioned on the row's current `state` and `lastAckKey`: set `state`, `stateAt = at`, `principal = actorId`, `principalAt = at`, `lastAckKey`, `snoozedUntil` (or unset it for `seen`/`dismissed`), `expiresAt` per D9, and clear `nextNudgeAt` for `seen`/`dismissed` (both stop nudging) or set it aside for `snoozed`. A lost CAS — a sweep tick moved the row between read and write — retries **once** and then returns `{ state: "unavailable" }`.

**Re-snoozing an already-`snoozed` row moves `snoozedUntil` and nothing else** (D7's table). **`snoozed` does not clear and `dismissed` does not clear** — only a class-legal clearing fact does (D4).

**Bounded and contained.** Intake is one indexed read plus one CAS under a wall-clock deadline (⚠ delegated), never throws, never publishes (D10 invariant (a)), never spawns a turn (invariant (b)), and records **the principal and the instant and nothing else** — no display name, no email, no device, no client, no location, and deliberately no free-text reason for a dismissal (D9).

**What the edge owes, restated so KPR-455 has it in one place** (D6, unchanged and binding on that child, not this one): convert one vendor-specific act into one `accept(...)` call and do nothing else; never read or write the ledger or `ops_subscriptions`; hold no state; attribute or refuse — a read receipt, a channel visit, an emoji reaction or elapsed time is **not an act**, and this edge must not manufacture one from any of them. Idempotency, class legality and state legality are intake's job, so a duplicate callback is safe and the edge needs no memory.

### D8. Single-flight, containment, and the fault counters

**Single-flight per row** (D12). Ticks never overlap and a tick acts on a row at most once, so intra-sweep concurrency is impossible by construction. The one genuine race is intake against a tick on the same row, and it is **serialized, never merged**: a per-row in-process latch (a `Map<rowId, Promise>` chain, entries deleted on settle so the map is bounded by in-flight work) orders them, and every ledger write is additionally a CAS on the precondition it depends on, so a lost race is *detected* rather than blended. Cross-process concurrency is out of model — KPR-456 canon fixes the single-engine assumption and this child introduces no new work identity, no lease, and no elapsed-time reclamation.

**Containment, in D12's three separate senses, which must not be merged.**

(a) *Never fails, delays or alters a turn.* None of this component's work is on a turn path, and that is structural rather than promised: nothing in the sweep, the transports, or intake is imported by `agent-runner.ts`, `tool-bridge.ts`, `dispatcher.ts` or `agent-manager.ts`, and an import-graph test pins it (AC2). Intake runs on the acknowledging caller's own path — an operator command, a transport callback, or an agent's tool call on a turn it was already running — so its bounded write is the acknowledger's own cost.

(b) *A tick contains its own faults.* Per-row `try`/`catch`, counted, tick continues; per-phase `ok` flags feed the heartbeat's `degraded` state; ticks never overlap; a stuck adapter call is bounded by the adapter's own deadline, not by the sweep's patience.

(c) *Faults are counted, never published.* D10 invariant (a), and this is where it earns its keep: a wire that published its own delivery, nudge or intake failures into the surface it serves would be the feedback loop the invariant forbids. Counters live in memory behind a `getSnapshot()` and in the heartbeat document; **nothing about the ops path is ever published as an `ops_event`**, on any path, including the transports. And invariant (b) binds absolutely: **no delivery may synchronously spawn an agent turn** — the Slack echo registration in D6 is the concrete mechanism, not a nicety.

**Counters**, exposed by `getSnapshot()` and mirrored to the heartbeat: `eventsApplied`, `rowsCreated`, `rowsRenewed`, `renewalStale`, `rowsCleared`, `clearRefused`, `clearNoRow`, `deliveriesAccepted`, `deliveriesRejected`, `deliveriesUnknown`, `transportFaults`, `transportUnbound`, `cadenceUnresolved`, `reasonUnknown`, `subscriptionUnloaded`, `intakeApplied`, `intakeNoop`, `intakeRefused`, `intakeUnavailable`, `cursorReinitialized`, `sweepFaults`, `subscriptionReloadFaults`, `indexFailures`.

### D9. Retention: the ledger TTL and the acknowledgement-silence horizon

D9 requires a row to be **retained while it is still working** — `pending`, `delivered`, `snoozed` — and to TTL from `stateAt` once it has stopped — `seen`, `dismissed`, `cleared` — so attributed actor data ages out with the row that carries it. A Mongo TTL index cannot be state-conditional, so the conditional lives in a field: `expiresAt` is **set** on every transition into a stopped state (`stateAt + ledgerRetention`) and **unset** on every transition out of one (the `cleared → pending` reopen, the snooze expiry). The index is `{ expiresAt: 1 }, expireAfterSeconds: 0`. A TTL on `stateAt` instead would delete working rows and is the specific mistake this paragraph exists to prevent.

**The value is `min(30 days, config.activity.retentionDays)`.** ⚠ Delegated, non-blocking, and composed rather than copied for a stated reason: D9 rules that "an operator who wants longer retention of ops history should extend the event TTL and not the ledger's, so the behavioural half ages first", and KPR-454 binds the event TTL to `config.activity.retentionDays` (default 90, `src/config.ts:659`). A fixed 30 days satisfies the direction invariant at the default and violates it for an operator who sets activity retention to 14; the `min` keeps the invariant true for *any* setting with no new `hive.yaml` key. **No lever ships** (the standing "no preemptive levers" preference); raising the horizon is a code change.

D9's named consequence is carried here unchanged and must be stated to an operator rather than discovered: **acknowledgement silence lasts until the condition recovers and recurs (a new epoch, KPR-454 D8) or until this TTL elapses, whichever comes first.** Once a row ages out, a still-recurring condition re-mints under the same `dedupeKey` at `pending` and nudges again as though never acknowledged. Deliberate in both directions — a per-person behavioural record should not be kept indefinitely for a condition nobody ever cleared, and, as everywhere in this design, the race errs toward a duplicate nudge rather than a silent gap.

`ops_policy` carries no TTL: it is operator configuration, not history.

### D10. Boot order, start, and shutdown drain

**Above the boundary** (`src/index.ts:474`), in the wiring block ending at `:466`: construction, `await opsNotifier.init()` (collections, indexes, the reason map, the first subscription load, the reload timer), and `setOpsNotifier(opsNotifier)` — a module-global singleton with a test reset, the `provider-registry.ts` / KPR-454 `publisher-singleton.ts` precedent. Unset ⇒ every intake call returns `{ state: "unavailable" }`, which keeps the pre-wiring boot window and every bare test construction correct by construction.

The ticket fixes this placement, and the reason it is right rather than merely mandated: **intake is reachable from a turn.** D6 names an agent tool call as one of the inbound surfaces, so once KPR-455 wires an agent-facing edge the intake singleton *is* a per-spawn read; wiring it above the boundary now is what keeps that true without a later move — which is exactly the class of silent breakage KPR-414 was spent removing.

⚠ **Naming collision, the same trap KPR-454's plan flags:** `src/ops/notifier-singleton.ts` exports a reader named `opsNotifier()`. `index.ts` imports only `setOpsNotifier`, so the local `const opsNotifier` is unambiguous — but the boot-order anchors are the literal strings `await opsNotifier.init()` and `setOpsNotifier(`, so the local variable name is load-bearing for the guard and the reader import must never be added to `index.ts` without renaming one of the two.

**`init()` is non-fatal to boot, with a split posture** mirroring KPR-454 D10 but drawn one line differently, because this child's unique index carries a correctness role (D2):

- The `(subscriptionId, dedupeKey)` **unique index failing leaves the notifier unstarted** — construction succeeds, the singleton is not set, the sweep never starts, and boot continues. Running the ledger without its identity guarantee is worse than not running it.
- Every other index fault is individually contained and counted and keeps the notifier usable.
- A reason-map or subscription load fault leaves the notifier **unstarted**, for KPR-454's reason: a started notifier over an empty subscription map would create no rows and look identical to "nobody subscribed", spending an honest signal on a Mongo outage.
- **Nothing here is fatal to boot.** An ops-diagnostics surface that can prevent the engine from starting is strictly worse than one that is absent, and "unstarted ⇒ inert" is this spec's defined safe state everywhere else.

**Below the boundary**, immediately after `await obligations.start(...)` at `index.ts:639` — that is, after `dispatcher.registerAdapter(slackAdapter)` (`:632`) and `await slackAdapter.start(...)` (`:634`):

```
opsNotifier.registerTransport(new SlackOpsTransport(config.slack.botToken, (c, ts) => slack.registerOutboundTs(c, ts), ...));
await opsNotifier.start();
```

This is the `workerPool.start()` disjoint-range precedent (`index.ts:815-828`) stated for a second subsystem: wiring-above-the-boundary and start-after-adapters have deliberately disjoint valid ranges, because a sweep that begins before its adapters exist would burn attempts against nothing (D12) — here, every due row would resolve `transportUnbound` and the counter would fill with boot noise.

**Shutdown** adds `await opsNotifier.stop()` immediately after `await obligations.stop()` (`index.ts:943`), which places it before `slackAdapter.stop()` (`:975`) and `mongoClient.close()` (`:976`) — the KPR-456 ordering D12 names. `stop()` sets the stopped latch, clears the reload timer, stops accepting new intake, and awaits the in-flight tick, which exits at its next inter-row checkpoint; the drain is therefore bounded by one adapter deadline rather than being open-ended.

**`src/boot-order.test.ts` gains anchors in all three lists** — presence (a), the `wiringOffsets` array (b), and the `wiringStart` `Math.max` set (c), whose superset sweep must be bounded by the **latest** wiring anchor or a surface introduced between two wiring calls passes green. Adding to (a) alone is the exact failure mode the guard exists to catch. The two anchors are `await opsNotifier.init()` and `setOpsNotifier(`. `await opsNotifier.start()` sits **after** `wiringStart`, so (c)'s sweep does not see it and its `allowlist` needs no entry — a placement a later refactor must preserve or explicitly allowlist under the reviewed-classification discipline that list's comment demands. A second `describe` block, on the KPR-456 lifecycle-block pattern (`boot-order.test.ts:134-164`), pins the start-after-adapters and drain-before-Slack/Mongo orderings, and a negative-verify moves the wiring below the marker and confirms (b) and (c) both fail.

### D11. Levers: what an operator can turn off, and what rollback is

**No `hive.yaml` key ships.** Every lever is data, the KPR-454 posture and the standing "no preemptive levers" preference:

1. **Per-subscription kill switch.** `ops_subscriptions.enabled: false` on a row ⇒ within one reload (≤ 60 s) that subscription is unloaded, no new rows are created for it, and **its existing rows are neither delivered nor nudged**. Rows are left in place, never deleted, so re-enabling resumes exactly where it stopped. This is the lever an operator reaches for at 2 a.m., and it is per-subscriber rather than global on purpose.
2. **The producer's own switch** is unchanged and upstream: `ops_reasons.enabled: false` + restart stops publication (KPR-454 D5).
3. **`ops_policy` absent or a cadence entry removed** ⇒ affected rows are delivered once and never nudged.

**Rollback is a code revert.** No configuration flag turns the notifier off wholesale, because with zero subscription rows it is already inert and the per-subscription lever covers the live case.

**Two properties make merging ahead of KPR-455 honest, and one residual remains.** The sequencing constraint stands — D12 and this ticket's body both state that KPR-468 must not ship without KPR-455's inbound edge. What softens it to a *deployment* constraint rather than a code hazard is that (i) with zero `ops_subscriptions` rows no ledger row is ever created, and (ii) with no `ops_policy` cadence a row is delivered once and never nudges. **The residual:** an operator who registers both a subscription and a cadence before KPR-455 lands gets exactly the state D12 warns about — `judgment` and `integrity` rows, and `resource` conditions that never recover, nudging with nothing able to acknowledge them, and the only stop being lever 1 above. Recovering `resource` conditions still fall silent on their own, because D4's enable gate guarantees every `resource` reason has a registered clearing reason and a clearing fact reaches `cleared` with no acknowledgement.

### D12. Boundaries — what this child deliberately does not touch

- **KPR-454 is read-only and additive from here.** The notifier consumes `ops_events`, `ops_subscriptions` and `ops_reasons` through `OpsStore`'s existing handles and `loadReasons()` / `loadSubscriptions()`; it creates none of them, indexes none of them, writes none of them, and **never imports `src/ops/match.ts`**. Should the plan writer find a needed read that `OpsStore` does not expose, the change is **additive** — a new read method — never a modification of an existing one.
- **KPR-456 and KPR-457 keep their contracts.** Neither becomes an adapter of `OpsTransport`; `SlackObligationPoster` is not reused, re-exported, or refactored, and KPR-457's watchdog must not acquire a dependency on the thing it watches. KPR-456's unknown/no-automatic-resend rule and KPR-457's bounded-retry alert contract are separate and are not superseded by D6's taxonomy (canon, D10).
- **`agent_events` is unchanged**, including `EVENT_SCHEMAS`, `Scheduler.checkEvents` and the `subscribe: string[]` agent-definition field, which stays the event-bus domain list and is never overloaded to mean an ops subscription.
- **No MCP server is added**, so both KPR-390 standing obligations are inapplicable and are named here so a reader does not go looking: there is no `buildToolTransportInventory` descriptor to push and no `suppressAutoInjectedServers` gate to extend. `WORKER_SERVER_DENYLIST` and the `delegateServers` in-process constraint are untouched. An agent-facing acknowledgement tool would be an MCP surface subject to all of that — it is **KPR-455's** to decide and build, not this child's.
- **No reader, view, CLI, `hive doctor` section or dashboard.** The heartbeat document is a *write*; everything that reads it is KPR-455, and Gate 1 forbids the dashboard.
- **No catch-all.** No default subscription, fallback recipient, or fallback adapter is created by any code path (C3). An event that matched nobody produces no row, and that is the measurement.

### D13. Three columns, restated for the notifier

| Defined by KPR-458 (contract) | Ships with KPR-468 (code) | Registered by the operator |
| --- | --- | --- |
| Ledger states, the total transition table, attribution rules, the reserved system principal | `ops_notifications`, its indexes, the sweep, the boot wiring, the drain | — |
| The transport interface and the three-outcome taxonomy; both closed reason sets | `src/ops/transport.ts`; the Slack adapter and its vendor mapping | Which adapters are bound; which target each binding names |
| Acknowledgement-intake semantics (D6, D12) | `accept(...)`, the check order, the clamp, the idempotence key | Which surfaces expose an inbound edge (KPR-455 builds them) |
| Cadence-table **shape** keyed `(class, retry)`; profile-replaces-table semantics | The `ops_policy` collection and its resolver — **zero rows** | Cadence values, named profiles, the minimum-nudge floor, the snooze maximum |
| Clearing provenance by class | The envelope-checkable test (D4) | — |
| Retention posture | The ledger TTL composed against the event TTL | Retention values, via `activity.retentionDays` |
| The sync→swept handoff and the cursor | The `db.telemetry` cursor and the apply-if-newer watermark | — |

The intended post-deploy steady state, stated exactly so nobody reads a merged ticket as a live surface: **every tool failure and recovery is still recorded, no ledger row exists, nothing is delivered, and `matchedSubscriptions: 0` still measures how much nobody has claimed** — until an operator registers subscription rows, a transport binding and a cadence.

## Integration points

1. **`OpsStore` (KPR-454, `src/ops/store.ts`)** — read-only reuse of `events`, `subscriptions`, `reasons`, `loadReasons()`, `loadSubscriptions()`. The notifier constructs its own `OpsStore` and never calls `ensureIndexes()` or `upsertReasons()`. Any missing read is an **additive** method.
2. **`ops_events` cursor index** — `{ publishedAt: 1, _id: 1 }`, already created by KPR-454 D10 "because D12 assigns `ops_events` and its indexes here". This child depends on it and creates none of it. If that index is dropped in a KPR-454 revision, this child's ingest sort degrades to an in-memory sort; the plan writer should assert its presence in an integration test rather than re-creating it.
3. **`src/ops/types.ts`** — `OpsEvent`, `OpsClass`, `OpsRetry`, `Waiting`, `OpsSubject`, `OpsEvidence`, `OpsDetail`, `OpsReason`, `OpsSubscription` consumed as-is; the ledger's own types live in a new `src/ops/notification-types.ts` so KPR-454's frozen surface is untouched.
4. **`src/ops/publisher.ts` helpers** — `stripGeneration`, `generationOfDedupeKey`, `reasonIdOfDedupeKey` are available and pure. The notifier needs none of them for its own logic (it is generation-blind, D4) and may use them only for diagnostics; a plan that reaches for them in a decision path has probably re-invented epoch handling this component must not have.
5. **`SlackGateway.registerOutboundTs`** (`src/slack/slack-gateway.ts:608`) — the Slack transport is constructed with this callback, exactly as `obligations.start` is wired at `index.ts:639`. Not optional (D6, C14).
6. **`src/index.ts`** — construction + `init()` + `setOpsNotifier(` above `:474`; `registerTransport(...)` + `await opsNotifier.start()` after `:639`; `await opsNotifier.stop()` after `:943`; one line added to the existing `SIGUSR1` handler body, **never a second `process.on("SIGUSR1", …)` listener**.
7. **`src/boot-order.test.ts`** — two anchors in all three lists plus a new lifecycle `describe`.
8. **`CLAUDE.md`** — `ops_notifications` and `ops_policy` added to the engine-written collections list with their keys, indexes and TTL posture; the two new `telemetry` kinds (`ops_notifier_stats`, `ops_sweep_cursor`) added to that collection's entry; a short Common Gotchas bullet naming the two levers, the "no cadence ⇒ delivered once, never nudged" default, and the sequencing constraint against KPR-455.
9. **Test harness** — `src/obligations/testing/fake-db.ts` supports the update operators D4 needs and enforces unique indexes (`:279-302`), but not pipeline updates. The plan writer chooses between it and a purpose-built double; whichever is chosen must mint real `ObjectId`s, because the apply-if-newer comparison is over `(publishedAt, _id)` and a counter-string `_id` inverts lexicographically at 10 — the same trap KPR-454's plan flags for its own double.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Stamped subscription absent, disabled, or target-invalid at ingest | No row created. The event's stored `matchedSubscriptions` still stands (D12) — it was honest for the set that existed at accept, and never a delivery promise. |
| Subscription disabled *after* rows exist | Rows are retained, not delivered, not nudged; re-enabling resumes. Latency ≤ one 60 s reload. |
| Clearing event for a `dedupeKey` with no row | Counted no-op. Openness is answered from the log, not the ledger (D8). |
| Clearing event failing its provenance test | Stored (by the publisher), row untouched, `clearRefused` counted. |
| Clearing event on an `informational` row | Never clears (D3). |
| Clearing event on a `dismissed` row | **Clears.** A dismissal stops nudging; only a clearing fact closes the condition. |
| Clearing or renewal replayed after a crash | No-op via the apply-if-newer watermark; `eventCount` does not double-count (C17). |
| Renewal on a `cleared` row | Reopens to `pending`, system principal, `stateEventId` = the renewing event, `nextNudgeAt = now`, `expiresAt` unset (D7 rule 4). |
| Renewal on `pending`/`delivered` | Counters advance; **`nextNudgeAt` is not reset** — a flapping producer must not drive the cadence. |
| New `generation` for the same subject/reason | A different `dedupeKey` ⇒ a fresh `pending` row beside the closed one. The closed one is never touched. |
| Row TTL'd out while the condition still recurs | Re-mints at `pending` and nudges again as though never acknowledged — D9's stated, deliberate consequence. |
| Cursor absent | Initialize to the server clock, warn, count `cursorReinitialized`. **No backfill.** |
| Cursor ahead of the newest event | Nothing to ingest; not an error. |
| Sweep so far behind that events hit the event TTL | The cursor advances past a gap; `eventsBehind` is the only signal, and it is what a reader must surface. |
| Adapter `adapterId` not registered | Row untouched, `transportUnbound` counted. |
| Adapter throws instead of returning an outcome | Recorded as `unknown` / `transport-fault`, counted, contained. |
| `rejected` outcome | Recorded; no retry ladder; next attempt is the next ordinary nudge (D5, and D6 supplies no retry hint to schedule from). |
| `unknown` outcome | State unchanged — never reaches `delivered`; surfaced as uncertainty by every reader (C8). |
| No cadence resolvable for a row | Delivered once, `nextNudgeAt` unset, `cadenceUnresolved` counted; resumes on the first tick after a cadence is registered. |
| Subscription names an unknown cadence profile | **No fallback to the table** (D5's anti-merge rule); the row does not nudge, counted. |
| Snooze expiry | `delivered` if the row has a recorded `accepted` outcome, else `pending`; `nextNudgeAt = now` (D7). |
| Intake: unknown/malformed handle | `refused: "unknown-handle"`. |
| Intake: missing actor id | `refused: "unattributed"` — never attributed to a service principal. |
| Intake: duplicate callback, identical `(actorId, act, at)` | `{ state: "noop" }`, **checked before legality**, so a duplicated dismissal is not reported as an illegal transition. |
| Intake: any act on a `cleared` row | `refused: "row-cleared"` — benign for the acknowledger, not an error to surface. |
| Intake: `dismissed` on `integrity` | `refused: "integrity-dismissal"`. |
| Intake: `snoozed` with absent or non-future `snoozedUntil` | `refused: "snooze-not-future"`. |
| Intake: `snoozedUntil` beyond the maximum | **Applied clamped**, never refused; the clamped value is echoed back (D12). |
| Intake: no `ops_policy` registered | The hard ceiling still clamps — a clamp always exists. |
| Intake racing a sweep tick on the same row | Serialized by the per-row latch; a lost CAS retries once, then `{ state: "unavailable" }`. |
| Intake before `start()` / during `stop()` | `{ state: "unavailable" }`. Never throws. |
| Mongo unavailable for a tick | Tick fails, counted, heartbeat `state: "degraded"`, no throw, next tick retries. |
| Unique-index creation fails at `init()` | Notifier left **unstarted**; boot continues. |
| `waiting: human-now` event matching a subscription | Delivered normally. No engine default subscription selects `human-now`, and this child registers none (D10). |

## Acceptance criteria

Each maps to a KPR-458 criterion and is testable at this child's boundary.

1. **AC1 (C2, C3)** — With `ops_subscriptions` empty, ingesting any number of events creates **zero** `ops_notifications` documents and attempts zero deliveries; the events are unmodified. No code path creates a default subscription, fallback recipient or fallback adapter.
2. **AC2 (C2, C17, containment (a))** — Structural: the notifier never imports `src/ops/match.ts`, and no module under the notifier's own file set is imported by `agent-runner.ts`, `tool-bridge.ts`, `dispatcher.ts` or `agent-manager.ts`. A test asserts both over the source tree, so "off the turn path" is a checked property rather than a claim.
3. **AC3 (C17, the handoff)** — The sweep drives row creation **only** from each event's stamped `matchedSubscriptionIds`. Negative test: an event stamped with `[s1]` while an enabled subscription `s2` would also match its attributes creates a row for `s1` only. A second: a stamped id whose subscription has since been disabled creates no row and leaves the event's `matchedSubscriptions` count untouched.
4. **AC4 (C17, idempotence)** — Re-processing an arbitrary prefix of the log is a total no-op: `eventCount`, `state`, `attemptCount` and `nudgeCount` are byte-identical after a replay. **The able-to-fail case is the one D12's own phrasing misses:** a page containing two events for one `dedupeKey`, replayed after a simulated crash between the last write and the cursor advance, must leave `eventCount` at 2 — a `latestEventId`-equality implementation yields 3 and this test fails it. A third: an out-of-order (older) event is discarded, not applied.
5. **AC5 (C17, the cursor)** — The cursor advances only after the page's ledger writes are acknowledged; a crash between them re-processes rather than skips. An **absent** cursor initializes to the clock, counts `cursorReinitialized`, and creates **no** rows for events already in the log — the negative test is a log seeded with 50 pre-existing events and an empty cursor, after which the ledger is empty.
6. **AC6 (clearing)** — A clearing event with **zero** `matchedSubscriptionIds` clears every row on the named `dedupeKey`; a match-scoped implementation fails this. Provenance: a `resource` row clears on a same-producer clearing event; a `judgment` and an `integrity` row do **not** clear on a clearing event with empty `evidence` and **do** clear with a reference; an `informational` row never clears; a `dismissed` row clears; a `cleared` row is a no-op. Every failing test increments `clearRefused` and transitions nothing.
7. **AC7 (C8, C10, delivery and nudging)** — `accepted` transitions `pending → delivered`, records `deliveryReference`, and sets `nextNudgeAt` from the resolved cadence. `rejected` and `unknown` leave the state unchanged, and `unknown` never reaches `delivered`. **No automatic resend follows an `unknown`**; the row's next attempt is its next cadence-derived nudge, and a test drives the clock to prove the interval was the cadence's rather than a retry's. A nudge re-delivers the **same** row — a test asserts the `ops_notifications` document count is unchanged across ten nudges — and `nudgeCount` excludes the first attempt. There is no attempt ceiling and no terminal give-up. `attempts[]` never exceeds the ring cap while `attemptCount` keeps counting.
8. **AC8 (C9, intake)** — Every transition to `seen`/`dismissed`/`snoozed` arrives through `accept(...)`, records a stable actor id and instant, and is idempotent: replaying one act returns `noop` and leaves the row byte-identical. **The order test is explicit:** a duplicated `dismissed` returns `{ state: "noop" }` and **not** `refused: "illegal-transition"`. An act without an actor id is refused, never attributed to the system principal, and the system principal can never produce those three states. `dismissed` on `integrity` is refused. Any act on a `cleared` row is refused. No bulk transition exists — a test asserts no code path issues an `updateMany` against `ops_notifications` — and no sweep path can set `dismissed`.
9. **AC9 (C14, D10 invariants)** — No code path in this diff publishes an `ops_event`, on success or on any fault; a fault injected into every phase produces log lines, counter increments and heartbeat `degraded`, and zero writes to `ops_events`. **The Slack transport registers every accepted post's `ts` through the echo callback** — a test asserts `registerOutboundTs` was called with the returned channel and ts, because without it the post re-enters as a `WorkItem` and spawns a turn. No delivery synchronously spawns an agent turn.
10. **AC10 (C10, the clamp)** — A snooze beyond the operator maximum is **applied clamped** and the clamped value is echoed; a snooze with no `ops_policy` registered is clamped to the hard ceiling; a snooze with an absent or non-future `snoozedUntil` is refused. Expiry returns the row to `delivered` when it has a recorded `accepted` outcome and to `pending` otherwise, and the row is nudge-eligible immediately by that fact rather than by a special case.
11. **AC11 (cadence sourcing)** — With no `ops_policy`, a row is delivered exactly once and never nudged, and registering a cadence resumes nudging on the next tick without a restart. A subscription naming a cadence profile uses that profile's interval and **never** the `(class, retry)` table; naming an **unknown** profile resolves no cadence and does not fall back to the table. A profile below the floor is clamped up and warned. This child registers zero `ops_policy` rows.
12. **AC12 (C13, redaction)** — No `ops_notifications` field contains message text, prompt or completion text, tool arguments, a raw error object, a URL, a credential, a file path or free-form prose. Negative test: a delivery whose transport fails with a credential-shaped and a path-shaped error stores neither substring anywhere on the row. `remediation` is a registry template plus allow-listed parameters, rendered **in the adapter** at delivery; the ledger stores no rendered string.
13. **AC13 (containment (b))** — A per-row fault in any phase is caught and counted without aborting the tick or blocking the next; ticks never overlap under a slow adapter (a test starts a second tick while the first is in flight and asserts it is a no-op); a per-row latch serializes an intake write against a tick on the same row, and the loser observes a CAS failure rather than a merged write.
14. **AC14 (boot order, drain, and boot survival)** — `src/boot-order.test.ts` carries `await opsNotifier.init()` and `setOpsNotifier(` in **all three** lists, and a new lifecycle block pins `registerTransport(` before `await opsNotifier.start()`, `await opsNotifier.start()` after both `dispatcher.registerAdapter(slackAdapter)` and `await slackAdapter.start(`, and `await opsNotifier.stop()` before `await slackAdapter.stop()` and `await mongoClient.close()`. **Negative-verify:** moving the wiring block below `await bgTaskManager.scanOrphans()` fails (b) *and* (c) while (a) stays green — predict both. With the notifier unstarted, `accept(...)` returns `{ state: "unavailable" }` and no turn is affected; a unique-index failure leaves it unstarted and boot completes; a failure of any other index leaves it started; a subscription-load failure leaves it unstarted.
15. **AC15 (C12)** — No code path in this diff reads `activity_log.error`, `costUsd`, or a turn/tool duration to decide that anything failed. Every ledger row originates in a published `ops_events` document, and `activity_log` is neither read nor written here.
16. **AC16 (C16, D11 levers)** — Adding a subscriber, a transport binding, a reason or a cadence value is data rather than an engine change: a test inserts an `ops_subscriptions` row and an `ops_policy` document into an already-initialized notifier and, after one reload, publishes an event through KPR-454's accept path and observes a row created, delivered and scheduled — with no edit to the envelope, the filter grammar or the transport interface. The reverse: setting `enabled: false` on that row stops delivery and nudging within one reload while retaining the row, and re-enabling resumes.
17. **AC17 (documentation)** — `CLAUDE.md` gains `ops_notifications` and `ops_policy` in the engine-written collections list with keys, indexes and TTL posture; the `telemetry` entry gains `ops_notifier_stats` and `ops_sweep_cursor`; a Common Gotchas bullet names the two levers, the no-cadence default, and the KPR-455 sequencing constraint.

## Assumptions and remaining decisions

- **⚠ Delegated (non-blocking) — idempotence is apply-if-strictly-newer over `(publishedAt, _id)`, strengthening D12's `latestEventId` rule.** Argued in D3 and Key Points bullet 2 with the concrete C17 failure the weaker rule admits. This is a strengthening within the contract's own stated intent ("`eventCount` counts distinct events, never sweep attempts"), not an amendment; it costs two scalar fields on the row and makes any prefix replay a total no-op. AC4 is the able-to-fail test.
- **⚠ Delegated (non-blocking) — the D12 cursor lives in `db.telemetry` (`kind: "ops_sweep_cursor"`), not in a dedicated collection.** D12 explicitly leaves the location to this child and rules it is not a contract collection. Justified in D3: `telemetry` is engine-written, TTL-free and upserted per `kind`, and the cold-start rule makes cursor loss cost at most one sweep interval of events. The alternative — an `ops_notifier_state` collection — is one more collection, one more `CLAUDE.md` line, for a difference the initialization rule already erases. Reversible in one module.
- **⚠ Delegated (non-blocking) — a missing cursor initializes to the clock, never to the log's beginning.** The strongest single argument for it is the staging story: KPR-454 merges first and accumulates, so a backfilling notifier would deliver weeks of history on its first tick and re-mint rows for conditions whose ledger rows had already aged out. The cost is a bounded, counted gap. If an operator ever genuinely wants a backfill, it is an explicit one-off cursor write, not a default.
- **⚠ Delegated (non-blocking) — `ops_policy` as a new collection, and cadence read per tick rather than cached.** D5 and D11 make cadence values, profiles, the floor and the snooze maximum operator-registered data, and D1 named no home for them; one small document read once per 30 s tick is cheaper than a reload timer and is always fresh. **Zero rows ship.** The simpler alternative — code constants — would forfeit the operator lever entirely and would be exactly the default policy dependency KPR-456 canon forbids an engineering child from supplying.
- **⚠ Delegated (non-blocking) — no cadence registered means delivered once, never nudged.** The alternative is an engine default interval, which is policy this child may not hold. Stated as a deployment gate rather than a failure, and it is also what makes merging ahead of KPR-455 tolerable — a consequence, not a substitute for D11's sequencing constraint, whose residual is named there in full.
- **⚠ Delegated (non-blocking) — no retry ladder ships; `rejected` is recorded and the next attempt is the next nudge.** The contract decides most of this: D6's `{ status: "rejected"; reason }` carries no retry hint, so there is nothing to schedule from, and C8 *permits* rather than requires an automatic retry. Inventing a backoff would be cadence policy by another name. Cost: a `refused-rate-limit` row waits a full cadence interval. Reversible if a hint is ever added to the outcome type — which would be a contract amendment, not a change here.
- **⚠ Delegated (non-blocking) — the `judgment` / `integrity` clearing provenance test requires at least one `evidence` reference.** D3's wording for `integrity` ("carrying the underlying authoritative evidence") reads almost literally onto it; for `judgment` ("an event recording a named human ruling") it is an inference that the ruling's record is the reference. The envelope offers no other checkable signal, and this component may not judge content. The stated alternative is to accept C19's registration link alone as sufficient for all three classes, which is one predicate looser and is a one-line change. Named because a reviewer should look at it.
- **⚠ Delegated (non-blocking) — ledger TTL is `min(30 days, config.activity.retentionDays)`.** D9 flags the retention posture as a privacy call wanting operator confirmation and rules that the behavioural half must age before the event log; the `min` keeps that true for any operator setting with no new key. The value is the **acknowledgement-silence horizon**, not only a privacy setting (D9), and raising it is a code change.
- **⚠ Delegated (non-blocking) — a contract-side hard snooze ceiling (7 days) exists in code so a clamp is always available.** D12 makes the clamp mandatory and its maximum operator data this child ships none of; without a code-side ceiling an unregistered deployment would admit an unbounded snooze, i.e. the terminal state ruling 2 forbids. A registered maximum can only tighten it. This is a bound, not a cadence.
- **⚠ Delegated (non-blocking) — one transport ships, and it is Slack.** The alternative — interface only — was considered and declined on three grounds: D6's three-outcome taxonomy would have no vendor mapping to test, so C8 would be untestable; this ticket's own boot-order obligation ("the sweep starts after adapter registration") would be vacuous; and shipping it costs nothing operationally, since with zero subscription rows nothing is ever delivered regardless of which adapters are registered. The scope guard is that **exactly one** adapter ships and `SlackObligationPoster` is neither reused nor refactored.
- **⚠ Delegated (non-blocking) — intake idempotence keys on `(row, act, actorId, at)`, with `at` the vendor act's instant.** D12 says "`(row, act, actor)`", which cannot distinguish two genuinely distinct snoozes by the same actor — and D7 explicitly permits re-snoozing to move `snoozedUntil`. Including the act's own instant resolves the two, and it is why D6 fixes `at` as part of the intake tuple. Residual: an inbound edge that substitutes its own receipt time weakens idempotence to a harmless double-apply, and only for snooze — a repeated `seen` or `dismissed` lands on a row already in that state and changes nothing but `stateAt`. Non-blocking, and it is an obligation on KPR-455's edge worth stating in that child's spec.
- **⚠ Delegated (non-blocking) — the acknowledgement handle is the row `_id`'s hex string and confers no authority.** Attribution, not authorization, is the contract's model (D9). Named residual: a handle round-tripped through a vendor payload can be altered by the actor, so an act can in principle be applied to a row the actor was not shown — attributed to them either way. Adding an authorization model would be policy this component may not hold; a signed handle is the reversible alternative if the residual ever matters.
- **⚠ Delegated (non-blocking) — four numeric bounds carry no value in this spec** and are the plan writer's: sweep page sizes and the per-tick event budget, the delivery phase's wall-clock budget and inter-attempt spacing, the intake deadline, and the `attempts[]` ring cap (stated as 5 above, and the one of the four this spec does fix). What is **not** delegated is the behaviour on breach, fixed in D3 and D5: leftover work defers to the next tick and is visible as backlog; nothing is dropped; nothing is skipped. No `hive.yaml` key ships for any of them.
- **Non-blocking, follows from the contract — clearing is applied outside `matchedSubscriptionIds`.** Not a delegated call: D12's own guarantee that recovering `resource` conditions fall silent on their own is false under any match-scoped reading, because clearing reasons are `informational` and normally match nobody. AC6 is the able-to-fail test.
- **Non-blocking, follows from the contract — `NotificationView` carries the resolved target.** `deliver` takes exactly one argument, so the target must ride the view; D6 bars an adapter from *choosing* a recipient, not from being handed one.
- **Non-blocking — the unique index carries a correctness role, so its failure leaves the notifier unstarted.** This is the one place this child's index posture differs from KPR-454's blanket "contained and stay wired": the `(subscriptionId, dedupeKey)` uniqueness is the ledger's identity guarantee, and running without it means duplicate rows and duplicate nudges for one condition. Boot is still never fatal.
- **Non-blocking — the KPR-458 addendum is not yet on disk.** The design body at this commit still reads "chartered to no child" for D12 and D6; `kpr-458-plan.md:13` carries the operator's resolution and its Task 2 appends the addendum. This spec is written against the resolution. A reader who opens `kpr-458-design.md` alone will find the stale text until that plan runs.
- **Non-blocking — this child depends on KPR-454 as planned, not as merged.** Every module, type and index it consumes is specified in `kpr-454-design.md` and its six plan chunks at this commit and does not exist in the tree yet. If KPR-454's implementation diverges on the `OpsStore` surface, the `ops_events` cursor index, or the `matchedSubscriptionIds` stamp, this spec's integration points are where the divergence lands and the plan writer should re-verify all three against the merged code before writing a task.
- **Blocking for deployment, not for this spec — KPR-468 must not ship without KPR-455's inbound acknowledgement edge.** D12's constraint and this ticket's own body. D11 states the two properties that make the *merge* honest and names the residual that remains: an operator who registers both a subscription and a cadence before the edge lands gets unbounded nudging on `judgment`, `integrity` and never-recovering `resource` rows, with the per-subscription lever as the only stop.
