# KPR-454 runtime tool-failure producer implementation plan

> **For agentic workers:** Execute this plan through the epic implementation lane (`dodi-dev:implement-ticket`). Read this index and all five numbered chunks as one plan before starting Task 1.

**Goal:** Publish every tool failure and tool recovery observed on either provider lane as a durable, store-only `ops_events` document in the KPR-458 envelope, delivering nothing and altering no turn.

**Architecture:** Two capture points — a Claude-lane `PostToolUseFailure`/`PostToolUse` hook pair registered in `AgentRunner.buildHooks`, and Lane B's single `wrap()` success/catch pair in `ToolBridge` — call a synchronous, non-throwing, void observe API on a module-global publisher singleton. The publisher owns a bounded in-process job queue drained by one serial worker; the drainer runs the accept path (registry lookup → schema validation → epoch resolution → pure match evaluation → one immutable insert) and is the sole writer of the capped open-condition map that makes recovery publishing possible. `waiting` is derived from a single prefix→bucket table extracted inside the existing `src/outage/outage-notices.ts`, which becomes the repository's only reserved-`WorkItem.id`-prefix predicate.

**Tech Stack:** Existing TypeScript strict / Node 22–24, MongoDB driver 7, zod (already a transitive runtime dependency used by every in-process MCP server), `@anthropic-ai/claude-agent-sdk` 0.3.258 hook types, Vitest. No dependency addition.

**Approved input:** [KPR-454 design](kpr-454-design.md), clean at round 10, commit `2a29393f04acbdae1b66ddf0733f930b8b1b557d` on `epic/kpr-451`. Contract: [KPR-458 design](kpr-458-design.md) D2/D3/D4/D5/D9/D10/D11/D12 and C1–C19. Dependency KPR-453 merged at `681ec6751be86542fde9fc5487511ad9371a620e`; its canon (identity plumbing, live references refreshed including absence, retained identity across hooks/ToolBridge/guardrails/delegates, "identity proves neither unique attempt nor task continuity") binds this plan and is not amended by it. KPR-456's canon rule — an engineering child supplies no default recipient, severity, escalation, production registration, prompt rollout or new policy dependency — is satisfied: this ticket registers **zero** subscription rows and ships **no** hive.yaml key.

**Known-stale sibling artifact, not a contradiction to resolve:** `kpr-458-design.md`'s D12 and D6 still read "chartered to no child" at this commit. `kpr-458-plan.md` carries the operator's scoping resolution (matcher–deliverer ⇒ KPR-468, inbound acknowledgement edge ⇒ KPR-455), and KPR-458's own Task 2 appends the addendum recording it. This plan is written against the resolution. Do not "fix" the design body from here.

**Delivery tier (writer's assessment): `capable`.** The diff touches Lane B provider internals, adds an optional field to a frozen provider ABI, registers SDK hooks immediately adjacent to a fail-closed security gate, and moves boot wiring above the spawn-capable boundary — four shapes with non-local failure modes that a standard-tier pass would plausibly get subtly wrong.

## Review chunks and file structure

Each chunk file is under 1,000 lines. Code fences carry complete new-file payloads or exact insertion/replacement blocks. Apply repository formatting (`npm run format`); formatting changes are not design changes.

| Chunk | Plan file | Tasks | Responsibility |
| --- | --- | --- | --- |
| 1 | [Prefix table and `waiting`](kpr-454-plan-1-prefix-table.md) | 1 | Behaviour-preserving refactor of `src/outage/outage-notices.ts` to one prefix→bucket table; `waitingFor`; AC4 |
| 2 | [Contract module](kpr-454-plan-2-contract.md) | 2, 3 | `ops_events` envelope types, reason registry rows + enable gate, `classifyToolError`, id admissibility bound |
| 3 | [Publisher](kpr-454-plan-3-publisher.md) | 4 | Store/indexes, accept path, epoch resolver, open-condition map, bounded queue + drainer, counters, singleton |
| 4 | [Capture points and boot](kpr-454-plan-4-capture-and-boot.md) | 5, 6 | Claude-lane hooks, Lane B `wrap()`, `ProviderTurnAssembly.agentId?` → `ToolBridgeOptions.agentSlug?`, `index.ts` wiring, `boot-order.test.ts`, `CLAUDE.md` |
| 5 | [Acceptance suite and probes](kpr-454-plan-5-acceptance.md) | 7 | AC1–AC16 as named tests; the two `⚠ Verify at implementation` probes |

### Production files to create

- `src/ops/types.ts` — envelope, vocabularies, subscription/reason document shapes, `Waiting`, publish-input types. No I/O, no Mongo import beyond types.
- `src/ops/reasons.ts` — the two code-resident `hive-runtime` rows, `DetailKeySpec`, the D4 enable gate as a pure precondition, and the detail-schema builder that compiles a row's `detailKeys` into a cached zod object.
- `src/ops/error-tokens.ts` — the exported total `classifyToolError` over the closed nine-value set.
- `src/ops/ids.ts` — `isAdmissibleId` (the `^[A-Za-z0-9_.:#+@-]{1,200}$` capture-point bound) and the `subject`/`evidence` bound constants.
- `src/ops/store.ts` — collection handles, `init()` index creation (individually contained), reason upsert + read-back, subscription load.
- `src/ops/match.ts` — the pure, I/O-free D5 conjunction evaluator.
- `src/ops/publisher.ts` — `OpsPublisher`: queue, drainer, accept path, epoch resolver, open-condition map, counters, `getSnapshot()`, `init()`/`stop()`/`reloadSubscriptions()`.
- `src/ops/publisher-singleton.ts` — `setOpsPublisher` / `opsPublisher` / `__resetOpsPublisherForTests`, the `provider-registry.ts` module-global precedent.
- `src/ops/observe.ts` — `observeToolFailure` / `observeToolSuccess`: the synchronous, non-throwing, void capture-point API both lanes call.

### Production files to modify

- `src/outage/outage-notices.ts` — five-arm `startsWith` chain → one `SOURCE_PREFIXES` table, `sourceOfId`, `POLICY_BY_SOURCE`, `WAITING_BY_SOURCE`, `waitingFor`; `policyFor` becomes a wrapper over `policyForId`. Stale `:25` comment corrected onto the `human` row.
- `src/agents/agent-runner.ts` — two hook matchers in `buildHooks`, registered **outside** the archetype `try`/`catch`.
- `src/agents/provider-adapters/tool-bridge.ts` — `ToolBridgeOptions.agentSlug?`; two observe calls inside `wrap()`.
- `src/agents/provider-adapters/turn-assembly.ts` — `ProviderTurnAssembly.agentId?: string`, set by `assembleProviderTurn` and by `buildNestedDelegateAssembly` (parent's slug).
- `src/agents/provider-adapters/turn-scaffold.ts` — forward `assembly.agentId` into `ToolBridgeOptions.agentSlug`.
- `src/index.ts` — publisher construction + `await opsPublisher.init()` + `setOpsPublisher(` **above** the spawn-capable boundary; reload call added to the existing `SIGUSR1` handler body; `await opsPublisher.stop()` in `shutdown` before Slack/Mongo close.
- `src/boot-order.test.ts` — two anchors in all three lists.
- `CLAUDE.md` — three collections in the engine-written list; one Common Gotchas bullet.

### Test files to create

- `src/ops/error-tokens.test.ts`
- `src/ops/ids.test.ts`
- `src/ops/reasons.test.ts`
- `src/ops/match.test.ts`
- `src/ops/testing/fake-db.ts` — in-memory Mongo double (query/sort/limit over the five reads this producer performs) plus a throwing-handle variant for AC5/AC8.
- `src/ops/publisher.integration.test.ts`
- `src/ops/acceptance.integration.test.ts` — AC1–AC16 as named cases.
- `src/ops/capture-points.integration.test.ts` — lane parity, abort discipline, containment negative-verify.
- `src/outage/outage-notices.test.ts` — extended if it exists, created if not (see Task 1 Step 1).
- `src/ops/single-prefix-predicate.test.ts` — AC4's repository-wide scan.

### The three delegated numeric constants

The spec (Assumptions, `⚠ Delegated`) fixes the behaviour on breach and leaves the values here. All three live as named `const`s in `src/ops/publisher.ts`; no hive.yaml key ships for any of them (standing "no preemptive levers" preference), so each is a code change.

| Constant | Value | Reasoning |
| --- | --- | --- |
| `OPEN_CONDITION_MAP_CAP` (D8) | `2000` | The key space is one entry per *distinct failing tool*, i.e. bounded by the installed tool inventory rather than by traffic: a maximal hive runs on the order of 20 MCP servers × ~15 tools plus builtins — low hundreds. 2000 is therefore ~5× the realistic ceiling, so eviction is unreachable in normal operation and the cap functions as a leak bound, not an operating limit. Each entry is `{openSeq, dedupeKey, firstFailureAt}` keyed by a family string ≈ 150 bytes ⇒ ~300 KB at full cap. Breach evicts oldest-first and costs one delayed epoch boundary (D8's cap paragraph), the same bound as the restart residual. |
| `PUBLISH_QUEUE_DEPTH` (D9) | `1000` | A drain is two indexed reads plus one insert against a local `mongod` — single-digit milliseconds. 1000 jobs therefore represents roughly 3–8 seconds of drain, which is the right absorption window for the failure storm this queue exists to survive (a broken MCP server failing across every concurrent turn), while bounding memory to ~1000 × ~300 bytes ≈ 300 KB. Going deeper buys little: everything past the first failure of a family is, by construction, a restatement whose condition is already recorded, so the marginal rows preserved are the least informative ones. Overflow drops **oldest** and increments `queueOverflow` — the newest failures are the ones a responder needs. |
| `SHUTDOWN_DRAIN_MS` (D10) | `2000` | Shutdown already awaits Slack and Mongo; the ops queue must not add a visible stall to a `launchctl kickstart`. At the measured per-job cost, 2 s clears several hundred jobs — more than a healthy queue ever holds — and a queue deeper than that at shutdown means a storm was in progress, where the marginal rows are again restatements. On timeout the remainder is dropped and counted as `drainDropped`. |

One further value is stated *and* delegated by the spec and is adopted as written rather than re-derived: the subscription reload interval, **60 s** (D9). The timer is `unref()`ed at creation and cleared in `stop()`.

### The two `⚠ Verify at implementation` items

Both are executable steps in this plan, not notes. Neither blocks merge; both must be **run** and their outcome recorded in the implementation report.

1. **Which Claude-lane failure classes fire `PostToolUseFailure`** — Task 5, Step 6. Probed through the SDK's **bundled** binary via `query()` from inside the repo (`npx tsx`), never PATH `claude` (CLAUDE.md's gotcha: PATH `claude` is a different binary, and the fleet floats `^0.3.258` so deployed instances resolve higher than this lockfile). A class that does not fire is left **uncaptured**, never inferred from a `PostToolUse` `tool_response` (C12/AC15).
2. **TTL index-conflict error shape after a retention change** — Task 4, Step 7. `createIndex({publishedAt: 1}, {expireAfterSeconds})` against an existing index with a different value must be confirmed to surface as `IndexOptionsConflict` on the deployed driver, and the contained warning text must name the operator remedy (drop the index or `collMod`, then restart).

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `classifyToolError`; `isAdmissibleId`; the reason table and its D4 enable gate; the `detailKeys`→zod compiler; `sourceOfId` / `policyForId` / `policyFor` / `waitingFor`; the D5 match evaluator; `dedupeKey`/`clearsFamily` derivation; the epoch comparison's `(publishedAt, _id)` total order.
  - Reason: every one of these is a pure total function whose *closure* is the correctness property — the classifier must never emit a non-token, the id bound must admit exactly the enumerated population, the enable gate must refuse a development-time defect, and the prefix projections must be exhaustive. None is happy-path CRUD.
  - Minimum assertions: `classifyToolError` is total and its output is drawn only from the nine-value set, including for a credential-shaped and a path-shaped message; no substring of the input appears in the returned token. `isAdmissibleId` admits one case per shape in the design's two id tables — `imessage:<apple-id-email>` and `sms:<line>:+1555…` named explicitly — and rejects the two `sched:`/`scheduler:` shapes carrying a multi-word label, a space-bearing value and an over-length value. The enable gate throws when a `class: resource` row is enabled with no registered clearer. `detailKeys` compilation rejects an undeclared key, a wrong scalar type, a non-scalar and an over-length value. All six `sourceOfId` buckets are pinned; `policyFor`'s pre-refactor output is pinned per prefix; `team-` ⇒ `waiting: "agent"` explicitly. The match evaluator implements exactly the D5 conjunction and no operator, negation, wildcard or nesting.

- Integration: **required**
  - Scope: the publisher assembled over an in-memory Mongo double — accept path end to end, epoch resolution across the two indexed reads, open-condition map lifecycle, queue overflow and drain, `init()` fault postures, subscription reload; plus both capture points driven against a real `AgentRunner` hook set and a real `ToolBridge`.
  - Reason: the criteria that actually matter here are multi-step orderings — `R1 · F · R2` supersession, remove-at-accept versus remove-at-enqueue, index-fault-keeps-publisher-wired versus registry-fault-unsets-it, reject-versus-omit — and none is provable by call-count mocks on a single function.
  - Harness: **setup-required** — add `src/ops/testing/fake-db.ts` in Task 4 following the `src/db/db-identity.integration.test.ts` and `src/obligations/testing/fake-db.ts` conventions. No live Mongo. The double must support `insertOne`, `findOne` with `sort` and a projection-free read, `find().sort().limit().toArray()`, `updateOne` with `$set`/`$setOnInsert`/`upsert`, `createIndex` (including a programmable rejection), and a variant whose every method throws (AC5, AC8).
  - Minimum assertions: AC1–AC16 as enumerated in chunk 5, each as a named test.

- E2E: **not-required**
  - Scope: a live Anthropic session, a deployed instance, a real Slack workspace, a production Mongo.
  - Reason: this child delivers nothing, notifies nobody and registers zero subscriptions, so there is no end-to-end user-visible flow to exercise; the one genuinely external fact — which Claude-lane failure classes fire `PostToolUseFailure` — is a **verification probe** (Task 5 Step 6) whose result changes coverage, not behaviour, and it is run against the SDK's bundled binary rather than a deployed instance.
  - Harness: not-applicable.
  - Minimum assertions: not applicable; no assertion is waived from the integration group.

### Critical Flows

- Claude-lane tool failure → `PostToolUseFailure` → `observeToolFailure` → enqueue → drain → registry lookup → detail validation → epoch resolve → match (zero subscriptions) → one `ops_events` insert with `matchedSubscriptions: 0` → open-condition entry created at a fresh `openSeq`.
- Lane B tool failure through the single `wrap()` catch → the identical accept path → the same `subject.id` as the Claude lane for the same underlying tool, including a name long enough to trigger `applyNameAndCapEdges` truncation.
- Failure → success → failure: exactly one `tool-recovered` in between (carrying `clears`, `clearsFamily`, `waiting: "nobody"`, `generation: 0`), and the third failure at `generation` 1.
- Repeated identical failure: `generation` unchanged, a second event appended, the open-condition entry untouched.
- `R1 · F · R2` interleaving: `R2` dropped as `recoverySuperseded`, no clearing fact naming the dead `dedupeKey`, the live entry surviving, the next success still enqueuing.
- Burst of N successes before one recovery drains: exactly one `tool-recovered`, N−1 `recoveryCoalesced`.
- Own-abort mid-tool on either lane: nothing published. Foreign interrupt: `errorSig: "interrupted"`. Guardrail deny: nothing published.
- Untrusted `workItemId`/`threadId` failing the admissibility bound: event published with the key **omitted**, `evidence: []`, `idOmitted` incremented, rejection counter unchanged.
- Publisher throwing on every call, and publisher whose Mongo write always rejects: a Claude-lane turn and a Lane B turn produce byte-identical `RunResult`s to an unwired run.
- Boot: `init()` whose every `createIndex` rejects still yields a wired publisher; `init()` whose registry upsert rejects yields an unset publisher and a booted engine.
- Shutdown: queue drained (bounded) before Slack and Mongo close; reload timer cleared first.

### Regression Surface

- The live honest-outage path — `dispatcher.ts:872` and `:1103` call `policyFor`; its behaviour, signature, return type and every caller must be unchanged (Task 1 pins this per prefix before touching the file).
- `AgentRunner.buildHooks` — the `PreCompact` matcher and the archetype fail-closed deny-all `PreToolUse` arm; a thrown archetype build must still install the deny-all matcher **and** leave both observers registered.
- `ToolBridge.wrap()`'s structural no-throw promise, its four text shapes (`Tool call denied by policy:`, `Tool execution aborted (…)`, `Tool execution failed (…):`, the success passthrough), and `record()`'s existing counters.
- `ProviderTurnAssembly`'s frozen ABI at `LANE_B_PROVIDER_ABI_VERSION = 1` — additive optional only, no version bump; the `pkg/types/` d.ts closure and `scripts/check-bundle-strings.mjs` must still pass.
- `src/boot-order.test.ts`'s existing four order-pinned anchors and the KPR-456 readiness/drain group.
- `src/index.ts` shutdown ordering (`obligations.stop()` first, Slack and Mongo last).
- Worker/scribe containment: `WORKER_SERVER_DENYLIST` and the three `suppressAutoInjectedServers` gates are **untouched** — no MCP server is added by this ticket.
- `agent_events`, `EVENT_SCHEMAS`, `Scheduler.checkEvents`, `activity_log`, the `subscribe:` agent-definition field, delivery routing and KPR-456's obligation path: all unchanged and asserted so.

### Commands

Run from the child implementation worktree on Node 22 or 24 (CLAUDE.md: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher). A missing install is setup, not a skipped test.

- Setup: `node --version` (expect v22.x or v24.x); `npm ci`
- Unit: `npx vitest run src/ops/error-tokens.test.ts src/ops/ids.test.ts src/ops/reasons.test.ts src/ops/match.test.ts src/outage/outage-notices.test.ts`
- Integration: `npx vitest run src/ops/publisher.integration.test.ts src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts src/ops/single-prefix-predicate.test.ts`
- Boot/provider/containment regression: `npx vitest run src/boot-order.test.ts src/agents/agent-runner.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/turn-scaffold.test.ts src/workers/meeting-worker-pool.test.ts`
- Adjacent regression: `npx vitest run src/channels/dispatcher.test.ts src/outage src/agents/agent-manager.test.ts`
- Bundle guards (the ABI field touches the shipped d.ts closure): `npm run check:bundle`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Hygiene: `git diff --check`
- Expected results: exit 0, all selected Vitest tests pass, no skipped new contract cases, no TypeScript/ESLint/Prettier errors. Record actual totals; do not invent expected test counts.

### Harness Requirements

- `src/ops/testing/fake-db.ts` — the in-memory Mongo double described under Integration above, plus (a) a `createIndex` that can be programmed to reject per call, (b) an `insertOne` that can be programmed to reject, and (c) a fully-throwing variant used to prove the match evaluator performs no I/O (AC5) and that a dead database cannot alter a turn (AC8).
- No live MongoDB, no Slack token, no Anthropic API key for any test in this plan. `npm run check` needs the three Slack env stubs above (`reference_npm_check_env_stubs`).
- The `PostToolUseFailure` probe (Task 5 Step 6) needs a working Anthropic **subscription** session — the repo's normal dev auth. It is a manual verification step, not a Vitest case, and it must not be added to CI.

### Non-Required Rationale

- E2E: stated above — no deliverable reaches a human in this child by design, so an end-to-end assertion would have nothing to observe beyond what the integration group already pins at the real module boundaries.

### Verification Rules

- Missing harness is not a skip reason; set it up (Task 4 Step 1) or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane rather than reinterpreting the spec here.
- Negative-verify is required where the plan says so (AC4's pre-refactor pins, AC8's throwing publisher, AC9's `R1 · F · R2`): revert the source change, confirm the test fails, restore.

---

## Task and commit map

Seven tasks, seven commits. Chunked into five files because the ticket spans four distinct production surfaces (a shared-code refactor, a new module, two provider lanes, boot) plus a sixteen-criterion acceptance suite, and a single file would exceed the 1,000-line review chunk.

| Task | Chunk | Commit subject |
| --- | --- | --- |
| 1 | 1 | `refactor(KPR-454): one reserved-prefix table in outage-notices; add waitingFor` |
| 2 | 2 | `feat(KPR-454): ops event contract types, reason registry, error tokens, id bound` |
| 3 | 2 | `test(KPR-454): unit coverage for the contract module` |
| 4 | 3 | `feat(KPR-454): ops publisher — accept path, epoch resolver, queue, open-condition map` |
| 5 | 4 | `feat(KPR-454): capture points on both lanes; agentId through the Lane B assembly` |
| 6 | 4 | `feat(KPR-454): wire the ops publisher above the spawn-capable boundary` |
| 7 | 5 | `test(KPR-454): AC1–AC16 acceptance suite` |

Tasks are strictly ordered: Task 1 is independent and lands first (it is the only edit to shared production code, and pinning `policyFor` before touching it is the whole safety argument); Tasks 2–4 build the module bottom-up; Task 5 attaches it to the lanes; Task 6 wires boot; Task 7 pins the criteria. Do not reorder 5 before 4 — a capture point calling an unwritten publisher cannot be verified.

## Assumptions carried into implementation

Each is one line; all are non-blocking and all are the spec's own, restated here so the implementer does not have to re-derive them.

- `subject.kind` is `"tool"` and `subject.id` the canonical pre-sanitization tool name; the `<tool>#<token>` alternative stays a one-line change.
- `ops_reasons` is a fourth collection; the boot upsert never overwrites operator-set `enabled`, which is this ticket's entire kill switch.
- `tool-failed` is `retry: transient`; a deterministic class would be a second `reasonId`, not a per-event assertion.
- `ProviderTurnAssembly.agentId?` is additive-optional on a frozen ABI (the `datetimeInTurnInput?` / `memoryInTurnInput?` precedent) and needs no version bump.
- Untrusted `workItemId`/`threadId`/`evidence[].id` are bounded at the capture point and **omitted**, never rejected; the rejection counter stays the mis-integrated-producer signal.
- `agentId` is not in `tool-recovered`'s `detailKeys`, and the recovery's `waiting` is the fixed value `"nobody"`.
- The open-condition map is drainer-owned, mutated only at accept time, and each entry carries an `openSeq` identity; a superseded recovery is dropped, not re-targeted.
- `init()` is non-fatal to boot with a split posture: index faults keep the publisher wired, a registry-upsert fault leaves it unset.
- The `system:task_blocked` widening from the ticket body is dropped; `agent_events` is untouched.
- zod is used as a transitive runtime dependency, exactly as every existing in-process MCP server in `src/` already does; no `package.json` change.
