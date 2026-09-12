# KPR-465 — Voice latency: validate warm execution and reduce response pauses — implementation plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan after the plan review gate passes. Execute the chunks in the order fixed by the [execution chunk](./kpr-465-plan-execution.md) — that order is binding (spec §9, "Plan ordering").

**Goal:** Turn the September 7 cold-path numbers into a controlled, same-build comparison — close the two warm-lease instrumentation gaps, add a multi-call comparison reader, ship a loopback engine bench against a contained clone, deliver the KPR-430 static `effort` field on voice turns, and (conditionally) add one worker endpointing key — so that `bench/offline verified; live comparison and caller verdict pending` is a reachable, honest terminal state without May's live-call go.

**Architecture:** Every new measure is an additive, nullable `{value, reason}` key under schema-v2 `voice_diagnostic` rows (`queueWaitMs`, `bootToInitMs`, `effort` on the engine attempt terminal; endpointing on `session_started`), threaded from `WarmVoiceSession.consumeOneTurn` → `WarmRunResult` → `TurnResult.stageTimings` → the adapter's `EnginePayload`, and allowlisted in the reader in the same change. A new pure comparison module (`src/voice/voice-latency-compare.ts`) reuses `reduceVoiceDiagnostics` per call, stratifies turns from the attempt terminal's own continuity fields, and reports per-arm/per-stage nearest-rank distributions with seeded bootstrap intervals. The bench is a thin loopback SSE client posting the worker's exact request shape at the real adapter. Static effort on voice is the KPR-430-sanctioned one-line change at the `prepareSpawn` carve-out, plus the warm lease pinning the same value through `openVoiceStreamingSession`. No default flips; the only new `hive.yaml` key is the conditional `voice.livekit.endpointing.*`.

**Tech Stack:** TypeScript/ESM, Node 24, Vitest, `@anthropic-ai/claude-agent-sdk` streaming-input `query()`, `@livekit/agents` 1.6.4 (`turnHandling.endpointing`, `voice.defaultEndpointingOptions`), Node HTTP/SSE, `node:util.parseArgs`, existing `voice_diagnostic` JSONL + `createLogger`. No Mongo, no network, no vendor in any test.

**Authority:** [Clean spec](./kpr-465-spec.md) (round 3, `7f05b5ae`); epic canon R1–R7 (KPR-462 Decision Register, ALIGNED at `165e434c`). KPR-464 is the merged measurement substrate this plan sits on; KPR-463 owns deployment; KPR-466 consumes the chosen configuration. This plan changes documentation only until implementation is dispatched.

**Readiness:** DRAFT — first draft for review. Live execution (Tier L) and the on-instance bench (Tier E) are separately authorized operations; nothing in this plan assumes May's go or a KPR-463 deployment exists.

## Chunk map and execution order

| Chunk | File | Spec sections | Regression rows |
| --- | --- | --- | --- |
| A — Instrumentation | [kpr-465-plan-instrumentation.md](./kpr-465-plan-instrumentation.md) | §3.2 | R2, R5, R7 (new fields) |
| B — Comparison reader (part 1: module + CLI; part 2: fixtures + suite) | [kpr-465-plan-reader.md](./kpr-465-plan-reader.md), [kpr-465-plan-reader-fixtures.md](./kpr-465-plan-reader-fixtures.md) | §3.3, §3.1 strata, §3.4 intervals | R1, R7 |
| C — Static effort on voice | [kpr-465-plan-effort.md](./kpr-465-plan-effort.md) | §4.1 (effort), §3.2 (`effort` stamp) | R3, R7 |
| D — Bench script, bench clone, endpointing lever | [kpr-465-plan-bench.md](./kpr-465-plan-bench.md) | §4.2 Tier E, §6.1 script, §4.1 (endpointing) | R6, R4, R7 |
| E — Execution protocol and evidence record | [kpr-465-plan-execution.md](./kpr-465-plan-execution.md) | §3.4, §5, §6, §7 | R5 (bench/live rows), ordering |

**Binding order:** A → B → D (Tasks D1–D3: bench script + R6) → C (R3) → D (Task D4: endpointing, conditional on the A0 decomposition per spec §4 A3) → E. Chunks A, B and D1–D3 are offline-verifiable and must be complete — with `npm run check` green — before C is started, so that the spec §7 terminal state `bench/offline verified; live comparison and caller verdict pending` is reachable if May's go never arrives (spec §9, "Plan ordering"). Chunk E carries no product code; its Task E1 (the evidence-record skeleton) can be written any time after A, and its Tasks E2–E6 are live-instance operations gated exactly as the spec §6.2 states.

**Why five chunks in six files (chunking rationale):** the spec spans five subsystems with clean seams — the lease/manager/adapter measurement path (A), a pure read-only analysis module with its own CLI and fixtures (B), a manager/runner delivery change with a documented ABI ripple (C), an operator-run script plus an on-instance lifecycle and a worker-side config key (D), and an operations protocol with no code (E). Each of A–D is independently a working, testable increment; E depends on all of them. Chunk B is one increment written in two files (module + CLI, then fixtures + suite) purely to keep each review chunk under the ≤ 1,000-line bound — part 2 reproduces part 1's Testing Contract so either file stands alone for review; they are executed back to back. The conditional endpointing lever (R4) lives in D rather than its own chunk because it shares the worker/config surfaces with the bench's on-instance protocol and is small (one liberal-loader key, one `turnHandling` spread, one stamp); it is sequenced last inside D and gated by the A0 decomposition.

## File map

| Path | Responsibility | Chunk |
| --- | --- | --- |
| `src/agents/warm-voice-session.ts` | `enqueuedAt`/`openCalledAt` anchors; `queueWaitMs`, turn-1 `bootToInitMs`, re-based turn-1 `initToFirstTokenMs` on `WarmRunResult`; `opening.effort` consumer is the manager | A |
| `src/agents/agent-manager.ts` | Warm-branch queue anchor threaded through `spawnTurn` recursion → `openWarmLease` → `runWarmTurn`; `stageTimings.queueWaitMs`; voice carve-out calling `resolveStaticClaudeEffort`; lease pins `effort`; `runWarmTurn` shaping literal carries pinned effort; `TurnResult.effort` | A, C |
| `src/agents/agent-runner.ts` | `openVoiceStreamingSession` optional `effort` forwarded to `buildQueryEnvelope` | C |
| `src/channels/voice/voice-adapter.ts` | `engine_attempt_terminal`/`engine_terminal` carry `bootToInitMs`, `queueWaitMs`, `effort` from `TurnResult` | A, C |
| `src/voice/voice-trace.ts` | `EnginePayload` + `CallPayload` additive keys | A, C, D |
| `src/voice/voice-diagnostic-reader.ts` | Allowlist + validation for new keys; additive per-speech `latency` detail | A, B, C, D |
| `src/voice/voice-latency-compare.ts` | Multi-call comparison: strata, per-stage distributions, consistency checks, seeded bootstrap, engine-log cross-check, bench-composed estimate | B (part 1) |
| `src/voice/voice-latency-compare.test.ts`, `src/voice/testing/compare-fixture.ts`, `scripts/voice-latency-compare.test.ts` | Deterministic fixture builder + R1/R7 suite + CLI exit-code test | B (part 2) |
| `scripts/voice-latency-compare.ts` | CLI over the compare module; no Mongo/config/network | B (part 1) |
| `docs/epics/kpr-462/fixtures/kpr-465-*.jsonl` | Deterministic compare fixtures (cold/warm/mislabelled/bench/old-shape/engine-log/bench-results) | B (part 2) |
| `src/voice/voice-bench-script.ts` (+ test) | Fixed 10-turn caller script, expected-answer keyword sets, request-body builder, SSE client parser, per-turn assertion record | D |
| `scripts/voice-engine-bench.ts` (+ test) | Operator CLI: sequential calls, barge-in close, rapid double-request, 3-concurrent, CLI-kill drills, result JSONL | D |
| `src/config.ts`, `src/voice-worker/worker-config.ts`, `src/voice-worker/session.ts` | Conditional `voice.livekit.endpointing.{minDelayMs,maxDelayMs}`; `turnHandling.endpointing`; `session_started` stamp | D (Task D4) |
| `docs/providers.md` | Voice now receives the static `effort` field; `xhigh`/`max` caution | C |
| `docs/epics/kpr-462/kpr-465-latency-evidence.md` | Evidence record (spec §7) | E |

## Testing Contract (plan-wide; each chunk carries its own focused contract)

### Required Test Groups

- Unit: `required`
  - Scope: `WarmVoiceSession.consumeOneTurn` stage anchors; `voice-latency-compare.ts` (strata, distributions, consistency, bootstrap, cross-check, bench-composed); reader allowlist/validation for every new key; `voice-bench-script.ts` (request shape, SSE parse, keyword assertion); `resolveVoiceEndpointingConfig`; `resolveStaticClaudeEffort` reached from the voice carve-out.
  - Reason: every measure and every stratification rule is a deterministic function of recorded rows; no vendor timing is involved.
  - Minimum assertions: R2's four cases (queued behind in-flight, queued behind pending opening, warm turn 1, warm turn 2+, failed attempt); R1's twelve fixture conditions; R3's field-absent/invalid/valid × cold/warm/non-voice/Lane A/haiku matrix; R4's absent/invalid/valid; R6's request shape + assertion record; R7's sentinel absence in every new field and in bench output.
- Integration: `required`
  - Scope: real `VoiceAdapter` HTTP → real `AgentManager` (mocked `AgentRunner`) → real `WarmVoiceSession` for the payload stamps (`bootToInitMs`, `queueWaitMs`, `effort`) and the R5 behavior rows V1/V2(ordering)/V4/V8/V9; bench script against the real adapter with a fake spawn.
  - Reason: the payload stamps ride `TurnResult` across the adapter/manager seam and the lease's demux — a unit mock of that seam would not prove the value the JSONL row carries.
  - Harness: `existing` — `src/channels/voice/voice-startup.integration.test.ts` (real adapter + manager + lease, `runnerControl.openStream`), `src/channels/voice/voice-adapter.integration.test.ts` (real adapter, fake spawn), `src/agents/agent-manager.test.ts` warm block (`installEchoStreamingRunner`), `src/agents/warm-voice-session.test.ts` (`makeFakeQuery`).
  - Minimum assertions: cold `engine_attempt_terminal.bootToInitMs.value === "Voice turn complete".bootToInitMs`; warm turn 2 `bootToInitMs.reason === "not_applicable"`; failed attempt `not_observed`; `mockRunnerOpenStream.mock.calls[0][0].effort` equals the definition's field; the pre-464 aliasing regressions in the startup suite stay green before and after.
- E2E: `required` (offline) / `pending` (live)
  - Scope: offline — the bench script's loopback run against the real adapter with the fake runner produces a result file and per-turn assertion records; live — Tier E on the dodi engine with the `mokie-bench` clone, Tier L PSTN calls with May.
  - Reason: the bench script is the instrument that produces the powered claim; its request shape and SSE handling must be proved against the real adapter before it touches an instance.
  - Harness: `existing` for offline (loopback adapter); `setup-required` for Tier E/L — a KPR-463-supported deployment carrying KPR-464 instrumentation plus May's go (spec §9, "Blocking for execution only").
  - Minimum assertions: offline — ten turns posted, one barge-in close, SSE `[DONE]` framing, result rows carry no answer text, no bearer in output; live — recorded in the evidence record only, never as a passing test.

### Critical Flows

- Warm turn 1: `spawnTurn` warm-branch entry → `openVoiceStreamingSession` call → `system/init` → first delta, decomposed as `queueWaitMs` + `bootToInitMs` + `initToFirstTokenMs` with no overlap.
- Warm turn N ≥ 2 queued behind an in-flight turn or a pending opening: `queueWaitMs` spans entry → consume start; `bootToInitMs` reports `not_applicable`.
- Cold turn: `stageTimings` byte-identical to today; the attempt terminal now carries `bootToInitMs` from the same `RunResult` value the log row carries.
- Static `effort`: absent → every voice turn byte-identical; valid → delivered on cold, pinned on the lease, stamped on telemetry with `effortSource: "static"` on both lanes, stamped on the attempt terminal from `TurnResult`.
- Comparison reader: labelled arms, strata, stage tables, intervals, mislabel failures, cross-check mismatch count, old rows parse, unknown keys rejected.
- Bench: fixed script posted turn by turn with the worker's exact request shape; barge-in close mid-stream; per-turn assertion record; no content written.

### Regression Surface

- KPR-464 request-owned cancellation, opener slot reservation, `selectText`/`WarmInputAdmission`, `voiceLifetimeSignal` (canon R3) — untouched semantics; new fields only.
- KPR-324 tool-ack, KPR-399 abort persistence, KPR-434 memory-mark predicates — unchanged (canon R3).
- Every non-voice `prepareSpawn` branch, Lane A/B routes, reflection, worker-pool/scribe spawns — unchanged by the voice carve-out edit.
- `scripts/voice-latency-baseline.ts` — untouched (canon R4). `voice_call_stats` v2 — untouched.
- Reader: every existing KPR-464 fixture reduces byte-identically except the additive `latency` detail on speech entities.
- Engine boot: no new `hive.yaml` key is read by the engine process (endpointing is worker-only).

### Commands

- Unit: `npx vitest run src/agents/warm-voice-session.test.ts src/voice/voice-diagnostic-reader.test.ts src/voice/voice-latency-compare.test.ts src/voice/voice-bench-script.test.ts src/voice/voice-trace.test.ts src/config.test.ts src/voice-worker/worker-config.test.ts`
- Integration: `npx vitest run src/agents/agent-manager.test.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts src/voice-worker/session.test.ts scripts/voice-engine-bench.test.ts`
- Offline E2E: `npx vitest run scripts/voice-engine-bench.test.ts --reporter=verbose`
- Reader fixtures: `npx tsx scripts/voice-latency-compare.ts --input docs/epics/kpr-462/fixtures/kpr-465-compare.jsonl --call call-cold-a=A0-cold --call call-warm-a=A1-warm --pair A1-warm=A0-cold --seed 20260911`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Build: `npm run build`
- Live: no call or restart command is authorized by this plan; chunk E's protocol runs only under the spec §6.2 preconditions.

Expected: every named Vitest file passes with zero skipped required cases; `npm run check` exits 0. Record actual test names and counts at delivery; do not invent counts.

### Harness Requirements

- Tests mock `../config.js` before any module can load instance secrets (existing pattern in every voice suite).
- The startup integration suite's `runnerControl.openStream` fake must emit `system/init` after the input iterator is first pulled (not before), so turn-1 `bootToInitMs` is a real interval; the manager test's `installEchoStreamingRunner` emits init before input — both shapes are valid and both are asserted.
- The session test's `AgentSession` mock must capture constructor options (`sdkState.ctorOptions.push(options)`) for R4's byte-identical assertion; the `voice` mock must export `defaultEndpointingOptions`.
- The bench test binds the real adapter on `127.0.0.1:0` with a fake spawn returning `TurnResult` shapes; no real runner, no SDK.
- `npm ci` once per worktree on Node 24; never symlink `node_modules` from a deployed checkout.

### Non-Required Rationale

- No test group is optional. Tier E/L execution can remain pending without blocking the implementation-only handoff; it still blocks KPR-465 acceptance.
- No dashboard, no Mongo reader, no `voice_call_stats` change, no baseline-harvester change, no SDK upgrade.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- The KPR-430 T4 voice pins are the one place a previously-green test is *expected* to flip; re-pin them in the same commit as the carve-out change (chunk C), never earlier.
- No test asserts that any Markdown file in this plan exists.

## Spec §9 coverage ledger

| Spec §9 item | Where the plan covers it |
| --- | --- |
| Sample-plan derivation (non-blocking, delegated) | Execution chunk Task E2 (re-derivation formula + recording rule) |
| Contained `mokie-bench` clone (non-blocking, delegated) | Bench chunk Task D5 (definition, lifecycle runbook, three delete-time checks, accepted residuals) |
| Additive keys under schema v2, reader allowlist extended (non-blocking, delegated; ⚠ version bump) | Instrumentation Task A3 (reader allowlist, one commit *before* the Task A4 emitter — plan-review round 3 reorder), effort Task C4, bench Task D4 — allowlist edited in the same commit as each emitter for C4/D4; the ⚠ version-bump branch is recorded as *not taken* with the reason in Task A3 Step 2 |
| Static `effort` on voice is agent-wide (⚠ for the operator) | Effort Task C6 (`docs/providers.md`) + Execution Task E4 (pre-deploy check of every voice-capable definition for `xhigh`/`max`) |
| `voice.livekit.endpointing` conditional | Bench Task D4, gated by Execution Task E3's A0 decomposition rule |
| Production restarts rule-bound | Execution Task E3 (quiescence check commands, cap, block order, timestamps) |
| Plan ordering | This index + Execution chunk "Ordering" section |
| §2 diagnosis evidence-dependent | Execution Task E6 hypothesis-versus-observation table |
| Blocking for execution only (May's go; KPR-463 deployment) | Execution Tasks E3–E5 are marked LIVE-INSTANCE and gated; terminal state defined in Task E1 |

## Execution Handoff

Plan saved as this index plus five chunk files. Ready to execute after independent plan review; execute A → B → D1–D3 → C → D4 → E per the execution chunk.
