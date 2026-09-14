# KPR-501 — Agent-facing block producer: `hive-agent` publishes coordination and semantic blocks into `ops_events`

## TL;DR

KPR-501 is the **second producer** on KPR-458's contract. It gives every agent two tools on the existing in-process `event-bus` MCP server — `report_block` and `clear_block` — that publish, through the already-shipped `OpsPublisher` accept path, the two facts Gate 1 said only an agent can see: *I am blocked on another party's act* (`coordination-block`) and *I cannot proceed without a decision above my authority* (`semantic-block`), plus the clearing fact that closes either (`block-cleared`). The condition is keyed on the agent's unit of work — `(agentId, threadId)` — never on the turn, so a block raised in one turn is cleared from a later one; the open condition is resolved from the log, not from in-process state, so it survives restarts. No new server, no new collection, no new loader, no notification, no turn spawn: shipped alone it is staged exactly as KPR-454 was — every block recorded, none delivered, `matchedSubscriptions: 0` — and it is what fills KPR-455's ack-edge arm 1.

## Key Points

- **Smallest surface that satisfies the charter: two tools on the existing `event-bus` in-process server, not a new server.** `event-bus` is already in `IN_PROCESS_PORTED_SERVERS`, already in `WORKER_SERVER_DENYLIST`, already has a stdio placeholder so the Lane B inventory bridges it, is not auto-injected (so none of the three `suppressAutoInjectedServers` gates change), binds the agent id at construction, and already holds the runner-owned `WorkItemContextRef`. Both KPR-390 standing obligations are satisfied by inheritance and are asserted on the runner's **built** server set, not argued (D2).
- **Three reason rows ship with this producer, under `producer: "hive-agent"`:** `block-cleared` (`informational`, clears both, upserted first), `coordination-block` (`resource` / `deterministic`), `semantic-block` (`judgment` / `deterministic`). ⚠ Delegated: `coordination-block` is `resource`, not the `judgment` KPR-458's illustrative table showed, because a coordination block is cleared by the agent itself when the awaited act arrives, which is D3's `resource` clearing act; `semantic-block` is the one that needs a named human's ruling (D3).
- **The subject is the agent's work unit, not the turn.** `subject: { kind: "agent-work", id: "<agentId>:<threadId>" }`, falling back to `"<agentId>"` when the thread id is not storable. KPR-453 canon says a work-item id "proves neither unique attempt nor task continuity", and Gate 1's own storage note says a later turn "needs an explicit link to the blocked work" — the engine's link is the thread (the per-thread lock and session key). `workItemId` rides `detail` and `evidence` as the identity of the raising or clearing turn (D4).
- **Agents state facts, never axes.** `class`/`retry` come from the registry; `waiting` is `waitingFor(workItemId)` from the one prefix table (C6), never a tool parameter; `agentId`, `workItemId`, `threadId` are read from constructor state and the live `WorkItemContextRef` at execution, never from the agent. The tool's parameters are closed enums and admissible-id references; no free text is accepted anywhere (D5, D6).
- **The clearing fact is log-resolved and class-honest.** `clear_block` reads the open condition from `ops_events` with the same two indexed `(publishedAt, _id)` reads the epoch resolver uses, publishes `block-cleared` with `clears: <exact open dedupeKey>`, and refuses a `semantic-block` clear that carries no ruling reference — because KPR-468's ingest applies a `judgment` clear only with `evidence.length >= 1`, and a stored-but-inert clearing fact would still advance the epoch (D7). No open block ⇒ no publish (D2's "a clearing fact for a condition never raised is noise").
- **Every publish rides the single serial drainer.** A new accept-only job kind on `OpsPublisher` (`enqueuePublish`) carries both tools' events onto the same bounded FIFO the capture points use; nothing in this child inserts into `ops_events`, and a repo-wide guard test pins that. This is what preserves the `(publishedAt, _id)` publish/drain order KPR-468's cursor consumes — a synchronous side-door insert could land behind an advanced watermark and be skipped forever (D8).
- **The ops path still publishes nothing about itself and spawns no turn.** Tool faults return structured tool errors and increment counters; `agent_events`, `team_messages`, `agent_callbacks` are never written; `system:task_blocked`, `EVENT_SCHEMAS`, `Scheduler.checkEvents` and the `subscribe` field are untouched, exactly as KPR-454 D11 left them (D9, D10).
- **In scope:** the two tools, the three rows, the accept-only job kind and a bounded `flush`, the log-side open-condition read, the KPR-455 arm 1 interface constants, tests, `CLAUDE.md`. **Out of scope:** any subscription, cadence, recipient or prompt rollout (KPR-458 D11 column 3); any reader, view, CLI or doctor section (KPR-455); any change to the coordination bus; any `hive.yaml` key; any notification to the blocked-on party; an `escalate` primitive (an escalation ladder is a re-publishing subscriber, KPR-458 canon).
- **⚠ Delegated, non-blocking, named in Assumptions:** the reason classes above; the `agent-work` subject and its fallback; the `blockedOn` vocabulary and the optional `blockedOnAgentId` (a fact about the condition — the outstanding act — never an owner field); the optional explicit `threadId` on `clear_block`; the bounded pre-read `flush`; that cron-run blocks age to `unknown` rather than being cleared across runs.

## Scope and authority

Ticket: **KPR-501 — Agent-facing coordination/semantic-block producer into ops_events (KPR-454/458 extension)**. Parent: KPR-451. Filed as the corrective for the operator's **reject** ruling on KPR-454's GATE1_AMENDMENT (KPR-451#comment-60079ae4, held route KPR-451#comment-4a05ce45): Gate 1's KPR-454 clause "*and extend block context*" is not retired; it is chartered here. Worktree baseline: `epic/kpr-451` at `2b33b83a` (KPR-507 merged). Every runtime fact below was read at that tree.

**Signoff path.** Gate 1 delegated signoff (`epic-signed-off`, KPR-451#comment-95cc0708); KPR-501 carries no `needs-human-spec`. Delegated engineering calls are ⚠-flagged. Recipient, subscription and cadence policy is operator deployment data (KPR-458 canon) and none is supplied.

**Binding canon** (following a bullet needs no re-justification; contradicting one is a finding):

- **KPR-458:** operational facts publish without recipient, destination, transport, owner or severity; no owner or assignment model exists on the record. Interest lives only in subscription rows; no default subscription. `class`/`retry` are registry-declared per `(producer, reasonId)`; only `waiting` is per-publish, and `waiting: obligation` is published only by the expectation-holding producer. An unknown or disabled `(producer, reasonId)`, an undeclared `detail` key, an over-bound value or a non-scalar rejects and counts; redaction is the write-time schema. `generation` is an epoch over recovery — other producers declare their rule in the same terms, an undeclared one holds at 0. Match evaluation is pure and rides the immutable insert. The ops path never publishes about itself; no delivery may synchronously spawn an agent turn. `agent_events` is not reused for the ops record. Reason rows ship with their producer; subscription rows, cadence, horizons and retention values are operator data. A signed artifact is corrected by append-only supersession.
- **KPR-454:** the `hive-runtime` producer keys on the tool; `workItemId`/`threadId`/`agentId` ride `detail`, an admissible `workItemId` also rides `evidence` as kind `work-item`. `ops_reasons` is the D4 registry as data, upserted at boot with the clearing reason first and `enabled` `$setOnInsert`-only; restart is the reload lever, `enabled: false` the kill switch, no hive.yaml key; the 200-character ceiling clamps any producer-declared string bound. Externally authored ids are bounded at the capture point and omitted, never rejected; accept-path bounds reject and count; `waiting` is derived from the unfiltered id through `waitingFor(id?)` projecting the one reserved-prefix table, guarded repo-wide by `single-prefix-predicate.test.ts`. Publishing runs off the turn on a bounded in-process FIFO with a single drainer behind a module-global singleton wired above the spawn-capable boundary; counters live behind an uncalled `getSnapshot()`. Subscription rows are untrusted; `matchedSubscriptions` is exactly `matchedSubscriptionIds.length`; a `clears` must name the publishing producer's own family. `agent_events`/`EVENT_SCHEMAS`/`Scheduler.checkEvents`/`subscribe` stay untouched by KPR-454; KPR-501 publishes under KPR-458's contract as a second producer, never a fork.
- **KPR-453:** manager-owned turns supply the exact `WorkItem.id` before provider assembly; cached in-process MCP builders use live runner-owned references refreshed including absence, read at execution; retries and replay may reuse identity, which proves neither unique attempt nor task continuity.
- **KPR-468:** ledger identity is `(subscriptionId, dedupeKey)`; strict `(publishedAt, _id)` watermarks make prefix replay idempotent; clearing reaches all rows on the exact key with same-producer/class-evidence checks; **future producers, including KPR-501, must preserve the shared publish/drain ordering consumed by this cursor.** The notifier never publishes, matches, chooses recipients or spawns turns.
- **KPR-507:** publisher subscription reloads commit by start order, local to `OpsPublisher`; **KPR-501 publishes through this `OpsPublisher` accept path and adds no second loader.**
- **KPR-456 (applied twice already in this epic):** an engineering child supplies no default recipient, severity, escalation, production registration, prompt rollout or new policy dependency. This child supplies none.
- **KPR-452:** anything KPR-501 emits into Slack is not an audit copy and must not route through `postAuditLog` — trivially satisfied: this child emits nothing into Slack.

**Inputs.** The ticket body and its "read before drafting" list; the epic description and Decision Register; the KPR-454 coherence entry that held this route; `docs/epics/kpr-451/kpr-458-design.md` (contract, C1–C19), `kpr-454-design.md` (producer pattern), `kpr-468-design.md` (ordering, clearing provenance), `kpr-455-design.md` (arm 1, D5), `kpr-507-design.md` (§KPR-501 disposition); shipped `src/ops/*`, `src/events/*`, `src/agents/agent-runner.ts`, `src/agents/in-process-servers.ts`, `src/agents/server-traits.ts`, `src/workers/meeting-worker-pool.ts`. This artifact follows `docs/epics/kpr-451/` conventions and `CLAUDE.md`. Drafting does not approve an implementation plan.

## Verified runtime facts

Read at `2b33b83a`. Line spans drift; substance is what binds.

| Fact | Anchor | Bearing |
| --- | --- | --- |
| `event-bus` is built in-process per runner with `{ workItemContext: this.workItemContextRef, db, agentId: this.agentConfig.id, eventSubscribersJson }`, cached across turns, gated on `shouldEnableInProcessServer("event-bus")` | `src/agents/agent-runner.ts:1563-1573`; `buildInProcessServers` sets `workItemContextRef.current = context` at `:1514-1515` | The tools get a constructor-stable agent slug and the KPR-453 live reference for free (D2, D11). |
| `shouldEnableInProcessServer` reads `effectiveCoreServerSet()`, which starts from `coreServers` and adds only `schedule`/`team`/`team-roster`/(`workflow`) when not suppressed | `agent-runner.ts:521-552` | `event-bus` is **not** auto-injected: it appears only if an agent's `coreServers` lists it. The three-site gate is untouched (D2). |
| `event-bus` keeps a stdio placeholder in `buildAllServerConfigs`, so `filterCoreServers` yields it and `buildToolTransportInventory` classifies it `sdk-in-process` / `requires-hive-bridge` | `agent-runner.ts:1096-1106`, `:1380-1410`; `tool-transport.ts:129-131` | The KPR-327 Lane B compensation descriptor is **not** needed — unlike `memory`/`worker-pool` (`:1414-1447`). Lane B agents get the tools through the ToolBridge (D2). |
| `WORKER_SERVER_DENYLIST` contains `event-bus` | `src/workers/meeting-worker-pool.ts:54-69`, applied at `:460` | Contained workers and the scribe never see the tools (D2, D14). |
| `IN_PROCESS_PORTED_SERVERS` contains `event-bus`; `TURN_CONTEXT_DEPENDENT_SERVERS` does not | `src/agents/in-process-servers.ts`; `src/agents/server-traits.ts:8-17` | Already core-only (never a delegate server). No trait change is needed (D14). |
| `EventBusToolDeps` and `buildEventBusTools(deps)` return an array of SDK `tool()` descriptors; `createEventBusMcpServer` wraps them | `src/events/event-bus-mcp-server.ts:16-26`, `:28-132`, `:134-140` | The block tools are appended to that array (D2). |
| `system:task_blocked` is `{ taskId, description, blockedBy }` in a closed 13-type map; `emit_event` inserts into `agent_events` with a `deliveries[]` fan-out | `src/events/event-types.ts:119-126`; `event-bus-mcp-server.ts:86-103` | Untouched by this child (D10). |
| `OpsPublisher`'s job union is `failure \| recovery`; `runJob` creates an open-condition entry on every accepted **failure** job regardless of producer, and removes one on an accepted recovery | `src/ops/publisher.ts:107-109`, `:614-677` | Routing block publishes through `enqueueFailure` would pollute the capped open map; a third, accept-only kind is required (D8). |
| `accept()` is producer-agnostic: registry lookup from the loaded map, bounds, zod detail schema built from the row, `clears` legality (`clears-producer`, C19), `generation` from `resolveGeneration` when `clears` is absent else `0`, pure match, one insert | `publisher.ts:685-841`; `resolveGeneration` `:879-912`; `familyOf`/`stripGeneration`/`reasonIdOfDedupeKey` `:916-949`; `isMoreRecent` `:951-956` | The whole accept path is reused unchanged (D1, D7). |
| The constructor asserts `HIVE_RUNTIME_REASONS`; `init()` upserts that one table then loads the map from the collection | `publisher.ts:201-211`, `:226-251`; `store.ts:157-171`, `:211` | A second table is registered by extending both sites with a table list (D3). |
| `assertReasonTableLegal` is per-table: token bounds, remediation bound, string `maxLength` required, `clearsReasonIds` must name same-producer rows in the table, enabled `resource` rows must be cleared by some row | `src/ops/reasons.ts:170-238` | The `hive-agent` table is self-contained and passes on its own (D3). |
| `clearingProvenanceOk`: same producer, then `resource ⇒ true`, `judgment`/`integrity ⇒ evidence.length >= 1`, `informational ⇒ false` | `src/ops/ingest.ts:100-112` | A `semantic-block` clear needs a reference or it is stored and inert (D7). |
| The notifier cursor is `strictlyAfter(cursor)` over `(publishedAt, _id)` | `ingest.ts:56-62` | A document inserted behind an advanced watermark is never ingested (D8). |
| `__drainForTests()` waits on `queue.length > 0 \|\| draining`; `getSnapshot()` exposes `queueDepth` and `openConditions` | `publisher.ts:440-476` | The bounded public `flush()` is the same loop with a deadline (D7). |
| Bounds: `OPS_TOKEN_RE`, `OPS_ID_MAX_LENGTH = 200`, `OPS_EVIDENCE_MAX = 4`, `OPS_DETAIL_STRING_MAX = 200`, `OPS_CLEARS_MAX_LENGTH = 512`, `ADMISSIBLE_ID_RE`, `admissibleIdOrUndefined` | `src/ops/ids.ts:53-202` | Reused verbatim (D4, D6). |
| `observeToolFailure` derives `waiting` from the **unfiltered** id and stores the admissibility-filtered one | `src/ops/observe.ts:64-124` | The tools follow the same two-value discipline (D5, D6). |
| `WorkItemContext = { workItemId?, adapterId, channelId, channelKind, channelLabel, threadId, slackTs, slackThreadTs }` | `agent-runner.ts:149-166` | `threadId` is always present; `workItemId` is optional by contract (D4). |
| Publisher wiring sits above the boundary; SIGUSR1 reloads subscriptions; `stop()` drains before Mongo closes | `src/index.ts:564-567`, `:618`, `:726`, `:1144` | No new wiring, anchor or shutdown step (D13). |
| `schedule` binds its KPR-456 tools to `deps.agentId` from the constructor and returns `{ isError: true, ...response({ state: "unavailable" }) }` when the runtime is absent | `src/schedule/schedule-mcp-server.ts:273-316` | The response-shape precedent the block tools copy (D2, D9). |
| `buildOpsFixture()` returns a wired publisher over `FakeDb` with `events()` and `drain()`; `buildClaudeLaneHarness`/`buildLaneBHarness` drive real runner hooks and a real `ToolBridge` | `src/ops/testing/lane-harness.ts:46-80`, `:119-200` | The test harness exists (Testing Contract). |
| KPR-455 D5 names arm 1 "specified and empty", keyed `subject.kind = "workItem"` | `docs/epics/kpr-451/kpr-455-design.md:122-133`, Assumptions `:313` | `workItem` fails `OPS_TOKEN_RE` (capital `I`) — the interface in D12 names the real kind (D12). |

## Problem

Gate 1's consensus: "*Runtime emits, agents don't* … Agents tag only what the runtime can't see: coordination blocks and semantic blocks." KPR-454 shipped the runtime half. Today an agent that is blocked has exactly two outlets: narrate it in prose into whatever channel it is in (the noise this epic exists to remove), or `emit_event("system:task_blocked", …)` — which writes free text into a collection whose only reader spawns turns, and which no operational reader can query as a condition. Consequently KPR-455's work-status view (arm 1) has no producer: the reader is "correct today and returns only tool conditions". The stalled-work half of the epic's Storage section — "Work status keyed (agent, workItemId) — blocked until a same-run resumed / cancelled / escalated" — has no fact to derive from.

## Goals and non-goals

**Goals.** Let an agent state, as a published `ops_events` fact in the D2 envelope, that its work on a thread is blocked on another party or on a decision, and later that the block closed. Key the condition on the agent's work unit so it can be cleared from a later turn and after a restart. Reuse KPR-454's accept path, drainer, registry mechanics and bounds unchanged. Preserve worker containment, the three auto-injection gates and Lane B parity by inheritance. Make the fact honest with zero subscribers: recorded, not delivered. Give KPR-455 a stated interface for arm 1.

**Non-goals.** Notifying the blocked-on party (that is `team.send_message` / the coordination bus, unchanged). Any ledger row, delivery, nudge, snooze, intake or clearing *application* (KPR-468). Any reader, view, CLI, doctor section or the inbound acknowledgement edge (KPR-455). Any subscription row, transport binding, cadence, staleness horizon or retention value (operator, KPR-458 D11 column 3). Any change to `agent_events`, `EVENT_SCHEMAS`, `system:task_blocked`, `Scheduler.checkEvents` or the `subscribe` field. An owner, assignee, escalation target, severity or urgency on the event. An `escalate` tool. A publisher heartbeat or `ops_publisher_stats` (the KPR-455 request stands with the epic driver, unchanged). Any prompt, constitution or seed edit (no prompt rollout). Any `hive.yaml` key. Runtime-derived block detection (a block is an agent's statement; the runtime infers none).

## Design

### D1. Producer identity, and what is reused unchanged

`producer: "hive-agent"` — the agent's own statement about its own work, published by the engine on the agent's behalf through the tool. It is a bounded token under `OPS_TOKEN_RE`, not an enum member; the literal appears only in this producer's own rows and tool code, never in a validator (KPR-454 AC16).

Reused **byte-for-byte**: the envelope and vocabularies (`src/ops/types.ts`), the accept path (`OpsPublisher.accept`), the epoch resolver, the match evaluator and the immutable insert, the loaded reason map and the ordered subscription reload (KPR-507), `ops_events`/`ops_subscriptions`/`ops_reasons` and their indexes, the module-global singleton, the drainer, the shutdown drain, every bound in `ids.ts`, `waitingFor`. **No second loader, no second cache, no second collection, no second insert site.**

Added to `OpsPublisher`, minimal and named: (1) a third job kind and its enqueue method (D8); (2) a bounded `flush(deadlineMs)` (D7); (3) a read-only `findOpenCondition(family)` over the store (D7); (4) `isReasonEnabled(producer, reasonId)` over the loaded map (D9). The constructor and `init()` iterate a table list instead of one table (D3). Nothing else in `publisher.ts` changes; KPR-507's reload ordering is not touched.

### D2. The surface: two tools on the existing `event-bus` in-process server

**Decision.** `report_block` and `clear_block` are appended to the array `buildEventBusTools(deps)` returns, built by a new `buildBlockTools(deps)` in `src/ops/block-producer.ts` from the same `EventBusToolDeps` (`db`, constructor `agentId`, `workItemContext` ref). No new MCP server. No new key in `IN_PROCESS_PORTED_SERVERS`, `WORKER_SERVER_DENYLIST`, `TURN_CONTEXT_DEPENDENT_SERVERS`, or the runner's three gates.

**Why this is the smallest surface that satisfies "extend block context", against the two alternatives:**

| Option | New in-process server `ops` | Tools on `schedule` (auto-injected) | **Tools on `event-bus`** |
| --- | --- | --- | --- |
| KPR-390 obligation 1 (Lane B inventory compensation) | needed — no stdio placeholder | inherited | **inherited** (placeholder at `agent-runner.ts:1096`) |
| KPR-390 obligation 2 (three `suppressAutoInjectedServers` gates) | n/a unless auto-injected; if not auto-injected, operator must add `ops` to every agent's `coreServers` | already inside all three gates | **n/a — not auto-injected**, gates untouched |
| Worker containment | must add to `WORKER_SERVER_DENYLIST` | already denylisted | **already denylisted** |
| `delegateServers` constraint / CLAUDE.md list | must add | inherited | **inherited** |
| Reach | none until operators edit every agent | every agent | every agent whose `coreServers` lists `event-bus` — the universal default baseline includes it |
| Semantic fit | clean | poor — schedule is cron/obligations | **right — it is the coordination surface where `system:task_blocked` already lives** |

`event-bus` wins on every row but one (reach is opt-in per agent), and that one is the correct posture: an operator who removed `event-bus` from an agent removed its coordination surface and gets no block tools either; adding it back is the existing lever. A new server would be a strictly larger change for the same tools, and `schedule` would put block semantics on the wrong server to buy a reach the baseline already provides.

**Containment is asserted on the built set, per `CLAUDE.md`.** A worker-mode runner (`suppressAutoInjectedServers: true`, `coreServers` filtered by the denylist) builds a server set that does not contain `event-bus`, therefore no `report_block`/`clear_block`; the test drives `buildInProcessServers` + `buildToolTransportInventory` on such a runner and asserts absence there, never on the config array alone (AC1).

**Lane B parity by inheritance.** `buildToolTransportInventory` already emits an `event-bus` descriptor (`sdk-in-process`, `requires-hive-bridge`); `partitionInventoryForProvider` bridges it; the ToolBridge executes the same SDK server instance `buildInProcessServers(context)` returned, so the tools read the same live `workItemContext.current` on both lanes (KPR-453 canon). The plan drives one Lane B case through `buildLaneBHarness` (AC1).

**Tool response shape.** JSON text, the `schedule` precedent: `{ state, ... }` with `isError: true` on `unavailable` / `disabled` / `refused`. Handlers never throw — every path is inside the try/catch every in-process tool carries (`CLAUDE.md`, KPR-122). The `report_block` description says in its own words that the tool **records** a fact and **notifies nobody** — to alert the agent it is waiting on it uses `send_message` (team) as today — and that the agent clears the block itself with `clear_block` when it resumes or cancels. That description is the whole of the agent-facing guidance this child ships (no prompt rollout; "fix tool descriptions, not prompts").

### D3. The reason rows — three, shipped as one self-contained table

`src/ops/block-reasons.ts` (imports only `types.ts`/`ids.ts`, the `reasons.ts` layering), exporting `HIVE_AGENT_PRODUCER = "hive-agent"`, the three reason ids, and `HIVE_AGENT_REASONS` **in this order**:

| # | `reasonId` | `class` | `retry` | `clearsReasonIds` | `detailKeys` (all strings unless noted; `?` = optional) | `remediationTemplate` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `block-cleared` | `informational` | `transient` | `["coordination-block", "semantic-block"]` | `agentId` (≤64), `outcome` (≤16: `resumed`\|`cancelled`), `workItemId?` (≤200), `threadId?` (≤200) | `"none; recorded so {agentId}'s block closes ({outcome}) and reopens as a new epoch if it returns"` |
| 2 | `coordination-block` | `resource` | `deterministic` | — | `agentId` (≤64), `blockedOn` (≤16: `agent`\|`human`\|`external`), `blockedOnAgentId?` (≤64), `workItemId?` (≤200), `threadId?` (≤200) | `"{agentId} is blocked on {blockedOn}; supply what it is waiting for, and it clears the block itself (clear_block, resumed or cancelled)"` |
| 3 | `semantic-block` | `judgment` | `deterministic` | — | `agentId` (≤64), `workItemId?` (≤200), `threadId?` (≤200) | `"{agentId} needs a ruling above its authority; a named human rules, and the agent clears the block citing the ruling"` |

Templates interpolate always-present keys only (the KPR-454 rule). `enabled: true` on all three at deploy.

**Classes, argued.** D3's table decides class by *who can clear it, by what act*. A coordination block is cleared when the awaited act lands and the agent resumes (or cancels) — the same producer asserting the recorded predicate now holds, which is `resource`. A semantic block is "a decision above the producer's authority", cleared only by a named human's ruling — `judgment`. KPR-458's example table put `coordination-block` under `judgment` with the template "rule on {question}…"; that table is labelled illustrative and its template would store prose (`{question}`) that C13 forbids, so it is not followed. ⚠ Delegated. Consequences that follow from the classes and are wanted: `coordination-block` is enable-gated on a clearing reason (row 1 provides it) and any same-producer `block-cleared` clears it at the ledger; `semantic-block` clears only with evidence (D7); neither is `integrity`, so both are dismissible.

**`retry: deterministic` on both.** Re-running the blocked agent does not unblock it; the other party's act or the ruling must land first. D3: "something must change first". Nudge cadence is `f(class, retry)` operator data and reads nothing here. ⚠ Delegated.

**Registration.** `reasons.ts` gains `OPS_REASON_TABLES = [HIVE_RUNTIME_REASONS, HIVE_AGENT_REASONS] as const`. The constructor asserts each table with `assertReasonTableLegal` (the gate is per-table; the `hive-agent` table is self-contained — row 1 names rows 2 and 3, row 2 is the only `resource` row and row 1 clears it); `init()` upserts each table in list order, each table's internal order preserved. **Clearing-first is load-bearing** for the same severity reason KPR-454 D5 argued: a fault between writes must never persist an enabled, unclearable `resource` row; a dangling forward reference is inert and the next boot repairs it. `enabled` stays `$setOnInsert` — the operator's kill switch survives upgrades. `auditLoadedEnableGate` is already generic over the loaded map and covers the new `resource` row with no change.

### D4. Subject, dedupe identity, and why the thread — not the turn — is the key

```
subject = { kind: "agent-work", id: "<agentId>:<threadId>" }        // the normal shape
        = { kind: "agent-work", id: "<agentId>" }                    // fallback (below)
family  = "hive-agent:agent-work:<subject.id>:<reasonId>"
dedupeKey = family + ":" + generation                                 // D2's formula, unchanged
```

`agentId` is the constructor slug (`deps.agentId`); `threadId` is `workItemContext.current.threadId` read at execution. Both are engine-held; neither is a parameter.

**Why not `workItemId`.** The epic's storage note keyed work status on `(agent, workItemId)` and, in the same breath, warned that "`workItemId` is turn identity, not proof of task continuity — a later callback/retry needs an explicit link to the blocked work." KPR-453 canon fixed that: identity "proves neither unique attempt nor task continuity". A Slack thread produces a new `WorkItem.id` per human message, so a block raised on message `t1` and cleared on the reply at `t3` would be two subjects and the clear would find nothing. The engine's own unit of continuing work is the **thread** — the per-thread lock key `agentId:threadId`, the session-resume key — so that is the explicit link. `workItemId` still identifies *the turn that raised or cleared the block*, and rides `detail` and `evidence` exactly as KPR-454 carries it.

**Why the agent is embedded.** Conference threads dispatch one trigger to several agents (KPR-386); two agents blocked on the same thread must be two conditions, and one agent's clear must not close the other's. A subject bound to the calling agent also means **an agent can only ever report or clear its own blocks** — the tool has no parameter naming another agent as the subject.

**Fallback and bounds.** `subject.id` is bounded at 200 (`OPS_ID_MAX_LENGTH`, reject-and-count at accept). The tool composes the id and checks, in order: `threadId` passes `ADMISSIBLE_ID_RE` (a `scheduler:<agent>:<multi word label>:<epoch>` thread does not — the deliberate `sched:` exclusion KPR-454 D6 made) **and** the composed id is ≤ 200. On either failure the subject falls back to `"<agentId>"` and the tool counts `subjectFallback`. The fallback collapses every block that agent reports without a storable thread into one condition — the same accepted-collapse shape as KPR-454's one-condition-per-tool, and confined to turns that have no storable work unit. ⚠ Delegated.

**Named residual — cron-run blocks.** A scheduled turn's thread is per run (`scheduler:<agentId>:<task>:<epoch>`): when admissible, a block raised in one run keys a subject no later run will compose, so `clear_block` in the next run answers `no-open-block` and the condition ages into the reader's `unknown` past its horizon. That is the honest reading for a fact nobody re-asserted, and it is the behaviour Gate 1 asked for ("defaults to unknown after N minutes rather than trusting self-reported 'resolved'"). The explicit `threadId` parameter on `clear_block` (D7) is the manual escape. ⚠ Named, not solved; a per-job stable thread for cron is a scheduler question outside this child.

**Generation rule, declared per KPR-458 D2 in the same terms as `hive-runtime`'s.** `generation` is `0` on the first block report for a family and advances by exactly one when a block is reported for that family again **after** a `block-cleared` naming that family has been published; never on repetition, elapsed time, retry, or an unanswered nudge. The accept path already implements exactly this for any producer (`resolveGeneration`: latest condition vs latest `clearsFamily` under the compound order), so the declaration is a statement of what the shared path does, pinned by AC7 rather than re-implemented. On a resolver read fault the fallback reads the open-condition map, which holds no `hive-agent` entry (D8), so the publish proceeds at `0` — D2's named bounded mis-attachment, never a lost fact.

### D5. `waiting` — derived from the one prefix table, never a parameter

`waiting = waitingFor(workItemContext.current?.workItemId)` — the **unfiltered** id, exactly as `observe.ts:100` does; absent ⇒ `nobody`. A block raised in a human's live Slack thread is `human-now` (additive — the human sees the agent's own words in-thread; no engine subscription selects it, KPR-458 D10); in a `team-` turn it is `agent`; in a cron, callback, event or worker turn it is `nobody`; `obligation` is never produced here (canon). No second prefix predicate is introduced; `single-prefix-predicate.test.ts` stays green with no allowlist change (AC4).

The agent does not get to set `waiting`. That is the same structural refusal as registry-declared `class`/`retry`: a self-declared axis converges on its maximum (the Florist `loudness` lesson), and the invocation context is a fact the runtime already holds.

`block-cleared` publishes a **fixed** `waiting: "nobody"`, the KPR-454 `tool-recovered` posture: a clearing fact blocks no one, and a derived value would let a `human-now` subscription select clears.

### D6. Parameters, `detail`, `evidence` — redaction is the schema, and the tool refuses before the accept path can reject

**`report_block` parameters** (zod, strict, closed):

| param | type | required | becomes |
| --- | --- | --- | --- |
| `kind` | `"coordination" \| "semantic"` | yes | `reasonId` (`coordination-block` / `semantic-block`) |
| `blockedOn` | `"agent" \| "human" \| "external"` | coordination only; rejected on semantic | `detail.blockedOn` |
| `blockedOnAgentId` | string matching `^[a-z][a-z0-9-]{0,63}$` | optional, only with `blockedOn: "agent"` | `detail.blockedOnAgentId` |

**`clear_block` parameters:**

| param | type | required | becomes |
| --- | --- | --- | --- |
| `kind` | `"coordination" \| "semantic"` | yes | selects the family |
| `outcome` | `"resumed" \| "cancelled"` | yes | `detail.outcome` |
| `rulingRef` | string matching `ADMISSIBLE_ID_RE` | **required for `semantic`**, optional for `coordination` | `evidence: [{ kind: "ruling", id }]` |
| `threadId` | string matching `ADMISSIBLE_ID_RE` | optional | overrides the live thread when composing the family (the block was raised in another thread of the **same agent**) |

Engine-held values composed into every publish: `detail.agentId` (constructor slug), `detail.workItemId` and `detail.threadId` (from the live ref, through `admissibleIdOrUndefined`, omitted on breach with `publisher.countIdOmitted()` — the capture-point posture, reused rather than re-invented), `evidence: [{ kind: "work-item", id: workItemId }]` when admissible, `[]` otherwise (`report_block`); for `clear_block`, `evidence` is the ruling reference when supplied plus the clearing turn's `work-item` when admissible, at most two entries (well under `OPS_EVIDENCE_MAX`).

**No free text, anywhere.** There is no `summary`, `question`, `description`, `note` or `label` parameter, and none may be added: KPR-458 D9/C13 forbids message text and free-form prose in any stored field, KPR-454 canon treats a multi-word cron label as prose to be omitted, and a per-agent diagnostics surface is exactly where a token gets pasted. What a responder needs is a reference to open — the thread and the work item — plus closed tokens saying what kind of block and on whom; the remediation template supplies the sentence. `blockedOnAgentId` is a bounded lowercase slug (the agent-id convention), not validated against the roster (a live roster read on the tool path buys nothing a reader cannot do later; ⚠ delegated), and it is **a fact about the condition** — the outstanding act's party — not an owner: no engine path reads it, subscriptions cannot filter on `detail`, and it is absent from the explicitly-absent list's meaning (`owner`, `assignee`, `escalatedTo` all name who *handles* the notification; this names who the agent is waiting on).

**Two validation layers, deliberately distinct, as in KPR-454 D6.** The tool's zod parameter schema **refuses** a malformed call with a structured tool error and increments its own `refused` counter — the agent sees why and can fix it; nothing is published. The accept path's registry-built detail schema still **rejects and counts** on breach — but for input the tool admitted it must never fire, or the two schemas have drifted. AC5 drives the whole parameter matrix and asserts the publisher's `rejected` counter stays at zero. An `evidence` kind and `subject.kind` are literals in this module and satisfy `OPS_TOKEN_RE` by test (the KPR-454 `workItem`→`work-item` lesson).

### D7. The clearing fact — log-resolved, class-honest, never blind

`clear_block(kind, outcome, rulingRef?, threadId?)`:

1. **Availability.** No publisher singleton ⇒ `{ state: "unavailable" }`, `isError`. Reason row disabled (`isReasonEnabled`) ⇒ `{ state: "disabled" }`.
2. **Compose the family** from the constructor agent id and the live (or overridden) thread id under D4's rules.
3. **Flush, bounded.** `await publisher.flush(FLUSH_DEADLINE_MS)` — the `__drainForTests` loop with a deadline (⚠ value delegated; small, on the order of a second). This makes a block reported earlier *in the same turn* visible to the read below; a deadline that elapses (a failure storm has the queue deep) does not fail the call — the read proceeds and the response carries `queueIdle: false` so a `no-open-block` under that condition is honestly qualified.
4. **Resolve the open condition from the log**, not from the open-condition map: `publisher.findOpenCondition(family)` performs the resolver's two indexed reads — latest event in the family under the condition `reasonId`, latest event whose `clearsFamily` equals the family — and returns the condition's `dedupeKey` iff a condition exists and no clearing fact is more recent under `(publishedAt, _id)`. A read fault ⇒ `{ state: "unavailable" }`; the tool **never publishes a clear it could not verify** — D2: a clearing fact for a condition never raised is noise. **This is the one place this producer deliberately differs from `hive-runtime`**: KPR-454 resolves openness from the in-process map because a tool success is the hot path and a per-success read was rejected against C15; a block clear is a rare, deliberate agent act on its own turn, and a block is long-lived across deploys, so the restart residual KPR-454 accepted ("one lost epoch boundary per restart per open condition") would here mean *a block raised before a restart can never be cleared* — unacceptable for the fact this producer exists to record. The log is the source of truth; AC7 pins a clear across a simulated restart.
5. **No open condition** ⇒ `{ state: "no-open-block" }`, no publish, counted `clearNoOpen`.
6. **Class-honest evidence.** For `kind: "semantic"` a missing `rulingRef` ⇒ `{ state: "refused", reason: "ruling-required" }`, no publish. Reason: the cleared row's class is `judgment`, and KPR-468's `clearingProvenanceOk` (`ingest.ts:105-107`) applies such a clear only with `evidence.length >= 1`; KPR-455's reader applies the same rule (its D5). A clear published without evidence would be *stored but inert* at the ledger and the view — while the accept-path epoch resolver, which checks no class provenance, would count it as the more recent fact and advance the next report's `generation`, minting a fresh ledger row beside the still-open one. Refusing at the tool keeps every `hive-agent` clearing fact class-legal by construction. (A hand-inserted document is outside this guarantee, as it is outside KPR-454's.)
7. **Publish** `block-cleared` with `clears: <that dedupeKey>`, `waiting: "nobody"`, `detail: { agentId, outcome, workItemId?, threadId? }`, `evidence` per D6, through `enqueuePublish` (D8). The accept path validates C19 (`block-cleared` declares both condition reasons), `clears-producer` (own family) and derives `clearsFamily`; `generation` is `0` (a clearing publish skips the resolver), so every clear for one family renews one informational `…:block-cleared:0` row at the ledger — the `tool-recovered` shape.
8. Respond `{ state: "queued", clears, outcome, queueIdle }`.

An `escalated` outcome does **not** exist: escalation changes who handles a block and does not resolve it (Gate 1), and an escalation ladder is a re-publishing subscriber, not a primitive (KPR-458 canon). An agent that escalates does so with `send_message` and leaves the block open.

`report_block` on an already-open family is a renewal (same `dedupeKey`, `generation` unchanged, D7 rule 4 at the ledger, C18) — an agent may re-assert a block on every turn it remains blocked at no cost beyond one appended log row.

### D8. Ordering — every publish rides the one serial drainer

KPR-468 canon binds this child by name: preserve the shared publish/drain ordering the notifier cursor consumes. The mechanism that ordering rests on is that the **single serial drainer** stamps `publishedAt` and mints `_id` (client-side, per-process counter) and awaits the insert before touching the next job, so insertion completion order is stamp order. A synchronous accept from the tool path — running concurrently with the drainer — would break that: tool publish `A` stamps `t1`, drainer job `B` stamps `t2 > t1` and lands, the sweep advances its cursor past `(t2, id_B)`, then `A` lands at `(t1, id_A)` **behind** the watermark and is never ingested (`strictlyAfter`, `ingest.ts:56-62`). Nothing downstream can repair that; the event would be recorded and never notified.

**Therefore:** both tools enqueue and return; neither awaits acceptance; nothing in `src/ops/block-*.ts` touches an `ops_events` collection handle. `OpsPublisher` gains a third job kind — `{ kind: "publish"; input }` via `enqueuePublish(input)` — whose `runJob` arm is `await this.accept(job.input)` and **nothing else**: no open-condition entry is created (that map is `hive-runtime`'s recovery bookkeeping; a block entry there would consume slots of a cap sized for tools and evict a live tool condition, and nothing would ever read it), and no entry is removed. The existing `failure`/`recovery` arms are untouched. The same queue-depth, drop-oldest, `stopping` and shutdown-drain rules apply, so a block report enqueued at the edge of an overflow can be dropped and counted (`queueOverflow`) after the tool answered `queued` — the same residual the capture points carry, named rather than papered over; the agent's next turn can re-assert (a renewal is free).

A repository guard test (`src/ops/single-events-writer.test.ts`, the `single-prefix-predicate.test.ts` shape) pins that, outside tests, `OPS_EVENTS_COLLECTION` is referenced only by `types.ts` and `store.ts`, the literal `"ops_events"` only by `types.ts`, and `.events.insertOne(` only by `publisher.ts` — so a future writer must go through the drainer or argue with that test. Reads are unconstrained (KPR-455 will read; it adds itself to the constant's allowlist when it lands).

The block producer adds **no loader**: it holds no subscription set, no reason map, no timer, and calls neither `loadSubscriptions` nor `reloadSubscriptions` (KPR-507 canon; AC8).

### D9. The ops path publishes nothing about itself, and nothing here spawns a turn

Every fault on the tool path — publisher unset, reason disabled, parameter refused, read fault, flush deadline — is answered to the agent as a structured tool result and counted on the block producer's own counters (`reported`, `cleared`, `clearNoOpen`, `refused`, `unavailable`, `subjectFallback`; behind an uncalled `getBlockProducerSnapshot()`, the KPR-454 `getSnapshot()` posture). None is published: no `ops_events` document describes a failed `report_block`. Publisher-side faults keep their existing counters (`rejected`, `publishFaults`, `queueOverflow`, `idOmitted`).

Neither tool writes `agent_events`, `team_messages`, `team_pending_requests` or `agent_callbacks`, calls `emit_event`, or reaches any `runWorkItemTurn`/`spawnTurn` path. A block report's *only* effect is one appended `ops_events` row (and, once an operator subscribes, whatever KPR-468 does with it on its own sweep). Gate 1's "another agent waiting → notify that agent internally" is served by `team.send_message`, unchanged and deliberately not bundled: bundling would make a store-only record spawn a turn (D10 invariant (b)) and would make the record's honesty depend on a delivery.

C15 holds as it does for the capture points: the handlers are wrapped, a throwing publisher or a rejecting Mongo yields `{ state: "unavailable" }` and the agent's turn continues (AC11).

### D10. Relation to `agent_events`, `system:task_blocked`, and `Scheduler.checkEvents` — untouched

Nothing in `src/events/event-types.ts`, `emit_event`, `src/scheduler/scheduler.ts` or the `subscribe` agent-definition field changes. `system:task_blocked` remains what it is: a **coordination-bus message** whose publication fans out `deliveries[]` and whose only reader spawns turns for `system`-domain subscribers. `report_block` is an **operational record** that spawns nothing. They coexist and neither bridges to the other: an automatic "every `system:task_blocked` also publishes a `coordination-block`" would derive an agent's semantic statement from a free-text payload the ops contract cannot store, and would couple the record's existence to a turn-spawning write — the shape KPR-458 D10 declines. The only cross-reference is prose in `report_block`'s description (D2). Deprecating `system:task_blocked` is not this child's call and is not proposed.

### D11. Work identity and ownership — the KPR-453 shape, and no owner anywhere

`agentId` is `deps.agentId`, constructor-stable on the runner (the `schedule`/KPR-456 pattern). `workItemId` and `threadId` are read from `deps.workItemContext.current` **at execution**, never captured at build time (the server is cached across turns; the ref is refreshed by `buildInProcessServers(context)` on both lanes, including absence). No parameter lets the agent name a work item, a thread it did not run in (the `clear_block` override names a thread of the *same* agent), or another agent as the subject. Retries and outage replay may reuse a `WorkItem.id`; a replayed turn re-issuing `report_block` renews the same family, which is correct.

No `owner`, `assignee`, `escalatedTo`, `severity` or urgency exists on any event or parameter, and none may be added (KPR-458 D2, canon). Ownership of a block's *notification* is a subscription row; every acknowledgement is an attributed ledger act (KPR-468). The Gate 1 phrase "owner/escalation targets require deliberate writes" is met under the contract's stronger mechanism: the deliberate write is a subscription registration, and the deliberate act is an attributed acknowledgement — never a field on the fact.

### D12. Interface for KPR-455's arm 1 — stated, not implemented

KPR-455's spec revision consumes the following. It is exported as constants from `src/ops/block-reasons.ts` (`HIVE_AGENT_PRODUCER`, `REASON_COORDINATION_BLOCK`, `REASON_SEMANTIC_BLOCK`, `REASON_BLOCK_CLEARED`, `BLOCK_SUBJECT_KIND`, `BLOCK_EVIDENCE_KIND_WORK_ITEM`, `BLOCK_EVIDENCE_KIND_RULING`) so the reader imports rather than hand-copies (the `MEETING_ACK_TEXT` precedent).

| Aspect | Value |
| --- | --- |
| Producer | `hive-agent` |
| Condition reasons | `coordination-block` (`resource`, `deterministic`), `semantic-block` (`judgment`, `deterministic`) |
| Clearing reason | `block-cleared` (`informational`), `clearsReasonIds: [coordination-block, semantic-block]`, `generation` always `0`, `waiting` always `nobody`, `clears` = the exact open condition `dedupeKey`, `clearsFamily` derived |
| Subject | `kind: "agent-work"` — **not** `workItem` (fails `OPS_TOKEN_RE`); `id: "<agentId>:<threadId>"` or `"<agentId>"` (fallback). The agent id is the colon-free leading component and is also `detail.agentId` |
| Family / dedupeKey | `hive-agent:agent-work:<subject.id>:<reasonId>` / `…:<generation>` |
| Openness (the view's rule) | a family is **open** iff its latest condition event is more recent, under `(publishedAt, _id)`, than the latest event whose `clearsFamily` equals it **and** that clearing event passes KPR-458 D3 class legality for the condition's stored `class` (`resource` ⇒ any same-producer clear; `judgment` ⇒ `evidence.length >= 1`). This producer's tool guarantees the second clause for its own clears (D7), so for `hive-agent` events the two tests agree; the reader still applies both (its AC16) |
| Staleness | the reader's horizon, per view; past it, `unknown` (C11). A cron-run block is the common case that ages out rather than clears (D4) |
| `detail` | `agentId` always; `blockedOn`, `blockedOnAgentId?` on coordination blocks; `workItemId?`, `threadId?` (raising turn); `outcome` on clears |
| `evidence` | `work-item` (raising/clearing turn, when admissible); `ruling` (on clears, required for semantic) |
| `waiting` | from `waitingFor` on the raising turn's unfiltered work-item id; renders as the invocation context at report time |
| What arm 1 may not infer | resolution from elapsed time, from `activity_log`, or from a later turn on the same thread; only a class-legal `block-cleared` closes a block (C12/C11) |

### D13. Boot order, kill switch, counters — nothing new to wire

The publisher singleton is already constructed, initialized and set above the spawn-capable boundary (`index.ts:564-567`, marker `:618`); the `event-bus` server is built per runner. This child adds **no** `index.ts` line, no `boot-order.test.ts` anchor, no `.start(`, no shutdown step — the existing `await opsPublisher.stop()` drains block jobs with the rest. In the boot window before `setOpsPublisher`, the tools answer `unavailable` (the singleton is unset ⇒ every observe call and both tools are no-ops by construction).

**Kill switch:** `ops_reasons` `enabled: false` on `coordination-block` and/or `semantic-block` + restart. The tools then answer `{ state: "disabled" }` via `isReasonEnabled` — honest to the agent, rather than `queued` followed by a silent `unknown-or-disabled-reason` rejection that would spend the mis-integration counter on an operator's deliberate lever. Disabling only `block-cleared` is the unclearable-registry state `auditLoadedEnableGate` already logs once. Removing `event-bus` from an agent's `coreServers` + SIGUSR1 removes the tools from that agent. No `hive.yaml` key ships ("no preemptive levers").

**Counters** live in memory behind uncalled accessors (D9). No heartbeat, no telemetry document, no doctor section (KPR-455's standing request is unchanged).

### D14. Boundaries — what this child deliberately does not touch

- `agent_events`, `EVENT_SCHEMAS`, `system:task_blocked`, `emit_event`'s behaviour, `Scheduler.checkEvents`, the `subscribe` field (D10).
- `WORKER_SERVER_DENYLIST`, `IN_PROCESS_PORTED_SERVERS`, `TURN_CONTEXT_DEPENDENT_SERVERS`, `DELEGATE_UNSAFE_SERVERS`, the three `suppressAutoInjectedServers` gates, `buildToolTransportInventory`'s compensation block — all inherited (D2).
- `OpsPublisher.accept`, `resolveGeneration`, `reloadSubscriptions` (KPR-507), `evaluateMatches`, `OpsStore` indexes, every `ids.ts` bound, `waitingFor`/`outage-notices.ts`.
- KPR-468's notifier, ingest, intake, transport; KPR-456's obligation path; KPR-457.
- Agent prompts, the constitution, seeds, `docs/providers.md` (no provider behaviour changes).
- KPR-455's spec (revised by its own lane after this merges).

## Edge cases

1. **Publisher unset** (boot window, or `init()` faulted and left it unset): both tools return `unavailable`; no throw, no write.
2. **Reason disabled by the operator**: `disabled`; nothing enqueued; `rejected` unchanged.
3. **Thread id inadmissible or composed subject > 200**: agent-level fallback subject, `subjectFallback` counted, `detail.threadId` omitted, `idOmitted` counted.
4. **Work-item id inadmissible** (client-supplied ws/voice id, multi-word cron label): `detail.workItemId` omitted, `evidence` lacks the `work-item` ref, `waiting` still derived from the unfiltered id.
5. **Repeated `report_block`** on an open family: one more log row, same `dedupeKey`, `generation` unchanged (C18).
6. **report → clear → report**: the third publish carries `generation + 1` and a fresh `dedupeKey`.
7. **`clear_block` with nothing open**: `no-open-block`, no publish.
8. **`clear_block(kind: "semantic")` without `rulingRef`**: `refused`, no publish.
9. **Report and clear in one turn**: `flush` makes the report visible; the clear lands after it in FIFO order. If the flush deadline elapses under a storm the response says `queueIdle: false`; a `no-open-block` there is a qualified answer, and the agent may retry on its next turn.
10. **Two agents on one thread** (conference): two subjects, two families; one agent's clear never touches the other's.
11. **Contained worker or scribe**: no `event-bus` in the built server set, so no tools; the runtime still publishes *about* them via KPR-454. No outbound surface opens.
12. **Lane B agent**: tools are bridged and execute against the same live context; identical stored shape (AC1, AC2).
13. **Queue overflow after `queued`**: the job may be dropped oldest-first and counted; the agent's next renewal repairs it. Same residual as the capture points.
14. **Restart between report and clear**: the clear resolves the open block from the log and succeeds — the property D7 exists for.
15. **`human-now` block**: recorded, additive; the human already sees the agent's own words in the thread; no engine subscription selects it.
16. **Cron-run block**: keys a per-run subject; not cleared by the next run (`no-open-block`); ages to `unknown` in the reader; explicit `threadId` on `clear_block` is the manual escape (D4 residual).
17. **`clear_block` with an explicit `threadId`** of a family with no open condition: `no-open-block`; it can never name another agent's family because the agent id is composed in.
18. **`blockedOnAgentId` naming a non-existent agent**: stored as a bounded slug; not validated against the roster; a reader that wants to resolve it can (⚠).
19. **Epoch resolver read fault** during a block report: publish proceeds at the map fallback, which is `0` for this producer (no map entry) — D2's bounded mis-attachment, never a lost fact; `epochResolveFaults` counts it.
20. **Agent supplies extra/unknown parameters**: the strict tool schema refuses (`refused`), the accept path is never reached.

## Acceptance criteria

Each is an assertion a test can fail.

1. **AC1 (surface and containment, built set).** `report_block` and `clear_block` are tools of the `event-bus` SDK server returned by `buildInProcessServers` for a runner whose `coreServers` includes `event-bus`, and absent for one whose `coreServers` does not; absent from a worker-mode runner's (`suppressAutoInjectedServers: true`, denylist-filtered `coreServers`) built server set **and** its `buildToolTransportInventory` output; present on the Lane B partitioned inventory as an in-process `requires-hive-bridge` `event-bus` entry and executable through a real `ToolBridge` (`buildLaneBHarness`), producing the same stored document as the Claude lane. `IN_PROCESS_PORTED_SERVERS`, `WORKER_SERVER_DENYLIST`, `TURN_CONTEXT_DEPENDENT_SERVERS` and the three gate sites are byte-unchanged (a source-level assertion or a snapshot of the three sets).
2. **AC2 (envelope, C1/C4).** A stored `hive-agent` document's key set is exactly KPR-454 D9's list (`clears`/`clearsFamily` present on `block-cleared` only); `producer === "hive-agent"`; `class`/`retry` equal the row's; no `owner`/`severity`/`destination`/`recipient`/rendered string. Neither tool's parameter schema has a key that could set `class`, `retry`, `waiting`, `agentId`, `workItemId`, `threadId`, the subject or another agent (assert the schema's key set literally).
3. **AC3 (subject and identity).** `subject.kind === "agent-work"`; `subject.id === "<agentId>:<threadId>"` for an admissible thread; `"<agentId>"` with `subjectFallback` incremented for a `scheduler:… multi word …` thread and for a composed id > 200; two runners with different agent ids on one thread produce two families; the constructor agent id, not `config.name`, is used (harness agent has a display name distinct from its slug); `detail.agentId` equals the slug on every document.
4. **AC4 (waiting, C6).** `report_block` on a Slack-ts work item ⇒ `human-now`; on `team-…` ⇒ `agent`; on `sched:`/`callback:`/`event:`/`worker:` and with no work item ⇒ `nobody`; `block-cleared` ⇒ `nobody` regardless. `single-prefix-predicate.test.ts` passes with no allowlist change; the block modules contain no `startsWith`/regex over a reserved prefix.
5. **AC5 (redaction and the two validation layers, C5/C13).** No parameter accepts free text (schema key set assertion). A `blockedOnAgentId` carrying a space, uppercase, a path or a credential-shaped string is `refused` with the publisher's `rejected` unchanged and no document stored; the same for a `rulingRef` containing `/`. Driving every legal parameter combination for both tools through drain leaves `rejected === 0` and stores each document (tool schema ⊆ registry schema). The literals `agent-work`, `work-item`, `ruling` each satisfy `OPS_TOKEN_RE`. No stored field contains any substring of a prose-shaped ws/app-supplied `workItemId`/`threadId` (omitted, `idOmitted` incremented).
6. **AC6 (clearing, C19 + provenance).** With nothing open, `clear_block` returns `no-open-block` and stores nothing. After a coordination report, `clear_block(coordination, resumed)` stores one `block-cleared` with `clears` equal to the report's exact `dedupeKey`, `clearsFamily` equal to its family, `generation: 0`, `waiting: "nobody"`, `detail.outcome: "resumed"`. `clear_block(semantic, …)` without `rulingRef` returns `refused` and stores nothing; with `rulingRef` it stores a clear whose `evidence` contains `{ kind: "ruling", id }`. Provenance is driven through KPR-468's real `clearingProvenanceOk`: a ledger-row-shaped `resource` row clears on the coordination clear; a `judgment` row clears on the semantic clear **only** because of the ruling reference (the same document with `evidence: []` does not). A `clears` naming a `hive-runtime` family is unreachable from the tool (the composed family is always `hive-agent:…`); the accept path's `clears-producer` remains the backstop (existing test).
7. **AC7 (generation and restart, C18).** Two reports on one family: second has the same `dedupeKey`, `generation` unchanged. report → clear → report: third has `generation` 1 and a new `dedupeKey`. A clear issued through a **new** `OpsPublisher` instance over the same fake database (simulated restart, open map empty) still finds the open block and publishes `clears` for it. With `findOpenCondition`'s reads forced to fault, `clear_block` returns `unavailable` and stores nothing.
8. **AC8 (ordering and single writer, KPR-468/KPR-507 canon).** Both tools return before any insert (the stored count is unchanged until `drain()`); a block report enqueued between two tool-failure jobs is stored between them in `(publishedAt, _id)` order, and `openConditions` on `getSnapshot()` is unchanged by block and clear publishes (the accept-only job kind touches no map entry). The guard test pins: outside tests, `OPS_EVENTS_COLLECTION` only in `types.ts`/`store.ts`, `"ops_events"` only in `types.ts`, `.events.insertOne(` only in `publisher.ts`; the block modules contain no `loadSubscriptions`/`reloadSubscriptions`/`setInterval`.
9. **AC9 (C14 — nothing about itself, no spawn).** Every tool fault path (`unavailable`, `disabled`, `refused`, `no-open-block`, read fault) stores no `ops_events` document and increments the named block-producer counter. Across every case in this suite, `agent_events`, `team_messages`, `team_pending_requests` and `agent_callbacks` receive zero inserts, and no `runWorkItemTurn`/`spawnTurn` is invoked (spy on the harness manager where one exists; otherwise assert the collections).
10. **AC10 (kill switch and boot window).** With `coordination-block` set `enabled: false` in `ops_reasons` before `init()`, `report_block(coordination)` returns `disabled`, stores nothing, and `rejected` is unchanged, while `report_block(semantic)` still works; with the singleton unset both tools return `unavailable`. `enabled: false` survives a second `init()` (`$setOnInsert`).
11. **AC11 (C15).** With a publisher whose `enqueuePublish` throws, and with one whose Mongo read/insert rejects, each tool returns an `isError` structured result and a Claude-lane and Lane B turn that calls it completes with its `RunResult` classification unchanged; no exception escapes the handler.
12. **AC12 (reason table).** `assertReasonTableLegal(HIVE_AGENT_REASONS)` passes; `HIVE_AGENT_REASONS[0].reasonId === "block-cleared"` (order pinned); reordering `block-cleared` after `coordination-block` still passes the pure gate but fails the order test; a table with `coordination-block` enabled and `block-cleared` removed throws. `init()` upserts both tables and `loadReasons()` yields five rows; every remediation template interpolates only always-present keys of its row.
13. **AC13 (documentation).** `CLAUDE.md`: the `events/event-bus-mcp-server.ts` line names the two KPR-501 tools; a new Common Gotchas bullet **Ops block producer (KPR-501)** states the surface, the three rows, the `agent-work` subject, the log-resolved clear, the accept-only job kind and the kill switch; the `ops_reasons` collection entry mentions the `hive-agent` rows. Nothing claims a subscription, cadence or notification ships.
14. **AC14 (boot order).** `src/boot-order.test.ts` is unchanged and green; `index.ts` gains no line; no `.start(` is introduced.
15. **AC15 (KPR-455 interface).** The constants in D12 are exported from `src/ops/block-reasons.ts`, and a test asserts each stored document's `producer`/`reasonId`/`subject.kind`/`evidence[].kind` values equal those exports (a reader importing them cannot drift).

## Testing Contract

The plan derives its Testing Contract from this section; groups, commands and harness are fixed here, chunking is the plan's.

### Required test groups

- **Unit: required.**
  - Scope: the pure functions of `src/ops/block-producer.ts` (parameter → `OpsPublishInput` composition for both tools, subject composition and fallback, evidence composition, the semantic-ruling refusal) and `src/ops/block-reasons.ts` (`assertReasonTableLegal` over the shipped table, order pin, template-key audit, token-bound literals); `waitingFor` mapping via the composed input's `waiting`.
  - Reason: subject/fallback/evidence rules are the identity of the condition; a wrong composition is a wrong condition for every consumer and is cheapest to pin without I/O.
  - Harness: none beyond vitest; no `FakeDb`.
  - Minimum assertions: AC3 (composition limbs), AC4 (six `waiting` mappings on composed inputs), AC5 (schema key sets, token literals), AC6's refusal limb, AC12.

- **Integration: required.**
  - Scope: the tool handlers driven against a real `OpsPublisher` over `FakeDb` (`buildOpsFixture`), through `drain()`, asserting stored documents and counters; KPR-468's `clearingProvenanceOk` over stored clears; the simulated-restart clear; the ordering/single-writer guard; containment on built server sets via `buildClaudeLaneHarness`/`buildLaneBHarness`; a Lane B execution through the ToolBridge; the kill switch and boot-window cases.
  - Reason: every load-bearing property — accept-path agreement with the tool schema, `clears` naming the exact key, epoch advance, FIFO ordering, no open-map pollution, containment — lives at the publisher/runner boundary and cannot be seen by a unit test.
  - Harness: **existing**, extended: `src/ops/testing/lane-harness.ts` (`buildOpsFixture`, both lane harnesses, `makeHarnessAgentConfig` with `coreServers: ["event-bus"]`), `src/ops/testing/fake-db.ts` (`failNext`/`failAll` for the read-fault and insert-fault limbs; `operations` for "no insert before drain"), the tool descriptors' handlers invoked directly (the SDK `tool()` object) and, for the lane cases, through the runner's built server. New file `src/ops/block-producer.integration.test.ts`; guard test `src/ops/single-events-writer.test.ts`. Do not add a new harness module; do not import `notifier-harness.ts` except for `clearingProvenanceOk`'s row fixture shape if it already provides one.
  - Minimum assertions: AC1, AC2, AC5 (matrix limb), AC6, AC7, AC8, AC9, AC10, AC11, AC15, and every Edge case numbered 1–14 and 17–20 as a named test.

- **E2E: not-required.**
  - Scope: a deployed hive, a real agent calling the tool, a live Mongo, a live notifier subscription.
  - Reason: the shipped state has zero subscriptions, so the only observable is the stored document, which the integration group asserts byte-for-byte; the lane harnesses already drive real runner hooks and a real ToolBridge.
  - Harness: not-applicable.
  - Minimum assertions: none; nothing is waived from the integration group.

### Critical flows

- `report_block(coordination, agent, jasper)` on a Slack-ts turn → drain → one `coordination-block` document, `waiting: human-now`, `subject "<slug>:<thread>"`, `evidence [work-item]`, `matchedSubscriptions: 0`.
- Same again → renewal, same `dedupeKey`.
- `clear_block(coordination, resumed)` on a later turn of the same thread (different work item) → `block-cleared` with `clears` = that key; `clearingProvenanceOk(resourceRow, clear) === true`.
- `report_block(semantic)` → `clear_block(semantic, resumed)` without ref → `refused`; with `rulingRef` → clear whose evidence carries `ruling`; `clearingProvenanceOk(judgmentRow, clear)` true only with the ref.
- report → clear → report → `generation` 1.
- New publisher instance over the same db → `clear_block` still finds and clears.
- Worker-mode runner → no tools on the built set; Lane B runner → tools bridged and executing.
- Reason disabled → `disabled`, nothing stored; singleton unset → `unavailable`.
- Block job between two tool-failure jobs → stored in FIFO `(publishedAt, _id)` order; `openConditions` unchanged.

### Regression surface

- `src/ops/publisher.integration.test.ts`, `acceptance.integration.test.ts`, `capture-points.integration.test.ts`, `match.test.ts`, `reasons.test.ts` — the accept path, KPR-507 reload ordering and the `hive-runtime` rows are unchanged; `init()` now upserts two tables and `loadReasons()` returns five rows (adjust any exact-count assertion, if one exists, with the reason stated).
- `src/ops/delivery.integration.test.ts`, `ingest.integration.test.ts`, `notifier-acceptance.integration.test.ts` — the shared double and the notifier are untouched.
- `src/ops/single-prefix-predicate.test.ts` — no new hit.
- `src/boot-order.test.ts` — unchanged file, green.
- `src/events/event-bus-mcp-server.test.ts` — `emit_event` behaviour unchanged.
- Worker-pool containment tests (`src/workers/*.test.ts`) — built-set assertions still hold.
- `npm run check:bundle` — the new modules add no business strings (`scripts/check-bundle-strings.mjs`).

### Commands

Run from the child implementation worktree on Node 22 or 24 (`CLAUDE.md`: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher). A missing install is setup, not a skipped test. The env stubs are required because the lane harness imports `config.ts`.

- Setup: `node --version` (expect v22.x or v24.x); `npm ci` if `node_modules` is missing
- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/block-producer.test.ts src/ops/block-reasons.test.ts src/ops/reasons.test.ts`
- Integration (this child): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/block-producer.integration.test.ts src/ops/single-events-writer.test.ts`
- Ops regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops`
- Boot and prefix guards: `npx vitest run src/boot-order.test.ts src/ops/single-prefix-predicate.test.ts`
- Full: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle guards: `npm run check:bundle`
- Hygiene: `git diff --check`
- Expected: exit 0, all selected tests pass, no skipped new contract cases. Record actual totals; do not invent counts. Drafting makes no runtime success claim.

### Harness requirements

- `buildOpsFixture()` for a wired publisher; `fixture.drain()` is the only publish→assert barrier (enqueue is synchronous and fires `void drain()`; never assert on the store right after a tool call except to prove *nothing* landed yet).
- `makeHarnessAgentConfig({ id: "<slug>", name: "<DisplayName>", coreServers: ["event-bus"] })` — the slug/display split is load-bearing for AC3.
- A `WorkItemContextRef` the test mutates between calls to model successive turns on one thread (different `workItemId`, same `threadId`) and the `sched:`/`team-`/`callback:` id shapes for AC4.
- `FakeDb.failNext(collection, "find", …)` for the `findOpenCondition` fault limb; `failAll`/`failNext` on `ops_events` `insertOne` for the C15 limb; `operations` to assert "no `ops_events` insert before drain".
- A new-instance publisher over the fixture's existing `fakeDb.db` for the restart case (do not reset the collection).
- `clearingProvenanceOk` imported from `src/ops/ingest.ts` with a minimal `OpsNotification`-shaped row (`producer`, `class`); no notifier sweep is run.
- Logger remains the hoisted `mockLog` pattern used by the ops suites.
- No live Mongo, no Slack token, no Anthropic key, no fake timers (the flush deadline is driven with a real small value, not `vi.advanceTimers`).

### Non-required rationale

- E2E: stated above — zero subscriptions ship, so the deployed observable is the stored document already pinned in integration, and the lane harnesses exercise the real runner/bridge paths.

### Verification rules

- Missing harness is not a skip reason; every harness named exists at `2b33b83a`.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch (for example the accept path rejecting a tool-admitted value), demote to the spec lane rather than widening a bound in place.
- Negative-verify is required at six points, each naming the mutation and the test that must fail:
  1. **NV1 — thread-keyed subject (AC3/AC6):** compose `subject.id` from `workItemId` instead of `threadId`. The "clear on a later turn of the same thread" case fails with `no-open-block`.
  2. **NV2 — log-resolved clear (AC7):** resolve openness from the publisher's open-condition map instead of `findOpenCondition`. The simulated-restart case fails.
  3. **NV3 — accept-only job kind (AC8):** route block publishes through `enqueueFailure`. The `openConditions`-unchanged assertion fails.
  4. **NV4 — semantic ruling requirement (AC6):** drop the `rulingRef` requirement. The `clearingProvenanceOk(judgmentRow, clear) === false` limb (clear without a ref now published) fails.
  5. **NV5 — no self-notification (AC9):** make `report_block` also insert a `system:task_blocked` into `agent_events`. The zero-insert assertion fails.
  6. **NV6 — pre-read flush (Edge 9):** remove `flush` before the read. The same-turn report+clear case fails with `no-open-block`.
- Restore after each mutation. Run the targeted vitest files while changing the producer, then `npm run check` before submission.

## Deployment and rollback

No new collection, index, TTL, `hive.yaml` key or boot anchor. Three `ops_reasons` rows are upserted at first boot after deploy (`enabled: true` on insert; an operator's later `enabled: false` survives upgrades). Shipped state: **zero** `ops_subscriptions` rows — every block is recorded, none delivered, no ledger row exists, `matchedSubscriptions: 0` measures the unclaimed. Agents whose `coreServers` include `event-bus` see the two tools on their next spawn after the engine restart; no agent-definition or prompt change ships.

**When an operator does subscribe** (a `filter: { producer: ["hive-agent"] }` row plus an `ops_policy` cadence — both data, both outside this diff): KPR-468 will mint and nudge `judgment`-class `semantic-block` rows until acknowledged or cleared, so KPR-458's go-live gate applies unchanged — **KPR-468 must not be live with such a subscription before KPR-455's inbound edge exists.** This child does not alter that sequencing; it adds a producer whose rows make the gate matter sooner.

**Sequencing.** Merge after KPR-507 (done, `2b33b83a`); KPR-455's spec revision consumes D12 and its lane runs after this merges.

**Levers, all data or existing:** `enabled: false` on either condition row + restart (tools answer `disabled`); remove `event-bus` from an agent's `coreServers` + SIGUSR1 (tools vanish for that agent). **Rollback:** code revert. The three `ops_reasons` rows and any stored `hive-agent` events remain — inert without the code, deletable by hand, and honest history either way.

## Assumptions and remaining decisions

- **⚠ Delegated (non-blocking) — the surface is two tools on `event-bus`, not a new server.** D2's table; every KPR-390 obligation and the worker denylist are satisfied by inheritance, and the fit is the coordination surface. Reversal is a new server plus the four registrations D2 enumerates.
- **⚠ Delegated (non-blocking) — `coordination-block` is `resource`; `semantic-block` is `judgment`; both `deterministic`.** D3. The KPR-458 example table's `judgment` for coordination is illustrative and its template stores prose. A different class is a row change; the tool logic keyed on class (the ruling requirement) follows the row.
- **⚠ Delegated (non-blocking) — the subject is `agent-work` = `(agentId, threadId)`, with an agent-level fallback.** D4. This departs from the epic body's `(agent, workItemId)` phrasing for the reason that phrasing itself gave (KPR-453 canon); the epic body's Storage section is proposal, not canon. Reversal to a turn key would break cross-turn clearing (NV1).
- **⚠ Delegated (non-blocking) — the `blockedOn` vocabulary (`agent`/`human`/`external`) and the optional `blockedOnAgentId`, unvalidated against the roster.** D6. Argued as a fact about the outstanding act, never an owner; no engine path reads it. Dropping it is a row and schema change.
- **⚠ Delegated (non-blocking) — `clear_block` accepts an optional same-agent `threadId` override.** D6/D7. The escape for a block cleared from another thread of the same agent and for cron-run blocks; it can never name another agent's family.
- **⚠ Delegated (non-blocking) — the bounded pre-read `flush` and its deadline value.** D7 step 3. Without it a same-turn report+clear misses (NV6); the deadline keeps a failure storm off the agent's critical path.
- **⚠ Delegated (non-blocking) — the clear is log-resolved, and the accept path keeps its map-fallback epoch behaviour for this producer.** D7/D4. The map is `hive-runtime`'s; the log is authoritative here. The one residual (a resolver read fault on a block report publishes at `0`) is D2's own.
- **⚠ Delegated (non-blocking) — the accept-only job kind (`enqueuePublish`) on `OpsPublisher`, and the three small read-only accessors.** D1/D8. Every alternative either pollutes the open-condition map or bypasses the serial drainer, and the second breaks the KPR-468 cursor invariant outright.
- **⚠ Named residual (non-blocking) — cron-run blocks age to `unknown` rather than being cleared across runs.** D4/Edge 16. The honest outcome under Gate 1's own rule; a stable per-job cron thread would be a scheduler change and is not proposed here.
- **⚠ Named residual (non-blocking) — a block report can be dropped after the tool answered `queued`** under queue overflow or shutdown, counted on the publisher's existing counters. Same shape as the capture points; a renewal repairs it.
- **⚠ Named limit (non-blocking) — the engine verifies shape, never truth.** A `rulingRef` proves a reference exists in an admissible shape, not that a human ruled. The reader's staleness horizon and the ledger's attribution are the contract's answer to self-report; this child adds no oracle.
- **Non-blocking, corrects KPR-455's stated arm 1 key.** `subject.kind = "workItem"` cannot exist under `OPS_TOKEN_RE`; the interface is `agent-work` (D12). KPR-455's revision imports the exported constants.
- **Non-blocking, supersedes nothing signed.** No signed sibling body is edited; KPR-454's D11 note that the coordination-block producer is "a future producer" is discharged by this child, not amended.
- **No blocking product question.** Gate 1 named the two block kinds; KPR-458 fixed that reason rows ship with their producer; the operator's reject ruling fixed the venue (`ops_events`, second producer, no fork). Every remaining choice is engineering, delegated under Gate 1 and flagged above.
- **Plan shape — one implementation plan.** Surface: `src/ops/block-reasons.ts` (rows + constants), `src/ops/block-producer.ts` (compose/validate, tools, counters), three additive methods and one job arm in `src/ops/publisher.ts`, one table list in `src/ops/reasons.ts`, one spread in `src/events/event-bus-mcp-server.ts`, tests, `CLAUDE.md`. Natural order: rows and the table list; the publisher additions; the tools; the guard test; lane/containment cases; documentation.
