# KPR-458 — Ops event contract: publish, subscribe, transport

## TL;DR

KPR-458 defines a publish/subscribe contract for operational facts, in three parts and one ledger. A producer **publishes** an event stating what happened, naming neither a recipient nor a transport; every published event is durable whether or not anyone is listening. A **subscriber** declares, in its own record, which event attributes it cares about; interest never lives in a producer-side or central routing table, and there is no default subscription, fallback recipient, or catch-all. A **transport adapter** carries a notification to one subscriber; Slack is one implementation and the interface is closed over nothing Slack-specific. The one addition classic pub/sub does not supply is an **acknowledgement ledger** — per subscriber, per condition: delivered, seen, dismissed, snoozed, with the acting identity recorded — which is what makes "nudge until acknowledged" and attributed signals possible. Two components this contract requires are chartered to **no child** in the epic's proposed list — the wire between publish and transport, and the inbound edge an acknowledgement returns through. Both are defined here in full and neither is assigned; see the two ⚠ bullets below and D12.

## Key Points

- **Three parts and a ledger; no fourth part.** There is no router, no policy table mapping event to recipient, no default-owner table, and no fallback destination. An event that matches zero subscriptions is stored with `matchedSubscriptions: 0` — a countable, queryable gap. No conforming implementation may add a catch-all subscription to make that number nonzero. The wire that carries an accepted event to a transport holds no policy of its own and is therefore not a fourth part (D12) — but "not a part" is an architectural claim, not an ownership one, and two pieces of that wire are chartered to nobody:
- **⚠ Unowned, blocking for implementation: the matcher–deliverer (D12).** Ledger upsert and renewal, calling the adapter, the nudge sweep, snooze expiry, clearing application, and **acknowledgement intake** — the write path for an attributed `seen`/`dismissed`/`snoozed` act — all belong to one component the epic's proposed-children list names nowhere. Match evaluation is *not* among them: it is a pure, I/O-free test whose result is stamped into the publish insert (D2), so it ships on the **accept path with whoever publishes** — which is what makes a producer shipped alone *staged* rather than broken, and is why the `matchedSubscriptions: 0` above is honest with none of this component built. KPR-454 is chartered as a producer and KPR-455 as a reader. D12 defines the unowned obligations completely and deliberately assigns them to nobody; widening a child or filing a new one is the epic driver's call with the operator.
- **⚠ Unowned: the inbound acknowledgement edge (D6).** Something must capture the act — a Slack interaction, a CLI invocation, an agent tool call — and hand it to intake as `(row, act, actorId, at)`. D6 bars a transport adapter from ledger access, so the edge translates and does nothing else; it ships with whatever surface carries it and no child is chartered for it either. Without it the ledger only ever holds `delivered` and `cleared`, and nudging never stops — the ledger's whole stated purpose rests on this path existing.
- **Severity is not a field.** The Florist registry shipped a `loudness` axis and all 15 rows set it to maximum; a producer-declared severity converges on maximum and reproduces "when everything's red, nothing's red" inside the contract meant to fix it. Routing is `f(class, waiting)`; nudge cadence is `f(class, retry)`. Nothing reads a severity.
- **Producers state facts, not urgency — and cannot assert their own axes.** `class` and `retry` are properties of the *reason* and are read from a producer-owned reason registry, not supplied per publish. Only `waiting` is per-event, because it is invocation context: on the Hive runtime path it is `policyFor()` (`src/outage/outage-notices.ts:18-26`) promoted to a field, with its `silent` bucket split, implemented in that same module so exactly one prefix table exists.
- **⚠ Delegated: notification identity is the deduplicated condition, not the raw event.** The log appends one row per publish; the ledger is keyed `(subscriptionId, dedupeKey)` where `dedupeKey = producer:subjectKind:subjectId:reasonId:generation`. Without this, one flapping tool reproduces the noise the epic exists to remove. The brief said "per subscriber, per event"; this is that, with "event" meaning the condition rather than each restatement of it.
- **Measured, and it corrects the brief's premise.** Both candidate oracles fail on live traffic: `activity_log.error` misses most timeouts, and the brief's proposed `costUsd = 0` signature matches *every* Lane B turn because the shared result builder returns a literal zero. Counts, ratios, dates and file references are in the evidence table below, which is the authoritative statement; the rule they produce is C12 — **outcome must be published, never inferred from cost or duration.**
- **Nudging does not terminate, and no ladder is a primitive.** Per the operator's ruling, an unacknowledged condition keeps nudging on a cadence drawn from a data table; snooze is the only pause and it is attributed and expiring. An escalation ladder is a subscriber that re-publishes under a different reason at a different cadence — not a mechanism this contract builds. No de-escalation or self-healing path is specified.
- **Three signals where a naive design has one.** `dismissed` = seen and judged not worth action; `snoozed` = seen, matters, not now; silence = neither, and nudging continues. This is the record that would later support demoting a reason *from evidence* — the query is stated, the demotion is not built.
- **Reconciled, not superseded.** KPR-456's obligation delivery/notice path and KPR-457's Beekeeper alert sender keep their own contracts intact; neither becomes an adapter of this interface, and the watchdog in particular must not acquire a dependency on the thing it watches. The existing `agent_events` bus is deliberately not reused: its publish-time fan-out *dispatches agent turns* (`src/scheduler/scheduler.ts:322-405`), and an operational-failure feed that spawns turns is a spend-and-feedback loop.
- **In scope:** event envelope, attribute vocabularies, reason registry shape, subscription filter grammar, transport interface and outcome taxonomy, the inbound acknowledgement edge's obligations and intake semantics, ledger states and the total transition table, clearing provenance, staleness rule, redaction allow-list mechanism. **Out of scope:** any subscription row, recipient, channel, actor, cadence value, registry content beyond a labelled example table, dashboard, web server, second inbox, agent identity rollout, and the code of KPR-454 or KPR-455.

## Scope and authority

Ticket: **KPR-458 — Taxonomy + escalation contract for ops-surface severities**. Parent: KPR-451. Worktree baseline: `epic/kpr-451` at `6f1307e`; runtime facts below were read at that tree.

Inputs are the ticket body, the Florist **DRAFT PROPOSAL** comment on KPR-458 (2026-09-08), the KPR-451 epic description including its `## Decision Register — Canon`, an operator disposition pass over a week of live traffic, and four structural rulings by the operator relayed through this drafting dispatch. The rulings are binding and quoted verbatim in D1.

KPR-458 carries `needs-human-spec`, and the Florist draft is explicit that a draft does not close that gate. This artifact does not close it either, and does not claim to. What the four rulings settle is the **structure**: the shape is pub/sub, the event carries no owner, nudging is unbounded, transport is an adapter, viewer signals are attributed. What remains human policy is **content**: which reasons exist, who subscribes to what, and at what cadence. This document deliberately contains none of that content outside an explicitly labelled example table, because content is data and data is not contract.

An earlier framing of this ticket proposed a central routing layer resolving recipients from a policy table, plus a totality rule so nothing escaped it. That design is rejected: it manufactured a hole and then specified a plug. It must not reappear under another name.

Relevant canon: KPR-456's rule that an engineering child supplies **no default recipient, severity, escalation, production registration, prompt rollout, or new policy dependency** — this child is where such policy legitimately lives, and D11 states precisely which part of it is contract, which part ships with a producer, and which part stays operator-registered data. KPR-456's separate obligation contract and KPR-457's separate bounded-retry alert contract are preserved unchanged (D10). KPR-453's rule that a work-item identity "proves neither unique attempt nor task continuity" binds the dedupe key (D2). This artifact follows the repository epic-artifact convention and the conventions in `CLAUDE.md`. Drafting is not implementation-plan approval.

**What this ticket itself produces.** KPR-458 is the epic's policy child ("owner: Mokie — not engineering work" in the epic body). Its deliverable is **this contract document and nothing else**: no code, no collection, no index, no validator, no registry row, no subscription. Collections are created by the child that first writes them (D1), producers ship their own reason rows (D11), and the operator registers the third column. A plan writer reading this artifact should plan for a document, a Gate-1 conversation, and the two scoping decisions named below — not for an implementation.

**Two components this contract requires are chartered to no existing child, and this document assigns neither.** Publishing has an owner (KPR-454, a producer) and reading has an owner (KPR-455, a reader). Unowned are: (i) the thing in between — upserting and advancing the ledger, calling a transport adapter, running the nudge sweep, applying clearing facts, and accepting attributed acknowledgements (D12; match evaluation is *not* part of it — it rides the publish insert on the accept path, D2); and (ii) the inbound edge that captures an acknowledgement act and hands it to that intake (D6). D12 and D6 define both sets of obligations in full, because a contract whose central mechanism is undefined is not implementable. Neither names a child, because that is a scoping decision for the epic driver with the operator: widen KPR-455, widen KPR-454, or file a new child. Nothing in this document may be read as having made that call, and an implementer who finds them unowned has found a real gap rather than an omission.

## Problem and observed evidence

The epic's thesis is that healthy-quiet and stalled are indistinguishable in the record. That is measurable, and the measurement invalidates both candidate oracles.

All counts below were queried on **2026-09-08** over the trailing 7 days on `hive_dodi`. The window slides, so absolute counts move between runs while the ratios hold: a re-run the same day over a slightly shifted window returned 1,392 rows, union 127, 9.1%. Cite the ratio and the date, never the bare count.

| Observation | Evidence |
| --- | --- |
| `activity_log.error` is not a failure oracle | Trailing 7d, `hive_dodi`, queried 2026-09-08, 1,480 turn rows: `error` non-null on 74. `timedOut: true` on 65 rows, of which **57 have `error: null`**. `aborted: true` on 57. The union `error ∨ aborted ∨ timedOut` is 131 — **8.9%, versus 5.0% from `error` alone**. |
| The sparse flags are the best *existing* signal, and they are young | `aborted`/`timedOut` are written sparsely at `src/agents/agent-manager.ts:2611-2612` (KPR-401). The oldest flagged row on this instance is `2026-09-02T01:01:06Z`; only 56 of the 1,480 rows precede it, so the window is almost entirely post-flag and the 8.9% figure is not depressed by missing flags. On any older data — and on any instance deployed later — their absence means unknown, never success. |
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
| `clears` | Optional `dedupeKey` this event asserts is resolved, subject to D8's class provenance rules. Publishable only by a reason whose registry entry lists the cleared condition's reason in `clearsReasonIds` (D4); a `clears` key naming any other reason is rejected. |
| `clearsFamily` | Derived and stored when `clears` is present: the cleared `dedupeKey` with its `generation` component removed. Indexed. This is what lets the generation resolver find a clearing fact published under its own reason (the generation rule below). |
| `matchedSubscriptions` | Count of subscriptions matched at accept. `0` is the countable gap and must remain reachable. |
| `matchedSubscriptionIds` | The `subscriptionId`s matched at accept, stamped in the same immutable insert. `matchedSubscriptions` is its length. This is the **only** join between the synchronous half and the swept half (D12): the sweep reads the list rather than re-evaluating, so no subscription registered after accept can acquire the event (D5) and the stored count stays honest for the set that existed at accept. Bounded by the registered subscription set, which is operator-registered data and does not grow with traffic. |

Explicitly absent, and not to be added by any consumer: `owner`, `escalatedTo`, `assignee`, `severity`, `loudness`, `priority`, `destination`, `channel`, `recipient`, and any rendered message string.

**Dedupe and identity, with the KPR-453 caveat.** Canon: a work-item identity "proves neither unique attempt nor task continuity", and retries and outage replay may reuse an item id. So a `subject.kind: "workItem"` dedupe key deliberately collapses a retried turn's repeated failures into one condition — which is right for notification and lossless for the log, since every publish still appends. A producer that genuinely needs attempt-level separation advances `generation` under the rule below; it must not synthesize a fake subject id to force separation, and it does not get to advance `generation` at will either.

**When `generation` advances — the rule, not a producer's discretion.** `generation` is the only lever that gets a `seen` or `dismissed` condition notified again — it changes the `dedupeKey`, so it opens a fresh ledger row beside the closed one (D7 rule 4) — which makes an unstated advance rule a coin flip between "every occurrence bumps" — which collapses no duplicates and reproduces the noise this epic exists to remove — and "never bumps" — which makes one dismissal a permanent silence. Neither is acceptable, and the contract fixes the rule rather than leaving it to the implementer:

- **`generation` is an epoch over recovery, not an occurrence counter.** It advances when a condition *comes back after having gone away*. A repeat with nothing in between is not a new generation; that is what `eventCount` counts.
- **For the `hive-runtime` producer**, `generation` is `0` on the first publish of a `(subject, reasonId)` and advances by exactly one when the runtime publishes that condition again *after* it has published a class-legal clearing fact (D8) for it. It never advances because the condition recurred, because time passed, because a nudge went unanswered, or because a turn retried. A failing tool that fails again ten minutes later is `generation` unchanged and `eventCount` incremented; a tool that fails, succeeds (clearing fact published), and fails again is `generation + 1`.
- **This makes publishing recovery an obligation, not a nicety.** The rule only works if the clearing fact actually gets published: a producer that reports failures and never reports recovery can never advance a generation, and one dismissal there is permanent silence. Any producer with `class: resource` reasons must therefore publish the clearing fact when it observes the predicate hold again — for `hive-runtime`, the same tool succeeding on the same subject. A clearing fact per success would be a flood, and a clearing fact for a condition that was never raised is noise, so the producer publishes **only when it holds an open condition for that `(subject, reasonId)`**.
- **Openness is resolved from bounded in-process state, never from a read per success.** The producer keeps a capped in-process map of the `(subject, reasonId)` families for which it has published an uncleared failure, entered when it publishes the failure and removed when it publishes the clearing fact; eviction is oldest-first at the cap. A tool *success* therefore costs a map lookup and nothing else — a per-success database read would put I/O on the turn path for the overwhelmingly common case, against C15, and it is the common case that makes this the wrong place to spend. Named residual: a restart empties the map, so a condition raised before the restart gets no clearing fact when it next succeeds and its epoch does not advance at that boundary; the following failure→recovery cycle re-arms it. One lost epoch boundary per restart per open condition, never a lost fact — the log append is unconditional either way.
- **The clearing fact carries its own registered reason, and that is what keeps this rule from failing closed.** A clearing event is not published under the condition's own `reasonId`: it would then match the condition's subscriptions and notify people about a recovery. It carries a distinct reason (`tool-recovered` beside `tool-failed`) whose registry entry lists that condition reason in `clearsReasonIds` (D4), same producer. Without that declared link the resolver below could never observe the clearing fact, `generation` could never advance, and one dismissal would be permanent silence — the exact failure this rule exists to prevent.
- **Consequences, stated so nobody is surprised by them.** A `dismissed` condition stays silent until it genuinely recovers and recurs — that is the intended meaning of a dismissal, not a defect — or until its ledger row ages out under D9's retention, whichever comes first; D9 states that second horizon and why it is deliberate. A condition that never recovers keeps exactly one ledger row for its whole life; the operator's visibility lever there is the derived view's staleness horizon (D8) and the row's own `nudgeCount`, never a manufactured generation bump.
- **Resolution and its residual.** At publish of a *failure*, the producer resolves the current generation with **two bounded indexed reads over the same family** `producer:subject.kind:subject.id:reasonId`: the latest event under that `reasonId`, and the latest event whose `clearsFamily` equals it. If the clearing fact is the more recent of the two, the generation is the latest condition event's plus one; otherwise it is that condition event's unchanged (and `0` when there is none). Two reads rather than one is the price of the clearing fact carrying its own reason, and it is paid on failure publishes only — never on the success path (bullet above). If either read faults, the publish still proceeds — contained, per D10 — at the producer's last in-process value for that family, defaulting to `0`. Named residual: such an event may attach to a stale epoch's ledger row, which is a bounded mis-attachment of a notification, never a lost fact, because the log append is unconditional.
- **Every other producer declares its advance rule alongside its registry rows**, in the same terms (what counts as "went away" for that producer). A producer that declares none holds `generation` at `0`, and its conditions therefore reopen only through a clearing fact.

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
| `notify` | fallthrough: human channels (slack, sms, imessage, app/ws) | `human-now` |
| `silent` | `team-` | `agent` |
| `silent` | `callback:`, `event:`, `worker:` | `nobody` |
| `skip` | `sched:` | `nobody` |

One cue in that file is stale and must not be copied: `policyFor`'s fallthrough comment reads *"human channels: slack, sms, imessage, app/ws, team DM"*, but a `team-` id returns `silent` two lines above and can never reach the fallthrough. The table above therefore omits "team DM" from the `notify` row, and `team-` maps to `waiting: agent`. **Read the prefix table, not the comment** — an implementer who trusts the comment maps agent-to-agent traffic to `human-now`, which is precisely the misrouting this epic exists to remove.

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
{ producer, reasonId, class, retry, remediationTemplate, detailKeys[], clearsReasonIds?, enabled }
```

- `clearsReasonIds?` marks this reason as a **clearing reason** for one or more condition reasons of the *same producer*, and is the declared link D2's generation rule reads. One clearing reason may cover several conditions, so this costs a producer one extra row, not one per condition. A row naming an unregistered reason is rejected at registration; an event carrying `clears` whose reason declares no `clearsReasonIds`, or whose `clears` key names a reason not in that list, is rejected at publish (C5, C19). A clearing reason is an ordinary reason in every other respect: it is matched against subscriptions under its own attributes and mints or renews its own ledger rows, never the cleared condition's — the cleared row transitions by D12's clearing application, not by renewal. In practice a clearing reason is `informational` and no subscription selects it; a subscriber that *wants* recoveries registers for it, which is the whole mechanism.
- **A `class: resource` reason cannot be enabled until some registered reason clears it.** This is D2's recovery obligation in enforceable form rather than prose: `resource` is the class whose conditions recur, so it is the class where a missing clearing reason turns one dismissal into permanent silence. Registration order is free — the gate is `enabled`, not insertion — and `informational` reasons are exempt because they have no clearing act. `judgment` and `integrity` are deliberately *not* gated: their clearing acts are human-originated (a ruling, an authoritative evidence reference) and may legitimately be registered later or, for `integrity`, never dismissed at all. Named residual: a `judgment` condition dismissed while no clearing reason exists for it stays silent until one is registered (or until D9's retention horizon passes), which the dismiss-rate query (D8) makes visible.
- `class` and `retry` are declared here, once, and stamped onto every event of that reason. A producer therefore cannot escalate itself by declaration — the Florist lesson, enforced structurally rather than by review.
- `remediationTemplate` is **required, with no default**: a bounded parameterised string naming the act that would clear this, filled from `detail`. An alert that ships its own instruction is actionable; one that does not is noise with a timestamp. The template is registry data, reviewed when the row is added; the event stores parameters, never rendered prose. Rendering happens in the transport adapter at delivery.
- `detailKeys` declares the allow-list: key name, scalar type, max length. This is what makes redaction a write-time schema rather than a scrub-after pass.
- Adding a reason is a row. Adding a producer is rows. Neither is an engine change — which is what lets Florist come online later with producers that do not exist today.

The registry is the one piece of this design that could be dropped: `reasonId` would become a free bounded string and `detail` a fixed flat allow-list. That simplification costs fail-closed validation, the required remediation, the anti-drift property above, and — since D2's generation rule reads the declared `clearsReasonIds` link — the ability to reopen a dismissed condition at all. It is named here so the tradeoff is visible, not to invite it.

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

**`cadenceProfile?` replaces the table lookup; it never merges with it and never outruns the floor.** Nudge cadence is `f(class, retry)` from D8's table. A subscription may name one operator-registered cadence profile, and naming it **substitutes that profile wholesale** for the `(class, retry)` lookup for this subscription's rows. There is no field-by-field merge, no per-attribute override, and no inheritance chain — a merge semantics would make the effective cadence of any row a function of two tables and an implicit precedence order, which is a rules engine by another name. Absent the field, the table applies. Both paths are clamped by one operator-set minimum nudge interval, so no subscription can nudge faster than the floor; a profile asking for less than the floor is clamped up, loudly, at registration. The profile's *values* and the floor's value are operator data (D11), not contract.

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

`NotificationView` is **structured**, never a pre-rendered string: the event's envelope fields, the resolved remediation template plus its parameters, the evidence references, the ledger row's current state and nudge count, and an **opaque acknowledgement handle** naming that ledger row. The adapter owns rendering, because a Slack block, an SMS body, and a push payload are different artifacts of the same fact. The handle exists so that whatever act comes back can be tied to one row without the returning surface knowing the ledger's shape.

What an adapter must not do: choose or discover a recipient; read `ops_subscriptions`; decide whether something is important; apply policy of any kind; or spawn an agent turn (D10). It renders one notification to one target and reports one of three outcomes.

The three outcomes are deliberately KPR-456's honest-uncertainty taxonomy, adopted so the two contracts agree rather than compete: `accepted` requires a transport acknowledgement; `rejected` is a **closed, provenance-checked allow-list** of responses proving nonacceptance, and is the only status that permits an automatic retry; everything else — timeout, crash after submission, ambiguous error — is `unknown`, is never blindly re-sent, and must be surfaced as uncertainty by any reader rather than reported as notified. A `rejected` retry reuses the same ledger row and increments its attempt count; it never mints a new condition.

**Both reason sets are enumerated here, transport-agnostically.** KPR-456's list is not reused verbatim, because that list is Slack response codes and this interface is closed over nothing Slack-specific; what is reused verbatim is its *rule*. The two closed sets are:

```
type NonacceptanceReason =            // proof that nothing was accepted
  | "unauthenticated"                 // no valid credential presented
  | "unauthorized"                    // credential valid, not permitted for this target
  | "target-unknown"                  // target does not resolve
  | "target-ineligible"               // target resolves but cannot receive (archived, inactive, not a member)
  | "payload-rejected"                // refused on shape or size before acceptance
  | "refused-rate-limit";             // a refusal that proves nothing was accepted

type UncertaintyReason =              // everything else
  | "timeout"
  | "transport-fault"
  | "ambiguous-response"              // unrecognized, unvalidated, or partial acknowledgement
  | "crashed-after-submission";
```

Each adapter maps its vendor responses into these; the mapping is adapter-local and the sets are not extended by an adapter. A Slack adapter's mapping input is KPR-456's own code list, unchanged, and **KPR-456's rule governs additions in both contracts: a new response may be mapped to a `NonacceptanceReason` only with documented evidence that it proves nonacceptance, plus a classifier test.** Anything short of that proof maps to `ambiguous-response`, which never retries. An adapter that cannot decide maps to `unknown`, never to `rejected`.

Delivery state is per notification (D7), so an adapter is stateless with respect to policy.

**⚠ The inbound acknowledgement edge — defined here, owned by nobody.** An attributed `seen` / `dismissed` / `snoozed` act has to enter the system through *something*: a Slack interaction callback, an operator CLI invocation, an agent tool call. That something is **not** a method on `OpsTransport` — a CLI is not a transport, and requiring an inbound method would force every adapter to implement a surface most of them cannot have. It is a capability that ships with whichever surface carries it, under obligations fixed here:

- It converts one vendor-specific act into one intake call — `(acknowledgement handle, act, actorId, at, snoozedUntil?)` — and does nothing else. The handle is the one it was given in the `NotificationView`.
- It never reads or writes the ledger, never reads `ops_subscriptions`, and holds no state. D12's intake validates and applies; the edge only translates. This is the same bar D6 sets for outbound: no policy, no ledger.
- It must **attribute or refuse**. An act it cannot tie to a stable actor id is rejected, never attributed to the adapter, to a service account, or to the system principal. D7 rule 1's bar carries: a read receipt, a channel visit, an emoji reaction, or elapsed time is not an act, and this edge must not manufacture one from any of them.
- Idempotency, class legality (an `integrity` dismissal is refused), and state legality are intake's job, not the edge's — so a duplicate callback is safe and the edge needs no memory.

No child in the epic's list is chartered for this, exactly as none is chartered for D12. Without it, ledger rows only ever reach `delivered` or `cleared`, every acknowledgement state is unreachable, and "nudge until acknowledged" nudges forever — which makes this the second scoping item the driver owes the operator, not a detail.

### D7. Acknowledgement ledger and lifecycle

**Events never change state.** An event is a fact, and facts do not resolve. This is a deliberate divergence from the Florist draft's `raised → resolved` lifecycle on the escalation itself: under pub/sub the *condition* is tracked by the ledger and cleared by a *later fact* (D8).

One ledger row per `(subscriptionId, dedupeKey)`:

```
{ _id, subscriptionId, subscriberId,
  dedupeKey, producer, reasonId, class, waiting, retry, subject, generation,   // snapshot, so the reader needs no join
  firstEventId, latestEventId, eventCount, firstSeenAt, lastEventAt,
  state, stateAt, principal, principalAt, snoozedUntil?,   // principal: a stable actor id, or the reserved system principal
  attempts[], attemptCount, lastOutcome, deliveryReference?,
  nudgeCount, lastNudgeAt, nextNudgeAt }
```

**The row is bounded, because nudging is not.** Ruling 2 makes an unacknowledged condition nudge indefinitely and D9 retains a row for as long as it is still nudging, so an unbounded `attempts[]` is a row that grows for as long as nobody answers — the one place in this design where "no terminal state" would turn into an unbounded document. `attempts[]` is therefore a **ring of the most recent attempts only** (bounded by a contract-fixed cap, not an operator value; the implementing child picks the cap and it is not large), and `attemptCount` alongside it is the monotonic total that the ring cannot express. `nudgeCount` is likewise a counter, never a list. Nothing else on the row is a growing collection: `eventCount` counts and `latestEventId` replaces. What the ring drops is deliberately gone — older delivery attempts are not recoverable from `ops_events`, which records publications rather than deliveries — and the honest accounting that survives is the total, the most recent outcomes, and `lastOutcome`. A reader must not present the ring as a complete attempt history.

States and their exact meanings:

| state | meaning | set by |
| --- | --- | --- |
| `pending` | matched; not yet accepted by a transport | the sweep's ledger upsert (D12) |
| `delivered` | a transport returned `accepted`. **Not** seen. | transport outcome |
| `seen` | an explicit, attributed positive acknowledgement | an actor's deliberate act |
| `dismissed` | seen and judged not worth action | an actor's deliberate act |
| `snoozed` | seen, matters, not now; suppressed until `snoozedUntil` | an actor's deliberate act |
| `cleared` | the condition itself resolved | a class-legal clearing event (D8) |

**The lifecycle is total: every state has a defined transition in and a defined transition out, and every transition names a principal.** Unattended transitions are not unattributed — they record a reserved **system principal**, a stable non-human id that no person or agent can hold (D9).

| from | to | trigger | principal |
| --- | --- | --- | --- |
| *(none)* | `pending` | first match of a `dedupeKey` for a subscription; row created | system |
| `pending` | `delivered` | an adapter returned `accepted` | system |
| `pending`, `delivered`, `seen`, `snoozed` | `seen`, `dismissed`, `snoozed` | an attributed act through intake (D12); re-snoozing an already-`snoozed` row moves `snoozedUntil` (clamped, D12) and nothing else | actor |
| `snoozed` | `delivered` if the row has a recorded `accepted` outcome, else `pending` | `snoozedUntil` elapsed; applied by the sweep | system |
| any state | `cleared` | a class-legal clearing event applied (D8) | system, evidenced by the clearing event id |
| `cleared` | `pending` | a matching event renews a cleared row (rule 4) | system, evidenced by the renewing event id |
| `dismissed` | *(only `cleared`)* | a dismissal is not undone by repetition; a genuinely new epoch mints a new row instead (D2) | — |

Three things that follow, stated so none has to be inferred: an expired `snoozed` row is not merely "eligible", it **is** `pending` or `delivered` again and therefore inside D8's nudge-eligible set literally; a reopened `cleared` row is `pending`, so its next delivery goes through the ordinary attempt path rather than a special case; and an acknowledgement act arriving for a row that is already `cleared` is **refused, not applied** — the table admits no such transition, and this is the ordinary race in which a clearing fact lands between a delivery and the acknowledger's click. The row stays `cleared`, nothing is recorded, and the refusal is a no-op for the acknowledger rather than an error they must handle; if the condition returns, it returns as a renewal or a new epoch (rule 4), not as a stale acknowledgement.

Rules that make those distinctions load-bearing:

1. **`seen` requires an explicit act.** A Slack read receipt, a channel visit, an emoji reaction, elapsed time, or any inference is not `seen`. Only an act whose whole purpose is to say "I have seen this" transitions the row, and the acting identity is recorded — per the operator's one-word ruling, *attributed*.
2. **Silence is a state, not an absence.** A row left at `delivered` while nudges accumulate is the third signal. `dismiss` ≠ `snooze` ≠ silence, and a design that collapses them loses the only evidence the demotion question could ever be settled from.
3. **`dismissed` does not clear.** It stops nudging that subscriber; the condition remains open in the derived view (D8) until a clearing fact arrives. For `class: integrity` a dismissal is refused outright — if an integrity condition can be dismissed like an ordinary alert, someone eventually dismisses one and a gate is skipped.
4. **A repeat publication renews rather than duplicates, and a new epoch is not a renewal.** A matching event whose `dedupeKey` already has a row updates `latestEventId`, `lastEventAt`, and `eventCount`. If that row is `seen`, `dismissed`, or `snoozed`, the renewal increments and sends nothing new — `snoozed` still resumes on its own at `snoozedUntil`. If the row is `cleared`, the renewal **does** reopen it — to `pending`, under the system principal, with the renewing event id as its evidence: the condition demonstrably came back while the producer did not, or could not, advance its epoch, and the design errs toward a duplicate rather than a gap. An advanced `generation` never touches an existing row at all — it changes the `dedupeKey`, so it mints a fresh row and leaves the closed one closed, which is the ordinary path for a condition that recovered and recurred (D2). A `retry: deterministic` reason renewing repeatedly with no clearing fact and no epoch advance is itself a countable defect signal in the responder.
5. **No bulk transitions, and every transition names a principal.** Every state change names exactly one row and one principal: a stable actor id for `seen` / `dismissed` / `snoozed`, the reserved system principal for the four unattended transitions in the table above (row creation, delivery outcome, snooze expiry, clearing and reopen). The system principal can never produce `seen`, `dismissed`, or `snoozed` — those three require an act, which is the whole of rule 1. There is no "clear all", no "dismiss channel", and no sweep that ages rows into `dismissed`.

### D8. Nudging, clearing, and derived condition state

**Nudging does not terminate.** `nextNudgeAt` advances from a cadence table keyed `(class, retry)`; the table is data with operator-set values, and this contract fixes only its shape. A row that is `pending` or `delivered` past `nextNudgeAt` is nudge-eligible; `snoozed` suppresses until `snoozedUntil`, which acknowledgement intake clamps to an operator-set maximum measured from the act (D12 states the clamp; D11 lists the value as operator data), so no act can pause a row indefinitely; at that point the sweep transitions it back to `delivered` or `pending` per D7's table and it is nudge-eligible again by that fact rather than by exception; `seen`, `dismissed`, and `cleared` are not nudge-eligible. There is no attempt ceiling, no terminal give-up, and no automatic hand-off to anyone else — per ruling 2, and pending the operator's later call on a self-healing or de-escalation path. A nudge re-delivers the same ledger row through the same transport; it never creates a second row.

**Clearing is a published fact, with per-class provenance.** A clearing event is an ordinary event carrying `clears: <dedupeKey>`, published under its own registered clearing reason — one whose entry lists the condition's reason in `clearsReasonIds` (D4), never under the condition's own reason, which would notify subscribers about a recovery. Its `class` and `retry` are its own registry entry's; whether it takes effect is decided by the *cleared* condition's `class`, using D3's table: `resource` accepts a same-producer predicate assertion; `judgment` accepts only an event recording a named human ruling; `integrity` accepts only an event carrying the authoritative evidence reference; `informational` has no clearing act. A clearing event that fails its provenance test is stored — it is a fact that someone tried — and does not transition the row.

**Derived condition state, and the staleness rule.** The epic's two named views fall out of the log with no additional structure:

- *Tool health*, keyed `(detail.tool, detail.errorSig)` over `producer: hive-runtime` tool-failure reasons: latest outcome wins.
- *Work status*, keyed `subject` where `subject.kind = "workItem"`: open until a class-legal clearing fact.

For both, and for any future view: **past a staleness horizon with no fresh fact, the derived state is `unknown` — never `healthy`, never `resolved`, never `ok`.** A self-reported resolution is a fact like any other and is subject to the same horizon. This is the epic body's rule carried verbatim into the contract, and it is the single sentence that prevents the reader from re-inventing the heuristic this design exists to abolish.

The horizon's *value* is operator data, one per derived view, listed as such in D11 — it is not fixed here, because the right horizon for a tool-health rollup and for a work-status view are different questions and both are policy. Two things about it *are* contract: a view must have a horizon (a view without one cannot be registered, since the fallback would be indefinite trust in a stale fact), and the horizon is a property of the view rather than of a reason, a class, or a subscription.

**Openness is a property of someone caring.** With zero matching subscriptions there is no ledger row, so nothing tracks whether the condition is still open; the derived view above still answers the question from the log, and `matchedSubscriptions: 0` is the visible signal that nobody asked to be told. That is the honest consequence of refusing a catch-all, and it is stated rather than papered over.

**The demotion query, unbuilt.** Dismiss rate per reason is `count(state = dismissed) / count(rows)` grouped by `(producer, reasonId)` over a window. No engine behavior in this contract reads that ratio. The record exists so the operator can later decide, from evidence, that a reason should stop being routed — the intended replacement for anyone declaring a class unimportant up front.

### D9. Redaction, attribution, and retention

**Redaction is the schema, applied at write time.** The envelope's fields are fixed; `detail` accepts only registry-declared keys with declared scalar types and length bounds; `evidence` accepts only `{kind, id}` references. An unknown key, an oversized value, or a non-scalar rejects the publish — fail closed, and the rejection is counted so a mis-integrated producer is visible rather than silent. Never stored, in any field: message or prompt or completion text, tool arguments, raw error objects or stack traces, URLs, credentials, file paths, or free-form operator prose. A tool error becomes a normalized signature (tool name plus an enumerated error token), never the message that produced it. This is the epic's §5.1 rule — the surface whose purpose is pasting diagnostics is exactly where a token gets written.

**Attribution is an id and a timestamp, and nothing else.** A ledger transition stores the acting principal's stable identifier (Slack user id, agent id, or the reserved system principal for the unattended transitions in D7's table — a fixed non-human id no person or agent may hold) and the instant. The reserved id keeps "nobody recorded this" and "the system did this" distinguishable without a nullable field, and it is not behavioural data: a row whose only principal is the system principal says nothing about any person. It does **not** store a display name, an email, a device, a client, a location, or a free-text reason for a dismissal. There is deliberately no "why did you dismiss this" field: the signal is the rate, not the prose, and a prose field on a per-person behavioural record is a privacy liability with no consumer.

**Retention, and it puts a horizon on acknowledgement.** ⚠ Delegated, conservative default: `ops_events` carries a TTL on `publishedAt` aligned with the existing activity-history retention; an `ops_notifications` row is retained while it is still working — `pending`, `delivered`, `snoozed` — and TTLs from `stateAt` once it has stopped, which is `seen`, `dismissed`, or `cleared`, so attributed actor data ages out with the row that carries it. `snoozed` is the one retained state that carries an actor id, and it is bounded rather than open-ended: intake clamps `snoozedUntil` to the operator maximum (D12), so a retained row cannot hold attributed data indefinitely. **Retention follows nudging, not terminality**, and the two differ: `dismissed` and `seen` stop the nudging without closing the condition (only a clearing fact closes a row, D7), so ageing them out has a consequence that must be documented rather than discovered — **acknowledgement silence lasts until the condition recovers and recurs (D2) or until the ledger TTL elapses, whichever comes first.** Once the row ages out, a still-recurring condition re-mints under the same `dedupeKey` at `pending` and nudges again as though never acknowledged. Deliberate in both directions: a per-person behavioural record should not be kept indefinitely for a condition nobody ever cleared, and — as everywhere else in this design — the race errs toward a duplicate nudge rather than a silent gap. It makes the ledger TTL's *value* (operator data, D11) the acknowledgement-silence horizon, to be chosen as that and not only as a privacy setting. Two deliberate divergences from KPR-456's no-TTL occurrence checkpoints: those retain *delivery-obligation evidence*, which this log does not hold, and they carry no per-person behavioural fields, which these rows do. An operator who wants longer retention of ops history should extend the event TTL and not the ledger's, so the behavioural half ages first — noting that extending the ledger's also lengthens every acknowledged row's silence.

### D10. Boundaries: existing paths, the event bus, and turn spawning

**KPR-456's delivery and notice path is untouched.** `deliver_obligation` sends a registered deliverable to a registered destination and writes its own receipt under its own evidence rules; a missed-deadline notice goes to its own explicitly registered notice destination. Neither is an ops notification and neither is retrofitted onto this transport. KPR-456's sweep is, later, a natural *producer* into this log (`waiting: obligation`); that is a future publish, not a redirection of its notice path, and it requires no change to KPR-456's contract. Canon preserved.

**KPR-457's Beekeeper sender is untouched, and must stay that way.** It lives in another repository, in a process whose purpose is to report that Hive is gone; making it an adapter of an interface implemented inside Hive would give the watchdog a dependency on the thing it watches. Beekeeper is a *producer* whose events may later reach this log by an out-of-band path; its alert delivery keeps its own bounded-retry, best-effort contract, which canon explicitly preserves and this document does not supersede.

**`agent_events` is not reused, and the epic body's sketch is superseded on this point.** The epic's proposed child 3 suggested new `system:*` types written with `deliveries: []` and `hasPending: false` so the scheduler would not dispatch them. That works only by disarming a mechanism whose entire purpose is dispatch: `Scheduler.checkEvents` turns each pending delivery into a `WorkItem` and spawns a turn. An operational-failure feed sharing a collection with a turn-spawning bus is one field away from a spend loop, and its closed domain-keyed schema cannot carry the envelope above. Separate collections; the coordination bus keeps its behavior unchanged, including the `subscribe: string[]` field on agent definitions (`src/types/agent-definition.ts:65`), which is the *event-bus domain* list and must not be overloaded to mean ops subscriptions.

**Two invariants that close the feedback loop.** (a) *The ops path never publishes about itself* — a publish failure, a match failure, a transport `rejected`/`unknown`, or a nudge failure is logged and counted, never published. (b) *No transport delivery may synchronously spawn an agent turn.* Delivering to an agent subscriber means placing the notification on a surface that agent reads on a turn it was going to run anyway; it never causes a turn. Without (b), a tool failure notifies an agent, whose turn fails, which publishes, which notifies.

**Engine-integration obligations for the consuming children**, from `CLAUDE.md`, stated here because a contract that ignores them is unimplementable. They cover **publishing** only — and the accept path *is* publishing, so match evaluation and therefore the loaded subscription set and the `ops_events` / `ops_subscriptions` initialization fall under these obligations too (D12). The ledger, delivery and nudge component has its own boot-order and containment obligations, and they are not the same ones — see D12.

- Publishing is read per spawn, so its wiring belongs **above** `index.ts`'s `// ── Spawn-capable boundary ──` marker, with its anchor added to all three lists in `src/boot-order.test.ts`.
- Publishing must never fail a turn: contain every fault inside the publish call and degrade to warn-and-count, the discipline KPR-452 D4 imposed on the audit path for the same reason.
- If an agent-facing publish tool is ever added (agents tag only what the runtime cannot see — coordination and semantic blocks), it is subject to the in-process `delegateServers` constraint and to worker containment: `WORKER_SERVER_DENYLIST` and the three `suppressAutoInjectedServers` gates. A contained worker must not gain an outbound surface through this door.
- **`waiting: human-now` publication is additive and replaces nothing.** A human in a live thread already sees failures in that thread in real time, and that behavior is untouched — the disposition pass's principle that errors travel with their traffic. No engine default subscription selects `human-now`, so publication records the fact without producing a second notification for a human who already has one.

### D11. What this contract defines, what ships with a producer, and what stays operator-registered data

There are **three** columns of reality here, not two, and collapsing the first two is what makes "ships zero rows" sound safe when it is not. Reason-registry rows are *not* operator policy: they are a producer's own declaration of the conditions it can report, and under C5 an unknown `(producer, reasonId)` fails closed. A producer whose reasons are unregistered cannot publish at all.

| Defined here (contract) | Ships with its producer child (code-adjacent data) | Registered by the operator (not this ticket) |
| --- | --- | --- |
| Event envelope fields and their bounds | — | Any actual event |
| `class` / `waiting` / `retry` vocabularies and their meanings | — | — |
| `waiting` derivation from `policyFor` for the runtime producer | — | — |
| `dedupeKey` formula, renewal semantics, `generation` advance rule | Each producer's own declared advance rule (D2) | — |
| Reason-registry entry **shape**, including the `clearsReasonIds` link and the `resource` enable gate | Reason-registry **rows for that producer** — `class`, `retry`, `remediationTemplate`, `detailKeys`, and its own clearing reasons — reviewed with its code and enabled at its deploy | Enabling/disabling an individual reason after the fact (`enabled`) |
| Subscription document shape and the filter grammar | — | Every subscription row, subscriber, and transport binding |
| Transport interface and the three-outcome taxonomy; both reason allow-lists | Each adapter's vendor-response mapping | Which adapters are bound; which target each binding names |
| Ledger states, the total transition table, attribution rules, and the reserved system principal | — | — |
| Acknowledgement-intake semantics and the inbound edge's obligations (D6, D12) | Each carrying surface's own inbound edge — **⚠ chartered to no child** | Which surfaces expose one |
| Clearing provenance by class; the staleness→`unknown` rule | — | Each derived view's staleness-horizon **value** |
| Cadence-table **shape**, keyed `(class, retry)`; profile-replaces-table semantics | — | Cadence **values**, any named cadence profile, the minimum-nudge floor, and the snooze maximum |
| Redaction mechanism and the attribution allow-list | Each producer's `detailKeys` allow-list | Retention values, within D9's posture |

**A reason row is not a policy row.** It carries no recipient, no severity, no cadence and no urgency — `class` and `retry` are factual properties of the condition, and `remediationTemplate` is the act that would clear it. That is precisely why a producer may ship its own: nothing in a reason row decides who hears about it. Everything that decides that lives in the third column, and this ticket ships none of it.

Per KPR-456 canon, an engineering child supplies no default recipient, severity, escalation, or production registration. **This child supplies none either** — it supplies the vocabulary in which an operator can register those, and ships **zero rows of the third column**. The third column is the deployment gate, and it is human policy work that this document does not perform.

### D12. The matcher–deliverer: obligations defined, ownership open

Placed last because it is the epic's open scoping item, not because it is peripheral: without it, a publish reaches nobody and the ledger is never written. The name is the epic's shorthand and is kept for continuity; matching itself is not this component's, per the ownership split below.

**It is not a fourth part.** It holds no policy of its own and can hold none: it acts on a match result the accept path stamped, against a filter grammar it does not author; it hands a structured view to an adapter it does not choose, resolves a target it cannot read the meaning of, advances a clock from a table it does not set, and applies acknowledgement acts it neither authors nor judges. Deleting it would not remove a decision from the system, only the wire. That is what keeps "three parts and a ledger" true.

**What it owns**, exhaustively: (1) ledger row creation and D7-rule-4 renewal, driven by the event's stamped `matchedSubscriptionIds`; (2) calling `deliver` on the bound adapter and recording the outcome; (3) the nudge sweep and snooze expiry; (4) applying a clearing event after its D8 provenance test; (5) **acknowledgement intake** — accepting one attributed act from an inbound edge (D6), clamping it, and applying it to one row; (6) counting its own faults. It owns nothing else — no rendering, no recipient choice, no importance judgement, no retry beyond the `rejected` allow-list, and **not match evaluation**, which is pure, performs no I/O, and is stamped into the publish insert on the accept path (D2), so it ships with publishing rather than with this component.

**Intake is item (5) and belongs here, not on the adapter.** The ledger is the only thing an acknowledgement writes, D6 bars an adapter from touching it, and D7's rules — one row, one principal, no bulk path, `integrity` refuses dismissal, `seen` requires an act — are exactly the rules this component already enforces on every other transition. Splitting intake into its own component would mean two writers to one ledger enforcing one rule set, which is how the rule set drifts. Intake's obligations: validate the acknowledgement handle resolves to one row; require a stable actor id and refuse the act outright without one; refuse a transition the D7 table does not permit — including any act on a `cleared` row (D7) — and refuse a `dismissed` on `class: integrity`; **clamp `snoozedUntil`** to the operator-set snooze maximum (D11) measured from the instant of the act, applying the clamped value rather than refusing the act, since refusing would leave the row unpaused and nudging, which is the opposite of what the acknowledger asked for — and refuse a `snoozed` whose `snoozedUntil` is absent or not in the future, which is not a pause at all. Intake is the only place a `snoozedUntil` enters the system — D6 bars the inbound edge from anything but translation — so an unclamped one would be the single way an act could silence a row indefinitely — a terminal state by another name, which ruling 2 forbids. Intake must further be **idempotent** — replaying the same `(row, act, actor)` is a no-op rather than a second transition, so a duplicated callback is harmless — and must record the principal and instant and nothing else (D9). Intake is the one part of this component that is *not* swept: it is a direct, bounded write on the caller's own path, because an acknowledgement that takes a sweep interval to register invites the operator to press the button twice. It never spawns a turn and never publishes (D10).

**Synchronous versus swept — and the split is also the ownership line.** *Match evaluation is synchronous with accept, pure, and part of publishing, not of this component* — an in-memory test of the filter grammar against the loaded subscription set, no I/O — so its result is stamped into the event document at insert and the log stays immutable per D1. Whoever ships the publish call ships it; by the epic's list that is KPR-454. This is what makes the staging claim below literally true rather than aspirational: a producer alone stamps an honest `matchedSubscriptions: 0` with none of this component in existence. *Everything after the insert is this component's, and is swept*: ledger upsert, first delivery, nudges, snooze expiry, and clearing application all run on a bounded, non-overlapping periodic sweep, never on the publishing turn's path. KPR-456's independent 30-second obligation sweep is the precedent for the shape; the interval is an implementation choice, the non-overlap and the boundedness are not. Acknowledgement intake is the single exception and is not swept, for the reason given above.

**The handoff between the two halves, since the log is immutable.** Splitting match from delivery raises an obvious question — how does the sweep learn *which* subscriptions matched, when it cannot re-evaluate and cannot mark the log? Both answers are stated so neither is invented:

- **Which:** the immutable insert carries `matchedSubscriptionIds` (D2) alongside the count. The sweep reads that list; it never re-runs the matcher. Re-evaluation is forbidden precisely because it would let a subscription registered after accept acquire a past event, contradicting D5, and would make the stored count a lie. If a stamped subscription has since been disabled or removed, no row is created for it and the stored count still stands — the count is honest for the set that existed at accept, which is what C2 asserts, and it was never a delivery promise.
- **How far:** progress is a **cursor held outside the log**, not a marker on it — one durable checkpoint over the log's `(publishedAt, _id)` order, advanced only after the ledger upserts for the events it covers are durable. A crash re-processes rather than skips. It is a cursor, not a record: it holds no facts, nothing but the sweep reads it, and it is not a fourth collection of this contract; where it lives is the implementing child's choice.
- **Why re-processing is safe:** the ledger upsert is idempotent per `(row, event)` — a renewal applies only when the row's `latestEventId` is not already that event's id. `eventCount` therefore counts distinct events, never sweep attempts. Events are applied in log order, so a clearing event can never be applied before the condition event it clears.

**The subscription set is loaded, not queried per publish.** This is a **publisher** property, stated here because it is the handoff — a plan writer parcelling obligations by section must not read it as an obligation of this component. Matching is evaluated against whatever set is currently loaded; a reload lag means a just-registered subscription may miss an event by seconds. That is not a new failure mode — D5 already rules that a subscription never acquires past events — and `matchedSubscriptions` is honest for the set that existed at accept.

**Boot order, and it splits exactly where ownership does.** The accept path's needs are the *publisher's* obligation, not this component's: `ops_events` and `ops_subscriptions`, their indexes, and the loaded subscription set initialize **above** `index.ts`'s spawn-capable boundary, because the first turn after boot can publish and must meet a loaded set rather than a silently empty one — those anchors belong with D10's publishing obligations. This component adds two of its own, for `ops_notifications` and the sweep. The sweep **starts after** transport adapters are registered — the `workerPool.start()` precedent, where wiring-above-the-boundary and start-after-`dispatcher.registerAdapter(slackAdapter)` have deliberately disjoint valid ranges — since a sweep that begins before its adapters exist would burn attempts against nothing. Shutdown **drains the sweep before** Slack and Mongo close, the KPR-456 ordering. Each of those anchors goes in all three lists of `src/boot-order.test.ts`.

**Containment, in three separate senses that must not be merged.** (a) *It must never fail, delay, or alter a turn* — none of its work is on the turn path at all, which is the reason the split exists; the one synchronous step, match evaluation, is not this component's and is already contained inside the publish call (D10); and intake runs on the acknowledging caller's own path — an operator command, a transport callback, or an agent's tool call on a turn it was already running — so its bounded write is the acknowledger's own cost and never causes or delays anyone else's turn. (b) *A sweep tick contains its own faults*: a fault in one row's delivery is caught, counted, and does not abort the tick or block the next one; ticks never overlap; a stuck adapter call is bounded by the adapter's own deadline, not by the sweep's patience. (c) *Its faults are counted, never published* — D10 invariant (a), and this component is exactly where that invariant earns its keep, since a wire that published its own delivery, nudge, or intake failures would be the feedback loop the invariant forbids. And D10 invariant (b) binds it absolutely: **no delivery may synchronously spawn an agent turn.**

**Ledger interaction.** Single-flight per row: one sweep tick acts on a row at most once, two ticks never act on it concurrently, and an intake write racing a tick on the same row is serialized rather than merged. Every transition names one row and one principal — an actor id for the three acknowledgement states, the reserved system principal otherwise (D7 rule 5) — there is no bulk path, and a sweep may never age a row into `dismissed`. A `rejected` retry reuses the row and increments `attemptCount`; a nudge re-delivers the same row; neither mints a second row or a second condition.

**Ownership is open, and this document does not close it — for two items, not one.** KPR-454 is chartered as a producer and KPR-455 as a reader; the epic's proposed-children list charters nobody for (i) this component, intake included, or (ii) the inbound acknowledgement edge that calls intake (D6). The choices — widen KPR-455, widen KPR-454, or file a new child, and the two items need not land in the same place — belong to the epic driver with the operator. Worth naming as the honest interim: a producer shipped alone is not broken, it is *staged* — and it is staged **because the accept path travels with it**, match evaluation included, so events accumulate durably, `matchedSubscriptions` is a truthfully stamped `0` for a system with no subscriptions, and the log is queryable while no notification exists. That is precisely the state D11's third column describes, reached deliberately rather than by an unbuilt component. The one combination that is *not* honest staging is shipping this component **without** an inbound edge: notifications would go out and no acknowledgement could ever come back. Recovering `resource` conditions would still fall silent on their own — D4's enable gate guarantees every `resource` reason has a registered clearing reason, and a clearing fact reaches `cleared` with no acknowledgement — but `judgment` and `integrity` rows, and `resource` conditions that never recover, would nudge without bound, with no way to stop them but a snooze nobody can enter. If the two land separately, the edge is not the later half.

## Conformance criteria

A consuming implementation (KPR-454 as a producer, KPR-455 as a reader, any later producer) conforms when:

1. **C1** — A publish carries no recipient, destination, transport, owner, or severity field, and no such field can be added without amending this contract.
2. **C2** — An event is durably stored before any ledger row is written or any delivery is attempted, and is stored identically whether `matchedSubscriptions` is zero or nonzero. Match evaluation is a pure test that stamps the matched subscription ids and their count into that one immutable insert (D12); it never causes a second write to an event, and nothing downstream re-evaluates the match — the sweep reads the stamped list, so a subscription registered after accept can never acquire the event.
3. **C3** — There exists no default subscription, fallback recipient, or catch-all adapter. A query for `matchedSubscriptions: 0` returns the real gap.
4. **C4** — `class` and `retry` on a stored event equal the registry entry's values for `(producer, reasonId)`; a publish asserting them is rejected.
5. **C5** — An unknown `(producer, reasonId)`, an undeclared `detail` key, an over-bound value, or a non-scalar `detail` value rejects the publish and increments a rejection counter. No coercion to a generic reason.
6. **C6** — For the `hive-runtime` producer, `waiting` is produced by a function co-located with `policyFor` sharing its prefix table; no second prefix predicate exists in the repository.
7. **C7** — Subscription matching implements exactly the D5 grammar. A test enumerates the grammar; any operator, negation, wildcard, or nesting fails it.
8. **C8** — A transport adapter's `deliver` receives a structured view and returns one of the three outcomes. Only `rejected` with an allow-listed reason permits an automatic retry; `unknown` never resends and is surfaced as uncertainty by every reader.
9. **C9** — Every ledger transition to `seen` / `dismissed` / `snoozed` records a stable actor id and instant, arrives through intake, and is idempotent: replaying one act is a no-op, not a second transition. No transition to those three states derives from a read receipt, a reaction, or elapsed time, and an act intake cannot attribute is refused rather than attributed to a service principal. Every other transition — row creation, delivery outcome, snooze expiry, clearing, reopen — records the reserved system principal, which can never produce those three states. `dismissed` on a `class: integrity` row is refused. No bulk transition exists, and every state in D7's table has a defined transition in and out.
10. **C10** — Nudging has no terminal state. `snoozed` is the only pause and it expires: intake clamps `snoozedUntil` to the operator-set maximum, so no act can pause a row indefinitely, and a request beyond the maximum is applied clamped rather than refused. No code path hands a condition to a different subscriber.
11. **C11** — A derived view returns `unknown` past its staleness horizon, and never `healthy` or `resolved` by default or by self-report.
12. **C12** — No reader treats `activity_log.error` as a failure oracle, and none infers failure from `costUsd` or from duration alone. The measurement in "Problem and observed evidence" is the negative test: a reader that flags all 289 Lane B rows, or that misses the 57 `timedOut` rows with `error: null`, fails this criterion.
13. **C13** — No stored field contains message text, prompt or completion text, tool arguments, a raw error object, a URL, a credential, or free-form prose. Remediation is a registry template plus allow-listed parameters, rendered at delivery.
14. **C14** — The ops path publishes nothing about itself, and no delivery synchronously spawns an agent turn.
15. **C15** — A publish fault cannot fail, delay, or alter a turn's outcome.
16. **C16** — Adding a producer, a reason, a subscriber, or a transport binding requires no change to the envelope, the grammar, or the interface.
17. **C17** — Ledger upsert and renewal, delivery, nudging, snooze expiry, and clearing application run on a bounded, non-overlapping sweep off the turn path, driven by each event's stamped `matchedSubscriptionIds` and a cursor held outside the log; the upsert is idempotent per `(row, event)`, so a re-processed event does not increment `eventCount` twice. Only match evaluation is synchronous with publish, and it performs no I/O; only acknowledgement intake is a direct write, and it is bounded. A sweep tick contains a per-row fault without aborting the tick, acts on a row single-flight, and stops before Slack and Mongo on shutdown.
18. **C18** — `generation` advances only on recurrence after a published clearing fact, never on repetition, elapsed time, retry, or an unanswered nudge. A test asserts that a repeated identical condition leaves `generation` unchanged and increments `eventCount`.
19. **C19** — A clearing event is published under its own registered reason whose `clearsReasonIds` lists the condition's reason; an event carrying `clears` under a reason with no such declaration, or naming a reason outside that list, is rejected. The generation resolver reads that clearing fact through the indexed `clearsFamily` derivation, so a condition that recovers and recurs advances its epoch and mints a fresh row beside a `dismissed` one. The fail-closed test is at registration, not at notification time: enabling a `class: resource` reason that no registered reason clears is refused.

## Example seed tables — illustrative only, not configuration

**These are examples for review, not rows to install.** No name, channel, or person below is contract; nothing here ships.

Example reason-registry entries (shape only):

| producer | reasonId | class | retry | `clearsReasonIds` | remediation template (parameterised) |
| --- | --- | --- | --- | --- | --- |
| `hive-runtime` | `tool-failed` | `resource` | `transient` | — | "retry {tool} on {subjectId}; if it repeats, inspect {errorSig}" |
| `hive-runtime` | `turn-deadline` | `resource` | `transient` | — | "check whether {subjectId} needs a longer envelope on tier {tier}" |
| `hive-runtime` | `runtime-recovered` | `informational` | `transient` | `tool-failed`, `turn-deadline` | "none; recorded so {subjectId} reopens as a new epoch if it returns" |
| `hive-agent` | `coordination-block` | `judgment` | `deterministic` | — | "rule on {question} for {subjectId}; nothing else clears this" |
| `hive-scheduler` | `obligation-missed` | `judgment` | `deterministic` | — | "deliver or cancel {obligationId} for {dueAt}" |
| `beekeeper` | `capability-evicted` | `resource` | `deterministic` | — | "restore {capability}; a healthy probe rearms" |
| `beekeeper` | `capability-restored` | `informational` | `transient` | `capability-evicted` | "none; a healthy probe was observed for {capability}" |
| `florist` | `sha-mismatch` | `integrity` | `deterministic` | — | "reconcile {expected} against {observed}; no dismissal permitted" |

The two recovery rows are the shape D2's generation rule and D4's enable gate require: one clearing reason per producer, covering that producer's `resource` conditions, `informational` so nobody is notified about a recovery unless they deliberately subscribe to it. Neither `judgment` row carries one, which is legal and illustrates the residual named in D4.

Example subscription (shape only): *a subscriber that wants integrity and judgment conditions where an agent is blocked, on one transport binding* —

```
{ subscriberId: "<stable-id>", filter: { class: ["integrity", "judgment"], waiting: ["agent"] },
  transport: { adapterId: "<adapter>", target: "<opaque stable ref>" } }
```

## Assumptions and remaining decisions

- **⚠ Delegated (non-blocking):** notification identity is `(subscriptionId, dedupeKey)` rather than `(subscriptionId, eventId)`. The brief said "per subscriber, per event"; deduplicating the condition is what keeps a flapping producer from reproducing the epic's own noise, and every publish still appends to the log. Reversing it is a key change in one place.
- **⚠ Delegated (non-blocking):** `class` and `retry` are registry-declared rather than producer-supplied. This is the structural fix for the Florist `loudness` finding and is stronger than that draft proposed; it costs a producer the ability to mark one instance of a reason as different in kind, for which a second `reasonId` is the intended lever — `generation` is not, being rule-bound to recurrence-after-recovery rather than discretionary (D2).
- **⚠ Delegated (non-blocking):** retention posture in D9 — event TTL aligned with activity history, ledger TTL from the instant a row stops nudging (`seen` / `dismissed` / `cleared`), behavioural fields ageing with the row, and the acknowledgement-silence horizon that follows. Operator confirmation is wanted because it is a privacy call, not an engineering one.
- **⚠ Delegated (non-blocking):** the reason registry is retained rather than simplified away. D4 names the simpler alternative and what it costs.
- **Non-blocking, corrects the brief:** the brief's proposed failure signature (`costUsd = 0` with duration near the ceiling) is not usable — `turn-scaffold.ts:353` gives every Lane B turn `costUsd: 0`, all 289 in the measured window, and the 19 long zero-cost unflagged rows are successful `codex/*` turns. The brief's underlying claim stands and is strengthened: 57 of 65 `timedOut` rows carry `error: null`, so `error` is not a failure oracle, and the honest rate is 8.9% against the 5.0% that field reports. Recorded as C12.
- **Non-blocking, supersedes an epic-body sketch:** the epic's child-3 proposal to write ops events into `agent_events` with `deliveries: []` is declined in D10, with reasons. No Decision Register canon is contradicted; the epic body's "Proposed children" section is proposal, not canon.
- **Non-blocking, answers the Florist draft's open questions:** (1) `informational` is in and costs nothing; (2) the default-owner table is rejected by architecture — there is no owner field, and no escalation resolves "to the void" because nothing resolves to a recipient at all; (3) cadence values are operator data, shape fixed here; (4) paging is another adapter and needs no contract change; (5) `remediation` is required, from the registry; (6) `human-now` in-thread behavior is confirmed untouched, and no default subscription selects it.
- **Deployment gate, not a spec gap — and "zero rows" needs the distinction D11 now draws.** The safe state is *zero subscriptions*, not zero rows of everything: a producer must ship its own reason-registry rows with its code, because C5 fails an unknown `(producer, reasonId)` closed, so a producer deployed with an empty registry publishes nothing and records nothing. With reasons registered and no subscription rows, the intended state holds and is worth stating exactly: **every publish is recorded, no publish is delivered, no ledger row exists, and `matchedSubscriptions: 0` measures how much nobody has claimed yet.** What remains human policy before anything becomes visible is D11's third column — subscription rows, transport bindings, cadence values and the nudge floor, staleness horizons, retention values.
- **⚠ Delegated and named residuals, each argued in full where it binds (all non-blocking):** a clearing fact carries its **own** registered reason and a `class: resource` reason cannot be *enabled* until some reason clears it — rationale, the deliberate `judgment`/`integrity` exemption, and the residual are in D4; the sweep's progress is a cursor held outside the immutable log and is not a fourth collection, its location the implementing child's choice — D12; a producer's open-condition set is in-process, so a restart costs at most one epoch boundary per open condition and never a lost fact, the per-success database read having been rejected against C15 — D2.
- **Open, epic-level scoping (blocking for implementation, not for this contract) — two items, not one:** (i) the matcher–deliverer of D12 — ledger, delivery, nudge sweep, clearing application and acknowledgement intake, **not** match evaluation, which rides the publish insert and ships with the producer; and (ii) the inbound acknowledgement edge of D6 that calls intake. Both are chartered to no existing child — KPR-454 is a producer, KPR-455 a reader, and the epic's proposed-children list names nobody for either — and this document assigns neither. D12's closing paragraph holds the options (widen KPR-455, widen KPR-454, file a new child; the two need not land together), the honest interim (a producer alone is staged, not broken), and the one sequencing constraint the contract asserts: (i) must not ship without (ii).
- **Open, deferred by the operator:** whether nudging should ever de-escalate or self-heal. Quoted in D1; not designed here, and the ledger carries the fields (`nudgeCount`, `state`, `stateAt`, dismiss rate) that would let that decision be made from evidence.

---

## Post-signoff addendum (2026-09-08)

*Everything above this line is the artifact signed off at [KPR-458#comment-3f6e8a4a](https://linear.app/keepur/issue/KPR-458#comment-3f6e8a4a), committed at `3aa6d06`. Nothing above is edited. This addendum corrects by supersession, following the `docs/epics/kpr-415/kpr-417-spec.md` §12/§13 precedent: a body claim that later becomes false is superseded here and left standing there, so the signoff stays attached to a document that still exists.*

### A.1 Scoping resolved: both unowned components now have owners

The body reads, at thirteen lines in ten places — each one mapped in A.2 below, which is authoritative over this sentence — as though two components this contract requires are chartered to no child, and it closes by naming that as an open epic-level scoping item "blocking for implementation, not for this contract". **That item is closed.** The operator resolved it in the epic driver session immediately after spec review closed, recorded at [KPR-455#comment-1b79ee1a](https://linear.app/keepur/issue/KPR-455#comment-1b79ee1a):

| Component | Body reference | Owner |
| --- | --- | --- |
| The matcher–deliverer: ledger upsert and renewal, calling the adapter, the nudge sweep, snooze expiry, clearing application, and acknowledgement intake | D12 | **KPR-468** — *Notifier — deliver, nudge, clear and accept acknowledgements over the ops-event ledger*, a new child filed for exactly this scope. Blocked by KPR-454 and KPR-458. |
| The inbound acknowledgement edge: capturing an attributed act and handing it to intake as `(handle, act, actorId, at, snoozedUntil?)` | D6 | **KPR-455** — the reader, widened to carry it. |

Three things the body says about these that the resolution does **not** change, and that both owners inherit unaltered:

1. **Match evaluation is not KPR-468's.** It is pure, performs no I/O, and is stamped into the immutable publish insert as `matchedSubscriptionIds` on the accept path (D2, D12, C2). It ships with publishing — by the epic's list, **KPR-454** — together with the `ops_events` / `ops_subscriptions` initialization, their indexes, the loaded subscription set, and the above-the-boundary wiring D10 requires for all of it. A plan writer parcelling D12 to KPR-468 must not carry the matcher across with it.
2. **The sequencing constraint stands.** D12's closing paragraph: the matcher–deliverer must not ship without the inbound edge, because notifications would go out and no acknowledgement could ever come back. With the split above, that reads: **KPR-468 must not ship without KPR-455's inbound edge.** The blocking edge KPR-468 already carries on KPR-454 does not express this one; it is stated here and belongs in KPR-468's own body.
3. **A producer shipped alone is still staged, not broken.** KPR-454 alone accumulates durable events with a truthfully stamped `matchedSubscriptions: 0` and a queryable log while no notification exists. That remains the honest interim, and it remains D11's third column — subscription rows, transport bindings, cadence values, the nudge floor, staleness horizons, retention values — that gates anything becoming visible. This ticket ships zero rows of it.

### A.2 Supersession map

Each location below reads, at `3aa6d06`, as though ownership is open. Each is superseded by A.1 and is otherwise unchanged; the surrounding obligations, which are the load-bearing content, all stand.

| Line(s) at `3aa6d06` | Body text superseded | Now reads as |
| --- | --- | --- |
| 5 | TL;DR: "Two components this contract requires are chartered to **no child**… neither is assigned" | Both assigned; see A.1. |
| 9 | Key Points, "no fourth part" bullet, closing clause: "two pieces of that wire are chartered to nobody" | Both pieces owned; see A.1. The architectural claim the clause qualifies — that the wire is not a fourth part — is untouched. |
| 10 | Key Points: "⚠ Unowned, blocking for implementation: the matcher–deliverer (D12)" | Owned by KPR-468. The ⚠ marker no longer applies; the exhaustive obligation list in that bullet does. |
| 11 | Key Points: "⚠ Unowned: the inbound acknowledgement edge (D6)" | Owned by KPR-455. |
| 33 | Scope and authority: "plan for a document, a Gate-1 conversation, and the two scoping decisions named below" | The two scoping decisions are made; the document and the Gate-1 conversation remain this ticket's work. |
| 35 | Scope and authority: "this document assigns neither… that is a scoping decision for the epic driver with the operator" | The driver made it with the operator. The paragraph's statement of *what* is unowned remains an accurate statement of the two obligation sets. |
| 260, 267 | D6: "owned by nobody"; "No child in the epic's list is chartered for this" | KPR-455. D6's four obligations on the edge — translate-only, no ledger or subscription access, attribute-or-refuse, idempotency/legality belong to intake — are unchanged and bind KPR-455. |
| 377 | D11 table row: "Each carrying surface's own inbound edge — **⚠ chartered to no child**" | Chartered to KPR-455 for the surfaces it carries; the row's third column (which surfaces expose one) stays operator-registered data. |
| 386, 388, 412 | D12 heading "ownership open"; "Placed last because it is the epic's open scoping item"; "Ownership is open, and this document does not close it — for two items, not one" | Closed, for both items, per A.1. D12 keeps its place and its name; its exhaustive "what it owns" list is unchanged and is KPR-468's scope statement. |
| 475 | Assumptions: "Open, epic-level scoping (blocking for implementation, not for this contract) — two items, not one" | Resolved. Reclassify as closed. |

Nothing else in the body is superseded. In particular the four operator rulings (D1), the three vocabularies (D3), the filter grammar (D5), the transport interface and its two closed reason sets (D6), the ledger transition table (D7), the retention posture (D9), the boundaries against `agent_events` / KPR-456 / KPR-457 (D10), the three-column split (D11), and C1–C19 stand exactly as signed off.

### A.3 Runtime-anchor verification record

The contract's evidence table, D3, D10 and C6/C12 cite live source by file and line. Re-verified against `epic/kpr-451` at `f377fe1` — the epic-branch head the verification actually read at, which is the parent of the commit that lands this addendum:

| # | Anchor | Claim it supports | Result |
| --- | --- | --- | --- |
| A1 | `src/outage/outage-notices.ts:18-26` | D3's `policyFor` → `waiting` mapping; the stale "team DM" fallthrough comment; C6 | verified |
| A2 | `src/agents/provider-adapters/turn-scaffold.ts:353` | literal `costUsd: 0` in the shared Lane B result builder; C12 | verified |
| A3 | `src/agents/agent-manager.ts:2611-2612` | sparse `aborted` / `timedOut` flags (KPR-401) | verified |
| A4 | `src/types/agent-definition.ts:65` | `subscribe?: string[]` is the event-bus domain list, not an ops subscription | verified |
| A5 | `src/scheduler/scheduler.ts:322` | `checkEvents` turns a pending delivery into a turn-spawning `WorkItem` | verified |
| A6 | `src/events/event-types.ts` | closed 13-type schema; `system:task_blocked` carries `{taskId, description, blockedBy}` | verified |
| A7 | `src/index.ts` spawn-capable boundary marker; `src/boot-order.test.ts` superset sweep | D10's and D12's boot-order obligations on the consuming children | verified (observed `src/index.ts:474`, `src/boot-order.test.ts:84` — both unchanged from the `771c63c` observation) |

The counts in "Problem and observed evidence" are deliberately **not** re-run: that table states its own window rule — *"The window slides, so absolute counts move between runs while the ratios hold… Cite the ratio and the date, never the bare count."* The 2026-09-08 measurement stands as recorded.

### A.4 Canon — entries KPR-458 contributes to the KPR-451 Decision Register

Drafted here so the driver can lift them verbatim at merge, in the register's existing one-line declarative style, following `docs/epics/kpr-415/kpr-417-spec.md` §12's precedent. They contradict no merged entry from KPR-453, KPR-456 or KPR-457.

* KPR-458: Operational facts publish without recipient, destination, transport, owner, or severity; no severity axis exists and none may be added.
* KPR-458: Interest lives only in subscriber-owned subscription rows; no default subscription, fallback recipient, or catch-all adapter, and `matchedSubscriptions: 0` stays reachable as the measured gap.
* KPR-458: `class` and `retry` are registry-declared per `(producer, reasonId)` and stamped at accept; only `waiting` is per-publish, derived for the runtime from one prefix table shared with `policyFor`.
* KPR-458: An unknown `(producer, reasonId)`, an undeclared `detail` key, an over-bound value, or a non-scalar rejects the publish and is counted; redaction is the write-time schema, never a scrub-after pass.
* KPR-458: Notification identity is `(subscriptionId, dedupeKey)`; `generation` advances only on recurrence after a published class-legal clearing fact, never on repetition, retry, elapsed time, or an unanswered nudge.
* KPR-458: Match evaluation is pure, rides the immutable publish insert as `matchedSubscriptionIds`, and is never re-evaluated downstream; everything after the insert runs on a bounded non-overlapping sweep off the turn path.
* KPR-458: Transitions to `seen`/`dismissed`/`snoozed` require an attributed act through idempotent intake; every other transition records the reserved system principal, `integrity` refuses dismissal, and no bulk path exists.
* KPR-458: Nudging has no terminal state; snooze is the only pause, and intake clamps it to the operator-set maximum rather than refusing the act.
* KPR-458: Transport is an adapter returning accepted/rejected/unknown; only allow-listed `rejected` retries, the ops path never publishes about itself, and no delivery may synchronously spawn an agent turn.
* KPR-458: Derived views return `unknown` past a required staleness horizon; failure is never inferred from `activity_log.error`, `costUsd`, or duration. `agent_events`, KPR-456's obligation path and KPR-457's watchdog keep their own contracts and become no part of this interface.

### A.5 What this ticket did not ship

Restating D11's third column and D1's collection rule as a checklist, because the next reader's most likely error is assuming a merged contract means a live surface. KPR-458 ships **no** code, collection, index, validator, reason-registry row, subscription row, transport binding, cadence value, nudge floor, staleness horizon, or retention value. `ops_events` and `ops_subscriptions` are created and documented in `CLAUDE.md` by KPR-454; `ops_notifications` by KPR-468. Until D11's third column is registered by the operator, a conforming deployment records every publish, delivers none, holds no ledger row, and measures how much nobody has claimed.
