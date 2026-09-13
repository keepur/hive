# KPR-465 execution chunk (E) — ordering, live protocol, evidence record

> **For agentic workers:** This chunk carries no product code. Task E1 (evidence-record skeleton) and Task E2 (sample-plan derivation) are offline and may be done any time after chunk A. Tasks E3–E6 are **LIVE-INSTANCE / LIVE-CALL operations** gated exactly by spec §6.2 and §9 ("Blocking for execution only"): a KPR-463-supported deployment carrying KPR-464's instrumentation, and May's explicit go. Never run them from an implementation dispatch. Never mark them done from a test result.

**Goal:** Fix the cross-chunk execution order so the offline work lands first, and define — step by step, with the exact commands, readbacks, caps and stop rules — how the bench (Tier E) and live (Tier L) evidence is produced and recorded, so that the ticket reaches either a caller-verdict decision or the honest terminal state `bench/offline verified; live comparison and caller verdict pending`.

**Architecture:** The evidence record (`docs/epics/kpr-462/kpr-465-latency-evidence.md`) is the single artifact; every live step writes to it. Machine numbers come only from `scripts/voice-latency-compare.ts` over `voice_diagnostic` JSONL (canon R4); human verdicts are recorded by hand against call ids with observation times; restarts are rule-bound (spec §6.2); the clone lifecycle is chunk D Task D5.

**Tech Stack:** the shipped CLIs from chunks B and D, `mongosh` read-only queries, `launchctl kickstart`, `kill -USR1`, the admin MCP tools (`agent_get`/`agent_update`/`agent_create`/`agent_delete`).

Spec authority: §3.4, §4 (arms), §5 (V1–V10), §6.1–§6.4, §7, §9. Canon R5 (no numeric target exists; live acceptance stays behind May's go and KPR-463), R6 (startup precedence is KPR-464's — the bench's turn 1 is a greeting, not the SIP opening), R7 (probes are prerequisite evidence only).

## Ordering (binding — spec §9 "Plan ordering")

```
A (instrumentation, R2/R5/R7)
  → B (comparison reader, R1)
    → D1–D3 (bench script + R6)
      → [offline gate: npm run check green; evidence record status = "bench/offline verified; live comparison and caller verdict pending" with every live row `pending`]  ← reachable without any go
        → C (static effort on voice, R3)
          → E3 Tier E blocks A0/A1/A2 (requires: KPR-463 deployment + quiet-window go)     ← LIVE-INSTANCE
            → D4 endpointing (R4) ONLY IF E3's A0 decomposition names the EOU stage         ← conditional
              → E3 Tier E block A3 (if built)                                                ← LIVE-INSTANCE
                → E5 Tier L calls + verdict (requires: May's live-call go)                  ← LIVE-CALL
                  → E6 decision, rollback, evidence closure
```

Dependencies stated explicitly: B needs A's keys for its fixtures (it tolerates their absence, R1 "old rows", but its stage tables are empty without them); D1–D3 need B's `BenchResultRow` type; C is sequenced after the offline gate so that a go that never arrives still leaves a complete offline deliverable and so that C's behavior change (what voice sends to the SDK) is never merged ahead of the instruments that measure it; D4 needs E3's decomposition; E5 needs E3 (the bench proves the §5 bench rows before real Mokie takes a call); E6 needs E5. Chunk C does not block the offline gate — that is deliberate: the gate is the honest stopping point.

## Testing Contract (chunk E)

### Required Test Groups

- Unit: `not-required` — no product code in this chunk.
- Integration: `not-required` — no product code in this chunk.
- E2E: `required` (live) — **status `pending` until executed under the gates**; recorded in the evidence record, never as a test result. Scope: Tier E bench blocks A0/A1/A2(/A3) with the drills; Tier L calls with May. Harness: `setup-required` — a KPR-463-supported deployment whose running engine and worker carry KPR-464 (the pilot worker `ab0d2d68` does not: zero `voice_diagnostic` rows, spec §1), plus May's go. Minimum assertions: every §5 row has a recorded outcome per tier (pass / fail / not-run-with-reason) with call/turn/speech ids; every arm has its reader tables and interval with n and shortfall; every restart has its quiescence check timestamps; the clone's three delete-time checks are recorded; May's verdicts are recorded per call before the arm is revealed.

### Critical Flows

- Offline gate reached and recorded before any live step.
- One cold block and one warm block per session, ≤ 2 engine kickstarts + ≤ 1 worker restart, quiescence-checked, in a declared quiet window.
- A2 window: `effort` set immediately before the first A2 call and reverted (`effort: null` + SIGUSR1) immediately after the last, inside the same window; non-voice `effortSource: "static"` rows counted.
- Verdict recorded blind; decision by the §3.4 procedure; rollback stated.

### Regression Surface

- Production dodi: no `hive.yaml` key survives a session except by the §6.4 decision; Mokie's definition ends every session with `effort` unset; `mokie-bench` never survives a window.

### Commands

- Reader (per block): `npx tsx scripts/voice-latency-compare.ts --input <call-filtered jsonl> --call <id>=<arm> ... --pair A1-warm=A0-cold --pair A2-warm-medium=A1-warm --engine-log <hive.log slice> --bench-results <bench out> --seed 20260911`
- Historical context only (recorded operator go, not the comparand): `npx tsx scripts/voice-latency-baseline.ts ...` (canon R4; untouched).
- Live: none authorized by this plan.

### Harness Requirements

- `mongosh` read-only access to the instance DB (`telemetry`, `meeting_worker_claims`, `agent_turn_telemetry`, `team_messages`, `agent_definitions`); read access to `<instance>/logs/hive.log` and the worker log; the admin MCP through the CoS or `ADMIN_API_TOKEN` for the REST surface.
- A scratch directory for call-filtered JSONL slices (`grep '"callId":"<id>"' hive.log`) — the reader is bounded at 32 MiB per file.

### Non-Required Rationale

- Unit/Integration: every deterministic assertion for this ticket lives in chunks A–D; this chunk only sequences and records.

### Verification Rules

- Missing harness (no deployment, no go) is a **concrete blocker to record**, not a skip: the evidence record's status line names it and the ticket stops at the terminal state.
- Never populate a human field (verdict, correctness mark, "felt cut off") from machine timestamps.
- Never import KPR-323's W1 "< 40 %" rule or W2's `[baseline − 800 ms]` / `≤ 900 ms` thresholds as a bar (spec §3.4).
- A shortfall on either tier is reported as a shortfall, never rounded up to a claim.

---

### Task E1 (offline): evidence-record skeleton and the terminal state

**Files:**
- Create: `docs/epics/kpr-462/kpr-465-latency-evidence.md`

- [ ] **Step 1: Create the record with every live section `pending`.** Sections, in order (spec §7): 

```markdown
# KPR-465 latency evidence

**Status:** bench/offline verified; live comparison and caller verdict pending
**Build/pins:** engine <sha>, worker <sha or "pilot ab0d2d68 — pre-464, not usable">, @livekit/agents 1.6.4, SDK <version>, Node <version>
**Running identities (read back at session start):** pending
**Schema decision:** additive keys under voice_diagnostic schemaVersion 2 (`bootToInitMs`, `queueWaitMs`, `effort` on engine terminals; endpointing on `session_started`); no version bump (chunk A Task A3 Step 2 rationale)

## 1. Offline verification (chunks A–D)
| Row | Suite / test names | Result | Commit |
| R1 | ... | pass | <sha> |
| R2 | ... | pass | <sha> |
| R3 | ... | pass | <sha> |   ← "not yet delivered" until chunk C lands
| R4 | ... | not built / pass | <sha> |
| R5 (offline V1, V2-ordering, V4, V8, V9) | ... before/after pass lists | pass | <sha> |
| R6 | ... | pass | <sha> |
| R7 | ... | pass | <sha> |

## 2. Sample plan (Task E2)
## 3. Sessions (one subsection per session): quiet window, go, block order (randomized: seed + result), restarts with quiescence checks, clone create/delete readbacks + three delete-time checks, A2 set/revert times, non-voice static-effort turn count
## 4. Per-arm distributions and stage tables (reader output, seed echoed) — per tier, per stratum, with excluded-by-reason
## 5. §5 behavior contract results (V1–V10) with call/speech/turn ids, per tier
## 6. Per-turn correctness (bench assertions; May's marks)
## 7. Caller verdicts (per call, blind, observation time)
## 8. Hypothesis-versus-observation (spec §2 diagnosis)
## 9. Decision, target provenance, rollback
## 10. Historical context (September 7/11 v1 rows — provenance only)
```

- [ ] **Step 2: Fill §1 from the delivery notes of chunks A–D as each lands** (test names/counts as actually observed, commit SHAs). The row for R3 reads "not yet delivered — sequenced after the offline gate" until chunk C lands; R4 reads "not built — conditional on E3" until/unless D4 is built.

- [ ] **Step 3: Commit** (`docs(kpr-465): evidence record skeleton at the offline terminal state`). This is the state the ticket stays in if May's go never arrives; it is complete and honest as-is.

### Task E2 (offline): sample-plan derivation and re-derivation rule

- [ ] **Step 1: Record the derivation in evidence §2.** From the ten September 7 cold first-token values, SD ≈ 720 ms. For a two-sided α = 0.05, power 0.80, minimum detectable median shift δ = 500 ms, the t-approximation per-arm n is

  n = 2 · ((z₀.₉₇₅ + z₀.₈₀) · σ / δ)² = 2 · ((1.960 + 0.842) · 720 / 500)² = 2 · (4.035)² ≈ 32.6 → 33;
  Mann-Whitney efficiency correction (÷ 3/π ≈ 0.955) → ≈ 34.1 → 34; plan default **36 eligible steady non-tool turns per arm**.

  The §6.1 script yields ≈ 5 steady non-tool turns per call (10 − turn 1 − two barge-ins − two tool turns − goodbye = 4, plus the recall turn = 5), so **≥ 8 bench calls per arm**. These numbers size the experiment and select no target (spec §3.4).

- [ ] **Step 2: Re-derivation rule (binding).** After the first cold bench block (A0, ≥ 8 calls), re-estimate σ from that block's steady non-tool `initToFirstTokenMs` samples (reader: `arms[A0-cold].byStratum.steady.stages.initToFirstTokenMs.samples`), recompute n with the formula above, and write the new per-arm minimum to evidence §2 **before** any treatment arm is analysed. If the recomputed n exceeds the collected n for an arm, report the shortfall against it; never round up.

- [ ] **Step 3: Tier L confirmatory n.** Record ≈ 10 steady non-tool turns per arm at the two-call minimum and the explicit shortfall against 36; the live interval is confirmatory, never the powered claim.

### Task E3 (LIVE-INSTANCE): Tier E bench sessions on the dodi engine

Preconditions (all recorded in evidence §3 before the first call): a KPR-463-supported deployment whose engine **and** worker carry KPR-464 (readback: engine `hive doctor` build line; worker `voice_worker_stats` heartbeat identity in `db.telemetry`; `grep -c '"kind":"voice_diagnostic"' <worker log>` > 0 on a recent call); a declared quiet window covered by an operator go for the session; chunks A, B, D1–D3 (and C for A2) deployed on that build.

- [ ] **Step 1: Block order.** Randomize cold-first vs warm-first per session: `node -e 'console.log(((Date.now()>>>0)*2654435761>>>0)%2?"warm-first":"cold-first")'` — record the printed value and the timestamp. Warm-first means one kickstart into warm at session start and one back to cold at session end; cold-first means one kickstart into warm mid-session and one back at end (or none back if the go says the session may end warm).

- [ ] **Step 2: Quiescence check (immediately before EVERY kickstart or worker restart; record both commands' output and the UTC time).**

```bash
mongosh "$MONGO_URI" --quiet --eval '
  const fresh = new Date(Date.now() - 30_000);
  const rows = db.telemetry.find({ kind: "spawn_coordinator_stats", updatedAt: { $gte: fresh } }).toArray();
  printjson(rows.map(r => ({ agent: r.agentId, activeSpawns: r.activeSpawns, warmVoiceSessions: r.warmVoiceSessions ?? 0, updatedAt: r.updatedAt })));
  print("running claims:", db.meeting_worker_claims.countDocuments({ status: "running" }));'
```

Proceed only if every row shows `activeSpawns: 0` and `warmVoiceSessions: 0`, `running claims: 0`, and no live call is up. Accepted residuals (record, do not wait out): a turn starting inside the ≤ 30 s heartbeat window; a claim-free scribe `runRoleTurn`.

- [ ] **Step 3: Flag edits and restarts (cap: two engine kickstarts + one worker restart per session).**

```bash
# warm ON: add to <instance>/hive.yaml
#   voice:
#     warmPath:
#       enabled: true
launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent      # engine kickstart #1 — record time
# warm OFF at session end: remove the key, kickstart again           # engine kickstart #2 — record time
```

Readback after each restart (before the first call of the block): `hive doctor` Spawn coordinator row shows `warm-voice=0`; the "Opening warm voice streaming session" log row appears on the block's first bench call iff warm is on.

- [ ] **Step 4: Per block (A0 cold, A1 warm, A2 warm+effort):**
  1. Clone create (chunk D Task D5 Step 1) → SIGUSR1 → `agent_get mokie-bench` readback recorded.
  2. `--warmup` discarded turn, then ≥ 8 scripted calls (`--calls 8`), then the drills on the warm block: `double-request` (V9), `concurrent-3` (V10), `kill-a`, `kill-b`, `kill-c` (V6 a/b/c — the operator supplies the pid at the prompt; V6(c) is recorded as the *no-retry* outcome, not a failure). **On the warm arm(s) (A1, A2), add `--call-gap-ms 130000` to the main scripted-calls invocation AND to `--drill double-request`** (it defaults to 8 full sequential calls too, not one call — pre-PR review round 3 finding) **and re-check quiescence (`warm-voice=0`, Step 2's command) between each of these commands**, so a still-open prior lease never contests the clone's `spawnBudget` (5) with the next command's — this is what keeps V10's `warm-voice=3` reading during `concurrent-3` honest and keeps a kill drill's `pgrep` from finding the wrong process. **`--call-gap-ms` does not reach across the `--warmup` boundary** (round 4 finding — the flag only spaces sequential scripted calls, never the warm-up itself, which runs first with no gap): expect `warm-voice=2` rather than `1` on the block's first scripted call after `--warmup`, and score V1's "`warm-voice=1` during" check on a later call in the block instead. Not needed on the cold arm (A0): no warm lease is held between calls.
  3. For A2: `agent_update mokie-bench { effort: "medium" }` + SIGUSR1 before the block; `low` only if `medium` passes the §3.4 quality gate **and** its interval against A1 includes zero (reader `pairs[A2-warm-medium=A1-warm].intervals.initToFirstTokenMs`); `xhigh`/`max` never.
  4. Clone delete with the three checks (Task D5 Step 3) → SIGUSR1 → `agent_list` readback.
  5. Slice the engine log by the printed call ids, run the reader with `--engine-log` and `--bench-results`, paste the per-arm tables, intervals (seed echoed), exclusions, consistency results and cross-check counts into evidence §4; `ok: false` on a mislabel or an incomplete call is a session finding, not a pooling license.

- [ ] **Step 5: Bench rows of the §5 contract (record pass/fail per row with ids):**

| Row | Bench evidence (reader/log fields) |
| --- | --- |
| V1 identity | one "Opening warm voice streaming session" row per call; `warmTurnSeqMonotonic[callId] === true` (cross-check); `sessions` row keeps one id (mongosh `db.sessions.findOne({ agentId: "mokie-bench", threadId: <voice thread> })` before/after); `warm-voice=1` during, `0` within 120 s of the last result (`spawn_coordinator_stats`) |
| V3 tools | lookup turns' `toolCount ≥ 1` — **since the pre-PR review round-2 fix that excludes barge-in turns from correctness scoring** (turn 7 is deliberately cut off during its tool wait), the tool criterion is `benchAssertions.tool.pass === calls` (turn 8 only) **and** `benchAssertions.tool.unobserved ≥ calls` (turn 7, always scored `unobserved` rather than pass/fail) — not the original `2 × calls`; `toolAckInjected: true` where the model was silent |
| V4 cancellation | barge-in turns' attempt terminals `outcome: "cancelled"`; the next turn's `selectedContinuity: "warm"` on the same lease (no new "Opening" row) |
| V5 cleanup | "Warm voice lease closed" with `idle-timeout` ≤ 120 s after the last result; `pgrep -P <engine-pid> -f claude-agent-sdk | wc -l` before/after equal; one reflection scheduled per call (log) |
| V6 fallback | (a) `engine_attempt_started.continuity: full_transcript`, terminal `selectedContinuity: fresh`, `warm: true`, a new "Opening" row, reader stratum `retried`; (b) turn ends with SSE `[DONE]` finish `error`, next request opens a fresh lease; (c) 500 `spawn_failed`, next request opens the fresh lease; in all: no duplicate speech, `warm-voice ≤ 1` |
| V7 accounting | per-turn `durationMs`/`llmMs` on the attempt terminals show no monotone growth over the 10-turn script |
| V9 opening reservation | `double-request` drill: two `engine_received`, one "Opening" row, second turn `warmTurnSeq: 2` |
| V10 concurrency | `concurrent-3`: three leases (`warm-voice=3`), all reclaimed within 150 s of the last turn |

- [ ] **Step 6: A0 decomposition → D4 gate.** From the A0 reader output (steady non-tool), rank the stage p50s: `eouMs` (pooled live if available, else the September 7 value 500–649 ms as context only), `lockQueueMs`, `bootToInitMs`, `initToFirstTokenMs`, `ttsTtfbMs`. Write the ranking to evidence §4. Build chunk D Task D4 **only if** the EOU stage is the largest or second-largest remaining term after A2; otherwise record "A3 not built — EOU ranked <n>". If built: one worker restart pair in its own session (`voice.livekit.endpointing.minDelayMs: <value>` in `hive.yaml`, `launchctl kickstart -k gui/$(id -u)/com.hive.dodi.voice-worker`), A3 needs its own live samples (worker-side variable).

- [ ] **Step 7: Measure-only items (no lever; record numbers, file a follow-up if warranted).**

```bash
mongosh "$MONGO_URI" --quiet --eval '
  db.agent_turn_telemetry.find({ agentId: "mokie-bench", threadId: /^voice/ }, { cacheReadTokens: 1, cacheCreationTokens: 1, llmMs: 1, durationMs: 1, effort: 1, effortSource: 1, resumedSession: 1 }).sort({ _id: -1 }).limit(100).toArray()'
```

Correlate `cacheCreationTokens` with `initToFirstTokenMs` per turn (join by time within the block); record `textLength`/TTS `durationMs`/playout duration per speech from the live rows (Task E5).

### Task E4 (pre-deploy check, before the first A2 window or any C deployment): voice-capable definitions carrying `xhigh`/`max`

- [ ] Run and record: `mongosh "$MONGO_URI" --quiet --eval 'db.agent_definitions.find({ effort: { $in: ["xhigh", "max"] }, $or: [{ coreServers: "voice-livekit" }, { coreServers: "voice" }] }, { _id: 1, effort: 1, coreServers: 1 }).toArray()'`. Expected on dodi per spec §1 readback: `[]` (Mokie carries no `effort`). Any hit is raised to the operator before chunk C is deployed (spec §9 ⚠): the field would now deliver on that agent's voice turns.

### Task E5 (LIVE-CALL — May's explicit go): Tier L calls and the caller verdict

Preconditions (spec §6.2, recorded per session): May's go for the session; the same deployment identity as E3 (re-read and recorded: engine + worker revisions, `@livekit/agents` 1.6.4, arm flag values, Mokie's model and Cartesia voice id, UTC clock basis); §5 offline rows green on that build. Stop rule: identity/config drift, unexpected destination, lost correlation, or May's stop → stop dialing, hang up, keep the attempt as failed/incomplete, no retry under the same go.

- [ ] **Step 1: Arms and blinding.** Minimum two calls per configuration presented for verdict (A0, A1, A2 level(s), A3 if built); blocks, not interleaved per call; May is not told the arm until after her record for that call is written. The caller script is the §6.1 script read from `BENCH_SCRIPT` verbatim (same lines, same order; the two barge-ins are May's interruptions at the marked points).

- [ ] **Step 2: A2 live window.** Immediately before the first A2 call: `agent_update mokie { effort: "medium" }` + SIGUSR1; readback `agent_get mokie`. Immediately after the last A2 call: `agent_update mokie { effort: null }` + SIGUSR1; readback. Both times to evidence §3. Count Mokie's non-voice turns in the window: `db.agent_turn_telemetry.countDocuments({ agentId: "mokie", effortSource: "static", threadId: { $not: /^voice/ }, ... window bounds })` → evidence §3. **A session may not end with the field set.**

- [ ] **Step 3: Verdict form (per call, before the arm is revealed; human evidence only):**

```
call id: ____            observation time (UTC): ____
pauses: acceptable / borderline / annoying
felt cut off or talked over: yes / no — where:
interruptions behaved naturally: yes / no
anything replayed or stale: yes / no
per-turn correctness (turns 2,3,4,5,6,7,8,9,10): correct / wrong / missing each  (turn 6 = recall of turn 2's number; turns 7/8 = did she hear a search happen and a count)
free text (verbatim only with May's ok; else paraphrased and marked):
```

- [ ] **Step 4: Live rows of the §5 contract:** V1 (`warm-voice` 1 → 0 within 120 − t s of hangup), V2 (ear: recall turn answered from earlier context; log ordering `engine_received` → `engine_first_text` → `engine_terminal` per turnId), V3 (tool on a warm turn, `maxInterChunkGapMs` reported from `bridge_terminal.maximumGapMs`), V4 (barge-in: `engine_client_closed` → interrupted speech terminal → next turn same lease), V5 (idle reclaim, no orphan CLI children), V8 (one speech attempt per non-interrupted turn; no `speech_started` after `call_closed`; May confirms nothing replayed). Worker-side stages (EOU, bridge hop, TTS TTFB) are pooled across A0–A2 live calls; A3 gets its own.

- [ ] **Step 5: Reader run per arm with live + bench inputs** (`--call <liveId>=A1-warm --call <benchId>=A1-warm-bench ...`), tables to evidence §4; confirmatory interval with its own n and shortfall (Task E2 Step 3). A live block that contradicts the bench direction is recorded and the arm is not a candidate until resolved by more live calls under a fresh go.

### Task E6: decision, rollback, evidence closure

- [ ] **Step 1: Candidate rule (spec §3.4, procedure only):** an arm is a candidate iff it passes every §5 row on its tier(s) **and** shows no correctness regression against A0 on the scripted expected answers (bench assertions + May's marks; a regression disqualifies regardless of latency). Among candidates, the best pause verdict wins; if May judges none acceptable, the recorded decision is "keep cold" with the measured gap and KPR-466 proceeds on cold. A V-row failure on the warm arm demotes A1 (and A2): record the finding, file it against the lease (not patched here unless a one-line evidence-backed correction reviewed in this plan).

- [ ] **Step 2: Target provenance.** The recorded target for KPR-466 is the candidate arm's measured steady p50 and p95 of the primary estimate, **or** an explicit number May states after hearing the calls — whichever she chooses — written to the epic decision register with provenance (bootstrap seed, n per tier, shortfall). A machine improvement May does not hear is not the target.

- [ ] **Step 3: Apply and rollback (spec §6.4).** Apply only as `hive.yaml` keys (`voice.warmPath.enabled`, optionally `voice.livekit.endpointing.*`) through the supported deployment path, plus Mokie's `effort` via `admin_agent_update` + SIGUSR1 if a level was selected. Rollback: key removal + the corresponding service restart; `effort: null` + SIGUSR1. Engine defaults stay off; a fresh install is cold by construction.

- [ ] **Step 4: Hypothesis-versus-observation table (evidence §8).** Rows: "CLI boot ≈ 26 % of first-token p50", "model first text ≈ 51–70 %", "EOU floor ≈ 500 ms", "queue wait 0.8–1.4 s on queued turns", "bridge hop 10–60 ms", "TTS TTFB 207–266 ms" — each with the A0 re-measured value, n, and agree/disagree.

- [ ] **Step 5: Decision-register entry (epic KPR-462, `## Decision Register — Canon`), template:**

> **KPR-465 latency decision** (`<merge sha>`, R8): comparand = same-build cold arm on v2 denominators; arms A0/A1/A2(<levels>)/A3(<built|not built>); bench powered n = <n> per arm (σ re-derived = <ms>), live confirmatory n = <n> (shortfall <n>); §5 rows <all pass | failures: ...>; May's verdict <...>; decision = <warm on + effort <level> | keep cold>; target for KPR-466 = <p50/p95 | May's number> (provenance: seed <seed>, evidence §4/§7); rollback = <keys/field>. Static `effort` now delivers on voice (agent-wide; `xhigh`/`max` caution in `docs/providers.md`).

- [ ] **Step 6: Status line.** If E3–E5 completed: status becomes the decision. If any live precondition is unmet: the status stays `bench/offline verified; live comparison and caller verdict pending` and the ticket is **not** complete (spec §7, §9).

## Explicitly out of scope for this plan (recorded, not dropped)

- Epic follow-ups F1 (CLAUDE.md voice-adapter paragraphs on disconnect/warm admission — epic-PR doc obligation), F2 (`kpr-464-startup-evidence.md` refresh before KPR-466), F3 (`kpr-463-plan-runtime.md` shutdown-sequencing refresh — KPR-463's lane): not this plan's job.
- Excluded variables (spec §4): model/provider change, vendor STT/TTS change or A/B, SDK upgrade, prompt rewrites beyond a lever, ambience, pre-rendered audio, opening delay, warm-lease lifetime constants, dashboards, Vapi-path changes beyond the shared adapter fields, KPR-321 telephony operations.
- `scripts/voice-latency-baseline.ts` and `voice_call_stats` v2: untouched (canon R4).
- The pilot worker `ab0d2d68` cannot produce Tier L evidence; its replacement is KPR-463's deliverable, not this plan's.
