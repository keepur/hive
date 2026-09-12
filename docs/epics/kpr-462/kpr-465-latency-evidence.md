# KPR-465 latency evidence

**Status:** bench/offline verified; live comparison and caller verdict pending
**Blocking live execution (recorded blockers, spec §6.2 / §9):** (1) no KPR-463-supported deployment whose running engine **and** worker carry KPR-464's instrumentation — the running pilot worker `ab0d2d68` predates KPR-464 and has produced zero `voice_diagnostic` rows (spec §1); (2) no operator go — neither a quiet-window go for Tier E nor May's live-call go for Tier L has been given. "bench" in the status line means the offline loopback bench (R6, §1). No Tier E on-instance bench block and no Tier L call has run. The ticket is not complete in this state (spec §7).
**Build/pins:** engine `151ee6c0b3314f505bd843501e2a9d4d0e6861a7`, the tip of `claude/kpr-465-latency` when this record was written (the final PR head supersedes it once the PR is opened); worker: pilot `ab0d2d68`, pre-464 and not usable (spec §1); `@livekit/agents` 1.6.4; `@anthropic-ai/claude-agent-sdk` 0.3.258 as resolved by the lockfile (`package.json` range `^0.3.258`; the range floats, so the running SDK version is a session-start readback); Node 24.16.0 (offline verification runtime).
**Running identities (read back at session start):** pending
**Schema decision:** additive keys under `voice_diagnostic` schemaVersion 2 (`bootToInitMs`, `queueWaitMs`, `effort` on engine terminals; endpointing on `session_started`); no version bump (chunk A Task A3 Step 2 rationale: no existing key changes meaning, KPR-464-era rows parse unchanged, and a bump would stop the compare mode from pooling semantically identical rows). The keys on this build are `bootToInitMs` and `queueWaitMs` (chunk A) and `effort` (chunk C). The endpointing keys on `session_started` belong to chunk D Task D4, which has not been built, so no endpointing key is emitted or allowlisted.

Authored 2026-09-12 (offline only). No instance, database, log, or call was touched to write this record.

## 1. Offline verification (chunks A–D)

Every row below is deterministic offline evidence: real adapter/manager/lease with a mocked runner, pure-module fixtures, or a loopback adapter. None of it is Tier E or Tier L evidence.

| Row | Suite / test names | Result | Commit |
| --- | --- | --- | --- |
| R1 reader | `src/voice/voice-latency-compare.test.ts`, describe "KPR-465 comparison reader (R1)", 12 tests: checked-in fixtures are byte-identical to the builder; labels arms and stratifies turns from attempt fields only; produces per-arm, per-stratum stage tables with exclusions for a cold and a warm arm; interrupted turns stay in the stratum but are excluded from the estimate by reason; fails the run on a warm-labelled arm with a cold steady turn and on a cold-labelled arm with a warm steady turn; engine-only arm (engine stages only, bench-composed estimate from the live pool, null without a pool); engine-log cross-check counts exactly the one disagreeing row and checks `warmTurnSeq` monotonicity; KPR-464-era rows (no new keys) parse, stages report `missingByReason.absent`; unknown keys are still rejected and surface as malformed rows; percentiles are nearest-rank and the bootstrap is seeded and reproducible; bench assertions join `toolCount` by `turnId` and never carry text; R7 sentinel test. `scripts/voice-latency-compare.test.ts`, "voice-latency-compare CLI", 4 tests: exit 0 with `ok:true` on the fixture and echoes the seed; exit 1 on a mislabelled arm; exit 2 on missing `--call`, an unlabelled arm, or a bad pair; accepts multiple `--input` files and a bench-results join. `src/voice/voice-diagnostic-reader.test.ts`: "speech details expose the estimate components and the bound turnId". Fixture CLI re-run at authoring (`--input …/kpr-465-compare.jsonl --call call-cold-a=A0-cold --call call-warm-a=A1-warm --call call-bench-1=A1-warm-bench --pair A1-warm=A0-cold --engine-log …/kpr-465-engine-log.jsonl --bench-results …/kpr-465-bench-results.jsonl --seed 20260911`): exit 0, `ok: true`, seed echoed, arm kinds cold/warm/warm, `crossCheck.mismatched: 1` (the designed disagreeing row), `warmTurnSeqMonotonic` true. The fixture values are synthetic and are not measurements. | pass | `8bc0d07b`, `c15df1b7`, `18d4b7c2`, `3e8e5dee`; fixtures regenerated with delivered effort in `9e516a30`; cast removed in `bdf59b64` |
| R2 warm instrumentation | `src/agents/warm-voice-session.test.ts`, "KPR-465 stage anchors", 9 tests: opener (`queueWaitMs` ends at the open call, `bootToInitMs` spans open → init, `initToFirstTokenMs` spans init → first delta); turn ≥ 2 queued behind an in-flight turn (`queueWaitMs` spans entry → consume start, `bootToInitMs` undefined); opener without an open anchor; no `enqueuedAt` means both measures undefined (fail-closed); failed turn still reports `queueWaitMs`; cancelled-opener survivor that entered after the open call is measured as a joiner; survivor that queued before the open call measures as the opener; negative queue delta reported raw, never clamped; stage fields never carry request bytes. `src/agents/agent-manager.test.ts`: "cold stageTimings carry no queueWaitMs key (byte-identical cold shape)"; "a request queued behind a pending opening reports queueWaitMs spanning its FIRST warm-branch entry". `src/voice/voice-diagnostic-reader.test.ts`, "KPR-465 additive engine measures": accepts `bootToInitMs`/`queueWaitMs` on attempt and request terminals; rejects malformed measures and unknown keys; KPR-464-era rows without the keys still parse and the complete fixture reduces to the same totals. `src/channels/voice/voice-adapter.integration.test.ts`: cold attempt terminal carries `bootToInitMs` equal to the log row's and `queueWaitMs` `not_applicable`; a failed attempt reports `not_observed` for both new stages; a cancelled (aborted-result) attempt reports `not_observed` for both even when the stages were measured. `src/channels/voice/voice-startup.integration.test.ts`: "warm attempt terminals carry the boot stage on the opener only and the queue stage on every turn". Chunk A gate: `npm run check` green, 4257 tests passing; `npm run build` green. | pass | `0f260022`, `a8aca2c5`, `2f7e5bfa`, `2b581c7b` |
| R3 static effort on voice | `src/agents/agent-manager.test.ts`, KPR-430 block: "T4 (KPR-465): voice path delivers the static field (carve-out still skips the router)" (the KPR-430 T4 voice pin, re-pinned in the same change as the carve-out); "T4b (KPR-465): voice haiku agent with the field — nothing delivered, one warn, no TurnResult.effort"; "T4c (KPR-465): Lane A voice agent with the field — unchanged: nothing delivered and ZERO static warns (route gate)"; "T4d (KPR-465): reflection turn on a voice thread delivers the field like any other reflection"; renamed pin "voice path with no static field delivers no effort (carve-out — router never runs)". Warm lease block: "a static effort field is pinned on the lease, forwarded to openVoiceStreamingSession, and stamped on every warm turn"; "no field ⇒ the lease opens without effort and telemetry carries no effortSource (today)"; "a definition reload mid-call does not change the pinned effort until the next lease". `src/channels/voice/voice-adapter.integration.test.ts`: "attempt and request terminals carry the delivered effort from TurnResult, null when absent". `src/channels/voice/voice-startup.integration.test.ts`: "a warm lease delivers the pinned static effort and stamps it on the second turn's attempt terminal". `src/voice/voice-diagnostic-reader.test.ts`: "effort on engine terminals accepts null and the five levels, rejects anything else"; "reader effort literal tracks AGENT_EFFORT_LEVELS". Invalid field values are dropped by the existing KPR-430 registry load-time sanitiser. Non-voice behavior is covered by the existing KPR-430 pins, which are unchanged and green: T1–T3, T5a–T5c (including T5b, off-catalog claude id), T6/T6b, and "KPR-430 T8: static effort field on a Lane B (codex) agent — request.effort undefined, one warn, no telemetry effort". No separate voice off-catalog case exists; that gate is the shared `resolveStaticClaudeEffort` path. Docs: `docs/providers.md` and the CLAUDE.md note. No `hive.yaml` key: `git diff a0a026e0 151ee6c0 -- src/config.ts src/voice-worker` is empty. Chunk C gate: `npm run check` green, 4295 tests passing; `npm run build` green. | pass | `44ba9b59`, `3bf39097`, `b92d1f7c`, `9e516a30`, `bdf59b64`; docs `501c6e1e`, `151ee6c0` |
| R4 endpointing lever | Not built. Chunk D Task D4 depends on Task E3's A0 decomposition naming the EOU stage as the largest or second-largest remaining term. E3 is live-instance work and has not run. This build has no `voice.livekit.endpointing` key in `src/config.ts`, no `turnHandling.endpointing` in `src/voice-worker/`, and no endpointing stamp or allowlist entry in `src/voice/`. | not built — conditional on E3 (live-instance, not run) | — |
| R5 (offline V1, V2-ordering, V4, V8, V9) | Before/after pass lists re-run at authoring for the two suites named in chunk A Task A4 Step 5 (`src/channels/voice/voice-startup.integration.test.ts` and `src/agents/voice-request-cancellation.test.ts`). **Before** (pre-chunk-A base `a0a026e0`): 29/29 pass. **After** (`151ee6c0`): 31/31 pass. The 29 pre-existing test names are identical and pass in both runs. The two additions are the KPR-465 cases listed under R2 and R3. Task A4 Step 5 names the V-rows as these existing cases: "cold request cancellation releases only its real spawn ticket and a queued successor completes", "warm demux drops a cancelled queued request before provider input and a later independent request progresses", "opener reserves…", and the retained-lifetime cases. The cancellation, demux and retained-lifetime cases are in the identical 29-name list, alongside the four `voice-request-cancellation` cases (including "waits for opening completion and cancels only its own waiter"). Neither suite has a case named "opener reserves…". The V9 opener-reservation case is "coordinates concurrent openers before publication and reserves A before B" in `src/agents/agent-manager.test.ts`. It was not part of the before run, but it passes at `151ee6c0` (433/433 in that file) and the full suite was green at every chunk gate. | pass | `2b581c7b` (A4, the change under check); after-state at `151ee6c0` |
| R6 bench script | `src/voice/voice-bench-script.test.ts`, "bench script (KPR-465 §6.1)", 5 tests: fixed shape (10 turns, two barge-ins, two tool turns, one recall, expectations on every non-greeting turn, no personal data); builds the worker's exact request shape and nothing else; parses the adapter's SSE framing incrementally; asserts keywords case-insensitively and returns null where no keywords exist; result rows never carry text. `scripts/voice-engine-bench.test.ts`, "voice-engine-bench against the real adapter (R6)", 6 tests: posts ten turns with the worker's shape, records assertions, closes twice for barge-in, never writes text or the token; double-request (turn 2 posted before turn 1 settles, both complete); three concurrent calls keep their ids and rows apart; kill-a / kill-b / kill-c fire the kill hook exactly once at the designated point (before-first-byte turn 3 / after-first-byte turn 3 / before-first-byte turn 1) and tag the row. The loopback kill drills show only that the hook fires and the row is tagged. The real CLI-subprocess kill outcomes (V6 a/b/c) are Tier E and pending. Loopback-fixture extraction refactor, re-run at authoring: `voice-adapter.integration.test.ts` 19/19 before (`6fa06594`) and 19/19 after (`01bd8ea8`), identical pass lists. Bugfix found during D3 (`1ed8412f`): the mid-sentence barge-in timer now has the `settled` guard its sibling has; no observable change today. Chunk D gate (D1–D3): `npm run check` green, 4285 tests passing; `npm run build` green. | pass | `b9ab1857`, `6fa06594`, `01bd8ea8`, `1ed8412f`, `39b54e5a` |
| R7 privacy | Observed, not only type-level. `warm-voice-session.test.ts` "the stage fields never carry request bytes"; `voice-trace.test.ts` "keeps the KPR-465 boot and queue stage measures content-free on an engine attempt terminal" (no `SENTINEL` / `+1555` / `Bearer `); `voice-startup.integration.test.ts` "warm attempt terminals carry the boot stage…" (a transcript sentinel reaches provider input but never appears on any engine row or on the "Voice turn complete" log row); `voice-latency-compare.test.ts` "R7: the report never contains a transcript/phone/token sentinel from inputs" and "bench assertions … never carry text"; `voice-bench-script.test.ts` "result rows never carry text"; `voice-engine-bench.test.ts` "… never writes text or the token" (goal/context sentinels and bridge token absent from output). `effort` is a validated enum literal or `null` (R3 reader test). | pass | A: `0f260022`, `2f7e5bfa`, `2b581c7b`; B: `3e8e5dee`; C: `9e516a30`; D: `b9ab1857`, `39b54e5a` |

**Authoring-time re-verification at `151ee6c0` (Node 24.16.0):** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` exit 0, with 200 test files passed / 2 skipped and 4295 tests passed / 3 skipped. The 3 skips are the pre-existing `describe.skipIf(SKIP_NESTED)` archetype spikes; KPR-465 adds no skip. `npm run build` exit 0. The KPR-465 suites run together (`warm-voice-session`, `voice-diagnostic-reader`, `voice-trace`, `agent-manager`, `agent-runner`, `voice-adapter.integration`, `voice-startup.integration`, `voice-request-cancellation`, `voice-latency-compare` module + CLI, `voice-bench-script`, `voice-engine-bench`): 855/855 pass.

**Measurement notes for §4 readers (carried from chunk A Task A5):**

- (i) The warm opener's queue stage ends at the open call. This deliberately refines spec §3.2 bullet 1 so that the three warm stages (`queueWaitMs`, `bootToInitMs`, `initToFirstTokenMs`) do not overlap.
- (ii) `bootToInitMs` and `queueWaitMs` are `not_observed` on every non-`completed` attempt outcome (failed, cancelled, incomplete). The pre-existing stage measures, including `initToFirstTokenMs`, are stamped from the attempt result regardless of outcome, as before.
- (iii) On an `incomplete` request, the attempt row can be `completed` with real stage values while the request-level row is `not_observed`. Source stage tables and evidence from `engine_attempt_terminal`, never from the request-level row.
- (iv) Sampling bias: forcing `not_observed` on a cancelled turn 1 discards boot timing that was genuinely observed under barge-in. If barge-in on turn 1 is common in the live sample, the boot-stage sample is biased toward uninterrupted openers and §4 must say so. The check is the cancelled-attempt row count against the completed-opener count.

## 2. Sample plan (Task E2)

**Derivation (spec §3.4, as approved).** From the ten September 7 cold first-token values, SD ≈ 720 ms. For a two-sided α = 0.05, power 0.80, and a minimum detectable median shift δ = 500 ms, the t-approximation per-arm n is:

n = 2 · ((z₀.₉₇₅ + z₀.₈₀) · σ / δ)² = 2 · ((1.960 + 0.842) · 720 / 500)² = 2 · (4.035)² ≈ 32.6 → 33;
Mann-Whitney efficiency correction (÷ 3/π ≈ 0.955) → ≈ 34.1 → 34; plan default **36 eligible steady non-tool turns per arm**.

The §6.1 script yields ≈ 5 steady non-tool turns per call (10 − turn 1 − two barge-ins − two tool turns − goodbye = 4, plus the recall turn = 5), so **≥ 8 bench calls per arm**. These numbers size the experiment and select no target (spec §3.4).

Arithmetic check at authoring: (1.960 + 0.842) · 720 / 500 = 4.0349; 4.0349² = 16.280; × 2 = 32.56 ≈ 32.6. 3/π = 0.9549, and 32.56 / 0.9549 = 34.10 ≈ 34.1. At 5 per call, 8 calls give 40 ≥ 36. The figures reproduce.

**Authoring notes (not part of the binding rule; for whoever runs Task E3):**

- In the shipped `BENCH_SCRIPT` (`kpr-465-v1`), the eligible steady non-tool, non-interrupted turns are 2, 3, 4 (factual), 6 (recall) and 9 (factual), so five, which matches the headline. Turn 5 (long question) is the mid-sentence barge-in. Turn 7 (lookup) is both a tool turn and the during-tool-wait barge-in. Turn 8 is the second lookup and turn 10 is the goodbye.
- The reader path named in the re-derivation rule, `byStratum.steady.stages.initToFirstTokenMs.samples`, is not the same set as the "eligible" count above. The compare module assigns the `steady` stratum from attempt continuity and `toolCount` alone (`classifyStratum`). It does not filter by turn kind or outcome, and interrupted turns stay in their stratum, excluded only from the estimate (R1 test "interrupted turns stay in the stratum but are excluded from the estimate by reason"). Its steady stage samples can therefore include the goodbye turn and the mid-sentence barge-in turn when those attempts carry an `initToFirstTokenMs` value. State in §2 which sample set was used for σ and for the collected-n count.

**Re-derivation rule (binding).** "After the first cold bench block (A0, ≥ 8 calls), re-estimate σ from that block's steady non-tool `initToFirstTokenMs` samples (reader: `arms[A0-cold].byStratum.steady.stages.initToFirstTokenMs.samples`), recompute n with the formula above, and write the new per-arm minimum to evidence §2 before any treatment arm is analysed. If the recomputed n exceeds the collected n for an arm, report the shortfall against it; never round up."

- Re-estimated σ from A0: pending (A0 has not run)
- Re-derived per-arm minimum n: pending
- Collected n per arm / shortfall: pending

**Tier L confirmatory n.** "Tier L (live) confirmatory n ≈ 10 steady non-tool turns per arm at the two-call minimum; report the explicit shortfall against 36; the live interval is confirmatory, never the powered claim."

- Collected Tier L n per arm / shortfall against 36: pending

## 3. Sessions

pending: no session has been authorized or run.

Each session gets one subsection recording: the quiet window and the go (who, when, scope); the block order (randomization command output and timestamp); every engine kickstart and worker restart, with the quiescence-check output and UTC time immediately before it (cap: two engine kickstarts and one worker restart per session); the `mokie-bench` clone create/delete readbacks (chunk D Task D5) with the three delete-time checks; A2 `effort` set and revert times with readbacks; and the count of Mokie's non-voice `effortSource: "static"` turns in the A2 window.

- Pre-deploy check (Task E4, voice-capable definitions carrying `xhigh`/`max`): pending

## 4. Per-arm distributions and stage tables

pending: no Tier E or Tier L input exists. Records, per tier, per arm and per stratum (steady / first / retried / tool / unclassified): reader output with the seed echoed, n / min / p50 / p95 / max, excluded-by-reason, consistency results, the engine-log cross-check counts, and the between-arm intervals. Also records the Task E3 Step 6 A0 stage ranking (the D4 gate) and the Task E3 Step 7 measure-only items (cache tokens against first text, response length).

## 5. §5 behavior contract results (V1–V10)

Offline rows are covered by §1 (R5, plus R6 for the loopback drill mechanics). Bench and live rows are pending and must record call, speech and turn ids per tier.

| Row | Offline | Tier E (bench) | Tier L (live) |
| --- | --- | --- | --- |
| V1 identity | pass (§1 R5) | pending | pending |
| V2 context | ordering: pass (§1 R5) | — | ear check: pending |
| V3 tools | — | pending | pending |
| V4 cancellation | pass (§1 R5) | pending | pending |
| V5 cleanup | — | pending | pending |
| V6 fallback (a / b / c) | loopback hook only (§1 R6); not a V6 result | pending | — |
| V7 accounting | — | pending | — |
| V8 no duplicate/stale speech | pass (§1 R5) | — | pending |
| V9 opening reservation | pass (§1 R5) | pending | — |
| V10 concurrency | loopback id/row separation only (§1 R6); not a V10 result | pending | — |

## 6. Per-turn correctness

pending: bench keyword/tool assertions per turn (from `--bench-results`) and May's per-turn marks, side by side. Disagreement is reported, not reconciled away.

## 7. Caller verdicts

pending: one blind verdict form per call (Task E5 Step 3), recorded before the arm is revealed, with the observation time. Human evidence only, never populated from machine timestamps.

## 8. Hypothesis-versus-observation (spec §2 diagnosis)

pending: A0 has not run. Rows to fill (Task E6 Step 4), each with the A0 re-measured value, n, and agree/disagree:

| Hypothesis (spec §2, n ≤ 12, one build) | A0 observed | n | Agree? |
| --- | --- | --- | --- |
| CLI boot ≈ 26 % of first-token p50 | pending | pending | pending |
| Model first text ≈ 51–70 % | pending | pending | pending |
| EOU floor ≈ 500 ms | pending | pending | pending |
| Queue wait 0.8–1.4 s on queued turns | pending | pending | pending |
| Bridge hop 10–60 ms | pending | pending | pending |
| TTS TTFB 207–266 ms | pending | pending | pending |

## 9. Decision, target provenance, rollback

pending: no candidate arm, verdict, or target exists. There is no numeric bar until May sets one (canon R5). KPR-323's W1 "< 40 %" rule and W2's `[baseline − 800 ms]` / `≤ 900 ms` thresholds are not imported as a bar (spec §3.4). This delivery flips no default and writes no instance configuration. At the spec §1 readback (not re-read for this record), dodi had no `voice.warmPath` key (cold) and Mokie carried no `effort`. No endpointing key exists on this build. Rollback levers, if an arm is ever applied (spec §6.4): remove `voice.warmPath.enabled` and kickstart the engine; `effort: null` via `admin_agent_update` + SIGUSR1.

## 10. Historical context (September 7/11 v1 rows — provenance only)

pending, populated alongside §4. The source readback (three v1 `voice_call_stats` docs, and twelve cold "Voice turn complete" rows, all `warmPath: false`) is summarized in spec §1–§2. Those rows are v1 provenance only. They are not the comparand (the same-build A0 cold arm is) and not a bar.
