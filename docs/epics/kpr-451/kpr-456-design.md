## TL;DR

KPR-456 adds an operator-managed registry of recurring human delivery obligations, independently of agent schedules and prompts. Each deadline is satisfied only by an engine-recorded receipt for the identified deliverable at its registered destination; a completed turn, unrelated message, or missing cron cannot satisfy or remove it. A durable per-deadline notice record prevents repeated sweeps and restarts from producing repeated missed-delivery notices, with an explicit limitation when Slack accepts a post but its acknowledgement is lost.

## Key Points

- **The registry is the expectation:** deliverable, producer, deadline rule, delivery destination, and an explicitly chosen notice destination live in their own Mongo collection. Removing a schedule, disabling its producer, or changing prompt text does not remove the expectation.
- **Delivery is an acknowledged outbound action:** add an explicit `deliver_obligation` tool to the existing in-process schedule server. It sends the named occurrence to its registered Slack destination and writes an append-only receipt to `activity_log`; it cannot mark an occurrence delivered without sending it.
- **⚠ Delegated initial scope:** Slack text deliverables, posted through the explicit tool, with a local daily/weekday deadline and explicit IANA timezone. Untagged dispatcher output, hosted Slack MCP posts, email, internal handoffs, file uploads, and semantic completeness checks are not silently treated as proof.
- **No recipient or severity defaults:** registration requires an explicit notice destination. The feature does not choose May, Mokie, an agent home channel, or `auditChannel`, and does not implement KPR-458's severity or escalation rules. No production registrations or prompt edits are included.
- **One occurrence, one notice identity:** persist occurrence and notice state before sending. An on-time receipt suppresses the notice; late delivery remains late and cannot erase an already-missed deadline. Routine retries, concurrent sweeps, and restarts reuse the same identity.
- **⚠ External acknowledgement tradeoff:** automatic retries are allowed only after an authoritative rejection. A timeout or crash after submission leaves the notice `unknown` and is never blindly reposted. This preserves the no-duplicate rule, but an ambiguous attempt may result in no visible notice; the reader must show that uncertainty, never claim successful notification.
- **Evidence is independent of turn telemetry:** receipt writes are awaited and enabled whenever obligations are used, even if buffered turn activity is disabled. Receipt rows have their own discriminator and fields; no fabricated cost, token, or turn-success values.
- **Small operational surface:** add CLI registration/list/deactivation and occurrence inspection, plus a 30-second engine sweep. No dashboard, server, agent execution during checking, generic notification framework, or new dependency on KPR-453/454/455/458.

## Scope and authority

Ticket: **KPR-456 — Delivery obligations registry (dead-man's switch) for scheduled human deliverables**. Parent: KPR-451. Runtime source baseline inspected: `6abe046065d05fc5b52f44b18f17ac8cc82cee53`.

Inputs are the ticket, epic description, approved Gate 1 package (`95cc0708-858b-4a13-b9fa-fb92c9374d29`), and recorded signoff (`15794549-d6f1-483e-bb9a-4646fdf6de65`). Gate 1 delegates routine engineering decisions in waterfall mode while retaining the KPR-452/KPR-458 human policy gates. No child comments, hard dependencies, or merged decision-register canon were supplied. KPR-453 design/plan files in this worktree are unmerged sibling artifacts, not binding canon; this design does not require their implementation.

This artifact follows the epic-document convention in `CLAUDE.md` and the dispatch-specified path. Drafting is not implementation-plan approval. The repository's required `/spec-and-implement` entry point remains an implementation-boundary prerequisite; this ticket neither supplies nor bypasses it.

## Problem and observed code

The reported Jasper case has no scheduled invocation at all. Looking for failed runs, expiring callbacks, or blocks cannot find an expectation that exists only in prose. The registry must continue producing deadlines when the agent's entire `schedule` array is empty.

The current delivery and telemetry code cannot support a trustworthy match by itself:

| Surface | Observed behavior and consequence |
| --- | --- |
| `src/scheduler/scheduler.ts:77`, `:115`, `:203` | Jobs are reconstructed solely from agent schedules; reload replaces the list. Each cron invocation is a Slack-shaped WorkItem addressed to `homeBase` or the first configured channel. Neither jobs nor prompts are a registry of expected deliveries. |
| `src/schedule/schedule-mcp-server.ts:21`, `:65`, `:164` | In-process tools close over shared Db and constructor-fixed `agentId`. Schedule removal changes only `agent_definitions.schedule`. This is a usable existing tool surface, but obligation administration must not be folded into schedule removal. |
| `src/agents/agent-manager.ts:2558` and `src/activity/types.ts:1` | Activity records describe provider turns, before the dispatcher delivers their result. They lack deliverable identity and acknowledgement evidence. `channel` is the source label, not necessarily the eventual destination. |
| `src/activity/activity-logger.ts:27`, `:64`, `:76` | Turn logging may be disabled, buffers records, and drops a batch after a second failed write. Waiting for its next flush is not a reliable delivery receipt. |
| `src/channels/slack-adapter.ts:135`, `src/slack/slack-gateway.ts:367`, `:388`, `:484`, `:625` | Adapter delivery returns `void`; gateway failures can return `undefined`; split sends return the first timestamp even if later chunks failed; file sends can return the summary timestamp. Resolving these existing methods does not prove complete delivery. |
| `src/slack/slack-internal-api.ts:167` | The local Slack API's active-item lookup chooses a recent item for threading. That heuristic must not establish which deliverable or deadline a post satisfies. The hosted Slack MCP does not pass through this API. |
| `src/sweeper/retry-queue.ts:27` | The existing delivery retry queue is in memory and retries the whole WorkResult. It cannot supply restart-safe notice deduplication. |
| `src/index.ts:118`, `:158`, `:799` | The engine owns one Mongo pool with a datastore-identity write guard and starts timer-driven scheduler work after Slack setup. New stores must use that guarded Db and the same lifecycle ordering. |

## Goals and non-goals

The implementation must detect an explicitly registered missing deliverable without requiring a run, match actual delivery to exactly one expectation, preserve evidence and notice decisions across restarts, and let the operator inspect what the engine knows.

Out of scope are historical inference from prompts, automatic cron creation/repair, production registration, agent configuration or prompt rollout, remediation turns, dashboards, escalation ladders, severity taxonomy, general-purpose task tracking, and external Hive-down monitoring. Delivery proof means the registered artifact was accepted by Slack; it does not prove that a human read it or that its content includes every expected fact. A composite report's required contribution must be registered as its own deliverable or later use a separately specified semantic validator; a generic final briefing receipt cannot prove that Jasper's slice was present.

## Design

### D1. Registry and operator surface

Create `delivery_obligations` with a strict, allow-listed schema:

| Field | Contract |
| --- | --- |
| `_id` | Stable operator-chosen identifier, restricted to lowercase letters, digits, and hyphens; 1–100 characters. Unique within the instance's database. |
| `deliverable` | Short display description, 1–200 characters. Identification is by `_id`, never fuzzy text matching. |
| `producerAgentId` | Explicit registered producer; must exist when registering. Subsequent removal or disablement leaves the obligation intact. |
| `deadline` | `{ localTime: "HH:MM", weekdays: [0..6], timezone }`, with a nonempty unique weekday set and explicit IANA timezone. Its matching instants are expectation deadlines, not jobs to execute. All seven weekdays means daily. |
| `destination` | `{ kind: "slack", channelId, threadTs? }`; require canonical C/D/G channel IDs. An absent thread means channel root. |
| `noticeDestination` | Same shape, explicitly supplied; no fallback or implicit reuse of `destination`. |
| `activeFrom` | Server-stamped creation time. Deadlines at or before this instant are not retroactively created. |
| `deactivatedAt?` | Explicit operator action stops future expectations; it does not delete prior occurrences. |
| `createdAt`, `createdBy`, `deactivationReason?` | Administrative provenance; bounded strings, no freeform diagnostics. |
| `scanThrough` | Engine-owned UTC cursor for materialized deadlines; initialized to `activeFrom`, never accepted from registration input. |

Keep immutable delivery semantics for a registered ID. The initial CLI supports `hive obligations register --file <json>`, `list [--json]`, `show <id> [--json]`, and `deactivate <id> --reason <text>`. Registration of an existing identical definition is idempotent; a conflicting definition errors. Changing producer, deadline, destination, or recipient requires deactivating the old ID and registering a new one. No delete/re-enable command, upsert that overwrites history, or agent-facing management tool is added.

Deactivation has prospective effect: any deadline at or before `deactivatedAt` still receives evaluation and, when warranted, its notice. A not-yet-due occurrence is cancelled by the explicit deactivation and cannot subsequently be delivered through this registry. The operator output describes this behavior before/with the action; removing or locking a cron never invokes it.

CLI writes must resolve the explicitly selected Hive instance and verify its existing identity sentinel before writing. Never stamp/restamp a sentinel as a side effect of registry administration. Use the same store and validation code as the engine; close the CLI's short-lived client. A read-only command never creates indexes, fixes data, sends notices, or creates missing occurrences.

### D2. Deadlines, windows, and occurrence identity

Add a pure strict evaluator for obligation deadlines rather than expanding the legacy scheduler's permissive cron matcher. Validate a 24-hour local time, a nonempty set of weekdays 0–6 (Sunday through Saturday), and an IANA timezone. This covers a daily report and weekday briefings without introducing a second general-purpose cron parser. Monthly rules, multiple deadlines per day under one ID, holidays, and business calendars are excluded; a second independent expectation may use a second ID. Do not change existing cron jobs' semantics.

Evaluate a UTC minute against local components in the registered timezone. Each matching UTC instant is one deadline. A skipped local minute at a spring DST transition has no occurrence; both matching UTC instants in an autumn fold are distinct occurrences. Registration prints upcoming instants including local offset so this engineering interpretation is reviewable. The daily 08:00 briefing case produces one local-morning deadline across DST. Host timezone changes never alter a registered rule.

For deadline `dueAt`, the delivery window is `(previousDueAt, dueAt]`, with its first lower bound clamped to `activeFrom`. There is no hidden grace period: `acknowledgedAt <= dueAt` is on time. The lower bound is exclusive so one receipt cannot count for adjacent occurrences. The engine defines `acknowledgedAt` using its clock when it receives the successful Slack response; the Slack message timestamp is retained as destination evidence, not relabelled as a provider completion time.

An occurrence has a stable unique key `(obligationId, dueAt)`. Its document snapshots the immutable definition, window bounds, receipt reference if any, and notice state. Store it in `delivery_obligation_occurrences` with a unique compound index and a due/notice-status query index. Do not TTL this collection or the registry: these documents retain deduplication and evaluation facts after `activity_log` receipt retention expires. They are engine-maintained projection/checkpoint records, not a mutable human issue board.

The registry carries a CAS-updated scan cursor initially at `activeFrom`. The sweep enumerates every matching deadline through its captured `now`, materializes occurrences with insert-if-absent, and advances the cursor only through persisted occurrences. Bound work per tick and resume on the next tick without dropping old deadlines. Registration, sender lookup, and sweeps share the same evaluator; no independent recurrence interpretation. A sender may materialize its explicit open occurrence before the deadline. Advance cursors monotonically despite concurrent ticks, clock rollback, and restart.

### D3. Explicit delivery operation

Extend the existing `schedule` in-process server with `my_delivery_obligations` and `deliver_obligation`. Keep all existing schedule tools unchanged. The first tool lists only the constructor-bound producer's registered obligations, destinations, and valid current occurrence keys. It does not parse prompt text or discover/register expectations.

`deliver_obligation` takes `obligationId`, explicit `dueAt` from that list, and nonblank `text`. It accepts no producer, arbitrary destination, reported success flag, receipt timestamp, or supplied Slack timestamp. Resolve producer identity from `ScheduleToolDeps.agentId`; validate the definition, exact occurrence, window lower bound, and producer before any send. Empty, deactivated-future, unknown, other-producer, and future-not-yet-open occurrences error without side effects. An overdue occurrence may still be delivered explicitly, but its acknowledgement is late; a missing receipt never authorizes relabelling it as today's occurrence. An already acknowledged occurrence repairs any missing receipt from its checkpoint, then returns that receipt without posting again. A completed old occurrence may be inspected, but cannot be reused to satisfy a newer deadline.

The initial supported artifact is one Slack text post of at most 3,900 characters, including engine-added producer attribution. This bounded entry point avoids pretending a first-chunk timestamp or file summary proves complete delivery. Longer artifacts must be reduced to an intentionally complete deliverable or use an explicitly described link as the deliverable; the engine does not truncate, silently split, or claim to verify a linked file's contents. Supporting multipart/file delivery is a later extension, not a hidden prerequisite for normal turns.

Inject a narrow delivery service into the existing schedule-tool dependencies through manager/provider runner construction. Use the service for both Claude and Lane B's existing in-process schedule server; do not introduce another MCP server, process-global active-agent lookup, AsyncLocalStorage, external subprocess context, or a dependency on the unmerged KPR-453 `workItemId` field. Preserve all existing schedule enablement and worker-containment gates. If the service is unavailable in a compatible test/standalone runner, these new tools return an explicit unavailable error and never claim success.

The service uses a narrow acknowledged Slack-post method: canonical registered destination, explicit threading, bot identity with safe producer attribution, no identity fallback, no split/file/streaming path, and a required `ok: true`, destination channel, and nonempty `ts`. Register the returned `(channel, ts)` in the existing outbound echo cache. A successful unrelated post, activity row, acknowledgement/status message, audit mirror, outage notice, tool-call count, or `error: undefined` is never a receipt.

A current obligation is therefore opt-in at two independent points: the operator registers its expectation, and the producer actually sends that occurrence through this capability. Existing uninstrumented delivery routes keep their behavior but supply no proof. Deployment documentation must make that enrollment requirement explicit; this engineering ticket performs neither enrollment nor actual production sends.

### D4. Receipt storage and data minimization

Add a discriminated `DeliveryReceiptRecord` member to the activity collection's document type while preserving existing `ActivityRecord` turn callers. New receipt rows use `recordKind: "delivery_receipt"`; existing rows without that discriminator remain turn records. Receipt fields are only:

`receiptId`, `obligationId`, `dueAt`, `producerAgentId`, `destination {kind, channelId, threadTs?}`, `providerMessageTs`, `acknowledgedAt`, `timestamp` (record-write time), and `schemaVersion`.

Use an idempotent, awaited insert keyed by a unique receipt ID/occurrence; do not push these through `ActivityLogger.record()` or `flush()`. The receipt unique/query indexes must be partial indexes restricted to `recordKind: "delivery_receipt"`, so missing receipt fields on legacy turn rows cannot cause uniqueness conflicts. Receipt persistence and indexes are initialized independently of `config.activity.enabled`. Preserve the existing turn-record retention policy and use its TTL timestamp field for receipt history. No body, prompt, URL credential, tool arguments, raw error object, or arbitrary metadata is stored. Diagnostic failures use bounded enumerated reasons. Escape operator descriptions in Slack notice text so registry labels cannot create mentions or control Slack markup.

After Slack acknowledgement, first checkpoint the small acknowledgement evidence in the occurrence document, then append the receipt; the sweep repairs a missing receipt from that checkpoint, using the same stable receipt ID. This closes the receipt-insert failure/restart gap once the acknowledgement has been checkpointed. The tool returns confirmed delivery only after both writes are acknowledged. If Slack succeeded but subsequent storage failed, report `delivery_outcome_unknown` to the caller without inviting an automatic second post; an existing durable send intent prevents that second post. Do not throw an ordinary retryable tool error suggesting that nothing was sent.

Existing turn aggregates/readers must exclude `recordKind: "delivery_receipt"` when counting turns, cost, tokens, or failures. Search all repository `activity_log` consumers in implementation; do not fabricate turn fields to make receipt rows fit. The KPR-455 future reader may consume this additive contract but is not a dependency.

### D5. Sending state and honest uncertainty

There are two independent side effects per occurrence: sending the deliverable and sending its missed-deadline notice. Each has durable state with a unique intent, atomic claim, and outcomes `pending`, `sending`, `acknowledged`, `rejected`, or `unknown`. A DB claim must be acknowledged before submitting to Slack. A concurrent caller loses the claim and observes the existing state. No external send occurs while the datastore identity write guard refuses writes.

Use a separately configured narrow Slack client/path with SDK retries disabled (`retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`), leaving ordinary Slack behavior unchanged. The gateway's existing default WebClient retries cannot be used as the deduplication mechanism. Authoritative Slack refusal or rate limiting may permit the *same* logical notice to retry on a later sweep (honor `Retry-After`; otherwise use a bounded technical retry delay). No automatic recipient changes or new escalation. Do not infer authoritative refusal from a timeout, connection reset, HTTP proxy failure, missing receipt fields, or process interruption.

A `sending` record found after engine restart, or a submitted request whose outcome cannot be known, becomes `unknown`. Persist a claim token and owner boot identity; normal ticks do not treat a live owner's slow request as a restart orphan, and an acknowledgement update must match its exact claim token. Never expire a claim and blindly post again. Preserve its identity and the last known state in the reader; the initial feature has no automatic unknown-state replay or generic operator resend command. Deliverable retries after an acknowledged receipt likewise return that receipt without resending. An authoritative rejected delivery can be retried by the producer for the same occurrence; the deadline still applies to the eventual acknowledgement.

This is an explicit at-most-once submission choice for ambiguous attempts, not a claim of distributed exactly-once delivery. There is an unavoidable crash window after the durable intent and before submission, or after Slack acceptance and before the acknowledgement checkpoint. A durable logical notice is guaranteed when a readable registry/evidence store permits evaluation; a visible Slack message cannot be guaranteed through those windows while also prohibiting duplicate posts. Do not report `sending` or `unknown` as `notified` or `delivered`.

### D6. Sweep and missed-deadline notice

Create a small engine service with `start`, non-overlapping `sweepOnce`, and `stop`. Run an initial sweep after store indexes and Slack wiring are ready, then every 30 seconds. Sweep operation is independent of `Scheduler.cronJobs`, schedule hot reload, agent availability, and `onDispatch`. It never launches a model turn. All runtime stores use the shared guarded Db, and shutdown stops/drains this service before closing Slack or Mongo.

For each due occurrence, reconcile a durable acknowledgement checkpoint into `activity_log`, then query an exact matching receipt using obligation, producer, destination, and deadline. Receipt acknowledgement must lie within the occurrence's window to count as on time. An on-time matching receipt records `on_time` and suppresses the notice. A late receipt records `late`; it does not suppress the one missed-deadline notice. No receipt, including an unknown delivery attempt, means `no_confirmed_delivery`; the notice must describe absence of confirmation rather than assert that Slack definitely received nothing.

If Mongo reads fail, receipt repair fails, or the identity guard is engaged, leave evaluation pending/unknown and do not convert infrastructure failure into a confirmed delivery or definitive miss. Retry the read/evaluation on later ticks. Maintain a service heartbeat with last successful sweep and backlog count using the existing telemetry conventions, so a failed checker is visible in CLI output. No new Slack escalation for checker failures is invented.

Materialize a notice identity only once per missed `(obligationId, dueAt)`, using atomic conditional state transitions. Immediately before claiming a pending notice, repeat the exact receipt/checkpoint check so a newly committed on-time receipt can suppress it. Serialize receipt checkpoint publication and notice claim through the occurrence's CAS revision; a claim based on an older revision fails and re-reads. A post received after the deadline is late even if it raced the first sweep. If a previously uncheckpointed acknowledgement later appears after a notice was submitted, append/retain the factual receipt, show the correction in the reader, and neither delete the notice nor post a second message.

The notice is bounded deterministic text, for example: `No confirmed delivery of <deliverable> from <producer> by <local deadline with zone/offset> to <destination>. Obligation <id>; deadline <UTC instant>.` The only destination is the occurrence's explicit `noticeDestination`; no homeBase/audit fallback, user mention, urgency label, or page command. Acknowledged notices remain terminal across repeated ticks, process restarts, and old `activity_log` TTL deletion.

Persisted acknowledgement checkpoints keep old delivered occurrences satisfied after their receipt history expires. Because every receipt is written only after that non-expiring checkpoint, old `activity_log` TTL deletion never removes the evidence needed for evaluation or deduplication. Do not continually recreate TTL-expired receipt rows: replay the original insert with its original `timestamp` only for an unresolved initial write, and let the occurrence projection remain the historical summary once evaluation is recorded. A registry created in this feature never has obligations before `activeFrom`; existing old turn records do not acquire retrospective coverage. Malformed/missing projection data is an explicit integrity error in the reader and must not be guessed into success. Restoring a partial/inconsistent database is outside the automatic recovery contract.

### D7. Reader, compatibility, and rollout

`hive obligations list/show` report active/deactivated definitions, next deadline with timezone, recent occurrence outcomes, acknowledged receipt references, notice state, evidence availability, and sweep heartbeat/backlog. JSON output retains UTC instants and stable machine-readable states. Keep lookup read-only and bounded/paginated. No status is inferred from the agent's successful turn count.

No existing Mongo turn records need migration; they remain insufficient delivery evidence. Initialize stores and indexes before enabling the sender/sweep; index failure must prevent this subsystem from claiming readiness. An empty registry produces no deadlines or messages; the new tools are visible to normal schedule-server users but create no registrations or scheduled tasks. Existing dispatcher delivery, audit routing, schedule CRUD, and outage diversion are unaffected. Existing `hive doctor` health exit semantics remain unchanged; the dedicated CLI is the initial viewer.

Production rollout is a separate operator action: choose a specific deliverable and its real producer/destination/notice recipient, confirm the supported delivery format, register it, and update its producing workflow to call `deliver_obligation`. Do not seed Jasper/May/Mokie values, create missing cron jobs, change deployed prompts, or register an inferred composite-report policy in this ticket.

## Acceptance criteria and verification contract

1. Register an expectation in a fake instance with no producer cron; advancing through its deadline creates one missed occurrence and one notice. Repeat after deleting a previously present cron, reloading schedules, disabling/removing the producer, and restarting the sweep. None removes the alarm.
2. A completed/error-free turn, an unrelated same-producer post, a wrong producer/destination/deadline receipt, and an untagged delivery cannot satisfy it. Explicit tool delivery with acknowledged Slack evidence and successful receipt persistence does; a caller-supplied success/producer/timestamp is rejected by the schema.
3. Window boundaries, first registration, daily/weekday rules, invalid local times/weekday sets/timezones, host-timezone independence, DST gap/fold behavior, and late delivery are deterministic under an injected clock. There is no hidden grace or replay into the next occurrence.
4. Deliverable sending is exercised through the real schedule tool/service boundary on Claude and Lane B. Constructor-bound identity is retained across calls, the tool targets only the registry destination, and contained worker runners do not gain a sender. Oversized/empty text is rejected before Slack; ordinary schedule and Slack behavior is unchanged.
5. Race two senders and two sweeps against an atomic fake store: one claim wins for each side effect, stale CAS decisions re-read, duplicate receipt inserts are idempotent, and a persisted on-time acknowledgement blocks notice submission. Advance another deadline and show it has its own notice identity.
6. Simulate interruption before submission, after Slack acceptance, after checkpoint, and during receipt insertion. Acknowledgement checkpoint recovery repairs the receipt; ambiguous uncheckpointed outcomes remain unknown and never auto-resend. Confirm no implicit WebClient or in-memory RetryQueue retry bypasses the claim.
7. Authoritative refusal and rate limiting leave retryable notice state without setting `acknowledged`; successful retry produces one accepted notice. Timeout/proxy failure is unknown. Stored acknowledgement and terminal notice state survive recreation of the service.
8. Disabled/buffered/dropped turn logging does not disable awaited delivery receipts. Receipt rows preserve strict allow-lists and do not contaminate turn aggregates. Receipt TTL expiry cannot reopen an acknowledged occurrence, cause perpetual receipt recreation, or duplicate its notice; pre-registration history never becomes monitored implicitly.
9. Mongo read/write failures, identity-guard engagement, lost acknowledgement persistence, and shutdown ordering never produce a false success. Failed evidence evaluation does not advance the evaluation checkpoint past unfinished work, and backlog recovery resumes without skipping deadlines.
10. CLI registration/deactivation are validated, instance-bound, and idempotent as specified; reads have no writes or sends. Deactivation preserves past-due misses, cancels future expectations, and does not touch schedules. No production seeds, prompts, registrations, or credentials enter the change.

Use Vitest with fake timers, injected Slack client responses, and atomic fake Mongo boundaries following `src/scheduler/scheduler.test.ts`, `src/activity/activity-logger.test.ts`, and `src/db/db-identity.integration.test.ts`. Exercise real store/service/tool assembly rather than testing only mocked calls. No live Slack, production Mongo, or deployment is needed. Implementation must pass focused obligation, activity, schedule, gateway, containment, and boot-order regressions plus the repository-required `npm run check` before completion. This drafting phase does not execute implementation tests or claim their results.

## Assumptions and remaining decisions

- **Non-blocking, delegated:** local daily/weekday deadlines with explicit timezone and documented UTC-instant/DST semantics are sufficient for the initial recurring registry. General cron expressions, holidays, and business calendars are excluded.
- **Non-blocking, delegated:** explicit bounded Slack text delivery through the existing schedule server is the initial evidence-producing route; this avoids expanding or retrofitting every vendor delivery transport.
- **Non-blocking, delegated but material:** ambiguous notice submission favors no duplicate over guaranteed visible delivery. The unknown state is permanent until separately specified reconciliation; the implementation and release notes must not promise exactly-once Slack delivery.
- **Non-blocking enrollment inputs:** real deliverable identity, producer, deadlines, delivery/notice destinations, and composite-report boundaries must be explicitly chosen when an operator enrolls a production obligation. Engineering supplies no defaults from KPR-458. No enrollment is authorized by this artifact.
- **No blocking spec question:** the approved Gate 1 delegation covers these engineering choices. Changing the ambiguity tradeoff to automatic retransmission, introducing semantic handoff/composite-report checks, or adding escalation recipients would require a concrete revised contract before implementation of that expansion.

## External integration evidence

Slack documents a successful post's channel and message timestamp and the scope needed to send a message; these are transport evidence, not proof of human reading or semantic completeness. The implementation must validate the response rather than assume that a resolved adapter call is sufficient. [Slack `chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/) (checked 2026-09-07).

The Node Slack client enables retries by default; its documented no-retry configuration requires disabling ordinary retries and opting out of automatic rate-limit retries. The no-blind-repost choice above is an application contract; these docs do not establish an exactly-once guarantee for a client-generated identifier. [Slack Node Web API retries](https://docs.slack.dev/tools/node-slack-sdk/web-api/#automatic-retries) (checked 2026-09-07).
