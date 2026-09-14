# KPR-501 — Agent-facing block producer implementation plan

> **For agentic workers:** Execute this plan through the epic implementation lane (`dodi-dev:implement-ticket`). This single file is the whole plan; no chunk split is needed. Tasks are sequential — see [Task order and commits](#task-order-and-commits).

**Goal:** Give every agent whose `coreServers` lists `event-bus` two tools, `report_block` and `clear_block`, that publish the `hive-agent` producer's `coordination-block` / `semantic-block` conditions and their `block-cleared` clearing fact into `ops_events` through the shipped `OpsPublisher` accept path and its single serial drainer — recorded, never delivered, never spawning a turn, never publishing about itself.

**Implementation approach:** Carry [KPR-501 design](kpr-501-design.md) forward without amendment. Six code surfaces, in dependency order:

1. A repository guard (`src/ops/single-events-writer.test.ts`) proving `ops_events` has exactly one writer — authored first so it is green on the unmodified baseline (AC8's "green before the producer lands") and then guards every later task's diff.
2. A self-contained `hive-agent` reason table (`src/ops/block-reasons.ts`) plus a table list in `src/ops/reasons.ts` that the `OpsPublisher` constructor asserts and `init()` upserts in order (D3, D12).
3. Four minimal additive members on `OpsPublisher` — an accept-only `enqueuePublish` job kind, a bounded `flush(deadlineMs)`, a log-resolved `findOpenCondition(components)` that shares one private two-read helper with `resolveGeneration`, and `isReasonEnabled(producer, reasonId)` (D1, D7, D8). Nothing else in `publisher.ts` changes; KPR-507's reload ordering is not touched.
4. The pure layer of `src/ops/block-producer.ts` — declared shapes (types and optionality only), handler-side value rules with the seven `reason` codes, `RULING_REF_RE`, subject/detail/evidence/`waiting` composition, module-global counters (D4, D5, D6, D9).
5. The two tool handlers (`buildBlockTools(deps)`) appended to `buildEventBusTools(deps)`'s array, with every handler answer non-`isError` (D2, D7, D9, D10, D11, D13).
6. Lane, containment and `isError`-boundary proofs through the real runner build, a real `ToolBridge` over the connected in-process server, the real Claude-lane hook bodies, and the SDK server's own request handler (D2, D6, D9) — then `CLAUDE.md` (AC13) and the final gate.

**Dependency order:** Task 1 (guard) → Task 2 (reason table) → Task 3 (publisher additions) → Task 4 (pure block-producer layer) → Task 5 (tool handlers + `event-bus` spread + handler-level integration) → Task 6 (surface, containment, Lane B execution) → Task 7 (`isError` boundary on both lanes, MCP-layer residual, C15 lane limbs) → Task 8 (documentation + final gate). No external ticket dependency: KPR-454, KPR-458, KPR-468 and KPR-507 are merged on `epic/kpr-451` (KPR-507 at `2b33b83a`; `a9936299` adds only this ticket's spec). KPR-455 consumes D12's exported constants after this merges and is not touched here.

**Tech Stack:** TypeScript strict, Node 22/24, Vitest, zod 4 (already a dependency), `@anthropic-ai/claude-agent-sdk` `tool()` / `createSdkMcpServer`, `@modelcontextprotocol/sdk` `Client` + `InMemoryTransport` (already used by `tool-bridge.ts`), the existing in-memory Mongo double `src/ops/testing/fake-db.ts` and lane harness `src/ops/testing/lane-harness.ts`. No dependency addition, no new collection, index, TTL, `hive.yaml` key, boot anchor, loader, timer or harness module.

**Approved input:** [KPR-501 design](kpr-501-design.md), spec sha256 `01025583e30db205ab0eb9decc027c15dd05e6b73eb995507165e423526e9ea5` (verified unchanged at plan time), approved at spec-review round 4 (Frontier fable xhigh) under Gate 1 delegated signoff (`epic-signed-off`, KPR-451#comment-95cc0708). Planner routing: **Capable** tier — "boundaries and interfaces are settled, but decomposition must preserve two cross-component invariants while touching shipped KPR-454 code: factoring `resolveGeneration`'s two-read comparison into a helper shared with `findOpenCondition` without altering epoch behaviour or the `(publishedAt, _id)` order KPR-468's cursor consumes, and an accept-only job kind that must not touch the open-condition map; test sequencing constraints (one `connect()` per `McpServer` across AC1/AC5/AC9, fault arming before call / assert after drain, fresh fixtures where a limb opens a `hive-runtime` condition)." Those three sequencing constraints are restated as invariants in Tasks 3, 5, 6 and 7 and in the Testing Contract's Harness Requirements.

**Round-4 spec-review advisories carried into this plan** (not applicable to the spec without invalidating its approval; each is binding here):

| # | Advisory | Where honoured |
| --- | --- | --- |
| A1 | AC9's "stores no `ops_events` document at all" presupposes no open `hive-runtime` condition on that tool at call time (D2 row 1), and AC9's last limb deliberately opens one on `report_block`. Fresh fixtures per case, or assert "no `tool-failed`", so limbs cannot collide. | Task 7 invariants; Harness Requirements |
| A2 | AC11's "`RunResult` classification unchanged" is verified at the KPR-454 capture-point fidelity — `runner.wasAborted` / `signal.aborted` untouched and the call resolving without a thrown or containment-prefixed failure — not a full `send()` diff. | Task 7 invariants; Testing Contract fidelity note |
| A3 | AC11 limb (iii) arms `failNext` (not `failAll`) on `ops_events` `insertOne`, otherwise "no `hive-runtime` document" is vacuous (a `failAll` would also swallow any `tool-failed` insert). | Tasks 5 and 7; Harness Requirements |
| A4 | Edge 21 (`workItemContext.current === undefined`, KPR-453 refreshed-as-absence) joins the integration minimum set. | Testing Contract; Task 5 |
| A5 | The `block-producer.ts` module comment names the deliberate departure from the sibling `emit_event` catch (which returns `isError: true`, KPR-122 convention) and its KPR-458 D10(a) reason, so a later "normalize the catches" pass trips NV8(b) knowingly. | Task 5 |
| A6 | D2 row 1: a `tool-recovered` minted after a non-`isError` block-tool answer on a tool that already holds an open fault condition is caused by the same control-flow event as any successful answer (the fault is not its cause), and C12 forbids the only result-text sniff that could suppress it. Implementers must not suppress it. | Tasks 5 and 7 invariants |

**Epic Decision Register canon carried forward (KPR-451, read at plan time):** KPR-458 — no owner/severity/recipient on the record; `class`/`retry` registry-declared, only `waiting` per publish; unknown/disabled reason or over-bound value rejects and counts; the ops path never publishes about itself; no delivery spawns a turn; `agent_events` not reused. KPR-454 — `ops_reasons` upserted clearing-first with `enabled` `$setOnInsert`-only, restart is the reload lever; ids bounded at the capture point and omitted, never rejected; `waiting` from `waitingFor(id?)` over the unfiltered id; single drainer behind the module-global singleton; `clears` names the publishing producer's own family; KPR-501 publishes under KPR-458's contract as a second producer, never a fork. KPR-453 — live runner-owned references read at execution, refreshed including absence; identity proves neither unique attempt nor task continuity. KPR-468 — future producers, including KPR-501, preserve the shared publish/drain ordering the cursor consumes. KPR-507 — KPR-501 publishes through this `OpsPublisher` accept path and adds no second loader. KPR-456 — no default recipient, severity, escalation, production registration or prompt rollout. KPR-452 — nothing here routes through `postAuditLog` (this child emits nothing into Slack).

**Execution boundary:** This plan drafts artifacts only. It does not implement, push, edit PM state, deploy, or start a service. Drafting makes no runtime success claim.

---

## Files to create

- `src/ops/single-events-writer.test.ts` — the D8 single-writer repository guard (Task 1).
- `src/ops/block-reasons.ts` — `HIVE_AGENT_PRODUCER`, the three reason-id constants, `BLOCK_SUBJECT_KIND`, `BLOCK_EVIDENCE_KIND_WORK_ITEM`, `BLOCK_EVIDENCE_KIND_RULING`, and `HIVE_AGENT_REASONS` in D3 order. Imports only `types.ts` / `ids.ts` (the `reasons.ts` layering). Falls inside the `src/ops/**` source scans, so its source and comments obey the [source-scan constraint](#source-scan-constraint-on-srcops-modules) (Task 2).
- `src/ops/block-reasons.test.ts` — AC12 unit cases (Task 2).
- `src/ops/block-producer.ts` — pure layer (Task 4) and `buildBlockTools(deps)` handlers (Task 5). Falls inside the `src/ops/**` source scans, so its source and comments — the A5 module header and every D10 cross-reference included — obey the [source-scan constraint](#source-scan-constraint-on-srcops-modules).
- `src/ops/block-producer.test.ts` — unit group (Task 4).
- `src/ops/block-producer.integration.test.ts` — integration group: publisher-additions describe (Task 3), handler-level describes (Task 5), surface/containment describe (Task 6), `isError`-boundary describe (Task 7).

## Files to modify

- `src/ops/reasons.ts` — `OPS_REASON_TABLES` table list (Task 2).
- `src/ops/publisher.ts` — constructor and `init()` iterate the table list (Task 2); the third job kind, `enqueuePublish`, `flush`, `findOpenCondition`, `isReasonEnabled`, and one private helper shared by `resolveGeneration` and `findOpenCondition` (Task 3).
- `src/ops/publisher.integration.test.ts` — only the existing boot/registry case that pins the `ops_reasons` row id set and upsert call order to the two `hive-runtime` rows (Task 2; reason stated there).
- `src/ops/acceptance.integration.test.ts` — only the existing AC16 case "producer and reasonId are validated by the D2 pattern bound, never against a hardcoded list": its `toContain("HIVE_RUNTIME_REASONS")` on `publisher.ts` becomes the table-list identifier, plus a `HIVE_AGENT_PRODUCER` not-contain limb (Task 2; reason stated there).
- `src/ops/reasons.test.ts` — table-list assertions (Task 2), additive only.
- `src/events/event-bus-mcp-server.ts` — one spread of `buildBlockTools(deps)` into `buildEventBusTools`'s returned array (Task 5). `createEventBusMcpServer` byte-unchanged; `emit_event` byte-unchanged.
- `src/ops/testing/lane-harness.ts` — additive, default-preserving option passthrough only, if Task 6 needs it (a `db` and runner-options passthrough on `buildClaudeLaneHarness`; a by-name lookup over `bridge.connect()`'s tools). No new harness module.
- `CLAUDE.md` — AC13 (Task 8).

## Files deliberately not touched

`src/index.ts`, `src/boot-order.test.ts` (AC14); `src/agents/agent-runner.ts`, `src/agents/in-process-servers.ts`, `src/agents/server-traits.ts`, `src/agents/provider-adapters/tool-bridge.ts`, `tool-transport.ts`, `src/workers/meeting-worker-pool.ts` (every KPR-390 obligation and the worker denylist are inherited — D2, D14; `TURN_CONTEXT_DEPENDENT_SERVERS` stays without `event-bus` deliberately, on the `contacts` precedent); `src/events/event-types.ts`, `src/scheduler/scheduler.ts`, the `subscribe` field (D10); `src/ops/store.ts`, `match.ts`, `observe.ts`, `ids.ts`, `types.ts`, `ingest.ts`, `notifier*.ts`, `delivery.ts`, `intake.ts`; `src/outage/outage-notices.ts`; `src/ops/testing/fake-db.ts` and `notifier-harness.ts` (unless a harness gap is found — see Harness Requirements); agent prompts, constitution, seeds, `docs/providers.md`; any KPR-455 file; `kpr-501-design.md` and every signed sibling design body.

### Source-scan constraint on `src/ops/**` modules

Existing suites read repository files **as text, comments included**, and several reach files this plan creates or edits — production modules, the new test files, and `CLAUDE.md`. The inventory below was re-derived at plan-review round 2 by searching every `*.test.ts` under `src/` for `readFileSync`, `readdirSync`, `globSync`, `readFile(` and subprocess calls, plus the bundle scripts, and reading each hit's scope. A scan tripped by this plan's text is fixed in the text; it is never fixed by editing the scan (no existing test is edited beyond Task 2's two documented adjustments).

**Scans reaching this plan's production modules** (`block-reasons.ts`, `block-producer.ts`, and the edits to `reasons.ts` and `publisher.ts`):

- `src/ops/acceptance.integration.test.ts` `opsSources` — `globSync("src/ops/**/*.ts")` excluding `*.test.ts` and `src/ops/testing/`; every such file contains none of:
  - `runWorkItemTurn`, `spawnTurn`, `agent-manager`, `dispatcher` — "no code path in this diff spawns a turn";
  - `costUsd`, `tool_response`, and no `durationMs` beside a relational operator or in an equality against a numeric literal (the case's `RELATIONAL` / `NUMERIC_EQUALITY` regexes) — "no code path in this diff reads costUsd, a duration threshold, or a tool_response";
  - `activity_log` — "activity_log is neither read nor written here";
  - `agent_events`, `EVENT_SCHEMAS`, `checkEvents`, `delivery_obligations` — the regression-surface describe "no adjacent substrate is read or written".
  Its able-to-fail pins also require some file to still contain `class OpsPublisher`.
- `src/ops/acceptance.integration.test.ts` `kpr454ProducerSources` — a **fixed** list of nine files (`error-tokens.ts`, `ids.ts`, `match.ts`, `observe.ts`, `publisher-singleton.ts`, `publisher.ts`, `reasons.ts`, `store.ts`, `types.ts`), each asserted `not.toContain("ops_notifications")` in AC2 "writes no ledger row and creates no catch-all subscription on any code path", comments included, with no file named in the failure message. This plan edits two of the nine (`reasons.ts`, `publisher.ts`), and Task 3's prose motivates the shared helper by KPR-468's cursor, whose ledger is that collection. The scan's header calls itself advisory and explains its fixed list; that is not licence to drop a file from the list. The new block modules are not in the list but follow the same rule.
- `src/ops/acceptance.integration.test.ts` AC16 "producer and reasonId are validated by the D2 pattern bound, never against a hardcoded list" — `publisher.ts`, `ids.ts`, `match.ts` contain no producer literal value (`hive-runtime`, and after Task 2 `hive-agent`); `publisher.ts` contains the table-list identifier (Task 2).
- `src/ops/acceptance.integration.test.ts` AC13 "src/ops/publisher.ts exposes no .start(-spelled method" — `publisher.ts` still contains `.start(` (the existing `init()` doc comment) and has no line whose first token, after an optional access modifier and `async`, is `start(`.
- `src/ops/single-prefix-predicate.test.ts` — every non-test `.ts` under `src/`, `scripts/`, `build/`, `setup/`, **no comment stripping**, for three spellings over the five reserved literals `sched:`, `callback:`, `event:`, `team-`, `worker:`: `.startsWith("<literal>`, an anchored regex literal `/^<literal>`, and `.slice(…) === "<literal>`. The pre-allowlist hit set is pinned exactly, so a hit in a block module — a comment quoting an anchored pattern included — fails.
- `src/ops/single-events-writer.test.ts` (this plan's Task 1) — outside `types.ts`/`store.ts` no code line names `OPS_EVENTS_COLLECTION`; the quote-closed literal `"ops_events"` only in `types.ts`; `store.events.insertOne(` only in `publisher.ts`. Comment lines are stripped; code lines, string literals included, are not.

**Scans reaching this plan's test files:**

- `src/ops/notifier-isolation.test.ts` "imports nothing from src/obligations/" — `sources(here)` walks every `.ts` under `src/ops/` recursively, **test files included**; only paths containing `/testing/` are skipped. Regex `from\s+"[^"]*obligations\/` over the whole text. `block-producer.test.ts`, `block-producer.integration.test.ts`, `block-reasons.test.ts` and `single-events-writer.test.ts` are in scope as well as the production modules. `src/ops/testing/fake-db.ts`'s own header and `pause` comment point at `src/obligations/testing/fake-db.ts` as its origin; import the ops double, never the obligations one.
- `src/no-deprecated-models.test.ts` — walks `src/` (tests included), `setup/`, `seeds/`, `install/`, `service/`, `templates/` and `docs/` (including `docs/epics/`, so this plan) for its `DEPRECATED` regex (Opus 4 ids below 4-7, Sonnet 4 ids below 4-6, Haiku 4 ids below 4-5, and any Haiku 3 id). A fixture needing a model uses `makeHarnessAgentConfig`'s default or a current id. This plan names that regex only in prose for the same reason: spelling out its Haiku 3 alternative verbatim would make this file an offender.

**Scans reading `CLAUDE.md` (Task 8):**

- `src/ops/publisher.integration.test.ts` KPR-507 AC8 "does not claim the notifier fix repaired the publisher…" — `not.toMatch(/notifier.{0,80}repair(?:ed|s)?.{0,80}publisher/is)` over the **whole file** (case-insensitive, dot-all, so across line breaks); and the Ops notifier bullet, sliced from `Ops notifier — the acknowledgement ledger` to the next `\n- **`, must not contain `ordered by start`. Its sibling case reads 600 characters after the KPR-454 bullet's `the subscription set, by contrast, reloads every 60 s and on SIGUSR1` anchor; that bullet is not rewritten.
- `src/ops/acceptance.integration.test.ts` AC14 (documentation) — `CLAUDE.md` contains `ops_events`, `ops_subscriptions`, `ops_reasons`, `producer:subjectKind:subjectId:reasonId:generation`, `must be single-field` and `$setOnInsert`.
- `src/ops/notifier-acceptance.integration.test.ts` AC17 — `CLAUDE.md` contains `ops_notifications`, `ops_policy`, `ops_notifier_stats`, `ops_sweep_cursor`, `KPR-455`, `ops_subscriptions.enabled: false` and `/attempted[^.]*once per occurrence/i`; the slice from the **first** `ops_sweep_cursor` to the end of file matches `DURABLE SWEEP PROGRESS, NOT A HEARTBEAT` and `never notified`. The first occurrence is in the MongoDB collections bullet today.

**Outside the test suite:** `scripts/check-bundle-strings.mjs` (`npm run check:bundle`) scans `pkg/*.min.js` and `pkg/types/**/*.d.ts` case-insensitively for `dodi`, `hubspot`, `cabinet`. Tool descriptions, reason text and string literals survive minification, so none may carry those words.

**Verified not to reach any file this plan creates or edits:** `notifier-isolation.test.ts`'s `NOTIFIER_FILES` scans (match import, `activity_log`/`costUsd`/`agent_events`/`EVENT_SCHEMAS`/`checkEvents`, channel/sweeper/outage imports, `subscribe:`) and its turn-path import scan (`agent-runner.ts`, `tool-bridge.ts`, `dispatcher.ts`, `agent-manager.ts`); `notifier-acceptance.integration.test.ts`'s `updateMany` and state-literal scans over the notifier files; `acceptance.integration.test.ts`'s `match.ts` import scan, `observe.ts` forbidden-word scan, `single-prefix-predicate.test.ts` presence read, `index.ts` order read, `agent-runner.ts` hook-placement read and the two capture-point hunks; `capture-points.integration.test.ts` (`agent-runner.ts`); `delivery.integration.test.ts` and `boot-order.test.ts` (`index.ts`); `dispatcher-conference.test.ts` (`dispatcher.ts`); `doctor.test.ts` (`doctor.ts`). Every other `readFileSync`/subprocess user reads temp fixtures or mocks `node:fs`. No test reads `src/events/event-bus-mcp-server.ts` as text.

**Permitted phrasings.** The plan's own invariant prose uses several forbidden literals to name what the tools must not touch; the files must say the same thing without them.
- Production modules: `system:task_blocked`, `emit_event`, `send_message` (team) and the path `src/events/event-bus-mcp-server.ts` as written; "the event bus's event collection" for the forbidden collection name; "the event schema registry"; "the scheduler's event-delivery loop"; "the delivery-obligation ledger"; "no turn is spawned" / "the turn path" / "the dispatch path" for the spawn and routing names. A substring match is enough to fail, so "dispatcher" is forbidden even inside a longer word, while "dispatch" is not.
- `reasons.ts`, `publisher.ts` and the block modules: "the notifier's acknowledgement ledger" or "KPR-468's ledger" for the forbidden collection name. The scan is case-sensitive, so the existing constant identifier would not trip it, but these modules have no reason to import it.
- Reserved prefixes, in production modules: name them in prose or as a bare quoted string (for example "a `team-` id"), never as a `startsWith` argument, an anchored regex literal or a sliced-prefix equality, in code or comment. Classification goes through `waitingFor` only.
- Test files: `obligations` may appear in prose; never in a `from "…"` import clause, in code or comment.
- `CLAUDE.md` (Task 8): use no form of "repair" anywhere in the new bullet. The scan's regex is ordered and dot-all (`notifier`, then within 80 characters a form of `repair`, then within 80 more `publisher`), and the preceding KPR-468 bullet already ends with "repair or remove the offending `ops_events` document", so a window-based rule is not safe. Edge 13's residual ("a renewal repairs it" beside "the publisher's counters") is the live risk; write "a later report restores it" and do not name the notifier in that sentence. The new bullet begins with `- **` directly after the KPR-468 bullet so it ends that bullet's slice, and neither says "ordered by start" nor names `ops_sweep_cursor`.

---

## Testing Contract

Derived from the design's Testing Contract; groups, commands and harness are fixed there, chunking is this plan's.

### Required Test Groups

- Unit: **required**
  - Scope: the pure functions of `src/ops/block-producer.ts` — parameter → `OpsPublishInput` composition for both tools, the handler-side value matrix (every D6 `reason` code, including the empty-string totality rule), subject composition and fallback, `detail` and `evidence` composition, the semantic-ruling refusal, the `RULING_REF_RE` admit/refuse matrix, the declared-shape key-set/type/optionality assertion — and `src/ops/block-reasons.ts` (`assertReasonTableLegal` over the shipped table, order pin, template-key audit, token-bound literals); `waitingFor` mapping observed through the composed input's `waiting`.
  - Reason: subject/fallback/evidence rules are the identity of the condition; a wrong composition is a wrong condition for every consumer and is cheapest to pin without I/O.
  - Harness: none beyond vitest; no `FakeDb`.
  - Minimum assertions: AC3 (composition limbs: `"<slug>:<thread>"`, fallback on a `scheduler:… multi word …` thread and on a composed id > 200, slug not display name), AC4 (six `waiting` mappings on composed inputs: Slack ts ⇒ `human-now`, `team-…` ⇒ `agent`, `sched:`/`callback:`/`event:`/`worker:` ⇒ `nobody`, absent ⇒ `nobody`; clear ⇒ `nobody` regardless), AC5 (declared key sets and per-key type/optionality with no enum/regex/`.strict()`/refinement; `agent-work`, `work-item`, `ruling` satisfy `OPS_TOKEN_RE`; the `RULING_REF_RE` matrix), AC6's refusal limb (semantic clear without `rulingRef`, and with `rulingRef: ""`, ⇒ `ruling-required`), AC12.

- Integration: **required**
  - Scope: the tool handlers driven against a real `OpsPublisher` over `FakeDb` (`buildOpsFixture`), through `drain()`, asserting stored documents and counters; the four `OpsPublisher` additions; KPR-468's real `clearingProvenanceOk` over stored clears; the simulated-restart clear; the ordering and single-writer guard; containment on built server sets through real `AgentRunner`s; a Lane B execution through a real `ToolBridge` on its in-process `connect()` path; the `isError` boundary through the real Claude-lane hook bodies and the real bridge; the MCP-layer residual through the SDK server's own request handler; the kill switch and boot-window cases.
  - Reason: every load-bearing property — accept-path agreement with the handler rules, `clears` naming the exact key, epoch advance, FIFO ordering, no open-map pollution, containment, non-`isError` answers minting no `hive-runtime:tool-failed` — lives at the publisher/runner/bridge boundary and cannot be seen by a unit test.
  - Harness: **existing**, extended additively only — `src/ops/testing/lane-harness.ts` (`buildOpsFixture`, `buildClaudeLaneHarness`, `buildLaneBHarness`, `makeHarnessAgentConfig` with `coreServers: ["event-bus"]`), `src/ops/testing/fake-db.ts` (`failNext`/`failAll`, `pause`, `operations`), tool descriptors' handlers invoked directly for value-matrix and composition limbs, and the runner's built `event-bus` instance for lane cases. New file `src/ops/block-producer.integration.test.ts`; guard `src/ops/single-events-writer.test.ts`. No new harness module; `notifier-harness.ts` is not imported (`clearingProvenanceOk` is imported from `src/ops/ingest.ts` with a minimal `OpsNotification`-shaped row).
  - Minimum assertions: AC1, AC2, AC5 (handler matrix and MCP-layer-residual limbs), AC6, AC7, AC8, AC9 (both lanes; every handler answer on the non-`isError` side, the MCP-layer residual on the other), AC10, AC11 (all three limbs, both lanes), AC15, and every Edge case numbered **1–14, 17–21 and 24** as a named test (Edge 21 added per advisory A4). Edges 15, 16, 22 and 23 are covered by the assertions of other named tests (15 by AC4's `human-now` + `matchedSubscriptions: 0`; 16 by AC3's scheduler fallback plus Edge 17's override; 22 and 23 are named benign races with no wrong stored fact) and need no separate test; an implementer may add them.

- E2E: **not-required**
  - Scope: a deployed hive, a real agent calling the tool, a live Mongo, a live notifier subscription.
  - Reason: zero subscriptions ship, so the only deployed observable is the stored document, which integration asserts field by field; the lane harnesses already drive real runner hooks and a real `ToolBridge`.
  - Harness: not-applicable.
  - Minimum assertions: none; nothing is waived from the integration group.

**Fidelity statement (advisories A2 and the AC9 wording).** On the Claude lane the harness has no SDK: the **test** routes a handler result whose `isError` is absent through `fireSuccess` and one whose `isError` is `true` through `fireFailure`; the routing itself is the SDK's, measured by `scripts/probe-posttooluse-failure.ts` class 2, and the Claude-lane test names say so. On Lane B the SDK server and `discover()` decide the routing through a connected in-process bridge. "`RunResult` classification unchanged" (AC11) is verified at that capture-point fidelity: the harness runner's `wasAborted` stays `false`, the Lane B `AbortController` signal stays un-aborted, the hook resolves, and the bridged `execute` resolves with the handler's JSON text rather than a thrown error or the `Tool execution failed (…)` containment prefix. No full `send()` diff is taken.

### Critical Flows

- `report_block(coordination, agent, jasper)` on a Slack-ts turn → drain → one `coordination-block` document, `waiting: human-now`, `subject { kind: "agent-work", id: "<slug>:<thread>" }`, `evidence [work-item]`, `matchedSubscriptions: 0`.
- Same again → renewal, same `dedupeKey`, `generation` unchanged.
- `clear_block(coordination, resumed)` on a later turn of the same thread (different work item) → `block-cleared` with `clears` = that key, `clearsFamily` = its family, `generation: 0`, `waiting: nobody`; `clearingProvenanceOk(resourceRow, clear) === true`.
- `report_block(semantic)` on a Slack-ts turn → `clear_block(semantic, resumed)` without ref → `refused` (`ruling-required`), zero `ops_events` reads, nothing stored; with `rulingRef` → a clear whose evidence carries `ruling` (+ `work-item`); `clearingProvenanceOk(judgmentRow, storedClear) === true`, and `false` for the same document with `evidence: []`.
- report → clear → report → `generation` 1, new `dedupeKey`.
- New `OpsPublisher` instance over the same fake database → `clear_block` still finds and clears.
- Worker-mode runner → no block tools on the built server set or inventory; Lane B runner → tools bridged and executing through `connect()`.
- Reason disabled → `disabled` (non-`isError`), nothing stored; a block opened before the disable → `clear_block` still stores its clear; singleton unset → `unavailable` (`publisher-unset`, non-`isError`).
- `refused` / `disabled` / `no-open-block` / `queued` / a `findOpenCondition` read fault through the real Claude-lane hooks and the real Lane B bridge → every answer non-`isError`, no `hive-runtime` document naming the tool; the read fault additionally `faults` +1 and one warn. The MCP-layer residual (`kind: 42`) through the Lane B bridge → exactly one `hive-runtime:tool-failed`, then a following `queued` stores one `tool-recovered`.
- `insertOne` rejecting once under each tool → each answers `queued`; after drain `publishFaults` +1 per call, nothing stored, no `hive-runtime` document.
- Block job between two tool-failure jobs → stored in FIFO `(publishedAt, _id)` order; `openConditions` unchanged.

### Regression Surface

- `src/ops/publisher.integration.test.ts`, `acceptance.integration.test.ts`, `capture-points.integration.test.ts`, `match.test.ts`, `reasons.test.ts` — accept path, epoch resolver behaviour (including its map fallback and `epochResolveFaults`), KPR-507 reload ordering and the `hive-runtime` rows unchanged. Known exact-set assertion to adjust: the boot/registry case in `publisher.integration.test.ts` pins `ops_reasons` ids to the two `hive-runtime` rows and the `updateOne` upsert order to `[tool-recovered, tool-failed]` — it becomes five ids with order `[tool-recovered, tool-failed, block-cleared, coordination-block, semantic-block]` (Task 2). Second known assertion to adjust: `acceptance.integration.test.ts`'s AC16 case asserts `publisher.ts` `toContain("HIVE_RUNTIME_REASONS")`, and `publisher.ts` names that identifier only at the import and the two call sites Task 2 rewrites — it becomes `toContain("OPS_REASON_TABLES")` and gains a `HIVE_AGENT_PRODUCER` not-contain limb over the same three files (Task 2). `acceptance.integration.test.ts`'s `opsSources` and `kpr454ProducerSources` scans, `single-prefix-predicate.test.ts`, and `notifier-isolation.test.ts`'s import scan (test files included) also read this plan's `src/ops/` files as text, and three suites read `CLAUDE.md` — see [Source-scan constraint](#source-scan-constraint-on-srcops-modules) for the full inventory.
- `src/ops/delivery.integration.test.ts`, `ingest.integration.test.ts`, `intake.integration.test.ts`, `notifier-acceptance.integration.test.ts` — the shared double and the notifier are untouched.
- `src/ops/single-prefix-predicate.test.ts` — no new hit, no allowlist change.
- `src/boot-order.test.ts` — unchanged file, green.
- `src/events/event-bus-mcp-server.ts` — `emit_event` behaviour unchanged. No existing test exercises `emit_event` (`event-bus-mcp-server.test.ts` imports only `event-types.js`), so the evidence is `git diff epic/kpr-451 -- src/events/event-bus-mcp-server.ts` showing only the tool spread and, at most, the header comment.
- `src/agents/agent-runner.test.ts` — mocks `@anthropic-ai/claude-agent-sdk`'s `tool`/`createSdkMcpServer` and pins KPR-453 live-identity wiring for `event-bus` (the "every enabled cached MCP gets live identity" case and "event-bus becomes an in-process SDK server"); the new import chain from `event-bus-mcp-server.ts` into `src/ops/` must not break it.
- `src/agents/agent-manager.test.ts` — worker-mode and scribe built-set containment pins still hold.
- Worker-pool containment tests (`src/workers/*.test.ts`).
- `npm run check:bundle` — the new modules add no forbidden business strings (`scripts/check-bundle-strings.mjs`).

### Commands

Run from the child implementation worktree on Node 24 (or 22). CLAUDE.md: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher. The Slack env stubs are required because the lane harness imports `config.ts`. Prefix every command below with `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" &&`.

- Setup: `node --version` (expect v24.x or v22.x); `npm ci` if `node_modules` is missing (a missing install is setup, not a skipped test).
- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/block-producer.test.ts src/ops/block-reasons.test.ts src/ops/reasons.test.ts`
- Integration (this child): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/block-producer.integration.test.ts src/ops/single-events-writer.test.ts`
- Ops regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops`
- Runner/event-bus regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/events src/workers`
- Boot and prefix guards: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/boot-order.test.ts src/ops/single-prefix-predicate.test.ts`
- Typecheck while iterating: `npm run typecheck`
- Full: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle guards: `npm run check:bundle`
- Hygiene: `git diff --check`
- Spec integrity: `shasum -a 256 docs/epics/kpr-451/kpr-501-design.md` (expect `01025583e30db205ab0eb9decc027c15dd05e6b73eb995507165e423526e9ea5`)
- Expected for every Vitest command: exit 0, all selected tests pass, no skipped new contract cases. `npm run typecheck`: exit 0, no diagnostics. `npm run check`: typecheck, lint, format check and full suite each exit 0. Record actual totals; do not invent counts.

### Harness Requirements

- `buildOpsFixture()` for a wired, initialized publisher registered as the singleton; `fixture.drain()` is the only publish→assert barrier (`enqueue` is synchronous and fires `void drain()`). Never assert on the store right after a tool call except to prove *nothing* landed yet. `fixture.dispose()` in `afterEach`.
- `makeHarnessAgentConfig({ id: "<slug>", name: "<DisplayName>", coreServers: ["event-bus"] })` — the slug/display split is load-bearing for AC3.
- A `WorkItemContextRef`-shaped `{ current }` object the test mutates between calls to model successive turns on one thread (different `workItemId`, same `threadId`), plus the `sched:`, `team-`, `callback:`, `event:`, `worker:` and Slack-ts id shapes for AC4, a `scheduler:<agent>:<multi word label>:<epoch>` thread for the fallback, and `current: undefined` for Edge 21. For handler-direct cases, build tools with `buildBlockTools({ db, agentId, workItemContext, eventSubscribersJson })` over the fixture's `fakeDb.db`; for lane cases, the runner's own ref is set by `runner.buildInProcessServers(context)`.
- **Real runners with a database.** `AgentRunner.buildInProcessServers` and `buildToolTransportInventory` gate every in-process server on the runner holding a `db`; the existing `buildClaudeLaneHarness` constructs its runner with no `db`, so an `event-bus` presence assertion against it would be vacuously absent. Either add a default-preserving `db` (and runner-options, for `suppressAutoInjectedServers`) passthrough to `buildClaudeLaneHarness`, or construct the runner in the test with the same positional shape `agent-runner.test.ts`'s `makeRunnerWithDb` uses. The worker-mode runner is `suppressAutoInjectedServers: true` with `coreServers` filtered through the exported `WORKER_SERVER_DENYLIST` (`src/workers/meeting-worker-pool.ts`), mirroring `spawnFetchWorker`'s role construction. If constructing an auto-injected server (`schedule`/`team`) over `FakeDb` needs a collection operation the double lacks, extend `fake-db.ts` additively and state why — never mock the server away.
- `FakeDb.failNext("ops_events", "findOne", …)` for the `findOpenCondition` fault limb — the resolver's reads register as `"findOne"`, not `"find"`; a `"find"` fault never fires and the limb passes vacuously. The once-fault is consumed by the first of the helper's two concurrent reads and rejects the pair; nothing later in that call reads `ops_events`. **Drain the queue before arming** it, so a queued report's `resolveGeneration` cannot consume the fault instead.
- `FakeDb.failNext("ops_events", "insertOne", …)` (**not `failAll`**, advisory A3) for the C15 insert limb — armed **before** the tool call, asserted **after** `drain()`, since the insert runs in the drainer. Use `operations` to assert "no `ops_events` insert before drain" and "zero `ops_events` reads" (AC6's refusal limb).
- A new `OpsPublisher` over the fixture's existing `fakeDb.db` (do not reset the collection), `await init()`, then `setOpsPublisher(newPublisher)` for the restart case; stop the first publisher first so its drainer is quiescent. `buildOpsFixture({ publisher })` constructs a fresh `FakeDb` and cannot be used for this.
- `clearingProvenanceOk` imported from `src/ops/ingest.ts` with a minimal `OpsNotification`-shaped row carrying `producer: "hive-agent"` and `class` `resource` or `judgment`; no notifier sweep is run.
- **One `event-bus` instance connects once.** `McpServer.connect` throws `Already connected to a transport` on a second `connect()` of the same instance. Each connected case takes its own instance — a fresh runner, or a fresh `createEventBusMcpServer(deps)` over the same deps — or closes its bridge (`await bridge.close()`) before the next connect on that instance.
- **Lane B execution case:** `buildLaneBHarness({ bridge: { inventory: [<the event-bus entry from runner.buildToolTransportInventory(context)>], inProcessServers: { "event-bus": <runner.buildInProcessServers(context)["event-bus"]> }, workItemContext: context } })`, then `await harness.bridge.connect()` and execute the bridged `mcp__event-bus__report_block` — the in-memory transport pair, **not** the harness's injected-behaviour `call()` seam (which never connects and exercises `wrap()` alone). If looking a connected tool up by name needs a helper, add it to `lane-harness.ts`.
- **MCP-layer residual (Edge 20, AC5) and the literal `isError: true`:** connect a fresh `createEventBusMcpServer(deps)` instance's `server.instance` to an `InMemoryTransport.createLinkedPair()` with an MCP `Client` and `callTool` (the exact shape `connectInProcess` uses) — the raw client exposes `isError` and the `Input validation error` text directly. The AC9 capture-point residual (`kind: 42` minting `tool-failed`) goes through a separately connected Lane B bridge on its own instance. A descriptor's `handler` invoked directly skips `validateToolInput` and must never be used for these limbs.
- **Fresh fixture per `isError`-boundary case (advisory A1).** Any case asserting "no `ops_events` document naming the tool" runs on a fixture where no prior limb opened a `hive-runtime` condition on that tool. The `kind: 42` residual limb (which deliberately opens one on `report_block`) runs in its own fixture, and a non-residual case that must share a fixture asserts "no `hive-runtime:tool-failed` naming the tool" instead.
- Claude-lane hook payloads reuse `capture-points.integration.test.ts`'s `FAILURE_INPUT`/`SUCCESS_INPUT` shape (copied, not imported — no cross-`.test.ts` imports) with `tool_name: "mcp__event-bus__report_block"` / `"mcp__event-bus__clear_block"`.
- Logger: the hoisted `mockLog` + `vi.mock("../logging/logger.js", …)` pattern of the ops suites; assert warn counts by message-fragment filter, never `not.toHaveBeenCalled()`.
- Block-producer counters are module-global: reset them in `beforeEach` through a `__`-prefixed module-level reset seam (the `__resetOpsPublisherForTests` precedent) and reset the publisher singleton in `afterEach`.
- No live Mongo, no Slack token, no Anthropic key, no fake timers. The flush deadline is driven with a real small value in the publisher-level case and with the shipped constant in the handler-level `queueIdle: false` case (one real deadline of wall time), never with `vi.advanceTimers`.

### Non-Required Rationale

- E2E: zero subscriptions ship, so the deployed observable is the stored document already pinned in integration, and the lane harnesses exercise the real runner hooks and bridge paths.

### Verification Rules

- Missing harness is not a skip reason; every harness named exists on the epic branch. Extend additively and state why.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch (for example the accept path rejecting a handler-admitted value, or a declared-shape rule surfacing at the MCP layer), demote to the spec lane rather than widening a bound or reinterpreting the design in place.
- Negative-verify is required at nine points. Each: apply the mutation, confirm the named test fails for the stated reason, restore, re-run green, and record the outcome. Mutations are never committed.

  | NV | Mutation | Test that must fail | Task |
  | --- | --- | --- | --- |
  | NV1 | compose `subject.id` from `workItemId` instead of `threadId` | "clear on a later turn of the same thread" answers `no-open-block` (AC3/AC6) | 5 |
  | NV2 | resolve openness from the publisher's open-condition map instead of `findOpenCondition` | the simulated-restart clear (AC7) | 5 |
  | NV3 | route block publishes through `enqueueFailure` | `openConditions` unchanged by block/clear publishes (AC8) | 5 |
  | NV4 | drop the `rulingRef` requirement | "`clear_block(semantic, resumed)` without `rulingRef` on a Slack-ts turn ⇒ `refused` (`ruling-required`), stored count unchanged" (AC6). The provenance limb is deliberately not the target — it stays green because the clearing turn's `work-item` ref satisfies the ledger floor | 5 |
  | NV5 | make `report_block` also insert a `system:task_blocked` into `agent_events` | the zero-insert assertion over `agent_events`/`team_messages`/`team_pending_requests`/`agent_callbacks` (AC9) | 5 |
  | NV6 | remove the `flush` before the read | the same-turn report+clear case answers `no-open-block` (Edge 9) | 5 |
  | NV7 | widen `RULING_REF_RE` to `ADMISSIBLE_ID_RE` | the three credential-shaped `ruling-ref-shape` limbs (AC5) — the unit matrix in Task 4 and the handler-level "nothing stored" limb in Task 5 | 4, 5 |
  | NV8 | (a) `isError: true` on `refused` and `disabled`; restore; (b) `isError: true` on the caught-fault `unavailable`/`fault` answer | (a) and (b) each: the AC9 "no `producer: "hive-runtime"` document naming the tool" limb on **both** lanes; (a) also AC10's kill-switch case; (b) also AC7's and AC11's read-fault limbs | 7 |
  | NV9 | move `kind`'s enum into the declared shape (`z.enum([...])`) | the declared-shape assertion (Task 4 unit), and through the connected server "a wrong `kind` value is `refused` with `reason: "kind"` and increments `refused`" (Task 7) | 4, 7 |

- Run the targeted Vitest files after each task; run `npm run check` once in Task 8. No completion, commit, or PR claim before evidence from a fresh run of the relevant command.
- Verify the spec sha256 before Task 1 and in Task 8; if it changed, stop and report.
- No live Slack posts, no agent-definition edit, no `ops_subscriptions`/`ops_policy` row, no deploy during implementation.

---

## Task 1: Single-writer repository guard for `ops_events`

**Outcome / spec coverage:** D8's guard, green on the unmodified baseline and thereafter pinning that nothing outside the drainer writes `ops_events`. Covers AC8's guard limb.

**Components and known files:**
- `src/ops/single-events-writer.test.ts` (new) — shaped like `src/ops/single-prefix-predicate.test.ts`: a repo-root derived from `import.meta.url`, a `tinyglobby` `globSync` over the precedent's own glob set (`src/**/*.ts`, `scripts/**/*.ts`, `build/**/*.ts`, `setup/**/*.ts` — the latter three currently have zero hits for any needle; D8 calls this a repository guard), comment lines stripped before matching, an expected-location set per needle.
- Current occurrences at the baseline (verified at plan time): `OPS_EVENTS_COLLECTION` in `src/ops/types.ts` (declaration) and `src/ops/store.ts` (import + collection handle); the closed-quoted literal `"ops_events"` only in `src/ops/types.ts` — `src/ops/store.ts` carries index labels such as `"ops_events.cursor"` and a remediation string containing `db.ops_events.dropIndex(`, which a prefix-only or unquoted needle would hit; `store.events.insertOne(` only in `src/ops/publisher.ts`'s accept path — plus a doc-comment quote in `src/ops/types.ts` that comment stripping must remove. Excluded: `*.test.ts` and `src/ops/testing/**` (`notifier-harness.ts` inserts directly; `lane-harness.ts` reads the constant). Unrelated bare `.events.insertOne(` hits exist in `src/workflow/event-emitter.ts` and `src/events/event-bus-mcp-server.ts`, which is why the needle is keyed on the `store.events.` handle.

**Dependencies:** None.

**Interfaces, compatibility, and invariants:**
- Three needles, three expected file sets: `OPS_EVENTS_COLLECTION` ⊆ {`src/ops/types.ts`, `src/ops/store.ts`}; `"ops_events"` (either quote style, quote-closed on **both** sides) ⊆ {`src/ops/types.ts`}; `store.events.insertOne(` ⊆ {`src/ops/publisher.ts`}. A hit elsewhere fails with the file and needle named.
- Each expected entry must still have a real occurrence (the no-stale-entry discipline of `single-prefix-predicate.test.ts`), so the guard cannot silently rot to vacuous.
- Comment stripping covers `//` line comments and `*`-prefixed block-comment lines; it must not strip code.
- Reads are unconstrained; the guard's header comment says a future reader (KPR-455) adds itself to the constant's allowlist, and a future writer must go through the drainer.

**Acceptance criteria:** Guard green on the baseline tree; each expected location present.

**Verification:**
- Tests and critical failure cases: the guard itself. Able-to-fail check (not committed): temporarily add a reference to `OPS_EVENTS_COLLECTION` in a non-test module outside the allowlist (for example a scratch line in `src/ops/observe.ts`) and confirm the guard fails naming that file; temporarily place `store.events.insertOne(` on a non-comment line in another `src/ops` module and confirm failure, then move it into a `//` comment line and confirm the guard is green again (comment stripping works); restore both.
- Harness/environment: none.
- Run: `shasum -a 256 docs/epics/kpr-451/kpr-501-design.md`; then `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/single-events-writer.test.ts src/ops/single-prefix-predicate.test.ts`.
- Expected: spec hash matches; both files pass; the able-to-fail mutations each fail and are restored.

- [ ] Verify the spec sha256, then author the guard over the three needles with the two exclusions and comment stripping.
- [ ] Verify: run the command; perform and record the able-to-fail mutations; restore.
- [ ] Commit the completed task.

## Task 2: `hive-agent` reason table and table-list registration

**Outcome / spec coverage:** The three `hive-agent` rows ship as one self-contained table, asserted at construction and upserted at `init()` after `hive-runtime`'s, clearing-first, with `enabled` still `$setOnInsert`-only. Covers D3, D12 (exported constants), AC12, AC15's constant half, and the regression adjustment for five rows.

**Components and known files:**
- `src/ops/block-reasons.ts` (new) — exports `HIVE_AGENT_PRODUCER = "hive-agent"`, `REASON_BLOCK_CLEARED`, `REASON_COORDINATION_BLOCK`, `REASON_SEMANTIC_BLOCK`, `BLOCK_SUBJECT_KIND = "agent-work"`, `BLOCK_EVIDENCE_KIND_WORK_ITEM = "work-item"`, `BLOCK_EVIDENCE_KIND_RULING = "ruling"`, and `HIVE_AGENT_REASONS` exactly per D3's table: row 1 `block-cleared` (`informational`/`transient`, `clearsReasonIds: [coordination-block, semantic-block]`, detail `agentId` ≤200, `outcome` ≤16, `workItemId?` ≤200, `threadId?` ≤200), row 2 `coordination-block` (`resource`/`deterministic`, detail `agentId` ≤200, `blockedOn` ≤16, `blockedOnAgentId?` ≤64, `workItemId?` ≤200, `threadId?` ≤200), row 3 `semantic-block` (`judgment`/`deterministic`, detail `agentId` ≤200, `workItemId?` ≤200, `threadId?` ≤200); the three remediation templates verbatim from D3; `enabled: true` on all three. A "DO NOT reorder" comment carrying D3's clearing-first severity argument (the `HIVE_RUNTIME_REASONS` comment is the model) and the `agentId ≤200` vs `blockedOnAgentId ≤64` rationale. Imports only `types.ts`/`ids.ts`.
- `src/ops/reasons.ts` — gains `OPS_REASON_TABLES`, the ordered list `[HIVE_RUNTIME_REASONS, HIVE_AGENT_REASONS]`. Mind the import direction: `block-reasons.ts` must not import `reasons.ts`, so no cycle forms.
- `src/ops/publisher.ts` — the constructor's single `assertReasonTableLegal(HIVE_RUNTIME_REASONS)` becomes a per-table assertion over `OPS_REASON_TABLES` (still before any await, still outside `init()`'s catch — the D5/D10 loud-boot posture); `init()`'s single `upsertReasons(HIVE_RUNTIME_REASONS)` becomes one upsert per table in list order, each table's internal order preserved, all before the single `loadReasons()`. `auditLoadedEnableGate` is unchanged (already generic over the loaded map).
- `src/ops/store.ts` `upsertReasons` / `loadReasons` — read to confirm sequential per-row upsert with `enabled` in `$setOnInsert`; no change.
- `src/ops/reasons.test.ts` — additive assertions on `OPS_REASON_TABLES`.
- `src/ops/block-reasons.test.ts` (new) — AC12 unit cases.
- `src/ops/publisher.integration.test.ts` — the boot/registry case that asserts `ops_reasons` ids equal `[FAILED_ID, RECOVERED_ID]` and the upsert order equals `[RECOVERED_ID, FAILED_ID]`. **Adjustment and reason:** KPR-501 D3 ships a second table under the same `init()` upsert, so the pinned id set becomes the five rows and the pinned call order becomes `hive-runtime`'s two (clearing first) followed by `hive-agent`'s three (clearing first). The kill-switch and disabled-row limbs of that case are unchanged.
- `src/ops/acceptance.integration.test.ts` — the AC16 case "producer and reasonId are validated by the D2 pattern bound, never against a hardcoded list". **Second adjustment and reason:** its closing assertion that `publisher.ts` contains `HIVE_RUNTIME_REASONS` pins "this producer's rows are registered by importing its table"; once the constructor and `init()` iterate `OPS_REASON_TABLES`, `publisher.ts` no longer names `HIVE_RUNTIME_REASONS` and the assertion fails for a correct change. It becomes `toContain("OPS_REASON_TABLES")`, and its comment restates the guarded property for both producers: `publisher.ts` registers reason rows only by importing the reason-table list, and never contains a producer literal. The same case's not-contain loop over `publisher.ts`, `ids.ts`, `match.ts` gains `HIVE_AGENT_PRODUCER` (imported from `block-reasons.ts`) beside `HIVE_RUNTIME_PRODUCER`, so "never in a validator" is pinned for the new producer too. No other existing test is edited beyond these two adjustments.
- Source-scan constraint: `block-reasons.ts` and the `reasons.ts` / `publisher.ts` edits obey [the constraint](#source-scan-constraint-on-srcops-modules) — in particular the D3 "DO NOT reorder" comment names no forbidden substring, and no text added to `reasons.ts` or `publisher.ts` (the `OPS_REASON_TABLES` comment included) contains `ops_notifications`, because both files are in `acceptance.integration.test.ts`'s fixed `kpr454ProducerSources` list; say "the notifier's acknowledgement ledger" if a comment needs it.

**Dependencies:** Task 1.

**Interfaces, compatibility, and invariants:**
- `assertReasonTableLegal(HIVE_AGENT_REASONS)` passes on its own: row 1 names rows 2 and 3 (same producer, in table), row 2 is the only `resource` row and row 1 clears it, every string detail key has a `maxLength`, every token is `OPS_TOKEN_RE`-legal, remediation within bound.
- Templates interpolate always-present keys only (`{agentId}`, `{outcome}` on row 1; `{agentId}`, `{blockedOn}` on row 2; `{agentId}` on row 3) — no optional key in any template.
- The `hive-agent` literal appears only in `block-reasons.ts` (and later `block-producer.ts`), never in a validator (KPR-454 AC16) — pinned by the adjusted AC16 case's `HIVE_AGENT_PRODUCER` limb.
- Re-entrant `init()` keeps an operator's `enabled: false` on any `hive-agent` row (`$setOnInsert`).
- `hive-runtime` rows, their order, and every accept-path behaviour for them are unchanged.

**Acceptance criteria:** AC12 in full — table legal; `HIVE_AGENT_REASONS[0].reasonId === "block-cleared"`; a reordered table (block-cleared after coordination-block) still passes `assertReasonTableLegal` but fails the order test; a table with `coordination-block` enabled and `block-cleared` removed throws; `init()` upserts both tables and `loadReasons()` yields five rows; template-key audit passes. AC15 constant half — the seven D12 constants are exported with the D12 values, and `agent-work`, `work-item`, `ruling` satisfy `OPS_TOKEN_RE`.

**Verification:**
- Tests and critical failure cases: `block-reasons.test.ts` covers the AC12 unit limbs and token literals; `reasons.test.ts` asserts `OPS_REASON_TABLES` order (`hive-runtime` first) and that each table passes the gate; the adjusted `publisher.integration.test.ts` boot case pins five ids and the five-call upsert order; the adjusted `acceptance.integration.test.ts` AC16 case pins `OPS_REASON_TABLES` in `publisher.ts` and neither producer literal in the three validator files (able-to-fail check, not committed: add a `"hive-agent"` string to a non-comment line of `match.ts` and confirm that case fails; restore); one new case (in `block-producer.integration.test.ts`'s publisher describe or the adjusted boot case) asserts `enabled: false` on a `hive-agent` row survives a second `init()`.
- Harness/environment: `FakeDb` via the publisher test file's existing fixture.
- Run: Unit command; then `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts`; `npm run typecheck`.
- Expected: all pass; the only changed existing assertions are the two documented ones — the boot-case id set and call order in `publisher.integration.test.ts`, and the AC16 case's table-list identifier and added `HIVE_AGENT_PRODUCER` limb in `acceptance.integration.test.ts`; that file's `opsSources` cases stay green with `block-reasons.ts` in scope.

- [ ] Add `block-reasons.ts` with the rows and constants, `OPS_REASON_TABLES` in `reasons.ts`, and the per-table constructor assertion and `init()` upsert loop in `publisher.ts`.
- [ ] Add the unit tests and make the two documented existing-test adjustments (boot/registry case; AC16 case), each with its reason in a comment.
- [ ] Verify: run the commands; confirm typecheck clean and the regression files green.
- [ ] Commit the completed task.

## Task 3: `OpsPublisher` additions — accept-only job, bounded flush, log-resolved open condition, enabled read

**Outcome / spec coverage:** The four named additive members from D1, with `resolveGeneration`'s two reads and comparison factored into one private helper both it and `findOpenCondition` call. Covers D1, D7 steps 4–5 (publisher side), D8 (job kind, FIFO), D9 (`isReasonEnabled`), AC7's publisher-level restart limb, AC8's ordering and `openConditions` limbs at the method level. This is the task carrying the routing record's two cross-component invariants.

**Components and known files:**
- `src/ops/publisher.ts`:
  - The `Job` union (`failure | recovery`) gains a third `publish` kind carrying only `input`. `enqueuePublish(input)` is a public, synchronous, non-throwing enqueue through the existing private `enqueue` (same depth, drop-oldest, `stopping` latch, overflow counter). `runJob`'s new arm awaits `accept(job.input)` and **nothing else**.
  - `flush(deadlineMs)` — public; the `__drainForTests` loop (`queue.length > 0 || draining`) bounded by a deadline; never rejects; tells the caller whether the queue reached idle before the deadline (the return value is the natural carrier; the handler exposes it as `queueIdle`). `__drainForTests` stays as is.
  - `findOpenCondition(key)` — public; takes `Pick<OpsPublishInput, "producer" | "subject" | "reasonId">` (the type `familyOf` takes), derives the family with `familyOf`, runs the shared helper, and returns the latest condition's `dedupeKey` iff a condition exists and no clearing fact is more recent under `isMoreRecent`'s `(publishedAt, _id)` order; `undefined` otherwise. No fallback, no catch: a read fault rejects to the caller.
  - `isReasonEnabled(producer, reasonId)` — public; reads the loaded reason map (`producer:reasonId` key); `false` when the row is absent or disabled. Pre-`init()` it is `false` for every row.
  - `resolveGeneration` — body refactored to call the shared helper; its `try/catch`, map fallback via `generationOfDedupeKey`, `epochResolveFaults` counter and warn text are byte-for-byte behaviour-preserving.
- `src/ops/publisher.ts` `accept`, `enqueueFailure`, `enqueueRecoveryIfOpen`, `failure`/`recovery` arms of `runJob`, `reloadSubscriptions`, `init`, `stop`, `getSnapshot` — read to confirm untouched.
- `src/ops/block-producer.integration.test.ts` (new) — first describe, publisher additions.

**Dependencies:** Task 2 (the `hive-agent` rows must be loadable so `enqueuePublish` of a `hive-agent` input is accepted in tests).

**Interfaces, compatibility, and invariants:**
- **Shared comparison (routing invariant 1).** Exactly one private helper performs the two indexed reads — latest event matching `producer`/`subject.kind`/`subject.id`/`reasonId` sorted `{ publishedAt: -1, _id: -1 }`, and latest event with `clearsFamily === family` under the same sort, concurrently — and returns both results (or the derived comparison); both `resolveGeneration` and `findOpenCondition` call it, so the "latest condition vs latest clearing" rule cannot drift. Filters, sort specs, and the component-based (not family-string) first read are unchanged, so the existing `(publishedAt, _id)`-covered indexes still serve both reads and KPR-468's cursor order is untouched.
- **Epoch behaviour unchanged.** For every existing `hive-runtime` case, `resolveGeneration` returns the same generation, faults the same way (fallback to the open entry's generation, `0` without an entry), and increments `epochResolveFaults` exactly as before. `findOpenCondition` does **not** touch `epochResolveFaults` or any publisher counter — a fault there is the block producer's to count (D7 step 5, D9).
- **Accept-only job (routing invariant 2).** A `publish` job never creates, updates, or deletes an open-condition map entry, regardless of the accepted input's producer or class; `failure` and `recovery` arms are byte-unchanged. `getSnapshot().openConditions` is unchanged by any number of `publish` jobs.
- **Single drainer ordering.** A `publish` job rides the same FIFO as `failure`/`recovery` jobs, so stored `(publishedAt, _id)` order equals enqueue order across kinds. Its insert faults land in `drain()`'s existing per-job catch (`publishFaults` + the existing warn with `kind: "publish"`); its overflow and `stopping` drops use `queueOverflow` / `drainDropped`.
- `flush` never throws and never waits past its deadline by more than one poll tick; it does not set `stopping`.
- No new loader, cache, timer, collection handle or insert site; KPR-507's ordering pair is not touched.
- `publisher.ts` is read as text by existing cases: the additions (comments included) obey the [source-scan constraint](#source-scan-constraint-on-srcops-modules) and contain no producer literal (AC16); no added member is spelled `start` and the existing `init()` doc comment quoting `.start(` stays (acceptance AC13 "exposes no .start(-spelled method"). `publisher.ts` is also in `kpr454ProducerSources`, whose AC2 case asserts it never contains `ops_notifications`: the `findOpenCondition` and shared-helper doc comments may explain the `(publishedAt, _id)` order KPR-468 consumes, but they name the ledger as "the notifier's acknowledgement ledger" or "KPR-468's cursor", never by collection name. `store.events.insertOne(` stays on a code line of the accept path only (Task 1's guard).

**Acceptance criteria:** `enqueuePublish` returns before any insert; a `publish` job enqueued between two `enqueueFailure` jobs is stored between them in `(publishedAt, _id)` order; `openConditions` unchanged across `publish` jobs; `findOpenCondition` returns the condition's exact `dedupeKey` when open, `undefined` when never raised, `undefined` when a more recent `clearsFamily` event exists, the new key after re-report; a second `OpsPublisher` over the same `fakeDb.db` (restart) returns the same answer as the first; with `failNext("ops_events", "findOne")` armed on a drained queue, `findOpenCondition` rejects, `epochResolveFaults` is unchanged, and `FakeDb.operations` shows **two** `ops_events` `findOne` attempts for the call (the double records a faulted call before rejecting it, so a sequential rewrite of the shared helper — which would stop after the first rejection — records one and fails this limb); `resolveGeneration` behaviour pinned by the existing suites; `flush` with a held insert (`FakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne")`) and a small real deadline resolves not-idle, and after release resolves idle; `isReasonEnabled` reflects `ops_reasons` `enabled` after `init()` and is `false` for an unknown pair.

**Verification:**
- Tests and critical failure cases: the acceptance limbs above as named tests in the publisher-additions describe. Critical: the ordering case sorts stored documents by `(publishedAt, _id)` and compares to enqueue order; the restart case does not reset the collection.
- Harness/environment: `buildOpsFixture()`; `FakeDb.pause`/`failNext`; hoisted `mockLog`.
- Run: Integration (this child) command; Ops regression command (`src/ops`) — the epoch-resolver suites in `publisher.integration.test.ts` and `acceptance.integration.test.ts` must stay green unchanged; `npm run typecheck`.
- Expected: new cases pass; every pre-existing `src/ops` test passes with no edit beyond Task 2's two documented ones.

- [ ] Add the job kind and the four members, factoring the two reads and comparison into one private helper called by both `resolveGeneration` and `findOpenCondition`, leaving every other member's behaviour unchanged.
- [ ] Add the publisher-additions describe to `block-producer.integration.test.ts`.
- [ ] Verify: run the commands; confirm the full `src/ops` suite green.
- [ ] Commit the completed task.

## Task 4: Block producer pure layer — shapes, value rules, composition, counters

**Outcome / spec coverage:** Everything in `src/ops/block-producer.ts` that needs no I/O, unit-pinned. Covers D4 (subject, fallback), D5 (`waiting`), D6 (declared shapes, handler-side value rules, seven reason codes, empty-string totality, `RULING_REF_RE`, detail/evidence composition, id omission), D9 (counter set and snapshot posture), AC3/AC4/AC5 unit limbs, AC6's refusal limb, NV7 and NV9's shape half.

**Components and known files:**
- `src/ops/block-producer.ts` (new), pure half:
  - The two declared raw shapes handed to `tool()`: `report_block` = `{ kind: string, blockedOn?: string, blockedOnAgentId?: string }`; `clear_block` = `{ kind: string, outcome: string, rulingRef?: string, threadId?: string }` — each `z.string()` / `z.string().optional()` with a `.describe()` naming the closed vocabulary or grammar, and **nothing else** (no enum, regex, refinement, `.strict()`).
  - The seven exported `reason` code literals (`kind`, `blocked-on`, `blocked-on-agent-id`, `outcome`, `ruling-ref-shape`, `ruling-required`, `thread-id-shape`) and `RULING_REF_RE` — the three alternatives of D6's table, anchored, exported for tests.
  - Handler-side value validation for both tools per D6's tables, returning either a validated parameter set or a refusal `{ reason, admitted-values text }`: `kind ∈ {coordination, semantic}`; `blockedOn ∈ {agent, human, external}`, required with coordination, refused with semantic; `blockedOnAgentId` matches `^[a-z][a-z0-9-]{0,63}$` and only with `blockedOn: "agent"`; `outcome ∈ {resumed, cancelled}`; `rulingRef` matches `RULING_REF_RE`, with `""` treated as absent **for `rulingRef` only**; semantic clear with absent `rulingRef` ⇒ `ruling-required`; `threadId` matches `ADMISSIBLE_ID_RE`. Every other `""` is an ordinary value refusal.
  - Subject composition: from the constructor agent id and a thread id (live, or the validated override) — `"<agentId>:<threadId>"` when a context exists, the thread passes `ADMISSIBLE_ID_RE`, and the composed id is ≤ `OPS_ID_MAX_LENGTH`; otherwise `"<agentId>"` with a fallback signal the handler counts on `subjectFallback`.
  - `OpsPublishInput` composition for the three reasons: `producer`/`reasonId`/`subject.kind` from `block-reasons.ts` constants; `waiting` = `waitingFor(<unfiltered live workItemId>)` for condition reports and fixed `"nobody"` for clears; `detail` = `agentId` (constructor slug) + `workItemId`/`threadId` from the **live ref** through `admissibleIdOrUndefined` (omitted on breach, with an omission signal the handler turns into `publisher.countIdOmitted()`) + `blockedOn`/`blockedOnAgentId` (coordination) or `outcome` (clear); `evidence` = `[work-item]` when the live `workItemId` is admissible, else `[]` (reports), and `[ruling?, work-item?]` (clears, ≤ 2 entries); `clears` supplied by the handler from `findOpenCondition`.
  - Module-global counters `reported`, `cleared`, `clearNoOpen`, `refused`, `unavailable`, `disabled`, `faults`, `subjectFallback` behind an exported, uncalled-in-production `getBlockProducerSnapshot()`, plus a `__`-prefixed module-level test reset seam.
  - `FLUSH_DEADLINE_MS` module constant (1000 ms — see Assumptions).
- `src/ops/ids.ts` (`ADMISSIBLE_ID_RE`, `admissibleIdOrUndefined`, `OPS_ID_MAX_LENGTH`, `OPS_TOKEN_RE`), `src/outage/outage-notices.ts` (`waitingFor`), `src/ops/observe.ts` (the two-value unfiltered/filtered discipline) — reuse, do not re-implement.
- `src/ops/block-producer.test.ts` (new).

**Dependencies:** Task 2 (constants and rows).

**Interfaces, compatibility, and invariants:**
- No parameter can set `class`, `retry`, `waiting`, `agentId`, `workItemId`, the live `threadId`, the subject kind, or another agent; `clear_block`'s `threadId` only selects a family to look up.
- No free-text parameter exists or may be added; no stored field carries agent prose.
- Handler rules ⊆ registry schema: every value the validator admits composes into an input the registry-built detail schema and accept-path bounds accept (all `RULING_REF_RE` shapes ≤ 40 chars and `ADMISSIBLE_ID_RE`-admissible; `blockedOn`/`outcome` ≤ 16; `blockedOnAgentId` ≤ 64; `agentId` ≤ 200 per row bound — an agent id over 200 is not reachable in composition terms here and remains the accept path's reject-and-count).
- `detail.workItemId`/`detail.threadId` on a clear are always the clearing turn's own (live ref), never the override (D6).
- `waiting` derives from the **unfiltered** id; storage uses the filtered one.
- No `startsWith`/regex over a reserved prefix anywhere in the block modules; `single-prefix-predicate.test.ts` needs no allowlist change. That scan does not strip comments, so this holds for comments too (the permitted phrasing is in [Source-scan constraint](#source-scan-constraint-on-srcops-modules)).
- Nothing in this module touches an `ops_events` handle, calls `loadSubscriptions`/`reloadSubscriptions`, or arms a timer.
- **Source-scan constraint.** `block-producer.ts` sits inside `acceptance.integration.test.ts`'s `opsSources` scans and `notifier-isolation.test.ts`'s import scan: its source and comments contain none of the substrings listed in [Source-scan constraint](#source-scan-constraint-on-srcops-modules) (`runWorkItemTurn`, `spawnTurn`, `agent-manager`, `dispatcher`, `costUsd`, `tool_response`, a thresholded `durationMs`, `activity_log`, `agent_events`, `EVENT_SCHEMAS`, `checkEvents`, `delivery_obligations`) and imports nothing from `obligations/`. Use the permitted phrasings listed there.

**Acceptance criteria:** AC3 composition limbs (normal shape; fallback + signal on a `scheduler:… multi word …` thread and on a composed id > 200; slug, not display name, in subject and `detail.agentId`; two agent ids on one thread ⇒ two families). AC4's six `waiting` mappings plus `nobody` on clears. AC5 unit limbs: declared key sets exactly `{kind, blockedOn, blockedOnAgentId}` and `{kind, outcome, rulingRef, threadId}`, per-key `z.string()` (required `kind`, `outcome`) or `z.string().optional()` with no checks; every D6 refusal with its code (wrong `kind`/`outcome`/`blockedOn`; `blockedOn` on semantic; `blockedOnAgentId` without `blockedOn: "agent"`; `blockedOnAgentId` with a space, uppercase, a path, a credential-shaped string; `kind: ""` ⇒ `kind`; `threadId` with a space or `/` ⇒ `thread-id-shape`); `RULING_REF_RE` admits `1757900000.123456`, `C0AB12CD3EF:1757900000.123456`, `KPR-451`, `KPR-451#comment-60079ae4` and refuses `/`, a URL, a sentence, an `sk-ant-…` token, a 40-hex secret and a three-segment JWT with `ruling-ref-shape`. AC6 refusal limb: semantic clear with no `rulingRef` or `rulingRef: ""` ⇒ `ruling-required`; a coordination clear with `rulingRef: ""` carries no ruling evidence. Edge 3/4/21 composition: inadmissible thread ⇒ fallback + `detail.threadId` omitted + omission signal; inadmissible (prose) work item ⇒ `detail.workItemId` omitted, no `work-item` evidence, `waiting` still from the unfiltered id; `current === undefined` ⇒ fallback subject, no ids, `evidence: []`, `waiting: "nobody"`.

**Verification:**
- Tests and critical failure cases: the acceptance limbs as unit cases. Negative-verify NV7 (widen `RULING_REF_RE` to `ADMISSIBLE_ID_RE` ⇒ the three credential-shaped refusal cases fail) and NV9's shape half (replace `kind`'s `z.string()` with `z.enum([...])` ⇒ the declared-shape case fails); restore both.
- Harness/environment: vitest only.
- Run: Unit command; `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/single-prefix-predicate.test.ts src/ops/single-events-writer.test.ts src/ops/acceptance.integration.test.ts src/ops/notifier-isolation.test.ts`; `npm run typecheck`.
- Expected: all pass, including the `opsSources` scans with `block-producer.ts` in scope; NV7 and NV9(shape) observed failing then restored green.

- [ ] Add the pure half of `block-producer.ts` within the constraints above.
- [ ] Add `block-producer.test.ts` covering the acceptance limbs.
- [ ] Verify: run the commands; perform and record NV7 and NV9 (shape half); restore.
- [ ] Commit the completed task.

## Task 5: Tool handlers, `event-bus` wiring, and handler-level integration

**Outcome / spec coverage:** `report_block` and `clear_block` exist as SDK `tool()` descriptors appended to `buildEventBusTools(deps)`'s array, implementing D7's eight-step `clear_block` and the `report_block` skeleton, every answer non-`isError`, every path counted, every publish through `enqueuePublish`. Covers D2 (response shape, `isError` boundary, description text), D7, D8 (tool side), D9, D10, D11, D13 (kill switch, boot window), AC2, AC5 handler matrix, AC6, AC7, AC8 (tool side), AC9 handler-direct limbs and zero-insert, AC10, AC11 handler-level limbs, AC15 stored-value limb; Edges 1–10, 13, 14, 17–19, 21, 24. NV1–NV6 and NV7's stored limb.

**Components and known files:**
- `src/ops/block-producer.ts` — `buildBlockTools(deps: EventBusToolDeps)` returning the two descriptors. `EventBusToolDeps` comes in through `import type` from `src/events/event-bus-mcp-server.ts`: the value import already runs the other way (the server spreads `buildBlockTools`), so a value import would create a runtime cycle. Reads `opsPublisher()` from `src/ops/publisher-singleton.ts` **at execution**, `deps.agentId` from construction, and `deps.workItemContext?.current` **at execution**. JSON-text `{ state, … }` responses in the `schedule` server's `response(value)` shape (`src/schedule/schedule-mcp-server.ts`), **without** its `isError` flag.
- **Module comment (advisory A5).** The header states: every handler answer — the caught fault included — is non-`isError`; this deliberately departs from the sibling `emit_event` catch in `src/events/event-bus-mcp-server.ts` (which returns `isError: true`, the KPR-122 convention) and from the `schedule` KPR-456 tools' `unavailable`; the reason is KPR-458 D10(a) / canon C14 (a fault of the ops path is logged and counted, never published — and KPR-454's capture points publish any `isError` as `hive-runtime:tool-failed`), plus D13 (the kill switch must not mint tool-health facts); NV8 exists to catch a normalizing edit. The header is scanned as text (see [Source-scan constraint](#source-scan-constraint-on-srcops-modules)): name the sibling as "the `emit_event` catch in `src/events/event-bus-mcp-server.ts`" and the capture points as "KPR-454's Claude-lane hooks and Lane B bridge", and never write the turn-spawn, routing, event-collection, schema-registry or scheduler-loop identifiers the scans forbid.
- `src/events/event-bus-mcp-server.ts` — `buildEventBusTools` spreads `buildBlockTools(deps)` into its returned array after `emit_event`. `EventBusToolDeps`, `createEventBusMcpServer` and `emit_event` byte-unchanged. Update the file header comment only if needed to mention the two tools.
- `src/ops/block-producer.integration.test.ts` — handler-level describes (report, clear, generation/restart, kill switch/boot window, faults, ordering, zero-insert).

**Dependencies:** Tasks 3 and 4.

**Interfaces, compatibility, and invariants:**
- **`clear_block` order (D7):** (1) publisher unset ⇒ `{ state: "unavailable", cause: "publisher-unset" }` (`unavailable` +1); `isReasonEnabled("hive-agent", "block-cleared")` false ⇒ `{ state: "disabled" }` (`disabled` +1) — the publishing row, never the condition row; (2) value and class rules (no I/O) ⇒ `{ state: "refused", reason }` with admitted values in the text (`refused` +1); (3) compose the family (live or override thread, D4 fallback, `subjectFallback` +1 when it fires); (4) `await publisher.flush(FLUSH_DEADLINE_MS)` capturing `queueIdle`; (5) `findOpenCondition({ producer, subject, reasonId })`; (6) `undefined` ⇒ `{ state: "no-open-block", queueIdle }` (`clearNoOpen` +1), no publish; (7) `enqueuePublish` a `block-cleared` input with `clears` = that key, `waiting: "nobody"`, clearing-turn `detail`, D6 evidence (`publisher.countIdOmitted()` per omitted id); (8) `{ state: "queued", clears, outcome, queueIdle }` (`cleared` +1). Refusal wins over `no-open-block` because step 2 precedes steps 4–6.
- **`report_block` order:** publisher unset ⇒ `unavailable`; `kind` invalid ⇒ `refused` (`kind`) — the enabled check needs a valid `kind` to pick its row; `isReasonEnabled("hive-agent", <coordination-block|semantic-block>)` false ⇒ `disabled`; remaining value rules ⇒ `refused`; compose; `enqueuePublish`; `{ state: "queued", kind }` (`reported` +1). No flush, no read.
- **Try/catch (D2, D9, C15):** the whole body of both handlers is inside one try/catch. The catch answers `{ state: "unavailable", cause: "fault" }` with `isError` absent, increments `faults` (not `unavailable`), and emits exactly one `log.warn` naming the tool and `String(err)` — never the error object into any stored field. Handlers never throw. In production the catch is reachable only by `findOpenCondition`'s rejection on `clear_block`.
- **Never `isError`.** No handler answer sets `isError`. The only `isError` either tool can produce is the MCP layer's own input-validation error on a call the handler never ran.
- **Do not suppress `tool-recovered` (advisory A6).** A non-`isError` answer on a tool whose `hive-runtime` family already holds an open fault entry will make KPR-454's success capture point publish a true `tool-recovered`; that recovery is minted by the same control-flow event as any successful answer (the fault is not its cause), and C12 forbids the result-text sniff that could suppress it. No handler, capture-point, or bridge change may try.
- **No publish about itself; no spawn (D9, D10).** No `hive-agent` document ever describes a failed call. Neither tool writes `agent_events`, `team_messages`, `team_pending_requests`, `agent_callbacks`, calls `emit_event`, or reaches `runWorkItemTurn`/`spawnTurn`. `system:task_blocked`, `EVENT_SCHEMAS`, `Scheduler.checkEvents` and `subscribe` untouched. This paragraph names those identifiers for the implementer; any D10 cross-reference written into `block-producer.ts` (code or comment) uses the permitted phrasings of [Source-scan constraint](#source-scan-constraint-on-srcops-modules) instead — `system:task_blocked`, `emit_event` and `send_message` as written; "the event bus's event collection", "the event schema registry", "the scheduler's event-delivery loop", "no turn is spawned" for the rest. (`src/events/event-bus-mcp-server.ts` is outside the scan.)
- **Ordering (D8):** both tools enqueue and return; neither awaits acceptance; nothing in `src/ops/block-*.ts` touches an `ops_events` handle (Task 1's guard pins it).
- **Identity (D11):** agent id from construction; work item and thread from the live ref at execution (never captured at build — the server is cached across turns).
- **`report_block` description** says, in its own words, that it records a fact and notifies nobody, that the agent uses `send_message` (team) to alert whoever it waits on, and that the agent clears the block itself with `clear_block` when it resumes or cancels. `clear_block`'s description names the semantic ruling requirement and the three `rulingRef` shapes. No prompt, constitution or seed edit.
- **Residuals named, not fixed:** overflow/`stopping`/insert-rejection drops after `queued` are counted on the publisher's existing counters and invisible to the tool (Edge 13); cron-run blocks age to `unknown` (Edge 16).

**Acceptance criteria:**
- AC2: a stored `hive-agent` document's key set equals KPR-454 D9's list (`clears`/`clearsFamily` on `block-cleared` only); `producer === "hive-agent"`; `class`/`retry` equal the row's; no `owner`/`severity`/`destination`/`recipient`/rendered string; a clear issued from thread `T2` with `threadId: T1` naming an open family stores `clearsFamily` naming `T1` while `detail.threadId === T2` and `detail.workItemId` is the clearing turn's.
- AC5 handler matrix: each refusal limb from Task 4, driven through the handler, answers non-`isError` `refused` with its code, `refused` +1, publisher `rejected` unchanged, nothing stored after drain; each `RULING_REF_RE` shape stored verbatim as `evidence[].id`; each non-admitted `rulingRef` (including the three credential-shaped strings) refused and not stored; a credential-shaped `threadId` override (which passes `ADMISSIBLE_ID_RE`) answers `no-open-block` and stores nothing; every legal parameter combination for both tools drains with `rejected === 0` and stores each document; no stored field contains any substring of a prose-shaped live `workItemId`/`threadId` (omitted, `idOmitted` +1).
- AC6: nothing open ⇒ `no-open-block`, nothing stored; coordination report then `clear_block(coordination, resumed)` ⇒ one `block-cleared` with `clears` = the report's exact `dedupeKey`, `clearsFamily` = its family, `generation: 0`, `waiting: "nobody"`, `detail.outcome: "resumed"`; `clear_block(semantic, resumed)` without `rulingRef` on a **Slack-ts** turn after a semantic report ⇒ non-`isError` `refused` `ruling-required`, stored count unchanged, **zero** `ops_events` operations recorded by the call (assert on `FakeDb.operations`), and the same refusal when nothing is open; with `rulingRef` ⇒ clear whose evidence contains `{ kind: "ruling", id }` and the `work-item` ref; `clearingProvenanceOk` true for a `resource` row on the stored coordination clear, true for a `judgment` row on the stored semantic clear, false for that semantic clear with `evidence: []`.
- AC7: two reports ⇒ same `dedupeKey`, same `generation`; report → clear → report ⇒ `generation` 1, new key; a clear through a new `OpsPublisher` over the same fake database finds and clears; with `failNext("ops_events", "findOne")` armed on a drained queue, `clear_block` answers `{ state: "unavailable", cause: "fault" }` with `isError` absent, `faults` +1, exactly one matching warn, and no `hive-agent` document stored.
- AC8 tool side: stored count unchanged until `drain()` after each tool call; a `report_block` issued between two `observeToolFailure` calls is stored between them in `(publishedAt, _id)` order; `openConditions` unchanged by block reports and clears.
- AC9 handler-direct: `unavailable` (both causes), `disabled`, `refused`, `no-open-block`, caught fault each store no `ops_events` document and increment their named counter; across every case in this file `agent_events`, `team_messages`, `team_pending_requests`, `agent_callbacks` receive zero inserts (an `afterEach` over `fakeDb.operations`).
- AC10: `coordination-block` `enabled: false` in `ops_reasons` before `init()` ⇒ `report_block(coordination)` answers non-`isError` `disabled`, stores nothing, `rejected` unchanged, while `report_block(semantic)` works; a coordination block opened **before** the disable (report, drain, flip `enabled: false`, re-`init()`) is still cleared by `clear_block(coordination, …)` — one `block-cleared` stored, `rejected` unchanged; `block-cleared` disabled ⇒ `clear_block` answers `disabled`; singleton unset ⇒ both tools answer `unavailable` / `publisher-unset` non-`isError`; `enabled: false` survives a second `init()`.
- AC11 handler-level limbs: (i) `enqueuePublish` replaced by a throwing double (`vi.spyOn`) ⇒ each tool answers `unavailable`/`fault` non-`isError`, `faults` +1, one warn, nothing stored after drain; (ii) the `findOne` fault limb ⇒ `clear_block` as in (i); (iii) `failNext("ops_events", "insertOne")` armed before each call ⇒ each tool answers `queued`, after drain `publishFaults` +1 per call and nothing stored. Both-lane forms are Task 7.
- AC15 stored-value limb: each stored document's `producer`, `reasonId`, `subject.kind` and `evidence[].kind` equal the `block-reasons.ts` exports.
- Named edge tests: 1 (unset), 2 (disabled), 3 (inadmissible thread / composed > 200), 4 (inadmissible work item), 5 (renewal), 6 (report→clear→report), 7 (clear with nothing open), 8 (semantic refusal beats `no-open-block`), 9 (same-turn report+clear succeeds via flush; and with an `ops_events` `insertOne` held by `FakeDb.pause` so the queue cannot idle, `clear_block` answers `no-open-block` with `queueIdle: false` after one real `FLUSH_DEADLINE_MS`, then release and drain), 10 (two agent ids on one thread — one's clear leaves the other's open), 13 (after a `queued` answer: a job dropped by the `stopping` latch counts `drainDropped`; an insert rejected via `failNext` counts `publishFaults`; and, with the drainer held inside an `insertOne` by `FakeDb.pause`, enqueuing past the queue depth drops the oldest and counts `queueOverflow` — each stores nothing for the dropped job and no `hive-runtime` document), 14 (restart), 17 (explicit `threadId` override with and without an open family), 18 (non-existent `blockedOnAgentId` stored as a bounded slug), 19 (resolver read fault on a report publishes at `0`, `epochResolveFaults` +1), 21 (`current === undefined`), 24 (the `findOne` fault on `clear_block`).

**Verification:**
- Tests and critical failure cases: the acceptance limbs above, each a named `it`. Critical: the AC6 refusal is on a Slack-ts turn; the restart case reuses the same `fakeDb.db`; fault limbs arm before the call and assert after drain; the `findOne` fault is armed on a drained queue.
- Negative-verify, each recorded then restored: NV1, NV2, NV3, NV4, NV5, NV6 (table in Verification Rules), and NV7's handler-level limb (the widened grammar now stores a credential-shaped `rulingRef`).
- Harness/environment: `buildOpsFixture()`; direct `buildBlockTools` descriptors over `fakeDb.db` with a mutable context ref; `FakeDb.failNext`/`pause`/`operations`; `clearingProvenanceOk` from `ingest.ts`; hoisted `mockLog`; block-producer counter reset seam.
- Run: Integration (this child) command; Ops regression command; Runner/event-bus regression command; Boot and prefix guards command; `npm run typecheck`.
- Expected: all pass; `src/agents/agent-runner.test.ts` and `src/events/event-bus-mcp-server.test.ts` unchanged and green; `acceptance.integration.test.ts`'s `opsSources` cases and `notifier-isolation.test.ts` green (within the Ops regression run) with the handler half and its module header in scope; NV1–NV7 each observed failing then restored.

- [ ] Add `buildBlockTools` handlers and the module comment to `block-producer.ts`, and the one spread in `event-bus-mcp-server.ts`.
- [ ] Add the handler-level describes to `block-producer.integration.test.ts`.
- [ ] Verify: run the commands; perform and record NV1–NV6 and NV7's handler limb; restore.
- [ ] Commit the completed task.

## Task 6: Surface, containment on the built set, and Lane B execution

**Outcome / spec coverage:** Proof that the tools exist exactly where D2 says — on the `event-bus` server a runner builds when `coreServers` lists it, absent otherwise and on worker-mode runners' built server set and inventory — and that a Lane B bridge executes them through the real in-process `connect()` path, storing the same document as the handler path. Covers D2 (containment, Lane B parity by inheritance), D11, D14, AC1, Edges 11 and 12.

**Components and known files:**
- `src/agents/agent-runner.ts` — `buildInProcessServers(context)` (sets `workItemContextRef.current`, builds `event-bus` only with a `db` and `shouldEnableInProcessServer("event-bus")`), `buildToolTransportInventory(context)` (emits the `event-bus` `sdk-in-process` / `requires-hive-bridge` descriptor from its stdio placeholder). Read only.
- `src/workers/meeting-worker-pool.ts` — exported `WORKER_SERVER_DENYLIST` and the `spawnFetchWorker` role construction (denylist-filtered `coreServers`) that the worker-mode fixture mirrors. Read only.
- `src/agents/in-process-servers.ts` (`IN_PROCESS_PORTED_SERVERS`), `src/agents/server-traits.ts` (`TURN_CONTEXT_DEPENDENT_SERVERS`). Read only.
- `src/agents/provider-adapters/tool-bridge.ts` — `connect()` → `connectInProcess` (in-memory linked pair, same `McpServer` instance) → `discover()` → `wrap()`. Read only.
- `src/agents/agent-manager.test.ts` worker-mode / scribe built-set pins — the precedent for asserting on the built set with a real runner.
- `src/ops/testing/lane-harness.ts` — additive passthroughs only if needed (see Harness Requirements).
- `src/ops/block-producer.integration.test.ts` — surface/containment describe.

**Dependencies:** Task 5.

**Interfaces, compatibility, and invariants:**
- Containment is asserted on the runner's **built** server set (`buildInProcessServers`) **and** its `buildToolTransportInventory` output, never on a config array alone (CLAUDE.md, KPR-390).
- `IN_PROCESS_PORTED_SERVERS`, `WORKER_SERVER_DENYLIST`, `TURN_CONTEXT_DEPENDENT_SERVERS` and the three `suppressAutoInjectedServers` gate sites are byte-unchanged: pin the three sets' current membership literally in the test (so an added `event-bus` entry, or a removal from the denylist, fails), with a one-line comment beside the pin saying a future legitimate change to any of the sets updates the pin together with a KPR-501 containment re-check, so the pin is not read as a prohibition and confirm via `git diff` that `agent-runner.ts`, `in-process-servers.ts`, `server-traits.ts`, `tool-bridge.ts`, `tool-transport.ts` and `meeting-worker-pool.ts` have no change.
- **One connect per instance (routing constraint).** The Lane B execution case connects the runner's `event-bus` instance once; any further connected case in this or Task 7's describes uses a fresh runner or a fresh `createEventBusMcpServer(deps)`, or closes the bridge first.
- The Lane B case executes through `bridge.connect()`'s returned `mcp__event-bus__report_block`, not through the harness `call()` seam.
- Tools read the runner's own ref, refreshed by `buildInProcessServers(context)`; the bridge's `workItemContext` option carries the same context.
- Harness extensions default to existing behaviour (existing `capture-points` and `acceptance` suites unchanged).

**Acceptance criteria:** AC1 in full — tool names `report_block` and `clear_block` are listed by the `event-bus` server a `db`-holding runner with `coreServers: ["event-bus"]` builds (listing through a connected client, or reading the descriptors the server was built from); no `event-bus` in the built set of a runner without it; no `event-bus` in a worker-mode runner's (`suppressAutoInjectedServers: true`, denylist-filtered `coreServers` starting from `["event-bus"]`) built server set **or** inventory (Edge 11); the Lane B partitioned inventory carries an in-process `requires-hive-bridge` `event-bus` entry; executing the bridged `report_block` through `connect()` stores, after drain, a `coordination-block` document with the same D2 key set and the same value for every key except `_id` and `publishedAt` as the one the handler-direct path stores for the same agent, context and parameters (Edge 12; run the two paths in separate fixtures so both documents are first reports at `generation` 0); the three sets are pinned.

**Verification:**
- Tests and critical failure cases: the acceptance limbs as named tests. Able-to-fail check (not committed): temporarily remove `event-bus` from `WORKER_SERVER_DENYLIST` in a scratch edit and confirm the worker-mode built-set case fails; restore.
- Harness/environment: real `AgentRunner`s with the fixture's `fakeDb.db`; `buildLaneBHarness({ bridge })`; `buildOpsFixture()`; env stubs for `config.ts`. The suites cited as precedent for driving `buildInProcessServers` / `buildToolTransportInventory` on a real runner do so under a **mocked** `../config.js` (`agent-manager.test.ts` wholesale, `agent-runner.test.ts` partial over `importOriginal`), because server-config assembly reads vendor config blocks; the ops lane harness imports the real `config.ts` (no `hive.yaml` in the worktree, env-only defaults). First confirm the positive AC1 case builds under the real config with the Slack stubs; if it does not, the named fallback is a file-scoped partial `vi.mock("../config.js", …)` in `block-producer.integration.test.ts` on the `agent-runner.test.ts` pattern — never a mock of the `event-bus` server or the runner. The positive built set also carries the auto-injected servers (`schedule`, `team`, …), so assert **containment** of `event-bus`, never set equality.
- Run: Integration (this child) command; Runner/event-bus regression command; `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/capture-points.integration.test.ts src/ops/acceptance.integration.test.ts` (harness regression); `npm run typecheck`.
- Expected: all pass; no diff in the read-only agent/worker files; the able-to-fail check observed and restored.

- [ ] Add any default-preserving harness passthrough needed, then the surface/containment describe with the worker-mode and Lane B cases.
- [ ] Verify: run the commands; perform and record the able-to-fail check; restore.
- [ ] Commit the completed task.

## Task 7: The `isError` boundary through both capture points, the MCP-layer residual, and C15 on both lanes

**Outcome / spec coverage:** Proof that every handler answer — including the caught fault — is a non-`isError` success to KPR-454's capture points on both lanes and mints no `hive-runtime:tool-failed`; that the only `isError` a caller can see is the SDK's own input-validation error, recorded as one `tool-failed` like any tool; and that the three C15 limbs complete the calling turn unchanged on both lanes. Covers D2's recording table, D6's residual, D9, AC5's MCP-layer limb (Edge 20), AC9's capture-point limbs, AC11 both-lane limbs. NV8 and NV9's connected half.

**Components and known files:**
- `src/ops/testing/lane-harness.ts` — `buildClaudeLaneHarness` (`fireSuccess`/`fireFailure` over the runner's real hook map, `markAborted`, `runner.wasAborted`), `buildLaneBHarness` (`bridge`, `abortController`).
- `src/agents/agent-runner.ts` `PostToolUseFailure`/`PostToolUse` hook bodies; `src/ops/observe.ts` `observeToolFailure`/`observeToolSuccess`; `src/agents/provider-adapters/tool-bridge.ts` `discover()` (converts `isError` to a throw) and `wrap()`'s catch/success pair. Read only.
- `@modelcontextprotocol/sdk/client/index.js` `Client` and `@modelcontextprotocol/sdk/inMemory.js` `InMemoryTransport` — the raw client for the literal `isError` limb.
- `src/ops/block-producer.integration.test.ts` — `isError`-boundary describe.

**Dependencies:** Task 6.

**Interfaces, compatibility, and invariants:**
- **Fresh fixture per case (advisory A1).** Every "no `ops_events` document naming the tool" assertion runs on a fixture in which no earlier limb opened a `hive-runtime` condition on that tool. The `kind: 42` residual limb runs alone in its own fixture. Where a case must share a fixture with a prior `tool-failed`, it asserts "no `hive-runtime:tool-failed` naming the tool" (and tolerates the true `tool-recovered` per advisory A6) instead.
- **One connect per instance.** Each connected case (bridge or raw client) owns a fresh `event-bus` instance (fresh runner or fresh `createEventBusMcpServer(deps)`), or closes its connection before reuse.
- **Lane fidelity (advisory A2).** Claude lane: the test obtains the handler's answer (direct handler call or connected client), then fires `fireSuccess` when `isError` is absent (and `fireFailure` only for the SDK's `isError: true` residual) with `tool_name` `mcp__event-bus__<tool>`; test names state that routing is the SDK's, measured by probe class 2. Lane B: the connected bridge's `execute` decides routing through `discover()`/`wrap()`. "`RunResult` classification unchanged" = `runner.wasAborted === false`, the Lane B signal un-aborted, hooks resolve, and the bridged call resolves with the handler's JSON text (not a thrown error, not the `Tool execution failed (…)` prefix).
- **Fault arming before the call, assertion after drain.** `findOne` faults are armed on a drained queue; the insert limb uses `failNext` (**not** `failAll`, advisory A3) on `ops_events` `insertOne`, so a `hive-runtime:tool-failed` insert, if the answer were wrongly `isError`, would still land and be caught by the assertion.
- **`tool-recovered` after the residual is expected and not suppressed (advisory A6).** The residual limb drains after the `kind: 42` call (the open-condition entry is created by the drainer), then issues a `queued` report on the same tool and expects one `tool-recovered` naming it.
- No production code changes in this task except fixes demanded by a failing test that exposes an implementation defect.

**Acceptance criteria:**
- AC9 capture-point limbs, each on both lanes: `refused`, `disabled`, `no-open-block`, `queued`, and the caught-fault `unavailable`/`fault` (driven on `clear_block` by `FakeDb.failNext("ops_events", "findOne", …)`) are returned with `isError` absent and, after drain, leave **no** document with `producer: "hive-runtime"` whose `subject.id` names either tool; the caught-fault case additionally shows `faults` +1 and exactly one matching warn. With the singleton unset, both producers are silent (Edge 1, both lanes).
- AC9 residual limb (Lane B bridge, own fixture): `report_block` with `kind: 42` ⇒ the bridge's `discover()` sees the SDK's `isError: true`; after drain **exactly one** `hive-runtime:tool-failed` on `subject { kind: "tool", id: "mcp__event-bus__report_block" }`; a following valid `report_block` (after a drain) stores its `coordination-block` plus exactly one `tool-recovered` naming the tool.
- AC5 MCP-layer residual (raw `Client` over a fresh instance, Edge 20): an extra unknown key is stripped and the call proceeds on its declared keys (answer `queued`, stored document has no trace of the key, `refused` unchanged); `kind: 42` and a missing `outcome` each yield `isError: true` with text beginning `Input validation error`, no `reason`, `refused` unchanged; a wrong `kind` **value** through the same connected server answers non-`isError` `refused` with `reason: "kind"` and `refused` +1 (NV9's connected limb).
- AC11 both-lane limbs: (i) throwing `enqueuePublish` double ⇒ each tool answers `unavailable`/`fault` non-`isError`, `faults` +1, one warn, after drain no `ops_events` document (neither `hive-agent` nor `hive-runtime` naming the tool); (ii) `findOne` fault ⇒ `clear_block` as (i); (iii) `failNext` on `insertOne` armed before the call ⇒ each tool answers `queued`, after drain `publishFaults` +1 per call, nothing stored, no `hive-runtime` document; every limb completes with the fidelity conditions above. A decided answer (`refused`/`disabled`/`no-open-block`) through the same two turns records nothing.
- AC9 zero-insert and no-spawn: the file's `afterEach` over `agent_events`/`team_messages`/`team_pending_requests`/`agent_callbacks` covers this describe too.

**Verification:**
- Tests and critical failure cases: the acceptance limbs as named tests, lane-suffixed. Negative-verify NV8 (a) then (b) and NV9's connected limb (table in Verification Rules); for NV8 confirm the failure on **both** lanes and the cross-task collateral failures (AC10 for (a); AC7 and AC11 read-fault limbs for (b)); restore each.
- Harness/environment: per-case `buildOpsFixture()`; fresh runners / fresh `createEventBusMcpServer` instances; `buildClaudeLaneHarness` (with `db` passthrough) and `buildLaneBHarness({ bridge })`; raw `Client` + `InMemoryTransport`; `FakeDb.failNext`; hoisted `mockLog`; counter reset seam.
- Run: Integration (this child) command; Ops regression command; Runner/event-bus regression command; `npm run typecheck`.
- Expected: all pass; NV8(a), NV8(b), NV9 observed failing then restored green.

- [ ] Add the `isError`-boundary describe with per-case fixtures and instances.
- [ ] Verify: run the commands; perform and record NV8 (a), NV8 (b) and NV9's connected limb; restore.
- [ ] Commit the completed task.

## Task 8: Documentation and the final gate

**Outcome / spec coverage:** `CLAUDE.md` documents the producer (AC13); boot order is proven untouched (AC14); the whole repository gate, bundle guards and hygiene pass; the spec is unchanged.

**Components and known files:**
- `CLAUDE.md`:
  - The MCP Servers list entry for `events/event-bus-mcp-server.ts` names the two KPR-501 tools (`report_block`, `clear_block`).
  - A new Common Gotchas bullet **Ops block producer (KPR-501, `src/ops/block-producer.ts`)**, placed after the KPR-468 ops notifier bullet, stating: the surface (two tools on the existing `event-bus` server — not auto-injected, worker-denylisted, Lane B bridged by inheritance, reachable only where `coreServers` lists `event-bus`); the three `hive-agent` rows and classes (`block-cleared` informational clears both; `coordination-block` resource/deterministic; `semantic-block` judgment/deterministic, clear requires a `rulingRef` in one of three shapes); the `agent-work` subject `<agentId>:<threadId>` with agent-level fallback and why the thread, not the work item, is the key (cron-run blocks age to `unknown`); the log-resolved clear through `findOpenCondition` with a bounded pre-read flush (survives restart); the accept-only `enqueuePublish` job kind riding the single drainer (no side-door insert; `single-events-writer.test.ts` guards it); every handler answer non-`isError` and why (KPR-454 capture points would publish it; KPR-458 D10(a)); the kill switch (`enabled: false` on a condition row + restart ⇒ `disabled`; open blocks stay clearable; removing `event-bus` from `coreServers` + SIGUSR1 removes the tools); no subscription, cadence, notification or turn spawn ships; KPR-455 imports the D12 constants from `block-reasons.ts`.
  - The `ops_reasons` entry in the MongoDB collections bullet mentions the `hive-agent` rows alongside `hive-runtime`'s.
- `src/index.ts`, `src/boot-order.test.ts` — confirm unchanged.

**Dependencies:** Tasks 1–7.

**Interfaces, compatibility, and invariants:** Documentation must not claim a subscription, cadence, recipient, notification or prompt rollout ships; must not describe `coordination-block` as `judgment`; must not suggest adding `event-bus` to `TURN_CONTEXT_DEPENDENT_SERVERS`. No other CLAUDE.md bullet is rewritten.
- Three suites read `CLAUDE.md` as text ([Source-scan constraint](#source-scan-constraint-on-srcops-modules), "Scans reading `CLAUDE.md`"). Two are the live risk for the new bullet. (1) `publisher.integration.test.ts`'s whole-file `/notifier.{0,80}repair(?:ed|s)?.{0,80}publisher/is`: case-insensitive, dot-all, so a match can span line breaks and bullets. When the bullet states Edge 13's residual (drops after `queued` count on the publisher's counters; a later report restores the fact), it does not use any form of "repair" and does not name the notifier within that window. (2) The Ops notifier bullet's slice ends at the next `\n- **`: the new bullet starts with `- **` immediately after the KPR-468 bullet, so that bullet's text is unchanged, and the new bullet does not contain "ordered by start". The `ops_reasons` edit in the collections bullet keeps `$setOnInsert` and every AC14/AC17 literal present, and the new bullet does not name `ops_sweep_cursor`, so AC17's first-occurrence slice does not move.

**Acceptance criteria:** AC13 (the three documentation changes present; nothing claims delivery ships). AC14 (`git diff` against the task's base shows no change to `src/index.ts` or `src/boot-order.test.ts`; no `.start(` added to any production source line in the diff). Full gate green; bundle guards green; `git diff --check` clean; spec hash unchanged.

**Verification:**
- Tests and critical failure cases: documentation assertions by grep; the full suite as the regression surface.
- Harness/environment: none beyond the repository setup.
- Run: `grep -n "report_block" CLAUDE.md` (expect the server-list line and the new bullet); `grep -n "Ops block producer (KPR-501" CLAUDE.md` (expect exactly one); `git diff --stat epic/kpr-451 -- src/index.ts src/boot-order.test.ts` (expect empty); `git diff epic/kpr-451 -- src ':!*.test.ts' | grep -n '^+.*\.start('` (expect no output — scoped to added production-source lines, so a test comment or this plan's prose citing an existing `.start(` call cannot trip it); the three `CLAUDE.md` scans run inside `npm run check` (`publisher.integration.test.ts`, `acceptance.integration.test.ts`, `notifier-acceptance.integration.test.ts`); `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`; `npm run check:bundle`; `git diff --check`; `shasum -a 256 docs/epics/kpr-451/kpr-501-design.md`.
- Expected: greps as stated; `npm run check` exits 0 (typecheck, lint, format check, full test suite); `npm run check:bundle` exits 0 with the forbidden-strings check clean; `git diff --check` prints nothing; spec hash `01025583e30db205ab0eb9decc027c15dd05e6b73eb995507165e423526e9ea5`. Record actual totals.

- [ ] Apply the three `CLAUDE.md` changes.
- [ ] Verify: run every command above and record results.
- [ ] Commit the completed task.

---

## Task order and commits

1. **Task 1** — `test(KPR-501): single ops_events writer guard` (green on the baseline).
2. **Task 2** — `feat(KPR-501): hive-agent reason table and table-list registration` (includes the two documented existing-test adjustments: the boot-case assertion and the AC16 table-list assertion).
3. **Task 3** — `feat(KPR-501): OpsPublisher accept-only job, bounded flush, log-resolved open condition` (shared resolver helper).
4. **Task 4** — `feat(KPR-501): block producer shapes, value rules and composition` (unit suite; NV7, NV9 shape).
5. **Task 5** — `feat(KPR-501): report_block and clear_block on the event-bus server` (handler integration; NV1–NV7).
6. **Task 6** — `test(KPR-501): block tool surface, worker containment and Lane B execution`.
7. **Task 7** — `test(KPR-501): isError boundary through both capture points and C15 lane limbs` (NV8, NV9 connected).
8. **Task 8** — `docs(KPR-501): CLAUDE.md block producer` + full gate.

Do not parallelize: each task asserts against the code the previous one produced, and the one-connect-per-instance and fresh-fixture constraints are easiest to hold with one author per describe. Negative-verify mutations are performed, observed, restored, and never committed. Each commit message ends with the session's attribution lines.

## Acceptance-criteria coverage map

| AC | Proved in |
| --- | --- |
| AC1 surface and containment (built set, Lane B `connect()`) | Task 6 |
| AC2 envelope, parameter key sets, clear `detail` identity | Task 4 (key sets) + Task 5 (stored documents, override limb) |
| AC3 subject and identity | Task 4 (composition) + Task 5 (stored, NV1) |
| AC4 `waiting` | Task 4 (mappings, and `single-prefix-predicate.test.ts` green with no allowlist change) + Task 5 (stored values) |
| AC5 redaction and two validation layers | Task 4 (shape, grammar, NV7, NV9 shape) + Task 5 (handler matrix, `rejected === 0`, override, prose ids) + Task 7 (MCP-layer residual, NV9 connected) |
| AC6 clearing and provenance | Task 4 (refusal limb) + Task 5 (stored clears, zero reads, `clearingProvenanceOk`, NV4) |
| AC7 generation, restart, read fault | Task 3 (method level) + Task 5 (tool level, NV2) + Task 7 (read fault on both lanes, NV8 b) |
| AC8 ordering and single writer | Task 1 (guard) + Task 3 (method-level FIFO, map) + Task 5 (tool-level FIFO, map, NV3) |
| AC9 nothing about itself, no spawn | Task 5 (handler-direct counters, zero inserts, NV5) + Task 7 (both capture points, residual, NV8) |
| AC10 kill switch and boot window | Task 2 (`$setOnInsert` survival) + Task 5 (tool answers) + Task 7 (NV8 a collateral) |
| AC11 C15 three limbs | Task 5 (handler level) + Task 7 (both lanes, capture-point fidelity) |
| AC12 reason table | Task 2 |
| AC13 documentation | Task 8 |
| AC14 boot order untouched | Task 8 (diff check) + every task's Boot and prefix guards run where listed |
| AC15 KPR-455 interface constants | Task 2 (exports) + Task 5 (stored values equal exports) |

Edges → tasks: 1, 2, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 19, 24 → Task 5; 3, 4, 21 → Tasks 4 and 5; 11, 12 → Task 6; 20 → Task 7; 15, 16, 22, 23 → covered by the tests named in the Testing Contract's minimum-set note.

## Engineering decisions and assumptions carried forward

- **Carried from the design (not re-decided):** every ⚠ delegated call in the spec's Assumptions — surface on `event-bus`; classes and `deterministic` retry; `agent-work` subject with agent-level fallback; `blockedOn` vocabulary and unvalidated `blockedOnAgentId`; three-shape `RULING_REF_RE`; same-agent `threadId` override; bounded pre-read flush; types-only declared shape with handler-side value rules and non-`isError` answers; log-resolved clear with the accept path's map-fallback epoch behaviour unchanged; the accept-only job kind; the named residuals (cron-run blocks age out; drops after `queued`; shape, never truth). The flagged Gate 1 `(agent, workItemId)` refinement belongs to the merge coherence verdict and changes nothing in this plan under either reading.
- **Plan-level assumption — `FLUSH_DEADLINE_MS` = 1000 ms.** The design delegates the value ("small, on the order of a second"); 1000 ms is a module constant, not configuration.
- **Plan-level assumption — a `disabled` counter.** D9 says every tool-path outcome, "reason disabled" included, is counted on the block producer's own counters but its enumerated list names no counter for `disabled`; the plan adds `disabled` rather than overloading `unavailable`. `unavailable` counts `publisher-unset` only and the caught fault counts `faults` only (AC7/AC11 assert `faults` +1). All counters sit behind the uncalled `getBlockProducerSnapshot()`; no reader exists.
- **Plan-level assumption — `report_block` check order.** D7 gives availability before parameter rules, but `report_block`'s enabled check reads the row selected by `kind`; the plan therefore validates `kind` between the publisher-unset check and the enabled check, and every other value rule after it. No AC distinguishes the orders.
- **Plan-level reading — Edge 3 `detail.threadId`.** D6 governs `detail.threadId` through `admissibleIdOrUndefined`: an inadmissible thread is omitted (and `idOmitted` counted); an admissible thread whose composed subject exceeds 200 falls back on the subject (`subjectFallback` counted) but keeps its admissible `detail.threadId`. Edge 3's combined sentence is read under that rule; the tests assert omission on the inadmissible limb only.
- **Plan-level sequencing — guard first.** The design's "natural order" lists the guard after the tools; this plan authors it first because AC8 requires it green before the producer lands and it then guards Tasks 2–7. No behaviour changes.
- **Plan-level test placement.** Publisher-addition tests live in `block-producer.integration.test.ts` (so the "Integration (this child)" command covers them); the only edit to `publisher.integration.test.ts` is Task 2's documented boot-case adjustment, and the only edit to `acceptance.integration.test.ts` is Task 2's documented AC16 adjustment.
- **No blocking decision remains.** Nothing in this plan changes product behaviour, scope, architecture or a shared contract beyond the approved design.
