# KPR-456 delivery obligations implementation plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan, after the repository's /spec-and-implement prerequisite has been resolved and invoked. This document does not authorize bypassing that entry point.

**Goal:** Register recurring human delivery expectations independently of cron and issue one durable missed-delivery notice identity for each unsatisfied deadline.

**Architecture:** A guarded Mongo registry arbitrates admission and deactivation, while durable occurrence documents checkpoint delivery and notice attempts. A dedicated Slack text transport disables retries; append-only activity receipts and retained receipt-write checkpoints distinguish confirmed delivery, expired history, and uncertainty. One bounded engine sweep materializes deadlines, repairs eligible initial receipt writes, and evaluates notices without invoking an agent.

**Tech Stack:** Existing TypeScript/Node 24, MongoDB driver, Slack WebClient 8.1.1, Zod, Claude in-process SDK MCP server and Lane B ToolBridge, Vitest. No runtime dependency addition.

**Approved input:** [KPR-456 design](kpr-456-design.md), spec-ready at dfe72cf; clean final spec review 2. Gate 1 delegates this engineering scope. No dependencies or merged decision-register canon. Unmerged sibling plans are not prerequisites.

**Execution boundary:** AGENTS.md requires /spec-and-implement after plan approval for a non-trivial architectural change. Its entry point remains unresolved at drafting time. The driver must resolve that workflow before executing this plan; do not ask again for Gate 1 approval. This draft does not implement, commit, push, edit PM state, deploy, enroll an obligation, or modify production prompts.

## Review chunks and file structure

Read the main plan and all seven numbered chunks as one plan. Each file is below 1,000 lines. Code fences contain complete new-file payloads or exact insertion/replacement blocks. Apply normal repository formatting; do not treat formatting changes as design changes.

| Chunk | Plan file | Responsibility |
| --- | --- | --- |
| 1 | [Contracts and store](kpr-456-plan-1-store.md) | Schemas, recurrence, durable Mongo CAS, indexes |
| 2 | [Evidence and delivery](kpr-456-plan-2-delivery.md) | Slack provenance, no-retry transport, receipt reconciliation, admission handoff |
| 3 | [Sweep and reader](kpr-456-plan-3-sweep.md) | Bounded materialization/recovery/evaluation, paginated views |
| 4 | [Integration and CLI](kpr-456-plan-4-integration.md) | Both provider paths, lifecycle, instance-bound CLI, operator documentation |
| 5 | [Harness and unit tests](kpr-456-plan-5-tests.md) | Atomic fake Mongo driver, recurrence and transport tests |
| 6 | [Integration tests](kpr-456-plan-6-integration-tests.md) | Real service/provider/CLI assembly, race and failure coverage |
| 7 | [Fault and lifecycle tests](kpr-456-plan-7-fault-tests.md) | Remaining explicit fault, shutdown, fairness and compatibility assertions |

Production files to create:

- src/obligations/types.ts — strict persisted and input schemas plus narrow tool capability.
- src/obligations/deadlines.ts — shared pure UTC-minute recurrence evaluator and window derivation.
- src/obligations/store.ts — acknowledged writes, CAS, admission and immutable registration.
- src/obligations/receipts.ts — exact history inspection and eligible initial insertion repair.
- src/obligations/slack-post.ts — one post, provenance validation, closed rejection classifier.
- src/obligations/delivery.ts — producer-bound validation and token-fenced admission/acknowledgement.
- src/obligations/sweeper.ts — bounded independent checker and heartbeat.
- src/obligations/reader.ts — bounded read-only operator/producer views.
- src/obligations/runtime.ts — initialization and drainable lifecycle capability.
- src/cli/obligations.ts — command parsing, existing-sentinel verification, short-lived Mongo client.
- docs/delivery-obligations.md — enrollment and uncertainty semantics, fake examples.

Existing files to modify:

- src/activity/types.ts — additive receipt discriminator/union, legacy turns remain compatible.
- src/activity/activity-logger.ts — count only turn documents in its startup diagnostic.
- src/schedule/schedule-mcp-server.ts — two strict new tools in the existing server.
- src/agents/agent-runner.ts — optional capability forwarded at the existing in-process seam.
- src/agents/agent-manager.ts — normal-runner capability wiring; contained workers remain excluded.
- src/index.ts — initialize before spawn-capable boundaries, enable transport after Slack starts, stop/drain before Slack/Mongo shutdown.
- src/cli.ts — command routing and help.
- Existing schedule, provider bridge/runner, activity and boot-order test files for boundary regressions.

Tests to create:

- src/obligations/testing/fake-db.ts
- src/obligations/testing/refusals.ts
- src/obligations/testing/harness.ts
- src/obligations/deadlines.test.ts
- src/obligations/slack-post.test.ts
- src/obligations/obligations.integration.test.ts
- src/obligations/faults.integration.test.ts
- src/obligations/reader.test.ts
- src/cli/obligations.test.ts

## Testing Contract

### Required Test Groups

- Unit: required
  - Scope: strict schemas, recurrence/windows/DST, bounded scanning, Slack acknowledgement/refusal classification, reader cursor validation, exact receipt match and retention decisions.
  - Reason: correctness depends on boundaries and conservative interpretation, not happy-path CRUD.
  - Minimum assertions: invalid/extra fields rejected; channel/thread canonicality and length bounds; UTC host independence; DST gap absent/fold double; (previousDueAt,dueAt] window; <=3,900 attributed characters; the design's independent exact 13-code refusal fixture matches the production set and each refusal is retryable; every other submitted result unknown; wrong response URL, absent provenance and redirects remain unknown with redirect:error asserted on real fetch options; no raw bodies/errors persisted.

- Integration: required
  - Scope: real guarded Mongo stores, receipt reconciler, sender, sweeper, CLI handler and schedule service/tool assembly over an atomic fake Mongo driver and fake Slack HTTP responses.
  - Reason: multi-document handoff, CAS races, restart recovery and historical receipt expiry cannot be proven by call-count mocks alone.
  - Harness: setup-required — add the deterministic fake driver in chunk 5, using existing src/db/db-identity.integration.test.ts conventions. No live Mongo or Slack.
  - Minimum assertions: all ten specification acceptance criteria, including both orders of admission/deactivation, unknown submissions after restart, pending/persisted/expired_unresolved receipt recovery, fair bounded overdue catch-up, read-only readers, disabled activity logging, missing cron, and cutoff-equal deadlines.

- E2E: not-required
  - Scope: deployed Slack workspace, live production Mongo, launchd, and actual provider inference.
  - Reason: this ticket authorizes no enrollment/deployment/real sends, and correctness is deterministic at real local tool/service/transport boundaries with external systems replaced. Both provider execution paths still require local integration coverage.
  - Harness: not-applicable
  - Minimum assertions: not applicable; no assertion is waived from the local integration group.

### Critical Flows

- Registry with no cron → overdue materialization → one notice identity/post → repeat sweeps/restart remain terminal.
- Explicit identity-bound tool send → Slack acknowledgement → durable pending checkpoint → append-only receipt → persisted marker → on-time suppression.
- Admission loses to deactivation → zero posts; admission wins → one token may finish after future expectation cancellation and preserve evidence.
- Submission ambiguity → permanent unknown until separately specified reconciliation; no implicit SDK/in-memory resend.
- Receipt insert failure/restart → original-timestamp repair only while pending/eligible; terminal history expiry never recreates rows.
- Old overdue keys, including deactivated past expectations, remain discoverable by bounded pagination; a late send stays assigned to its original deadline.
- Store failure/write guard → unknown/pending evaluation and visible stale heartbeat/backlog; no false success.
- Local-only commit followed by write timeout → majority recovery cannot authorize submission or publish receipt persistence; majority-confirmed commit-then-throw may recover the exact token/row.
- Same-boot invocation ends before handoff → token-fenced recovery records unknown, clears only its admission and permits a later occurrence; active delayed invocations remain untouched.
- Concurrent receipt repair/expiry → one shared per-occurrence queue, fresh clock at insert admission, no insertion behind a terminal checkpoint; queued repairs after persisted+TTL remain read-only for history.
- Future/cancelled pending receipts and admissions beyond one recovery page → nonzero heartbeat recovery backlog until drained; missing retained admission projection → explicit read-only integrity failure.

### Regression Surface

Existing schedule CRUD/locks, legacy cron interpretation, ordinary Slack split/file/streaming and echo cache, both provider assembly paths, worker containment, activity buffering/retention, datastore identity guard, boot boundary, shutdown, doctor exit behavior, dispatcher/audit/outage delivery.

### Commands

Execute from the child implementation worktree on Node 24. A missing install is setup, not a skipped test.

- Setup: node --version; npm ci
- Unit: npx vitest run src/obligations/deadlines.test.ts src/obligations/slack-post.test.ts src/obligations/reader.test.ts
- Integration: npx vitest run src/obligations/obligations.integration.test.ts src/obligations/faults.integration.test.ts src/cli/obligations.test.ts src/schedule/schedule-mcp-server.test.ts
- Provider/containment/boot regression: npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/workers/meeting-worker-pool.test.ts src/boot-order.test.ts
- Adjacent regression: npx vitest run src/scheduler/scheduler.test.ts src/activity/activity-logger.test.ts src/slack/slack-gateway.test.ts src/slack/outbound-ts-cache.test.ts src/db/db-identity.integration.test.ts src/cli/doctor.test.ts
- E2E: not required; no live account/service command.
- Broader regression: npm run check
- Artifact/code hygiene: git diff --check; rg -n 'activity_log' src scripts setup
- Expected results: exit 0, all selected Vitest tests pass, no skipped new contract cases, no TypeScript/ESLint/Prettier errors. Record actual totals, do not invent expected test counts.

### Harness Requirements

- Node 24; dependency installation from the existing lockfile.
- Fake clock controls both acknowledgement time and sweep time. No date assertions using the real wall clock.
- Atomic in-memory driver must enforce matching filters, unique _id/receipt indexes, CAS revisions, $setOnInsert/$set/$unset/$inc/$max and sorted limited cursor reads; all mutation decisions occur synchronously before returning their promise.
- Record read/write options and model majority-confirmed visibility separately from local-only commit-then-timeout; majority reads must never return the local-only row/token. Permit explicit majority commit or rollback of that staged state for recovery assertions.
- Barrier hooks at registry admission, occurrence claim, HTTP submission, acknowledgement checkpoint, receipt insert and persisted-marker publication. Failure modes must include commit-then-throw, throw-before-commit, and delayed successful writes. Serialize receipt repair through the real shared queue: never make a test barrier wait for two operations that the queue intentionally serializes.
- Fake Slack HTTP fetch runs through the real dedicated WebClient; accepted-message count is independent of returned acknowledgements. Test redirects/proxy/malformed acknowledgements and absent provenance.
- A fresh service reuses the same fake DB and new boot ID after the old service is stopped. Simultaneous senders/sweepers in the same live engine share a boot ID. No production credentials.
- All runtime stores share the engine's guarded Db object, so their receipt queues and active invocation tokens are shared even across distinct store/service wrappers. Test same-boot abandonment separately from a paused live invocation.
- Real SDK in-process MCP transport/ToolBridge tests for both provider paths; contained worker creation retains the existing denylist and suppressAutoInjectedServers gates.
- CLI fake connection verifies sentinel, read/write separation, selected instance, cleanup and idempotence without loading real secrets.
- CLI read-only cases include pending and expired initial receipt writes; instance tests capture exact CliSelection and route to distinct fake databases. Runtime initialization tests begin with no receipt indexes and cover independent receipt setup, createIndex failure and incompatible existing TTL without enabling readiness.

### Non-Required Rationale

- E2E: production service/account access is outside authorized scope; all critical internal flows are covered by local integration over real code.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- No completion, commit or PR claim before dodi-dev:verify obtains fresh evidence for the relevant command.
- No live Slack posts, production registrations, schedule creation or deployed prompt changes during implementation.
- A clean review of every chunk and final dependency check are required before ready-to-implement.

## Task order and commits

1. Apply chunk 1 and pure tests. Run focused unit/typecheck; commit contracts/store.
2. Apply chunk 2 and transport/activity tests. Receipt/admission integration runs after chunk 3 supplies its assembly dependencies. Run focused transport/activity/typecheck; commit sender/evidence.
3. Apply chunk 3, the complete test harness, and receipt/admission/overdue/notice/read-only tests. Run focused integration; commit checker/reader.
4. Apply chunk 4 and CLI/provider/lifecycle regressions. Run all focused commands; commit wiring/docs.
5. Finish every case in chunks 5–7, run npm run check and git diff --check, review actual diff for stored content/secrets and unintended enrollment; commit remaining test fixes.
6. Submit through the epic lane after the normal implementation/review gates; no push/PR/deploy action is part of this drafting phase.

Each chunk gives exact commands and touched-file commit lists. Worker scheduling may parallelize isolated pure evaluator/transport work only after contracts are frozen; store/sender/sweep changes share state-machine invariants and must not be independently merged without integration testing.

## Engineering decisions and limits

- One engine owns a database at a time, as the existing launchd/instance model assumes. A boot ID denotes that live engine, not a lease that expires. Concurrent callers/ticks share it. Do not introduce multi-engine leader election or declare a slow live owner orphaned.
- Recovery reads use primary majority concern with bounded execution time. A per-Db in-memory queue serializes receipt insert admission and terminal retention decisions; retained CAS state supplies durable fencing after restart. Same-boot delivery and notice liveness use invocation-owned tokens registered before claims and removed in finally, never elapsed-time reclamation.
- Technical bounds: 20 registry documents and 1,440 UTC minutes per document per tick; 100 recovery/evaluation records per page; stable keyset pagination and monotonic cursors prevent dropped work. Repeated infrastructure failures rotate eligible work by next-check time while remaining pending.
- Retention is the existing timestamp TTL. Initialization fails on an incompatible existing TTL, and the reader reports the observed effective value. Runtime modification of the TTL while this engine is running is outside this feature's administration surface.
- Slack acknowledgement is accepted transport evidence, not human reading or semantic completeness. Unknown means uncertainty; there is no exactly-once visible delivery promise.
- The only retryable outcomes are the design's closed refusal list with validated Slack provenance. Technical delay defaults to 30 seconds and honors a larger Retry-After.
- All errors persisted or returned from infrastructure paths use enumerated safe codes; raw response/error/body text is never serialized.

## API evidence used in drafting

The dedicated client sets retryConfig.retries to zero and rejectRateLimitedCalls to true; Slack documents the second option because rate-limit retries are separate. The pinned 8.1.1 client accepts an injected fetch function, allowing request-local response provenance without a global context. [Slack retry behavior](https://docs.slack.dev/tools/node-slack-sdk/web-api/#automatic-retries), [Slack SDK 8.1.1 source](https://github.com/slackapi/node-slack-sdk/blob/%40slack%2Fweb-api%408.1.1/packages/web-api/src/WebClient.ts).

Slack success contains the destination channel and ts; some server errors permit partial success, so the classifier defaults to unknown. [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).

Receipt-only partial unique indexes preserve legacy turn rows with absent receipt keys. [MongoDB partial indexes](https://www.mongodb.com/docs/manual/core/index-partial/).

Majority reads return majority-acknowledged data; write-concern timeouts do not undo local modifications. This plan therefore uses explicit primary majority reads wherever observation substitutes for acknowledged persistence. [MongoDB majority read concern](https://www.mongodb.com/docs/manual/reference/read-concern-majority/), [MongoDB write concern](https://www.mongodb.com/docs/manual/reference/write-concern/).
