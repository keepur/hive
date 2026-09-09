# KPR-458 — Ops event contract: publish, subscribe, transport

## TL;DR

KPR-458 defines a publish/subscribe contract for operational facts, in three parts and one ledger. A producer **publishes** an event stating what happened, naming neither a recipient nor a transport; every published event is durable whether or not anyone is listening. A **subscriber** declares, in its own record, which event attributes it cares about; interest never lives in a producer-side or central routing table, and there is no default subscription, fallback recipient, or catch-all. A **transport adapter** carries a notification to one subscriber; Slack is one implementation and the interface is closed over nothing Slack-specific. The one addition classic pub/sub does not supply is an **acknowledgement ledger** — per subscriber, per condition: delivered, seen, dismissed, snoozed, with the acting identity recorded — which is what makes "nudge until acknowledged" and attributed signals possible.

## Key Points

- **Three parts and a ledger; no fourth part.** There is no router, no policy table mapping event to recipient, no default-owner table, and no fallback destination. An event that matches zero subscriptions is stored with `matchedSubscriptions: 0` — a countable, queryable gap. No conforming implementation may add a catch-all subscription to make that number nonzero.
- **Severity is not a field.** The Florist registry shipped a `loudness` axis and all 15 rows set it to maximum; a producer-declared severity converges on maximum and reproduces "when everything's red, nothing's red" inside the contract meant to fix it. Routing is `f(class, waiting)`; nudge cadence is `f(class, retry)`. Nothing reads a severity.
- **Producers state facts, not urgency — and cannot assert their own axes.** `class` and `retry` are properties of the *reason* and are read from a producer-owned reason registry, not supplied per publish. Only `waiting` is per-event, because it is invocation context: on the Hive runtime path it is `policyFor()` (`src/outage/outage-notices.ts:18-26`) promoted to a field, with its `silent` bucket split, implemented in that same module so exactly one prefix table exists.
- **⚠ Delegated: notification identity is the deduplicated condition, not the raw event.** The log appends one row per publish; the ledger is keyed `(subscriptionId, dedupeKey)` where `dedupeKey = producer:subjectKind:subjectId:reasonId:generation`. Without this, one flapping tool reproduces the noise the epic exists to remove. The brief said "per subscriber, per event"; this is that, with "event" meaning the condition rather than each restatement of it.
- **Measured, and it corrects the brief's premise.** Trailing 7 days on `hive_dodi` (2026-09-08, 1,480 turn rows): `error` non-null on 74 (5.0%); `timedOut: true` on 65, of which **57 carry `error: null`**; union of `error ∨ aborted ∨ timedOut` = 131 (8.9%). But the proposed fallback signature `costUsd = 0` is worse, not better: `turn-scaffold.ts:353` returns a literal `costUsd: 0` for **every** Lane B turn, so all 289 Lane B rows in the window (19.5% of traffic) match it, and every one of the 19 long zero-cost rows carrying no flag and no error is a *successful* `codex/*` turn, one of them 27 minutes long. **Outcome must be published, never inferred from cost or duration.**
- **Nudging does not terminate, and no ladder is a primitive.** Per the operator's ruling, an unacknowledged condition keeps nudging on a cadence drawn from a data table; snooze is the only pause and it is attributed and expiring. An escalation ladder is a subscriber that re-publishes under a different reason at a different cadence — not a mechanism this contract builds. No de-escalation or self-healing path is specified.
- **Three signals where a naive design has one.** `dismissed` = seen and judged not worth action; `snoozed` = seen, matters, not now; silence = neither, and nudging continues. This is the record that would later support demoting a reason *from evidence* — the query is stated, the demotion is not built.
- **Reconciled, not superseded.** KPR-456's obligation delivery/notice path and KPR-457's Beekeeper alert sender keep their own contracts intact; neither becomes an adapter of this interface, and the watchdog in particular must not acquire a dependency on the thing it watches. The existing `agent_events` bus is deliberately not reused: its publish-time fan-out *dispatches agent turns* (`src/scheduler/scheduler.ts:322-405`), and an operational-failure feed that spawns turns is a spend-and-feedback loop.
- **In scope:** event envelope, attribute vocabularies, reason registry shape, subscription filter grammar, transport interface and outcome taxonomy, ledger states and transitions, clearing provenance, staleness rule, redaction allow-list mechanism. **Out of scope:** any subscription row, recipient, channel, actor, cadence value, registry content beyond a labelled example table, dashboard, web server, second inbox, agent identity rollout, and the code of KPR-454 or KPR-455.

## Scope and authority

Ticket: **KPR-458 — Taxonomy + escalation contract for ops-surface severities**. Parent: KPR-451. Worktree baseline: `epic/kpr-451` at `6f1307e`; runtime facts below were read at that tree.

Inputs are the ticket body, the Florist **DRAFT PROPOSAL** comment on KPR-458 (2026-09-08), the KPR-451 epic description including its `## Decision Register — Canon`, an operator disposition pass over a week of live traffic, and four structural rulings by the operator relayed through this drafting dispatch. The rulings are binding and quoted verbatim in D1.

KPR-458 carries `needs-human-spec`, and the Florist draft is explicit that a draft does not close that gate. This artifact does not close it either, and does not claim to. What the four rulings settle is the **structure**: the shape is pub/sub, the event carries no owner, nudging is unbounded, transport is an adapter, viewer signals are attributed. What remains human policy is **content**: which reasons exist, who subscribes to what, and at what cadence. This document deliberately contains none of that content outside an explicitly labelled example table, because content is data and data is not contract.

An earlier framing of this ticket proposed a central routing layer resolving recipients from a policy table, plus a totality rule so nothing escaped it. That design is rejected: it manufactured a hole and then specified a plug. It must not reappear under another name.

Relevant canon: KPR-456's rule that an engineering child supplies **no default recipient, severity, escalation, production registration, prompt rollout, or new policy dependency** — this child is where such policy legitimately lives, and D11 states precisely which half of it is contract and which half stays operator-registered data. KPR-456's separate obligation contract and KPR-457's separate bounded-retry alert contract are preserved unchanged (D10). KPR-453's rule that a work-item identity "proves neither unique attempt nor task continuity" binds the dedupe key (D2). This artifact follows the repository epic-artifact convention and the conventions in `CLAUDE.md`. Drafting is not implementation-plan approval.

## Problem and observed evidence

The epic's thesis is that healthy-quiet and stalled are indistinguishable in the record. That is measurable, and the measurement invalidates both candidate oracles.

| Observation | Evidence |
| --- | --- |
| `activity_log.error` is not a failure oracle | Trailing 7d, `hive_dodi`, 1,480 turn rows: `error` non-null on 74. `timedOut: true` on 65 rows, of which **57 have `error: null`**. `aborted: true` on 57. The union `error ∨ aborted ∨ timedOut` is 131 — **8.9%, versus 5.0% from `error` alone**. |
| The sparse flags are the best *existing* signal, and they are young | `aborted`/`timedOut` are written sparsely at `src/agents/agent-manager.ts:2610-2611` (KPR-401). The oldest flagged row on this instance is `2026-09-02T01:01:06Z`; only 56 of the 1,480 rows precede it, so the window is almost entirely post-flag and the 8.9% figure is not depressed by missing flags. On any older data — and on any instance deployed later — their absence means unknown, never success. |
| The proposed `costUsd = 0` signature is structurally wrong | `src/agents/provider-adapters/turn-scaffold.ts:353` returns a literal `costUsd: 0` in the shared Lane B `RunResult` builder. **All 289 Lane B rows in the window report zero cost** — 19.5% of traffic. Of the rows matching `costUsd = 0 ∧ durationMs ≥ 250 000` with no flag and no error, **all 19 are `codex/*` turns**, the longest 1,639,806 ms — long *successful* turns, not stalls. Cost is a billing field; on a subscription lane it carries no outcome information at all. |
| Failures on scheduled work die quietly | Of the zero-cost long rows, 11 are `sender: "system"`. A scheduler abort gets no continuation, so nothing surfaces. |
| The runtime already knows "is someone waiting" | `policyFor()` (`src/outage/outage-notices.ts:18-26`) classifies a WorkItem's source by id prefix into `notify` / `silent` / `skip`. It is the engine's one tested source classifier and is consulted only by the outage path today. |
| The existing event bus is a coordination bus, not an operational log | `agent_events` has a closed 13-type schema (`src/events/event-types.ts`); `system:task_blocked` carries `{taskId, description, blockedBy}` and no run, thread, tool, or context. Publication materializes a `deliveries[]` fan-out from a domain→agent map, and `Scheduler.checkEvents` (`src/scheduler/scheduler.ts:322-405`) turns each pending delivery into a `WorkItem` that **spawns an agent turn**. |
| Turn logging is not a publication surface | `ActivityLogger` may be disabled, buffers, and drops a batch after a second failed write — the same reason KPR-456 refused to use it as delivery evidence. |

**Consequence for this contract:** every one of those gaps is the same gap. No producer publishes an outcome, so every consumer invents a heuristic, and each heuristic is wrong in a different direction. The contract's job is to make the fact a published fact.

## Goals and non-goals

An implementation conforming to this contract must let a producer state an operational fact without knowing who cares; let a subscriber express what it cares about without a producer change; let a transport be replaced without either changing; record whether a specific subscriber has seen a specific condition, attributed; and make "nobody was listening" visible rather than absorbed.

Out of scope: a dashboard or web server, a second inbox a human must patrol, agent identity rollout, a rules engine, an expression language, a message broker or queue, an owner or assignment model, a severity axis, a terminating escalation ladder, a de-escalation or self-healing path, automatic demotion of reasons, retrospective enrollment of existing history, and the implementation code of KPR-454 (runtime tool-failure capture) or KPR-455 (the reader).

## Design

### D1. Shape: three parts and one ledger

The operator's framing, which this design implements without addition:

> in my mind, this is a simple pub/sub problem. there's the pub source — I've got events I'm publishing. Then, whomever is the sub side — these are the stuff I care to listen to. then there's the pipes / transports. that's it.

The four structural rulings, verbatim, and where each lands:

| Ruling | Verbatim | Lands in |
| --- | --- | --- |
| Owner on the event | *"no, it just needs to know it needs to raise issues. not responsible for who gets it, or how it is delivered"* | D2 — no `owner`, `escalatedTo`, `destination`, or transport field exists on an event. |
| Escalation termination | *"no. let it keep nudging... we'll let this come online first. then we may decide this is right, or we may decide to have a self-healing / de-escalation path"* | D8 — cadence, no terminal stop, no auto-clear except by a class-legal clearing fact. |
| Transport set | *"delivery channel should be an adapter -- properly abstracted, mind you. Today, it is slack tomorrow it could go directly to my phone. So slack should be just an adapter that implements that abstraction interface"* | D6 — adapter interface; Slack is one implementation and appears nowhere in the interface. |
| Viewer signal | *"attributed"* | D7 — every ledger transition records a stable actor id. |

Three collections, all engine-written, all to be added to `CLAUDE.md`'s collections list by the child that creates them (the KPR-452 precedent: a collection documented only in a spec is invisible to the next reader):

- `ops_events` — the append-only log. One document per publish. Nothing in it is ever mutated.
- `ops_subscriptions` — one document per subscription, owned by and named for its subscriber.
- `ops_notifications` — the acknowledgement ledger. One document per `(subscriptionId, dedupeKey)`.

Two consequences carried rather than re-derived, each stated once:

- **A dashboard is just another subscriber** (or, more cheaply, a reader that queries `ops_events` directly). Under this shape it needs no special provision, and Gate 1 forbids building one now.
- **An escalation ladder is not a primitive.** It is a subscriber that, on observing an unacknowledged condition, publishes a *new* event under a different `reasonId` whose registry entry carries a different `class`/`waiting` and therefore a different cadence and a different set of matching subscriptions. Since there is no severity field, "higher urgency" means "a reason that more people subscribe to, nudged faster" — nothing else.

### D2. The event envelope

Publication input is `(producer, reasonId, waiting, subject, detail, generation?, clears?)`. Everything else is derived, looked up, or server-stamped. The stored document:

| Field | Contract |
| --- | --- |
| `_id` | Server-assigned. |
| `schemaVersion` | Integer. Additive changes only; a reader must ignore unknown fields and must not infer meaning from absence. |
| `publishedAt` | Server clock at accept. Not producer-supplied. |
| `producer` | Namespace of the publishing system. Syntactically bounded (lowercase letters, digits, hyphens; 1–40 chars), **not** a hardcoded enum — a producer that does not exist yet (Florist) must be addable as data. |
| `reasonId` | Key into that producer's reason registry (D4). Bounded identically. An unknown `(producer, reasonId)` **fails closed**: the publish is rejected and the rejection is counted, never coerced to a generic reason. |
| `class` | Copied from the registry entry at accept. Never producer-supplied. |
| `retry` | Copied from the registry entry at accept. Never producer-supplied. |
| `waiting` | Producer-supplied, from the closed vocabulary in D3, because it is invocation context and varies per publication for the same reason. |
| `subject` | `{ kind, id }`. `kind` names the producer's own key space (`workItem`, `obligationOccurrence`, `capability`, `unit`, …); `id` is a **stable identifier, never a display name** and never a channel or person name. Both bounded. |
| `generation` | Non-negative integer, default 0. The producer's lever for saying "this is a materially new instance of the same condition". |
| `dedupeKey` | Derived and stored: `producer:subject.kind:subject.id:reasonId:generation`. Indexed, **not unique** — the log appends every publish. |
| `detail` | Flat map of scalars whose keys, types, and length bounds are declared by the registry entry. Unknown key ⇒ publish rejected. This is the redaction allow-list (D9). |
| `evidence` | Bounded array of `{ kind, id }` references — an activity row, a work item, a thread, a receipt. **References only; no text, no URLs.** |
| `clears` | Optional `dedupeKey` this event asserts is resolved, subject to D8's class provenance rules. |
| `matchedSubscriptions` | Count of subscriptions matched at accept. `0` is the countable gap and must remain reachable. |

Explicitly absent, and not to be added by any consumer: `owner`, `escalatedTo`, `assignee`, `severity`, `loudness`, `priority`, `destination`, `channel`, `recipient`, and any rendered message string.

**Dedupe and identity, with the KPR-453 caveat.** Canon: a work-item identity "proves neither unique attempt nor task continuity", and retries and outage replay may reuse an item id. So a `subject.kind: "workItem"` dedupe key deliberately collapses a retried turn's repeated failures into one condition — which is right for notification and lossless for the log, since every publish still appends. A producer that genuinely needs attempt-level separation advances `generation`; it must not synthesize a fake subject id to force separation.

### D3. Attribute vocabularies

Three closed vocabularies. They are the Florist proposal's three axes, adopted with their meanings intact, with one status change: **they are not a routing key.** They are attributes a subscriber filters on.

**`class` — who can clear it, and by what act.**

| value | meaning | legal clearing act |
| --- | --- | --- |
| `integrity` | a guarantee may have been violated; no permitted machine workaround exists | only a clearing event carrying the underlying authoritative evidence. Never auto-clears; never bulk-clears; a `dismissed` signal does not clear it. |
| `resource` | an operational or environmental fault | a clearing event from the same producer asserting the recorded predicate now holds. |
| `judgment` | a decision above the producer's authority | a clearing event recording a named human's ruling. Nothing else. |
| `informational` | nobody is blocked | no clearing act; store-only in practice. |

`informational` is in, and it costs nothing. It is not a suppression rule and the engine does not special-case it: it is store-only because no subscription selects it, not because code drops it. This answers the Florist draft's first open question — the tool-health rollup keeps its home in the log, and a reader that queries the log needs no subscription at all.

**`waiting` — invocation context.** This is the epic's routing principle promoted to a field so it can be tested instead of re-inferred at each call site.

| value | meaning |
| --- | --- |
| `human-now` | a person is in a live thread expecting a reply |
| `obligation` | a deliverable promised to a human at a time (KPR-456's registered expectations) |
| `agent` | another agent is blocked on this |
| `nobody` | no waiter |

For the `hive-runtime` producer, `waiting` is derived from `policyFor()`, not from a second classifier:

| `policyFor(item)` | id prefix | `waiting` |
| --- | --- | --- |
| `notify` | human channels (slack, sms, imessage, app/ws, team DM) | `human-now` |
| `silent` | `team-` | `agent` |
| `silent` | `callback:`, `event:`, `worker:` | `nobody` |
| `skip` | `sched:` | `nobody` |

Two rules bind the implementation of that split. First, **the split lives in `src/outage/outage-notices.ts` beside `policyFor`, sharing one prefix table** — a `waitingFor(item)` export, never open-coded prefixes elsewhere. One drifting predicate is the exact failure mode KPR-452 D1 and KPR-416/KPR-420 were spent removing. Second, `policyFor`'s own documented caveat carries over unchanged: ws/app ids are client-supplied and a client id colliding with a reserved prefix misclassifies; the blast radius here is one event's `waiting` value, hence one mis-selected subscription.

`waiting: obligation` is never derived by the runtime. It is published by the producer that holds the expectation — KPR-456's sweep — which is the only component that knows a deadline exists. A cron turn's own failure is `nobody` from the runtime's point of view, and that is correct: the runtime does not know what the cron was for.

**`retry` — does an identical retry reproduce this?**

| value | meaning |
| --- | --- |
| `transient` | the same input may succeed; a repeat is a dedupe increment |
| `deterministic` | an identical retry reproduces it — something must change first; a repeat without a `generation` bump is a defect in the responder, not new information |

This is the field that stops an alert loop, and it is a property of the reason, not of the moment — which is why the registry declares it and the producer cannot assert it.

### D4. The reason registry — producer-owned, data not code

One entry per `(producer, reasonId)`:

```
{ producer, reasonId, class, retry, remediationTemplate, detailKeys[], enabled }
```

- `class` and `retry` are declared here, once, and stamped onto every event of that reason. A producer therefore cannot escalate itself by declaration — the Florist lesson, enforced structurally rather than by review.
- `remediationTemplate` is **required, with no default**: a bounded parameterised string naming the act that would clear this, filled from `detail`. An alert that ships its own instruction is actionable; one that does not is noise with a timestamp. The template is registry data, reviewed when the row is added; the event stores parameters, never rendered prose. Rendering happens in the transport adapter at delivery.
- `detailKeys` declares the allow-list: key name, scalar type, max length. This is what makes redaction a write-time schema rather than a scrub-after pass.
- Adding a reason is a row. Adding a producer is rows. Neither is an engine change — which is what lets Florist come online later with producers that do not exist today.

The registry is the one piece of this design that could be dropped: `reasonId` would become a free bounded string and `detail` a fixed flat allow-list. That simplification costs fail-closed validation, the required remediation, and the anti-drift property above. It is named here so the tradeoff is visible, not to invite it.

### D5. Subscription

A subscription is a document owned by its subscriber, saying what that subscriber wants:

```
{ _id, subscriberId, subscriberKind, enabled, filter, transport: { adapterId, target }, cadenceProfile? }
```

**The filter is a conjunction of set-membership tests over the fixed attribute list, and nothing else:**

```
filter: { producer?: string[], reasonId?: string[], class?: […], waiting?: […], retry?: […], subjectKind?: string[] }
```

An absent field matches everything; a present field matches when the event's value is in the list; present fields are ANDed. There is **no** OR, negation, nesting, wildcard, regex, comparison operator, arithmetic, or scripting. If a subscriber needs a disjunction, it registers a second subscription — a row, not code. That is the whole of "policy is data" without a configuration language, and it keeps the matcher exhaustively testable. There is no `severity` term because there is no severity field.

Subscriptions are registered by an explicit operator action, mirroring KPR-456's explicit-enrollment rule. There is no retrospective enrollment: matching is evaluated at accept time and a subscription added later does not acquire past events.

**Names are not contract.** `subscriberId` is a stable identifier — for an agent, its `agent_definitions` id slug, never its display `name`, which changes. `transport.target` is an adapter-scoped opaque reference resolved *at delivery time* by the adapter; for a Slack adapter that is a canonical conversation id, which survives a channel rename. Human-readable labels may be stored alongside for display and must be re-resolved, never matched on. Changing a subscriber's stable id is a re-registration, exactly as KPR-456 treats an obligation id.

**Zero-match is a fact, not a failure.** When no subscription matches, the event is stored with `matchedSubscriptions: 0` and no notification exists. No conforming implementation may register a catch-all subscription, a default recipient, or a fallback adapter to avoid this. The gap is the measurement that tells an operator which classes nobody has claimed.

### D6. Transport adapter interface

```
interface OpsTransport {
  readonly adapterId: string;
  validateTarget(target: unknown): boolean;      // shape check at registration time
  deliver(n: NotificationView): Promise<DeliveryOutcome>;
}

type DeliveryOutcome =
  | { status: "accepted"; reference: { kind: string; id: string }; at: Date }
  | { status: "rejected"; reason: NonacceptanceReason }   // closed allow-list
  | { status: "unknown"; reason: UncertaintyReason };     // everything else
```

`NotificationView` is **structured**, never a pre-rendered string: the event's envelope fields, the resolved remediation template plus its parameters, the evidence references, and the ledger row's current state and nudge count. The adapter owns rendering, because a Slack block, an SMS body, and a push payload are different artifacts of the same fact.

What an adapter must not do: choose or discover a recipient; read `ops_subscriptions`; decide whether something is important; apply policy of any kind; or spawn an agent turn (D10). It renders one notification to one target and reports one of three outcomes.

The three outcomes are deliberately KPR-456's honest-uncertainty taxonomy, adopted so the two contracts agree rather than compete: `accepted` requires a transport acknowledgement; `rejected` is a **closed, provenance-checked allow-list** of responses proving nonacceptance, and is the only status that permits an automatic retry; everything else — timeout, crash after submission, ambiguous error — is `unknown`, is never blindly re-sent, and must be surfaced as uncertainty by any reader rather than reported as notified. A `rejected` retry reuses the same ledger row and increments its attempt count; it never mints a new condition.

Delivery state is per notification (D7), so an adapter is stateless with respect to policy.

### D7. Acknowledgement ledger and lifecycle

**Events never change state.** An event is a fact, and facts do not resolve. This is a deliberate divergence from the Florist draft's `raised → resolved` lifecycle on the escalation itself: under pub/sub the *condition* is tracked by the ledger and cleared by a *later fact* (D8).

One ledger row per `(subscriptionId, dedupeKey)`:

```
{ _id, subscriptionId, subscriberId,
  dedupeKey, producer, reasonId, class, waiting, retry, subject, generation,   // snapshot, so the reader needs no join
  firstEventId, latestEventId, eventCount, firstSeenAt, lastEventAt,
  state, stateAt, actor?, actorAt?, snoozedUntil?,
  attempts[], lastOutcome, deliveryReference?,
  nudgeCount, lastNudgeAt, nextNudgeAt }
```

States and their exact meanings:

| state | meaning | set by |
| --- | --- | --- |
| `pending` | matched; not yet accepted by a transport | accept-time matching |
| `delivered` | a transport returned `accepted`. **Not** seen. | transport outcome |
| `seen` | an explicit, attributed positive acknowledgement | an actor's deliberate act |
| `dismissed` | seen and judged not worth action | an actor's deliberate act |
| `snoozed` | seen, matters, not now; returns to nudge-eligible at `snoozedUntil` | an actor's deliberate act |
| `cleared` | the condition itself resolved | a class-legal clearing event (D8) |

Rules that make those distinctions load-bearing:

1. **`seen` requires an explicit act.** A Slack read receipt, a channel visit, an emoji reaction, elapsed time, or any inference is not `seen`. Only an act whose whole purpose is to say "I have seen this" transitions the row, and the acting identity is recorded — per the operator's one-word ruling, *attributed*.
2. **Silence is a state, not an absence.** A row left at `delivered` while nudges accumulate is the third signal. `dismiss` ≠ `snooze` ≠ silence, and a design that collapses them loses the only evidence the demotion question could ever be settled from.
3. **`dismissed` does not clear.** It stops nudging that subscriber; the condition remains open in the derived view (D8) until a clearing fact arrives. For `class: integrity` a dismissal is refused outright — if an integrity condition can be dismissed like an ordinary alert, someone eventually dismisses one and a gate is skipped.
4. **A repeat publication renews rather than duplicates.** A matching event whose `dedupeKey` already has a row updates `latestEventId`, `lastEventAt`, and `eventCount`. If the row is `seen`, `dismissed`, or `cleared`, a renewal reopens it to `delivered`-eligible only when `generation` advanced or a clearing fact had previously closed it; otherwise the counter increments and no new notification is sent. A `retry: deterministic` reason renewing without a `generation` bump is itself a countable defect signal in the responder.
5. **No bulk transitions.** Every state change names one row and one actor. There is no "clear all", no "dismiss channel", no sweep that ages rows into `dismissed`.

### D8. Nudging, clearing, and derived condition state

**Nudging does not terminate.** `nextNudgeAt` advances from a cadence table keyed `(class, retry)`; the table is data with operator-set values, and this contract fixes only its shape. A row that is `pending` or `delivered` past `nextNudgeAt` is nudge-eligible; `snoozed` suppresses until `snoozedUntil` (bounded by an operator-set maximum) and then resumes; `dismissed` and `cleared` are not nudge-eligible. There is no attempt ceiling, no terminal give-up, and no automatic hand-off to anyone else — per ruling 2, and pending the operator's later call on a self-healing or de-escalation path. A nudge re-delivers the same ledger row through the same transport; it never creates a second row.

**Clearing is a published fact, with per-class provenance.** A clearing event is an ordinary event carrying `clears: <dedupeKey>`; whether it takes effect is decided by the *cleared* condition's `class`, using D3's table: `resource` accepts a same-producer predicate assertion; `judgment` accepts only an event recording a named human ruling; `integrity` accepts only an event carrying the authoritative evidence reference; `informational` has no clearing act. A clearing event that fails its provenance test is stored — it is a fact that someone tried — and does not transition the row.

**Derived condition state, and the staleness rule.** The epic's two named views fall out of the log with no additional structure:

- *Tool health*, keyed `(detail.tool, detail.errorSig)` over `producer: hive-runtime` tool-failure reasons: latest outcome wins.
- *Work status*, keyed `subject` where `subject.kind = "workItem"`: open until a class-legal clearing fact.

For both, and for any future view: **past a staleness horizon with no fresh fact, the derived state is `unknown` — never `healthy`, never `resolved`, never `ok`.** A self-reported resolution is a fact like any other and is subject to the same horizon. This is the epic body's rule carried verbatim into the contract, and it is the single sentence that prevents the reader from re-inventing the heuristic this design exists to abolish.

**Openness is a property of someone caring.** With zero matching subscriptions there is no ledger row, so nothing tracks whether the condition is still open; the derived view above still answers the question from the log, and `matchedSubscriptions: 0` is the visible signal that nobody asked to be told. That is the honest consequence of refusing a catch-all, and it is stated rather than papered over.

**The demotion query, unbuilt.** Dismiss rate per reason is `count(state = dismissed) / count(rows)` grouped by `(producer, reasonId)` over a window. No engine behavior in this contract reads that ratio. The record exists so the operator can later decide, from evidence, that a reason should stop being routed — the intended replacement for anyone declaring a class unimportant up front.

### D9. Redaction, attribution, and retention

**Redaction is the schema, applied at write time.** The envelope's fields are fixed; `detail` accepts only registry-declared keys with declared scalar types and length bounds; `evidence` accepts only `{kind, id}` references. An unknown key, an oversized value, or a non-scalar rejects the publish — fail closed, and the rejection is counted so a mis-integrated producer is visible rather than silent. Never stored, in any field: message or prompt or completion text, tool arguments, raw error objects or stack traces, URLs, credentials, file paths, or free-form operator prose. A tool error becomes a normalized signature (tool name plus an enumerated error token), never the message that produced it. This is the epic's §5.1 rule — the surface whose purpose is pasting diagnostics is exactly where a token gets written.

**Attribution is an id and a timestamp, and nothing else.** A ledger transition stores the actor's stable identifier (Slack user id, agent id) and the instant. It does **not** store a display name, an email, a device, a client, a location, or a free-text reason for a dismissal. There is deliberately no "why did you dismiss this" field: the signal is the rate, not the prose, and a prose field on a per-person behavioural record is a privacy liability with no consumer.

**Retention.** ⚠ Delegated, conservative default: `ops_events` carries a TTL on `publishedAt` aligned with the existing activity-history retention; `ops_notifications` rows are retained while open (not `cleared`, not `dismissed`) and TTL from `stateAt` once terminal, so attributed actor data ages out with the row that carries it. Two deliberate divergences from KPR-456's no-TTL occurrence checkpoints: those retain *delivery-obligation evidence*, which this log does not hold, and they carry no per-person behavioural fields, which these rows do. An operator who wants longer retention of ops history should extend the event TTL and not the ledger's, so the behavioural half ages first.

### D10. Boundaries: existing paths, the event bus, and turn spawning

**KPR-456's delivery and notice path is untouched.** `deliver_obligation` sends a registered deliverable to a registered destination and writes its own receipt under its own evidence rules; a missed-deadline notice goes to its own explicitly registered notice destination. Neither is an ops notification and neither is retrofitted onto this transport. KPR-456's sweep is, later, a natural *producer* into this log (`waiting: obligation`); that is a future publish, not a redirection of its notice path, and it requires no change to KPR-456's contract. Canon preserved.

**KPR-457's Beekeeper sender is untouched, and must stay that way.** It lives in another repository, in a process whose purpose is to report that Hive is gone; making it an adapter of an interface implemented inside Hive would give the watchdog a dependency on the thing it watches. Beekeeper is a *producer* whose events may later reach this log by an out-of-band path; its alert delivery keeps its own bounded-retry, best-effort contract, which canon explicitly preserves and this document does not supersede.

**`agent_events` is not reused, and the epic body's sketch is superseded on this point.** The epic's proposed child 3 suggested new `system:*` types written with `deliveries: []` and `hasPending: false` so the scheduler would not dispatch them. That works only by disarming a mechanism whose entire purpose is dispatch: `Scheduler.checkEvents` turns each pending delivery into a `WorkItem` and spawns a turn. An operational-failure feed sharing a collection with a turn-spawning bus is one field away from a spend loop, and its closed domain-keyed schema cannot carry the envelope above. Separate collections; the coordination bus keeps its behavior unchanged, including the `subscribe: string[]` field on agent definitions (`src/types/agent-definition.ts:65`), which is the *event-bus domain* list and must not be overloaded to mean ops subscriptions.

**Two invariants that close the feedback loop.** (a) *The ops path never publishes about itself* — a publish failure, a match failure, a transport `rejected`/`unknown`, or a nudge failure is logged and counted, never published. (b) *No transport delivery may synchronously spawn an agent turn.* Delivering to an agent subscriber means placing the notification on a surface that agent reads on a turn it was going to run anyway; it never causes a turn. Without (b), a tool failure notifies an agent, whose turn fails, which publishes, which notifies.

**Engine-integration obligations for the consuming children**, from `CLAUDE.md`, stated here because a contract that ignores them is unimplementable:

- Publishing is read per spawn, so its wiring belongs **above** `index.ts`'s `// ── Spawn-capable boundary ──` marker, with its anchor added to all three lists in `src/boot-order.test.ts`.
- Publishing must never fail a turn: contain every fault inside the publish call and degrade to warn-and-count, the discipline KPR-452 D4 imposed on the audit path for the same reason.
- If an agent-facing publish tool is ever added (agents tag only what the runtime cannot see — coordination and semantic blocks), it is subject to the in-process `delegateServers` constraint and to worker containment: `WORKER_SERVER_DENYLIST` and the three `suppressAutoInjectedServers` gates. A contained worker must not gain an outbound surface through this door.
- **`waiting: human-now` publication is additive and replaces nothing.** A human in a live thread already sees failures in that thread in real time, and that behavior is untouched — the disposition pass's principle that errors travel with their traffic. No engine default subscription selects `human-now`, so publication records the fact without producing a second notification for a human who already has one.

### D11. What this contract defines versus what stays operator-registered data

| Defined here (contract) | Registered as data (not this ticket) |
| --- | --- |
| Event envelope fields and their bounds | Any actual event |
| `class` / `waiting` / `retry` vocabularies and their meanings | — |
| `waiting` derivation from `policyFor` for the runtime producer | — |
| `dedupeKey` formula and renewal semantics | — |
| Reason-registry entry **shape** | Reason-registry **contents** (per producer) |
| Subscription document shape and the filter grammar | Every subscription row, subscriber, and transport binding |
| Transport interface and the three-outcome taxonomy | Which adapters exist; which target each binding names |
| Ledger states, transitions, and attribution rules | — |
| Clearing provenance by class; the staleness→`unknown` rule | — |
| Cadence-table **shape**, keyed `(class, retry)` | Cadence **values**, and the snooze maximum |
| Redaction mechanism and the attribution allow-list | Retention values, within D9's posture |

Per KPR-456 canon, an engineering child supplies no default recipient, severity, escalation, or production registration. **This child supplies none either** — it supplies the vocabulary in which an operator can register those, and deliberately ships zero rows. The right-hand column is the deployment gate, and it is human policy work that this document does not perform.

## Conformance criteria

A consuming implementation (KPR-454 as a producer, KPR-455 as a reader, any later producer) conforms when:

1. **C1** — A publish carries no recipient, destination, transport, owner, or severity field, and no such field can be added without amending this contract.
2. **C2** — An event is durably stored before any matching or delivery is attempted, and is stored identically whether `matchedSubscriptions` is zero or nonzero.
3. **C3** — There exists no default subscription, fallback recipient, or catch-all adapter. A query for `matchedSubscriptions: 0` returns the real gap.
4. **C4** — `class` and `retry` on a stored event equal the registry entry's values for `(producer, reasonId)`; a publish asserting them is rejected.
5. **C5** — An unknown `(producer, reasonId)`, an undeclared `detail` key, an over-bound value, or a non-scalar `detail` value rejects the publish and increments a rejection counter. No coercion to a generic reason.
6. **C6** — For the `hive-runtime` producer, `waiting` is produced by a function co-located with `policyFor` sharing its prefix table; no second prefix predicate exists in the repository.
7. **C7** — Subscription matching implements exactly the D5 grammar. A test enumerates the grammar; any operator, negation, wildcard, or nesting fails it.
8. **C8** — A transport adapter's `deliver` receives a structured view and returns one of the three outcomes. Only `rejected` with an allow-listed reason permits an automatic retry; `unknown` never resends and is surfaced as uncertainty by every reader.
9. **C9** — Every ledger transition to `seen` / `dismissed` / `snoozed` records a stable actor id and instant. No transition derives from a read receipt, a reaction, or elapsed time. `dismissed` on a `class: integrity` row is refused. No bulk transition exists.
10. **C10** — Nudging has no terminal state. `snoozed` is the only pause and it expires. No code path hands a condition to a different subscriber.
11. **C11** — A derived view returns `unknown` past its staleness horizon, and never `healthy` or `resolved` by default or by self-report.
12. **C12** — No reader treats `activity_log.error` as a failure oracle, and none infers failure from `costUsd` or from duration alone. The measurement in "Problem and observed evidence" is the negative test: a reader that flags all 289 Lane B rows, or that misses the 57 `timedOut` rows with `error: null`, fails this criterion.
13. **C13** — No stored field contains message text, prompt or completion text, tool arguments, a raw error object, a URL, a credential, or free-form prose. Remediation is a registry template plus allow-listed parameters, rendered at delivery.
14. **C14** — The ops path publishes nothing about itself, and no delivery synchronously spawns an agent turn.
15. **C15** — A publish fault cannot fail, delay, or alter a turn's outcome.
16. **C16** — Adding a producer, a reason, a subscriber, or a transport binding requires no change to the envelope, the grammar, or the interface.

## Example seed tables — illustrative only, not configuration

**These are examples for review, not rows to install.** No name, channel, or person below is contract; nothing here ships.

Example reason-registry entries (shape only):

| producer | reasonId | class | retry | remediation template (parameterised) |
| --- | --- | --- | --- | --- |
| `hive-runtime` | `tool-failed` | `resource` | `transient` | "retry {tool} on {subjectId}; if it repeats, inspect {errorSig}" |
| `hive-runtime` | `turn-deadline` | `resource` | `transient` | "check whether {subjectId} needs a longer envelope on tier {tier}" |
| `hive-agent` | `coordination-block` | `judgment` | `deterministic` | "rule on {question} for {subjectId}; nothing else clears this" |
| `hive-scheduler` | `obligation-missed` | `judgment` | `deterministic` | "deliver or cancel {obligationId} for {dueAt}" |
| `beekeeper` | `capability-evicted` | `resource` | `deterministic` | "restore {capability}; a healthy probe rearms" |
| `florist` | `sha-mismatch` | `integrity` | `deterministic` | "reconcile {expected} against {observed}; no dismissal permitted" |

Example subscription (shape only): *a subscriber that wants integrity and judgment conditions where an agent is blocked, on one transport binding* —

```
{ subscriberId: "<stable-id>", filter: { class: ["integrity", "judgment"], waiting: ["agent"] },
  transport: { adapterId: "<adapter>", target: "<opaque stable ref>" } }
```

## Assumptions and remaining decisions

- **⚠ Delegated (non-blocking):** notification identity is `(subscriptionId, dedupeKey)` rather than `(subscriptionId, eventId)`. The brief said "per subscriber, per event"; deduplicating the condition is what keeps a flapping producer from reproducing the epic's own noise, and every publish still appends to the log. Reversing it is a key change in one place.
- **⚠ Delegated (non-blocking):** `class` and `retry` are registry-declared rather than producer-supplied. This is the structural fix for the Florist `loudness` finding and is stronger than that draft proposed; it costs a producer the ability to mark one instance of a reason as different in kind, for which `generation` and a second `reasonId` are the intended levers.
- **⚠ Delegated (non-blocking):** retention posture in D9 — event TTL aligned with activity history, ledger TTL from terminal state, behavioural fields ageing with the row. Operator confirmation is wanted because it is a privacy call, not an engineering one.
- **⚠ Delegated (non-blocking):** the reason registry is retained rather than simplified away. D4 names the simpler alternative and what it costs.
- **Non-blocking, corrects the brief:** the brief's proposed failure signature (`costUsd = 0` with duration near the ceiling) is not usable — `turn-scaffold.ts:353` gives every Lane B turn `costUsd: 0`, all 289 in the measured window, and the 19 long zero-cost unflagged rows are successful `codex/*` turns. The brief's underlying claim stands and is strengthened: 57 of 65 `timedOut` rows carry `error: null`, so `error` is not a failure oracle, and the honest rate is 8.9% against the 5.0% that field reports. Recorded as C12.
- **Non-blocking, supersedes an epic-body sketch:** the epic's child-3 proposal to write ops events into `agent_events` with `deliveries: []` is declined in D10, with reasons. No Decision Register canon is contradicted; the epic body's "Proposed children" section is proposal, not canon.
- **Non-blocking, answers the Florist draft's open questions:** (1) `informational` is in and costs nothing; (2) the default-owner table is rejected by architecture — there is no owner field, and no escalation resolves "to the void" because nothing resolves to a recipient at all; (3) cadence values are operator data, shape fixed here; (4) paging is another adapter and needs no contract change; (5) `remediation` is required, from the registry; (6) `human-now` in-thread behavior is confirmed untouched, and no default subscription selects it.
- **Deployment gate, not a spec gap:** the right-hand column of D11 — reason-registry contents, subscription rows, cadence values, retention values — is human policy that must exist before this contract does anything visible. Shipping the mechanism with zero rows is the intended, safe state: nothing is routed, everything is recorded, and `matchedSubscriptions: 0` measures exactly how much nobody has claimed yet.
- **Open, deferred by the operator:** whether nudging should ever de-escalate or self-heal. Quoted in D1; not designed here, and the ledger carries the fields (`nudgeCount`, `state`, `stateAt`, dismiss rate) that would let that decision be made from evidence.
