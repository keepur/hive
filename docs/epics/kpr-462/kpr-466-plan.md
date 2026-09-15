# KPR-466 — Voice acceptance: verify deployed Mokie calls end to end — implementation plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan after the plan review gate passes — but read this callout first. Unlike a normal code plan, almost every task here is a gated live operation, not a source change. **Task 1 is offline and may run immediately. Task 2 needs a KPR-463 T9-passed dodi identity (not merely "implementation verified"; merge SHA `6b993455` is not T9) and does not need May's live-call go. Tasks 3–6 additionally need May's explicit go for that session — never dial without it. Task 7 closes the evidence record whether or not the live run happened.** Never mark a live task done from a machine-green signal alone (spec §3.2); never invent a ticket-terminal state outside the four in spec §3.3. Never treat `hive doctor` green as P1–P7 (R18).

**Goal:** Prove, with sanitized and honest evidence, that a deployed Mokie can place and hold a real phone conversation with May end to end — not just return an HTTP 200 — by rerunning KPR-463's no-call preflight on the packaged identity, repeating KPR-464's L1–L4 startup checks, executing the smallest live call set that also covers initiation, exchange, barge-in, a read-only tool, and hangup cleanup, and consuming KPR-465's warm/cold configuration decision, so the ticket reaches one of the four honest terminal states defined in spec §3.3.

**Implementation approach:** This ticket adds no product code (spec §9). It operationalizes the approved spec into seven tasks: (1) an evidence-record skeleton, offline, buildable immediately; (2) a no-call preflight (P1–P7) that reruns KPR-463's packaged-release identity checks against the CURRENT live PIDs/args/paths — never by re-executing `hive update`/`hive rollback`, the frozen helper `--restart`, or `launchctl kickstart` to re-prove 463; (3) per-session preconditions that read back KPR-465's chosen `hive.yaml`/effort configuration (or record keep-cold-by-absence per spec §4.3), confirm May's go, and confirm a quiet spawn-coordinator window; (4) the largest live call — one initiation call (I1) that also covers the audible opening (L1), a two-turn exchange (X), one barge-in (B), one read-only tool ack (T), hangup cleanup (H), and warm/cold capture (C); (5) three short calls repeating KPR-464's remaining startup scenarios (L2, L3, L4); (6) an optional fifth call solely for a voicemail observation if none occurred naturally and May wants one; and (7) a closing pass that runs the existing compare CLI, applies the KPR-465 R8 CORRECTION split to any warm-opener timing, and sets the Status line to exactly one of the four §3.3 terminal states. Every scenario that needs a heard conversation is `unknown` without May's corroborating observation (spec §3.2) — a dispatch id, `sip_answered`, or SSE `[DONE]` is never sufficient proof by itself. A voicemail/no-SIP-answer classification on any required call gets exactly one retry under the same go so the four-call set stays completable (spec §6.2). This plan does not choose a KPR-465 arm, does not re-design KPR-463's packaged confinement (R14: Seatbelt / single-use jobs / clone-on-promote), and does not flip any default.

**Dependency order:** Task 1 (offline, no gate) may run immediately. Task 2 (no-call preflight) is gated on KPR-463 spec §7's T9 having actually passed — real dodi migration, paired restart via the frozen helper (as 463 recorded; 466 does not re-invoke it), rollback/reapply, and final readback all executed and recorded in `docs/epics/kpr-462/kpr-463-deployment-evidence.md`, not the weaker `implementation verified; migration pending` state — and on live read access to the deployed dodi identity; it does **not** need May's live-call go. Merge SHA `6b993455ac34691bc79bfe4247cf780d708562b8` (keepur/hive#491) is **not** that T9 evidence (R17); Task 2 **stops** if the evidence file is missing or T9 is not recorded as passed. Task 3 (live-session preconditions) depends on Task 2 passing for that session and additionally needs the KPR-465 configuration decision (or its keep-cold-by-absence fallback) plus May's explicit go for that specific session. Tasks 4–6 (the live calls) depend on Task 3's preconditions holding and run inside one authorized session in the order Call 1 → Calls 2–4 → optional Call 5. Task 7 depends on whichever of Tasks 4–6 actually ran, and can also close the ticket honestly at the "preflight verified, no live run yet" terminal state if May's go never arrives. **External dependencies:** KPR-463 is **delivered** (Done at `6b993455`, R13–R19 landed); KPR-464 is Done (`165e434c`); KPR-465 is Done (`28619e03`). Both 464 and 465 still have live checks pending May. The former maturity blocked-dependency on a 463 architecture decision (`JOB_ACCOUNTING_UNAVAILABLE`) is gone — R14 settled confinement. **Execution** still blocks on (a) an actual T9-passed dodi identity with P1–P7 green (R17 — do not consume `6b993455` as T9), (b) the KPR-465 configuration decision or keep-cold-by-absence (R12; live comparison still pending; this plan still does not choose an arm), and (c) May's live-call go. Drafting and reviewing this R13–R19 revision does not require those three.

**Tech Stack:** existing offline CLIs (`scripts/read-voice-diagnostics.ts`, `scripts/voice-latency-compare.ts`), read-only `mongosh` queries against the instance DB, Slack as the user-request channel, Mokie's existing `contacts`/memory resolution and `voice-livekit` MCP tool, and the already-shipped Twilio → LiveKit → Deepgram/Cartesia stack (`src/voice-worker/*`, `src/channels/voice/voice-adapter.ts`). No new source files, no new `hive.yaml` keys, no vendor API calls, no test suite or build run by this plan itself.

**Authority:** [Approved spec](./kpr-466-spec.md) at commit `ff9ff7b0`, sha256 `f6de0e83b79d04c1592797705d55b1f47fea90048cf69610bfea9a3cddd8adef` (reconfirmed unchanged before this revision); planner-routing record (standard tier; reason: "Remaining work is an ordered acceptance runbook and sanitized evidence record… Planning consumes KPR-463's approved handoff without designing its unresolved deployment mechanism"; source `spec-review`); epic canon **R1–R19** and the R8 CORRECTION (KPR-462 Decision Register); Gate 1 delegation (2026-09-07). R1–R12 and the R8 CORRECTION remain as already consumed by the approved spec. Operator contract for the packaged pair (not T9 evidence): [kpr-463-operations.md](./kpr-463-operations.md) (status line matches R17).

**Binding canon R13–R19 (do not re-litigate):**

- **R13** — One `@keepur/hive` tarball: `pkg/voice-worker.min.js start` + frozen `pkg/deploy.min.js` + shrinkwrap; LiveKit/native packages external; engines.node `>=22.19.0`; Node 24 is T10 proof, not a support narrow. Voice-disabled instances still get the larger tree; no worker starts and no LiveKit keys required.
- **R14** — Artifact jobs are Seatbelt-confined, single-use, clone-on-promote; no descendant census as settlement; ordinary rollback needs no `sandbox-exec`.
- **R15** — Supported CLI/start/stop/update/rollback invoke this package's helper, never the target `deploy.sh` / `BUILD_DIR`; `HIVE_SINGLE_INSTANCE=1` execs the helper first; `hive update` does not skill-sync; single-label `launchctl kickstart -k` is not pair restart.
- **R16** — Planned rotation: 30s reversible admission barrier (local IPC, not SDK drain, no public control server, no force-kill); worker supervisor exit + listener release, then engine; start engine then worker.
- **R17** — Status verbatim `implementation verified; migration pending`. T9/T10/S12 not closed; no evidence file; **do not consume this SHA as T9**.
- **R18** — No-call packaged profile (identity, engine markers, missing-agent 400, SDK registration, containment) vs informational doctor (installed ≠ observed; no default vendor API); pilot recovery is a separate profile.
- **R19** — Conversation, warm default, tool-ack, vendors, and Mokie routing unchanged.

**Readiness:** DRAFT — **R13–R19 revision** of the previously clean round-6 plan at `169445c5` (plan-review round 6 approved; `ready-to-implement` withheld as blocked-dependency on then-In-Progress KPR-463). Epic head is now `6b993455ac34691bc79bfe4247cf780d708562b8`. This is not a "round 6 draft." Nothing in this plan assumes KPR-463 T9 has passed, that a KPR-465 configuration decision exists, or that May's go has been given. Task 1 is the only task this plan authorizes to run before T9 + May's go.

**Assumptions (spec not edited):**

1. Spec Key Points / §4.1 / §10 still name `JOB_ACCOUNTING_UNAVAILABLE` as ⚠ architecture-open; for planning this is **resolved-by-R14** — consume 463 evidence fields; confinement is Seatbelt / single-use jobs / clone-on-promote; no descendant census as settlement; hangup cleanup is never installer process accounting.
2. Spec §2's 2026-09-13 `~/github/kpr-320-live-call` + `dist/voice-worker/main.js` identity is historical; live eligibility is the packaged `.hive` pair versus anything else (R13/R15/R18), not that frozen path.
3. Merge SHA `6b993455` and operations.md status `implementation verified; migration pending` are not T9 (R17). `docs/epics/kpr-462/kpr-463-deployment-evidence.md` is still required and is still absent at this revision.
4. KPR-465 is Done at `28619e03` with live comparison still pending May; this plan keeps keep-cold-by-absence and does not choose an arm (R12/R19).
5. Node 24 is T10 proof, not a 466 support narrow (R13). 466 does not close T9/T10/S12.

## Ordering (binding)

```
Task 1 (offline — evidence-record skeleton)                              ← no gate, run any time
  → Task 2 (no-call preflight P1–P7, consume KPR-463 T9)                 ← LIVE-INSTANCE, no call
    → Task 3 (465 config readback + go + quiet window + stop procedure) ← LIVE-INSTANCE precondition
      → Task 4 (Call 1: I1 / L1 / X / B / T / H / C, + V if that's the outcome)   ← LIVE-CALL
        → Task 5 (Calls 2–4: L2 / L3 / L4, + V if that's the outcome)            ← LIVE-CALL
          → Task 6 (optional Call 5: V only)                                     ← LIVE-CALL, conditional
            → Task 7 (harvest, hypothesis table, final Status line)              ← closes the record
```

If May's go never arrives after Task 2 passes, Task 7 still runs and closes the record at `no-call preflight verified; live end-to-end acceptance pending` — that is a complete, honest stop, not a skip (spec §3.3).

## Standing invariants (apply to every task below; referenced, not repeated)

1. **Result vocabulary and honest grammar (spec §3.1–§3.2).** Use only `pass` / `fail` / `unknown` / `unobserved` / `pending` / `consumed`. None of a LiveKit dispatch id, worker job acceptance, an HTTP 200/SSE `[DONE]`, `sip_answered`, `engine_first_text`/TTS-TTFB/playout events, a clean speech handle, or a `voice_call_stats`/JSONL estimate may be recorded as `pass` on I1, L1–L3, X, B, or T — those rows need May's corroborating observation. `callerConfirmation` in JSONL stays `"unknown"`; human verdicts live only in the evidence record, keyed by call id and observation time, never back-filled from timestamps.
2. **Privacy classes (spec §7.2).** Three classes only: (a) controlled script text (the I1 lines, the L2 "hello", L3/L4 caller actions) — pre-agreed, no personal data, may be checked into the git evidence record; (b) sanitized human observations (first-audible class, pause three-way, booleans, per-turn correctness) — go in the git evidence record, never verbatim wording; (c) operator-only observations (verbatim wording, unparaphrased free text) — retained only outside git, even with May's ok. No transcript text, phone numbers, destination, tokens, tool arguments, ack phrase text, prompt bytes, or audio may appear in the git-committed evidence record.
3. **Voicemail/no-answer retry-once rule (spec §6.2).** A `no_sip_answer` or `answered_voicemail` classification on any required call keeps that attempt in the denominator, does not score L1–L4/X/B/T/H/C on that attempt, and earns exactly one retry of that scenario under the same go. An **unexpected destination** trips the stop rule instead and is never retried under that go.
4. **Stop rule (spec §7.1 item 5).** Identity/config drift, unexpected destination, lost correlation, or May's stop → hang up, keep the attempt in the denominator as failed/incomplete, do not retry under that go (except the retry in Invariant 3).
5. **R8 CORRECTION (epic canon).** Any before/after table in the evidence record that includes warm-opener `initToFirstTokenMs` must split at the KPR-465 boundary (`a0a026e0` and earlier: push → first text including boot; `687235f7`/`28619e03` and after: init → first text, boot in `bootToInitMs`). September 7 rows are cold (`warmPath: false`) and are never plotted as a 466 arm. `38506f03` is the docs-only correction commit, not a runtime cut.
6. **No re-design of KPR-463's packaged confinement (R14).** Artifact jobs are Seatbelt-confined (`/usr/bin/sandbox-exec`), single-use, clone-on-promote; settlement is the job's direct-child exit plus a verified clone — not a descendant census. Ordinary `hive rollback` needs no `sandbox-exec`. Consume only the required fields KPR-463's own spec §7 defines for its evidence record. Never invent a census helper, native guardian, or `JobRequest.accept()` bookkeeping shape as a 466 mechanism, and do not re-design the 463 confinement that already shipped. Hangup cleanup (H) is speech/lease/heartbeat evidence, never installer process accounting.
7. **No arm selection, no default flip, no numeric target.** This ticket reads back whatever KPR-465 decided (or keep-cold-by-absence); it never chooses warm/cold, never sets `effort`, and never writes a latency target.
8. **No unauthorized live operation.** No `hive update`, `hive rollback`, `launchctl kickstart`, or `scripts/livekit-setup.ts` invocation is authorized by this plan. Restart/rollback proof is `consumed` from KPR-463's own evidence file, never re-executed. If a pair restart is named as the supported 463 form, it is the frozen helper — `hive stop` then `hive start --daemon`, or `node <instance>/.hive/pkg/deploy.min.js --restart` (R15/R16; operations.md) — and this ticket still must not invoke that helper (or any single-label `launchctl kickstart -k`) to re-prove 463. R16's 30s reversible admission barrier and ordered bootout/start sequence are 463's rotation contract; this ticket does not exercise them. No dispatch or SIP participant is created outside an actual authorized call in Tasks 4–6.
9. **Session end state.** A session may not end with a lingering `hive.yaml` key or agent-definition field this ticket did not intend to keep (e.g., no stray `effort`/`voice.warmPath` edits — those belong to KPR-465's own apply/rollback, not this ticket).

## Testing Contract (plan-wide)

### Required Test Groups

- Unit: `not-required`
  - Scope: n/a — this ticket adds no source module.
  - Reason: spec §9: "This ticket is not expected to change `src/`." If plan review or execution discovers a one-line, content-free harvest helper is genuinely required (spec §9's example: a call-id filter that refuses to copy destination/transcript fields), it ships with its own unit suite mirroring the privacy tests at `src/voice/voice-diagnostic-reader.test.ts` (KPR-464 S9) / `src/voice/voice-latency-compare.test.ts` (KPR-465 R7) before it is used. That helper is **not assumed** by this plan.
  - Minimum assertions: n/a unless the contingency above is triggered, in which case: the helper never copies destination/transcript/phone/token fields, and a sentinel value for each proves it.
- Integration: `not-required`
  - Scope: n/a — no module boundary changes.
  - Reason: same as Unit.
- E2E: `required` (live) — status `pending` until a May-authorized session executes it; never recorded as a passing automated test.
  - Scope: the full acceptance protocol — no-call preflight (P1–P7), the smallest live call set (I1/V/L1–L4/X/B/T/H/C), warm/cold capture, and KPR-463 restart/rollback consumption (R).
  - Reason: only a heard, human-corroborated conversation on the packaged deployment satisfies the epic outcome; no machine signal substitutes (spec §3.2).
  - Harness: `setup-required` — a KPR-463 T9-passed dodi identity with P1–P7 green, the KPR-465 configuration readback, and May's explicit go. Eligibility is the live packaged `.hive` pair versus anything else (R13/R15/R18): `com.hive.dodi.agent` ProgramArguments must execute `<instance>/.hive/pkg/server.min.js` (no extra args) and `com.hive.dodi.voice-worker` must execute `<instance>/.hive/pkg/voice-worker.min.js start`. Spec §2's 2026-09-13 readback (`~/github/kpr-320-live-call` engine + `dist/voice-worker/main.js` worker) is historical pilot identity, not a frozen eligibility path. A `dist/` path, a git-checkout path (including `~/github/kpr-320-live-call`), or any other non-`.hive` ProgramArguments remains ineligible. Pilot recovery is a separate 463 profile (R18) and is not a 466 live identity. `hive doctor` green does not replace P1–P7.
  - Minimum assertions: every row in spec §6.1 (I1, V, L1–L4, X, B, T, H, C, R) carries a recorded result from Invariant 1's vocabulary, with call/speech/turn ids and a link to its sanitized JSONL slice or evidence-record entry; every P1–P7 row is recorded pass/fail before any dialing; the ticket's Status line is one of the four §3.3 terminal states.

### Critical Flows

- No-call preflight green → quiet-window confirmed → May's go → Call 1 (I1 bundle) → Calls 2–4 (L2/L3/L4) → optional Call 5 (V) → harvest → evidence closure.
- A required scenario landing `fail` after an authorized run stops the ticket at `live end-to-end acceptance failed`; it is filed as a defect, not silently retried or patched inside this ticket (spec §3.3) unless plan review approves a one-line, evidence-backed correction.
- A voicemail/no-SIP-answer classification on any required call triggers exactly one retry of that scenario under the same go (Invariant 3); an unexpected destination triggers the stop rule instead, with no retry.
- A KPR-465 configuration change observed after live rows are recorded invalidates those rows; a fresh go is required before reusing them (spec §4.3).

### Regression Surface

- No `src/` change is expected from this ticket; the deterministic suites already owned by KPR-463/464/465 must already be green going into the live session — confirmed via each ticket's own evidence record, not by re-running their suites here.
- `npm run check` runs only if the contingent harvest helper above is authored; it does not run for the protocol/evidence-record tasks themselves.
- No production `hive.yaml` key or agent-definition field may be left changed at session end that this ticket did not explicitly intend to keep (Invariant 9).

### Commands

- Harvest (operator, after each call, bounded 32 MiB per file — spec §7.2):
  ```text
  npx tsx scripts/read-voice-diagnostics.ts --input <call-filtered jsonl> --call-id <id>
  npx tsx scripts/voice-latency-compare.ts --input <jsonl> --call <id>=<arm> --engine-log <hive.log slice> --seed 20260913
  ```
  The `--call` `<arm>` must contain exactly one of `warm`/`cold` (`armKindOf` in `src/voice/voice-latency-compare.ts`); a label such as `465-setting` exits 2.
- Broader regression (only if the contingent harvest helper is built): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Live: no `hive update`, `hive rollback`, `launchctl kickstart`, frozen helper `--restart`, or `scripts/livekit-setup.ts` invocation is authorized by this plan (Invariant 8). Restart/rollback proof is `consumed` from KPR-463's own evidence file. `hive doctor` is informational only (R18: installed ≠ observed; no default vendor API) and is never a P1–P7 pass.
- Historical context only, never a comparand: `npx tsx scripts/voice-latency-baseline.ts ...` (canon R4; untouched, drops `warmPath: true` rows).

### Harness Requirements

- Read access to the deployed dodi instance's `hive.log` and the voice-worker log; read-only `mongosh` access to `telemetry` (`spawn_coordinator_stats`, `voice_worker_stats`), `meeting_worker_claims`, `sessions`, and `agent_definitions`.
- A scratch directory for call-filtered JSONL slices, bounded at 32 MiB per file (the reader's own limit).
- Slack access for May to message Mokie the call-me request (I1) and for the operator to relay the live-call go.
- May available and willing to answer the calls and give verdicts per spec §7.3.

### Non-Required Rationale

- Unit/Integration: no source module is added or changed by this ticket (spec §9); see the contingent exception above.

### Verification Rules

- Missing harness (no 463 T9-passed identity, no May's go) is a concrete blocker to record in the evidence record's Status line, never a silent skip (spec §3.3, first row). Merge SHA `6b993455` / operations.md `implementation verified; migration pending` is not a T9-passed identity.
- Never populate a human field (verdict, first-audible class, correctness mark) from machine timestamps; never promote a machine-green signal to a caller-observation `pass` (Invariant 1, spec §3.2).
- If live execution exposes a genuine product defect, file it; do not patch it inside this ticket unless plan review approves a one-line, evidence-backed correction (spec §3.3).
- No test — automated or otherwise — asserts that `docs/epics/kpr-462/kpr-466-acceptance-evidence.md` exists (spec §8, §9).

## Spec coverage ledger

| Spec item | Where covered |
| --- | --- |
| §3 Honest outcomes and terminal states | Standing Invariant 1; Task 7 closure rule |
| §4.1 KPR-463 consumption, no re-rotation | Task 2 |
| §4.2 KPR-464 L1–L4 repeat, no reuse of frozen pending rows | Task 4 (L1); Task 5 (L2–L4) |
| §4.3 KPR-465 configuration consumption, waterfall/fallback sequencing | Task 3 |
| §4.4 R8 CORRECTION warm-opener split | Standing Invariant 5; Task 7 |
| §5 No-call preflight P1–P7 | Task 2 |
| §6.1 Required scenarios (I1/V/L1–L4/X/B/T/H/C/R) | Tasks 4–6 (scenarios); Task 2 (R = consumed) |
| §6.2 Voicemail/answer classification + retry-once | Standing Invariant 3; Tasks 4–6 |
| §6.3 Smallest authorized call set | Tasks 4–6 |
| §7.1 Live execution preconditions and stop rule | Task 3; Standing Invariant 4 |
| §7.2 Privacy and harvest | Standing Invariant 2; every live task's harvest step |
| §7.3 Caller verdict (not blinded) | Task 4 (I1 verdict form); Task 5 (per-call confirmations) |
| §8 Evidence record | Task 1 (skeleton); Tasks 2–7 (population) |
| §9 Regression and testing contract | Plan-level Testing Contract |
| §10 Non-goals / delegated assumptions | "Explicitly out of scope" section below |

---

### Task 1 (offline, no gate): Evidence-record skeleton and terminal-state tracking

**Outcome / spec coverage:** A durable, sanitized evidence file exists at `docs/epics/kpr-462/kpr-466-acceptance-evidence.md` with every required section (spec §8) present and every live-dependent field marked `pending`, so later tasks only ever fill it in rather than deciding its shape. Covers spec §8 and §3.1/§3.3.

**Components and known files:**
- Create: `docs/epics/kpr-462/kpr-466-acceptance-evidence.md`
- Reference, do not duplicate: `docs/epics/kpr-462/kpr-463-deployment-evidence.md` (does not exist yet — see Task 2), `docs/epics/kpr-462/kpr-465-latency-evidence.md`, `docs/epics/kpr-462/kpr-464-startup-evidence.md`
- Sibling shape to follow: `docs/epics/kpr-462/kpr-465-latency-evidence.md`'s section skeleton, built the same way in `kpr-465-plan-execution.md` Task E1 — same pattern, applied here to this ticket's own §8 section list.

**Dependencies:** None. Offline; may run immediately regardless of KPR-463/465 state.

**Interfaces, compatibility, and invariants:** Standing Invariant 2 throughout. The Status line must be exactly one of the four §3.3 terminal states, or — before any of those is reachable — an honest statement naming the actual blocker (for example, "463 T9 not yet passed as of `<date>`; preflight not attempted"). Never invent a fifth ticket-terminal state name.

**Acceptance criteria:** The file contains, in order, the nine sections from spec §8: (1) status line; (2) build/pins and running identities; (3) KPR-465 configuration input and readback; (4) P1–P7 preflight table; (5) KPR-463 T9 consumption; (6) session log; (7) per-scenario §6.1 table; (8) confirmatory compare CLI output for I1 with the R8-split statement; (9) hypothesis-versus-observation for September 7. Every live-dependent cell reads `pending`. The file contains none of the content Standing Invariant 2 prohibits.

**Verification:**
- Tests and critical failure cases: none automated — spec §8/§9 state no test asserts this file exists. Manually confirm all nine sections are present and no prohibited content appears.
- Harness/environment: none — offline documentation.
- Run: n/a.
- Expected: a reviewer can read the skeleton and know exactly which of the four §3.3 terminal states the ticket is in, without cross-referencing the spec.

- [ ] Create the file with the nine §8 sections, today's honest blocker status, and every live field `pending`.
- [ ] Confirm no prohibited content (Standing Invariant 2) appears anywhere in the file.
- [ ] Commit (`docs(kpr-466): acceptance evidence-record skeleton`).

### Task 2 (LIVE-INSTANCE, no call): No-call preflight — consume KPR-463 evidence and rerun P1–P7

**Outcome / spec coverage:** Establishes, per session, whether the currently running dodi identity is eligible for dialing at all. Covers spec §4.1 (KPR-463 consumption) and §5 (P1–P7), and the first honest terminal state in §3.3.

**Components and known files:**
- `docs/epics/kpr-462/kpr-463-deployment-evidence.md` — required T9 input; consumed, never re-verified by rerunning `hive update`/`hive rollback`/frozen helper `--restart`/`launchctl kickstart` (Standing Invariant 8). Merge SHA `6b993455` and [kpr-463-operations.md](./kpr-463-operations.md) are not this file (R17).
- KPR-463 spec §6 packaged-release profile and §7 required T9 fields — read, not re-derived (Standing Invariant 6 / R14).
- Live launchd identities `com.hive.dodi.agent` and `com.hive.dodi.voice-worker`. Expected live ProgramArguments (R13/R15, operations.md): engine `<instance>/.hive/pkg/server.min.js` (no extra args); worker `<instance>/.hive/pkg/voice-worker.min.js start`. Spec §2's 2026-09-13 `~/github/kpr-320-live-call` / `dist/voice-worker/main.js` readback is historical; current eligibility is the packaged `.hive` pair versus anything else. A `dist/` or git-checkout ProgramArguments (including that pilot path) remains ineligible. Pilot-recovery is a separate profile (R18) and is not a 466 live identity; an unresolved non-`.hive` path marks 463 incomplete and 466 must not dial on it.
- `src/channels/voice/voice-adapter.ts` (P3 bridge-auth probe target), `src/voice-worker/worker-config.ts` (P6 cell-defaults heartbeat), `src/cli/doctor.ts` `renderVoiceWorkerSection` (R18: informational only — installed ≠ observed; no default vendor API; doctor green is not sufficient by itself and never replaces P1–P7).
- `scripts/livekit-setup.ts` — must **not** be run (P5).

**Dependencies:** Task 1's skeleton exists to receive the results. Does not depend on Task 3 — this is explicitly a no-call check (spec §5) and does not need May's live-call go. Rerun whenever the identity may have changed since the last pass in this ticket's history (any `hive update`, restart, or config edit); a same-session prior pass may be reused only if nothing changed.

**Interfaces, compatibility, and invariants:** Standing Invariants 1, 2, 6, 8. A P4/P7 field's exact shape is whatever KPR-463's own evidence table defines for those fields (spec §5, P4/P7 "as the 463 evidence table defines these fields") — do not invent a different definition here. Keepur must remain untouched throughout (inherited from KPR-463). `hive doctor` is informational only (R18: installed ≠ observed; no default vendor API) and does not replace any P-row.

**Acceptance criteria:**
1. KPR-463 T9 confirmed passed from `docs/epics/kpr-462/kpr-463-deployment-evidence.md` — actual dodi migration, paired restart via the frozen helper (`hive stop` then `hive start --daemon` / `node <instance>/.hive/pkg/deploy.min.js --restart` as 463 recorded — 466 does not re-invoke it), rollback/reapply, and final readback all recorded. Merge SHA `6b993455ac34691bc79bfe4247cf780d708562b8` (keepur/hive#491) and operations.md status `implementation verified; migration pending` are **not** T9 (R17); T9/T10/S12 are not closed; do not consume that SHA as T9. If the evidence file is missing or T9 is not recorded as passed: **stop** — update the evidence record's Status line to name that blocker and do not proceed further in this task.
2. Every one of P1–P7 recorded pass/fail with its required evidence, against the CURRENT live PIDs/args/paths (an intervening update invalidates a prior pass).
3. Restart/rollback recorded `consumed` from KPR-463's T9 rows (link + digest), never re-executed.
4. A failed required P-row stops the session — no dialing — and is recorded as such; the Status line advances to `no-call preflight verified; live end-to-end acceptance pending` only when every required P-row passes.
5. `hive doctor` (Voice worker section or otherwise) is never recorded as a substitute for any P-row; installed ≠ observed (R18).

| ID | Check | Required evidence | Does not establish |
| --- | --- | --- | --- |
| P1 | Artifact and process identity | 463 evidence digest + live launchd PIDs, ProgramArguments, working directory, config selector; ProgramArguments are the packaged pair — engine `<instance>/.hive/pkg/server.min.js` (no extra args) and worker `<instance>/.hive/pkg/voice-worker.min.js start` (R13/R15); engine/worker boot identities match that activation; `@livekit/agents` 1.6.4; Node version; UTC clock basis | Package files on disk without live PIDs; a `dist/` or git-checkout ProgramArguments (including `~/github/kpr-320-live-call`); `hive doctor` green (R18: informational, installed ≠ observed) |
| P2 | Engine boot | Fresh `Hive starting up` then `Hive is running` scoped to the current PID, still alive at the final check | A stale prior-boot line |
| P3 | Bridge authentication | From the packaged worker environment: valid bridge token + `POST /v1/chat/completions` body `{}` → missing-agent 400; wrong/missing token → 401 (or 403 if Vapi unset). No model spawn; log status/classification only | Conversation, provider auth, audio |
| P4 | Worker registration | Current supervisor PID, fresh identity heartbeat, SDK `/` 200, `/worker` reports `hive-voice`, health socket owned by that supervisor — as 463's evidence table defines these fields | Heartbeat written before registration; `/worker` alone |
| P5 | Twilio / LiveKit outbound setup | Read-only LiveKit auth + lookup of the configured outbound trunk id; config relationship to the Twilio trunk/number (names/ids only); Mokie's `voice-livekit` routing preserved. Do **not** run `scripts/livekit-setup.ts`. Do **not** create a dispatch or SIP participant | PSTN delivery, CNAM, audible speech |
| P6 | Deepgram / Cartesia | Worker actually running (P1/P4) implies boot-time key presence; heartbeat `cell-defaults` name Flux + Sonic 3 (or explicit overrides); Mokie has a Cartesia voice mapping (boolean). No vendor HTTP | That STT/TTS will be heard |
| P7 | Loaded-artifact containment | Realpaths of loaded Hive, LiveKit job helpers, RTC/native libraries, and Silero model asset remain inside the selected instance release — as 463's evidence table defines these fields. A directory name, or success via a parent/global `node_modules` tree or a non-`.hive` / `dist/` / git-checkout layout, is insufficient | Package files on disk; P1 without containment; `hive doctor` green |

**Verification:**
- Tests and critical failure cases: a stale prior-boot line must not satisfy P2; a heartbeat written before registration must not satisfy P4; package files on disk without live PIDs must not satisfy P1; a `dist/` or git-checkout ProgramArguments (including `~/github/kpr-320-live-call`) must not satisfy P1; `hive doctor` green must not satisfy any P-row (R18); success via a parent/global `node_modules` tree or a non-`.hive` / `dist/` / git-checkout layout must not satisfy P7 — that is the failure mode recorded at spec-drafting (LaunchAgents pointed at the historical `~/github/kpr-320-live-call` pilot). Eligibility is the packaged `.hive` pair versus anything else, not that frozen 2026-09-13 path.
- Harness/environment: live read access to launchd (whatever readback commands KPR-463's own evidence file names for P1/P4/P7), the current `hive.log`/worker log, and the packaged worker's environment for the P3 probe.
- Run: KPR-463's own evidence-file commands for P1/P4/P7 identity fields; for P3, a `POST /v1/chat/completions` with an empty body `{}` against the bridge from the packaged worker's environment.
- Expected: seven recorded pass/fail rows plus a T9-consumption line, all against the SAME identity readback — never mixing a pre-update PID with a post-update artifact digest.

- [ ] Read `kpr-463-deployment-evidence.md`; confirm T9 passed. Do not treat merge SHA `6b993455` or operations.md `implementation verified; migration pending` as T9. If the file is missing or T9 is not recorded as passed, stop and record the blocker.
- [ ] Rerun P1 (identity), P2 (boot), P3 (bridge auth), P4 (worker registration), P5 (Twilio/LiveKit read-only setup — no dispatch/SIP participant), P6 (Deepgram/Cartesia presence — no vendor HTTP), P7 (loaded-artifact containment) against the current live identity.
- [ ] Record restart/rollback as `consumed` from KPR-463's T9 rows.
- [ ] Update the evidence record's Status line per the acceptance-criteria rule; stop the session (no dialing) on any required-row failure.
- [ ] Commit the evidence-record update (`docs(kpr-466): preflight P1-P7 recorded for <date> session`).

### Task 3 (LIVE-INSTANCE precondition): KPR-465 configuration readback and live-session preconditions

**Outcome / spec coverage:** Establishes the remaining preconditions for dialing — the KPR-465 configuration readback, May's go, a confirmed quiet window, and the stop procedure in hand — so Tasks 4–6 proceed on a fully authorized, drift-free basis. Covers spec §4.3 and §7.1.

**Components and known files:**
- `docs/epics/kpr-462/kpr-465-latency-evidence.md` §9 "Decision, target provenance, rollback" (the decision register entry, if any — that file's §6 is "Per-turn correctness", not the decision) or the epic canon's KPR-465 decision line. KPR-465 **spec** §6.4 is the *procedure* for writing that decision, not the evidence-file section that records it — reading spec §6.4 instead of evidence §9 risks treating an applied E6 decision as absent.
- Dodi's live `hive.yaml` readback (`voice.warmPath`, `voice.livekit.endpointing`, `defaultStt`/`defaultTts`), Mokie's `effort` field and model via `agent_get mokie`, `@livekit/agents` version pin (spec §7.1 item 3 lists model alongside warm/effort/endpointing/Cartesia-mapping/SDK-pin — do not drop it from the readback).
- `db.telemetry` (`spawn_coordinator_stats`), `db.meeting_worker_claims`.

**Dependencies:** Task 2 passed for this session.

**Interfaces, compatibility, and invariants:** Standing Invariants 3, 4, 7, 9. A KPR-465 configuration change observed after this readback invalidates it — re-run this task before dialing again. **Must-never live-setting gate (spec §4.3 Forbidden; §7.1 closing sentence):** if the live `hive.yaml`/Mokie `effort` readback does not match the KPR-465 written decision (or does not reflect keep-cold-by-absence when no decision exists), or a KPR-465 arm switch is observed in flight, **stop here** — never `launchctl kickstart`, never `hive update`/`hive rollback`, and never `node <instance>/.hive/pkg/deploy.min.js --restart` (or `hive stop` then `hive start --daemon`) to align them as a 466 proof (Standing Invariant 8); return to KPR-465 instead. This gate is checked before May's go is treated as sufficient to dial.

**Acceptance criteria:**
- 465 sequencing determined: if KPR-465 spec §6.4 / the epic canon carries a written decision (warm on + effort level, or explicit keep-cold), read it back on the live identity; otherwise "keep-cold by absence" applies and is recorded as such — this ticket does not choose an arm itself.
- The live-setting gate above holds: the readback matches the decision (or keep-cold-by-absence) and no arm switch is in flight. If it does not hold, this task stops without proceeding to May's go.
- May's go for this specific session is in hand (not Gate 1, not a prior session's go).
- Quiet window confirmed via the query below, or the specific accepted residuals recorded instead of waited out.
- Stop procedure understood by the operator before the first call (Standing Invariant 4).

**Verification:**
- Tests and critical failure cases: a live call must never start while `activeSpawns > 0` or `warmVoiceSessions > 0` for any agent, or while a `meeting_worker_claims` document reports `status: "running"`, except two accepted residuals: a turn starting inside the ≤ 30s heartbeat window, and a claim-free scribe `runRoleTurn` — record which applied rather than waiting indefinitely.
- Harness/environment: read-only `mongosh` access.
- Run:
  ```bash
  mongosh "$MONGO_URI" --quiet --eval '
    const fresh = new Date(Date.now() - 30_000);
    const rows = db.telemetry.find({ kind: "spawn_coordinator_stats", updatedAt: { $gte: fresh } }).toArray();
    printjson(rows.map(r => ({ agent: r.agentId, activeSpawns: r.activeSpawns, warmVoiceSessions: r.warmVoiceSessions ?? 0, updatedAt: r.updatedAt })));
    print("running claims:", db.meeting_worker_claims.countDocuments({ status: "running" }));'
  ```
  (same query shape as KPR-465's own quiescence check — that query is already unfiltered across agents, so this reuses it rather than generalizing it).
- Expected: every row shows `activeSpawns: 0` and `warmVoiceSessions: 0`; `running claims: 0`; no live call already up.

- [ ] Read back the KPR-465 configuration decision (or record keep-cold-by-absence) on the live identity; write it to evidence §3.
- [ ] Confirm the readback matches the decision (or keep-cold-by-absence) and no 465 arm switch is in flight; if either fails, **stop** — do not kickstart, do not invoke the frozen helper `--restart`, and do not otherwise rotate services — and return to KPR-465 instead of proceeding to May's go.
- [ ] Confirm May's go for this session; record who gave it and when.
- [ ] Run the quiet-window query; record the result or the accepted residual that applied.
- [ ] Confirm the stop procedure is understood before dialing.
- [ ] Commit the evidence-record update.

### Task 4 (LIVE-CALL): Call 1 — initiation, opening, exchange, barge-in, tool, hangup, capture (I1 / L1 / X / B / T / H / C, + V if that's the outcome)

**Outcome / spec coverage:** The largest evidentiary call: Mokie places an outbound call from a Slack request without digits, and the session evaluates the audible opening, two-turn exchange, one barge-in, one read-only tool ack, a clean hangup, and warm/cold capture. Covers spec §6.1 rows I1, L1, X, B, T, H, C (and V if that's the outcome), §6.2, §6.3 Call 1, §7.2/§7.3.

**Components and known files:**
- `src/voice/livekit-voice-mcp-server.ts` — `voice_call` builds the dispatch (`hive-voice`, room `call-<uuid>`); the initiation proof is dispatch id + call id, not `lk dispatch create` and not the Vapi `voice_call`.
- `src/contacts/contacts-mcp-server.ts` — `contacts_search`/`contacts_get` print formatted numbers; stored E.164 is not in tool text, so resolution is a genuine agent behavior, not a copied field. The user request must not contain digits.
- `src/voice-worker/session.ts` (SIP answer via `createSipParticipant(..., { waitUntilAnswered: true })`; hangup/cleanup via `closeCall`), `src/voice-worker/startup-arbiter.ts` (L1 opening), `src/voice-worker/telemetry.ts` (`noteCallEnded`/`activeCalls`, `VoiceWorkerHeartbeat.INTERVAL_MS`).
- `src/agents/warm-voice-session.ts` (`WARM_IDLE_TIMEOUT_MS` = 120s, applies if warm per Task 3's readback).
- Harvest: `scripts/read-voice-diagnostics.ts`, `scripts/voice-latency-compare.ts`.

**Dependencies:** Task 3's preconditions hold for this session.

**Interfaces, compatibility, and invariants:** Standing Invariants 1–4. The I1 caller script (six controlled lines, spec §6.1) is pre-agreed, no-personal-data text; it may be checked into the evidence record at execution but is never harvested from the model or STT.

**Acceptance criteria** (per spec §6.1/§6.2, one call):
1. **I1** — May messages Mokie in Slack to call her without stating digits; Mokie resolves the destination via contacts/memory and invokes `voice_call`; the record captures the dispatch id + room/call id and confirms the agent is Mokie, with the destination itself never written down; May confirms the ringing handset was her known line and that Mokie did not ask for the number.
2. **V (if applicable)** — classify per spec §6.2 (`no_sip_answer` / `answered_voicemail` / `answered_human` / `unclassified`). If `no_sip_answer` or `answered_voicemail`: do not score L1/X/B/T/H/C on this attempt; retry once under the same go (Standing Invariant 3).
3. **L1** — May answers and stays quiet through startup; record exactly one relevant opening, complete attempt accounting, and May's first-audible words with no prolonged unexplained silence. Keep generated-audio/worker-playout evidence rows distinct from May's handset-receipt report in the evidence record (the September 7 trap: a clean playout event is not proof the handset received it); git gets the sanitized first-audible class (§7.2), never verbatim wording.
4. **X** — two short factual questions per the script; May marks each answer correct/wrong/missing; ≥ 2 completed non-interrupted `sdk_response` speeches bound to turn ids; the `warm` flag matches Task 3's readback.
5. **B** — one mid-sentence interruption on the longer script line; the interrupted speech terminal reads `interrupted`; the replacement progresses; May confirms nothing replayed.
6. **T** — one turn forcing Mokie's actual read-only tool (prefer `conversation_search`; `contacts_search` acceptable, naming May, never a number); `toolCount ≥ 1`; `toolAckInjected: true` is recorded as machine evidence that an ack was injected but is never by itself sufficient for T `pass` — T is one of Standing Invariant 1's rows needing May's corroborating observation (spec §3.2: "I1, L1–L3, X, B, or T"), so T `pass` additionally requires May to confirm she heard an acknowledgement or brief spoken hold **and** a spoken result, then normal talk resumed; record `bridge_terminal.maximumGapMs` when present (spec §6.1 T).
7. **H** — goodbye and hangup; `call_closed`; every started attempt terminal or explicit incomplete; no `speech_started`/engine write/generated frame after close; `voice_worker_stats.activeCalls` returns to its pre-call value on a document whose `updatedAt` postdates hangup — `activeCalls` is decremented by `noteCallEnded` at job teardown, never by the 30s supervisor `writeOnce` tick (which `$set`s `cellDefaults`/`updatedAt` only), so a post-hangup `writeOnce` alone with a stale counter is neither H pass nor H fail; wait for the post-hangup heartbeat that actually reflects teardown rather than sampling immediately; if warm, wait for `warmVoiceSessions == 0` or the 120s idle timeout — that timer arms at the warm lease's **last turn result** (`armIdleTimer` in `consumeOneTurn`'s `finally`, in `src/agents/warm-voice-session.ts`), not at the hangup event itself, so it is typically already counting down before the caller hangs up; treating "up to 120s after hangup" as the outer bound for `warmVoiceSessions == 0` is a safe upper wait, not a race, and there is no separate clock to restart at hangup. **H's own `pass`/`fail` is decided from this machine-cleanup evidence alone — spec §6.1 H: "Machine-only rows may `pass` without audio" — and does not require May's corroboration.** Record May's late-speech observation as a separate item: if she reports late speech occurred, that is a defect and fails H (see Verification below); if she reports none, record that as corroboration; if she gives no report at all (call ended before she could observe, or it was not asked), record "late speech: `unknown`" without demoting H's own machine-based result.
8. **C** — record `voice.warmPath.enabled`, Mokie's `effort`, endpointing presence, and the JSONL `warm`/`selectedContinuity` fields; run the confirmatory compare CLI on this call's id with `--call <id>=<arm>` where `<arm>` names the arm Task 3 actually read back (warm or cold) — never an arbitrary label. **C's pass/fail rule is the arm's own consistency object, never the CLI's exit code or the report's top-level `ok`:** read the per-arm `ArmReport.consistency` object (produced via `armKindOf`'s per-arm classification, in `src/voice/voice-latency-compare.ts`) for the arm entry matching this call's label — `consistency.failure === "warm_arm_has_cold_steady_turn"` (warm-labelled arm, a steady turn not `warm: true`) or `"cold_arm_has_warm_steady_turn"` (cold-labelled arm, any steady turn `warm: true`) is C `fail`; `consistency.ok === true` (`failure === null`) on that arm is C `pass`. Do **not** derive C from `CompareReport.ok` or the CLI's process exit code: `CompareReport.ok` is `failures.length === 0` over the whole report, and `CompareReport.failures` also collects `call … is incomplete` and `call … has no engine attempts` strings that are independent of capture consistency — an H entity that is legitimately "explicit incomplete" per spec §6.1 H, or an unrelated diagnostic gap on a different call in the same input, can make `CompareReport.ok` false and the CLI exit non-zero (the CLI in `scripts/voice-latency-compare.ts` maps a false `report.ok` straight to its exit code) on a run whose C-relevant arm consistency is otherwise clean. If the same run's `CompareReport.failures` also names an incomplete-call or no-engine-attempts condition for this call, record that fact alongside C (it may simply be H's legitimate explicit-incomplete outcome, or a harness gap to investigate) without letting it override C's own `consistency.ok` reading. Record May's pause verdict (acceptable/borderline/annoying) as an observation only, never a pass/fail input for C (spec §4.3).

**Verification:**
- Tests and critical failure cases: an unexpected destination trips the stop rule (no retry); a `fail` on any required row (wrong destination, late speech after hangup, duplicate/stale opening, tool claimed but never ran, leftover warm session, or C's `warm_arm_has_cold_steady_turn`/`cold_arm_has_warm_steady_turn` capture-consistency failure) stops the ticket at `live end-to-end acceptance failed` for this run, filed as a defect rather than patched in-ticket.
- Harness/environment: Slack (May's request to Mokie), the live dodi identity from Tasks 2–3, May available to answer and give verdicts.
- Run: the I1 six-line controlled script (spec §6.1: quiet through opening; one short factual question with a go-time expected keyword; one second short factual question; one longer prompt interrupted mid-sentence; one lookup prompt naming the chosen tool's job without personal data; goodbye and hangup); the harvest commands from the plan-level Testing Contract, scoped to this call's id, with `--call <id>=<arm>` labeled per Task 3's readback.
- Expected: 7–8 recorded rows (I1, L1, X, B, T, H, C, and V if the outcome required it) each with call/speech/turn ids, a result from Invariant 1's vocabulary, and a link to its sanitized JSONL slice; the caller-verdict form (spec §7.3) filled in.

- [ ] Have May message Mokie in Slack with no digits in the request; confirm Mokie resolves via contacts/memory and invokes `voice_call`; record the dispatch id + call/room id (never the destination).
- [ ] Observe and classify the call per §6.2; if voicemail/no-answer, retry once under the same go before proceeding.
- [ ] Run the six-line script and capture May's live observations per §7.3 as they happen.
- [ ] After hangup, wait for the post-hangup `activeCalls` heartbeat that reflects `noteCallEnded` teardown (not merely a fresh supervisor `writeOnce` tick) — and, if warm, `warmVoiceSessions == 0` (the idle timer already started at the last turn's result, not at hangup, so up to ~120s after hangup is a safe wait, not a reset clock) — before declaring H closed.
- [ ] Harvest and sanitize this call's JSONL slice; run the compare CLI with the arm label matching Task 3's readback (a mismatched or arbitrary label is a harness error, not a valid C capture); read C's result from that arm's `consistency.ok`/`consistency.failure` in the JSON output, never from the process exit code or the top-level `report.ok` (a legitimate H explicit-incomplete entity, or an unrelated diagnostic gap, can make `report.ok` false without being a C failure); paste sanitized results plus the caller-verdict form into evidence §6/§7 (sanitized classes and booleans in git; verbatim wording only in the operator-only record outside git, with May's ok).
- [ ] Commit the evidence-record update for Call 1.

### Task 5 (LIVE-CALL): Calls 2–4 — startup regression (L2, L3, L4), + V if that's the outcome

**Outcome / spec coverage:** Repeats KPR-464's three remaining live startup scenarios on the deployed identity (canon R5) — early "hello" (L2), opening-start replacement (L3), and hangup during startup (L4) — each as its own short call, using Mokie's `voice_call` as initiation (a CLI dispatch is not a substitute). Covers spec §6.1 rows L2–L4, §6.2, §6.3 Calls 2–4, §7.2/§7.3.

**Components and known files:**
- Same worker/session/startup-arbiter surfaces as Task 4.
- `docs/epics/kpr-462/kpr-464-startup-evidence.md` §Live status for the L3/L4 caller-action definitions (unchanged since KPR-464).
- L2 classification reads only content-free JSONL fields: `caller_final_input.hasFinalInput`, `opening_decision` `decision`/`reason`, `caller_turn_accepted`, speech `origin`/`speechId`, `speech_terminal` `outcome`/`cause`, and the `startup_superseded` cancel cause — never transcript or prompt text.

**Dependencies:** Task 3's preconditions hold for this session (or are re-confirmed if this task runs in a later session than Task 4).

**Interfaces, compatibility, and invariants:** Standing Invariants 1–4. Call 2 is scored only on an `answered_human` attempt: classify §6.2 V first (Standing Invariant 3, mirroring Task 4's I1/V step) — a `no_sip_answer`/`answered_voicemail` attempt gets no L2 classification at all (neither Stage 1 nor Stage 2) and instead uses the retry-once rule. L2 scoring itself: do **not** copy KPR-464's frozen "no optional opening" cell (spec §4.2, canon R6) — L2 finalizes in two stages. **Stage 1 (JSONL-only):** check the defect condition in the classification table below; a match is `fail` on its own, regardless of May's report — the one case the classification table alone finalizes L2; that `fail` closes only L2's own classification, not the call or the task — harvest and Calls 3–4 still proceed. **Stage 2 (only when Stage 1 does not match):** classify the ordering into one of the four pass-track/`unknown` classes — each written to exclude the Stage-1 defect condition by its own wording — then finalize strictly from the corroboration table that follows, whose `pass` rows additionally require the matching class's own Stage-2 machine-side condition (exactly one caller-owned response/replacement, complete attempt accounting) to hold on this attempt. A Stage-2 class's result is never finalized from the classification table alone, and a Stage-1 `fail` is never re-derived from, or softened by, the corroboration table, which carries no row for it.

**Acceptance criteria:**

**Call 2 — L2.** May says hello immediately before or at answer, as the live caller action (itself controlled script text) — this happens regardless of how the attempt later classifies, the same live-action-first sequencing already used for Calls 3–4 (spec §6.1 L2's caller action). Classification and scoring happen afterward, from the evidence: classify §6.2 V — if this attempt classifies `no_sip_answer` or `answered_voicemail`, record V per §6.2, retry the call once under the same go, and do not classify or score L2 — neither Stage 1 nor Stage 2, no L2 result — on this attempt (an unanswered or voicemail pickup can still emit opening/`speech_terminal` JSONL events that would otherwise misfire the Stage-1 defect check); this skips only L2's scoring — still harvest this call and proceed to Calls 3–4. On a retry that classifies `answered_human`, re-enter this same hello-at-answer path and the two-stage scoring below on that retry. Only once an attempt classifies `answered_human` does the two-stage classification below apply, scoring the hello already said at/before answer. Classify from the JSONL fields above in two stages, Stage 1 always first — both classification steps alone may be done from JSONL:

**Stage 1 — JSONL-only defect check, checked before any Stage-2 classification:**

| Condition | Result |
| --- | --- |
| Suppression was required (final or accept before request) but an opening was still requested; or a late-final opening remained queued behind the replacement instead of being cleared before it proceeded; or the replacement required another utterance before it was accepted; or a distinct, later `origin: "opening"` speech — a second, different `speechId` from the original opening's — replayed only after the replacement had already progressed (this excludes the original opening's own overlapping `speech_terminal`, which the late-final classes' allowed `heard_both` already covers) | `fail` |

If this row's condition holds, record L2 `fail` immediately — do not classify into a Stage-2 class and do not consult the corroboration table below. This is the one case a table alone finalizes L2 (spec §3.1: "machine evidence shows a defect on a call the caller also experienced"). This `fail` concludes only L2's own classification for this attempt — it is not an instruction to stop the task: this call's harvest still runs, and Calls 3–4 still proceed on their own preconditions.

**Stage 2 — ordering classification, only reached when the Stage-1 row above did not match:**

| Class | Condition (excludes the Stage-1 defect condition by construction) | Machine-side result condition |
| --- | --- | --- |
| `l2_suppressed` | Nonempty final and/or accepted-turn occurs before any opening request, **and no opening was requested** | Ordering supports `pass` when exactly one caller-owned response proceeds and attempt accounting is complete |
| `l2_late_final_replaced` | Opening requested, then nonempty final arrived, then application cancellation wrote `startup_superseded` on the opening's `speechId`, **with that opening not left queued behind the replacement and no extra utterance needed to proceed** | Ordering supports `pass` when exactly one opening is requested then superseded and exactly one replacement proceeds (Stage 1 already ruled out a later stale replay). A brief heard-both is not `fail` |
| `l2_late_final_sdk_interrupted` | Same ordering, but the SDK already interrupted or settled the opening before acceptance (no cancel marker written), **with that opening not left queued behind the replacement and no extra utterance needed to proceed** | Ordering supports the same `pass` condition, identified by the opening's own `origin: "opening"` speechId whose `speech_terminal` `outcome` is `interrupted` (cause may be `unknown`) **or** `completed` — either counts, not `interrupted` only — ordered before acceptance; never by ordering against a speculative replacement's `speech_started` (Stage 1 already ruled out a later stale replay) |
| `l2_ordering_unknown` | Decision events missing, or interim-only/empty-final ordering | `unknown` — never `fail`; required L2 coverage incomplete on this attempt |

**L2 is one of Standing Invariant 1's rows (spec §3.2: "I1, L1–L3, X, B, or T" need May's corroborating observation) for its four Stage-2 classes — a Stage-2 "machine-side result condition" above is never itself a recorded `pass`, and never itself a recorded `fail` either: the JSONL ordering class only narrows which of `pass`/`fail`/`unknown` is reachable once May's report is in hand.** The one exception is Stage 1 above (suppression required but an opening still requested; a late-final opening left queued behind the replacement; a replacement that needed an extra utterance; a later stale opening replayed) — that is machine evidence of a defect on a call May experienced (spec §3.1) and is `fail` on its own, independent of what she reports, decided before Stage 2 is ever reached. For the four Stage-2 classes, finalize strictly from the corroboration table below — never from "does the machine class and caller class agree" as an ad hoc judgment call, and never by silently downgrading a mapped `fail` cell to `unknown`. `l2_ordering_unknown` is `unknown` regardless of caller input, per spec's own "never `fail`" rule for that class (the dispatcher's round-2 shorthand for this class is "unclassified" — spec's actual name is `l2_ordering_unknown`, used throughout). Any of the first three Stage-2 classes, once caller-corroborated to `pass` by the table below, completes required L2 coverage; Call 2 is still required even after a late-final pass (it does not absorb L3).

**L2 corroboration mapping (executable — finalizes L2's result for the four Stage-2 classes; a Stage-1 defect is already `fail` before this table is ever consulted).** Every `pass` row below additionally requires this attempt's own Stage-2 machine-side result condition to hold — exactly one caller-owned response/replacement, complete attempt accounting (the middle column of the Stage-2 table above). Caller class is necessary but not sufficient: if that machine-side condition does not hold on this attempt (for example, a second caller-owned replacement occurred) and no Stage-1 defect matched, the result is `unknown`, never `pass`, regardless of which caller-class row below would otherwise apply:

| Ordering class (from the table above, JSONL only) | May's stale-replay report | May's sanitized first-audible class (§7.2) | L2 result | Basis |
| --- | --- | --- | --- | --- |
| `l2_suppressed` | stale replay reported | (any) | `fail` | This class's `pass` condition requires "no stale replay" (spec §6.1 L2 row); a caller-reported defect on an experienced call is `fail` (§3.1) |
| `l2_suppressed` | none reported | `heard_opening` or `heard_both` | `fail` | An opening was heard even though this class means none should have been requested — the caller-corroborated instance of the defect row's "suppression was required...but an opening was still requested" |
| `l2_suppressed` | none reported | `heard_greeting_response` | `pass` | Matches spec's stated pass condition for this class exactly: "Caller sanitized class is greeting-response, not an opening, with no stale replay" |
| `l2_suppressed` | none reported | `heard_none` or `heard_other` | `unknown` | No positive corroboration that the required single caller-owned response actually reached her, and not one of spec's named defects — defaults to `unknown` per Standing Invariant 1 |
| `l2_late_final_replaced` | stale replay reported | (any) | `fail` | Same basis as the `l2_suppressed` stale-replay row — "no later stale opening replayed" is required across all three pass-track classes |
| `l2_late_final_replaced` | none reported | `heard_both` or `heard_greeting_response` | `pass` | Spec explicitly allows a brief opening before the reply (`heard_both`, "not L2 `fail`"); the reply alone (`heard_greeting_response`) also corroborates "exactly one caller-owned replacement proceeds" when the brief opening wasn't perceptible |
| `l2_late_final_replaced` | none reported | `heard_opening`, `heard_none`, or `heard_other` | `unknown` | The required replacement is not corroborated as having reached her; this is not one of spec's explicitly named machine-detected defects, so it stays `unknown` rather than `fail` |
| `l2_late_final_sdk_interrupted` | stale replay reported | (any) | `fail` | Same basis as `l2_late_final_replaced` |
| `l2_late_final_sdk_interrupted` | none reported | `heard_both` or `heard_greeting_response` | `pass` | Same basis as `l2_late_final_replaced` |
| `l2_late_final_sdk_interrupted` | none reported | `heard_opening`, `heard_none`, or `heard_other` | `unknown` | Same basis as `l2_late_final_replaced` |
| `l2_ordering_unknown` | (any) | (any) | `unknown` | Spec: "`unknown` — never `fail`... required L2 coverage is not complete on this attempt" — categorical, regardless of caller input |

No report from May at all (call ended before she gave one) reads as "none reported" with no first-audible class — i.e. `unknown` on every row above except the three explicit stale-replay `fail` rows (one per Stage-2 pass-track class — `l2_suppressed`, `l2_late_final_replaced`, `l2_late_final_sdk_interrupted` — each of which needs an actual stale-replay report to trigger) and the always-`unknown` `l2_ordering_unknown` row. This table covers every Stage-2 ordering class (`l2_suppressed`, `l2_late_final_replaced`, `l2_late_final_sdk_interrupted`, `l2_ordering_unknown`) crossed with every caller class the spec defines (§7.2's five first-audible classes) and the stale-replay report; no combination here is left undefined, so this plan does not need to escalate L2 as BLOCKED.

**Call 3 — L3.** May begins a greeting as the opening starts (464 live table caller action). Record: the obsolete opening interrupted, one replacement proceeding, no later stale opening; May confirms the interruption felt normal, the response arrived, and old speech did not replay.

**Call 4 — L4.** May hangs up while startup is pending or beginning (464 live table caller action). Record: disconnect terminalizes the attempt or leaves it explicitly incomplete, with no post-disconnect successor audio attributed as successful; May's recollection of what, if anything, was audible is qualitative — audibility reads `unknown` without a caller report, even if machine cleanup is clean.

**V (if applicable, any of the three calls).** Same classification and retry-once rule as Task 4's V step (Standing Invariant 3); keep the attempt in the denominator; do not fail L2/L3/L4 on a voicemail/no-answer attempt. For Call 2, May's hello is said at/before answer regardless of outcome (the live-action rule stated above); V is classified from the attempt's evidence afterward, and V's outcome gates only whether L2 is *scored* — never whether the hello is said. For Calls 3–4, the live action (beginning a greeting at Call 3; hanging up at Call 4) likewise happens as part of the attempt; classify V on the attempt before recording the L3/L4 outcome.

**Verification:**
- Tests and critical failure cases: delaying May's hello until after V classifies (rather than saying it at/before answer as the live caller action, with V classified afterward from the evidence) misses the L2 window and is an execution error, not a scoring nuance; scoring L2 at all on a `no_sip_answer`/`answered_voicemail` attempt (instead of classifying V and retrying, while still saying the hello and still harvesting/proceeding to Calls 3–4) is an execution error; copying KPR-464's frozen L2 cell instead of classifying from this session's own JSONL is an execution error, not a pass; skipping Stage 1 and classifying straight into a Stage-2 class when the Stage-1 defect condition actually matches is the same class of error — it would let a caller-corroborated `heard_greeting_response` launder a real defect into `pass`; treating the original opening's own overlapping `speech_terminal` — rather than a distinct, later `speechId` — as the Stage-1 "later opening replayed" condition is the inverse error: it would false-fail the spec-allowed late-final `heard_both` and must not happen; an `l2_ordering_unknown` result must never be recorded as `fail`; recording L2 `pass` from the JSONL ordering class alone, without May's sanitized first-audible class and stale-replay confirmation, is the same class of error as treating `sip_answered`/playout as a conversation pass (Standing Invariant 1) and must not happen; mapping a `pass` from caller class alone without confirming this attempt's own Stage-2 machine-side result condition — the matching class's own middle-column condition from the Stage-2 table above (exactly one caller-owned response for `l2_suppressed`; exactly one opening requested-then-superseded-or-interrupted plus exactly one caller-owned replacement for the two late-final classes; complete attempt accounting in every case) — e.g., promoting a second caller-owned response or replacement plus a matching caller-class report to `pass` — is the same class of error and must not happen; that gate failure, absent a Stage-1 defect match, reads `unknown`, not `pass` and not `fail`; a combination the L2 corroboration mapping table names `fail` (stale replay reported on any Stage-2 pass-track class, or `heard_opening`/`heard_both` under `l2_suppressed`), or a Stage-1 defect match, must never be softened to `unknown` — that would misreport a defect as incomplete coverage and close the ticket at the wrong terminal state.
- Harness/environment: same as Task 4; May available for three short calls plus any voicemail retries.
- Run: the harvest commands from the plan-level Testing Contract, scoped to each call's id.
- Expected: three recorded rows (L2, L3, L4), each with its class/result, call/speech/turn ids, and a link to its sanitized JSONL slice; any V outcomes recorded per §6.2.

- [ ] Place Call 2 (Mokie `voice_call` preferred); say hello immediately before/at answer as the live caller action, regardless of how the attempt later classifies. Then classify §6.2 V from this attempt's evidence — if `no_sip_answer`/`answered_voicemail`, record V, retry once under the same go, and do not classify or score L2 on this attempt (neither Stage 1 nor Stage 2, no L2 result) — this skips only L2's scoring: still harvest this call and proceed to Calls 3–4; on a retry that classifies `answered_human`, re-enter the hello-at-answer path and score that retry per the steps below. On an `answered_human` attempt: check the Stage 1 defect condition first from content-free JSONL fields (a distinct, later opening `speechId` replayed after the replacement progressed — never the original opening's own overlapping `speech_terminal`) — if it matches, record L2 `fail` (this concludes only L2's own classification, not the task: still harvest this call and proceed to Calls 3–4); otherwise classify the ordering into a Stage-2 class per the table above; record May's sanitized first-audible class and her stale-replay confirmation; finalize the result — `pass`, `fail`, or `unknown` — strictly from the L2 corroboration mapping table above, confirming this attempt's own Stage-2 machine-side result condition — the matching class's own middle-column condition from the Stage-2 table above (exactly one caller-owned response for `l2_suppressed`; exactly one opening requested-then-superseded-or-interrupted plus exactly one caller-owned replacement for the two late-final classes; complete attempt accounting in every case) — also holds before recording any `pass` — a second caller-owned response or replacement, or incomplete attempt accounting, caps the result at `unknown`; never record `pass` from JSONL ordering or caller class alone, never skip the Stage-1 defect check on the way to a Stage-2 class, and never downgrade a mapped `fail` (a Stage-1 defect match, stale replay reported on a Stage-2 class, or `heard_opening`/`heard_both` under `l2_suppressed`) to `unknown`.
- [ ] Place Call 3; begin a greeting as the opening starts; record the interruption/replacement/no-stale-opening outcome and May's confirmation.
- [ ] Place Call 4; hang up during startup; record the terminal/incomplete outcome and May's qualitative recollection.
- [ ] Harvest and sanitize each call's JSONL slice; paste results into evidence §6/§7.
- [ ] Commit the evidence-record update for Calls 2–4.

### Task 6 (LIVE-CALL, optional/conditional): Call 5 — voicemail observation

**Outcome / spec coverage:** Covers spec §6.1 row V and §6.3 Call 5 — a dedicated voicemail/no-answer observation, only if May wants one and none occurred naturally across Calls 1–4.

**Components and known files:** Same as Task 4/5.

**Dependencies:** Tasks 4 and 5 complete for this session; run only if V is still `unobserved` after them and May requests the extra attempt.

**Interfaces, compatibility, and invariants:** Standing Invariant 3 (`unobserved` never fails the ticket). A dedicated voicemail number or AMD feature stays out of scope.

**Acceptance criteria:** If run, the call classifies per spec §6.2 (any outcome recorded honestly — do not manufacture voicemail). If not run, V is recorded `unobserved` with the reason ("no natural voicemail outcome across Calls 1–4; May did not request an extra attempt").

**Verification:**
- Tests and critical failure cases: do not manufacture a voicemail outcome or misclassify a human answer as voicemail to close this row.
- Harness/environment: same as Task 4.
- Run: same harvest commands, scoped to this call's id if run.
- Expected: V recorded as `pass` (classified) or `unobserved` with its reason — never left `pending` at ticket closure.

- [ ] Confirm with May whether a dedicated voicemail attempt is wanted; if not, record V `unobserved` with reason and skip the remaining steps.
- [ ] If run: place the call, classify per §6.2, and record the outcome.
- [ ] Commit the evidence-record update.

### Task 7: Harvest, hypothesis-versus-observation, and ticket-terminal-state closure

**Outcome / spec coverage:** Finalizes the sanitized evidence record — confirmatory compare output, the R8-split statement, the September 7/11 hypothesis-vs-observation table, and the ticket's final Status line. Covers spec §8 items 8–9 and §3.3's closure rule.

**Components and known files:**
- `docs/epics/kpr-462/kpr-466-acceptance-evidence.md` (populated by Tasks 1–6).
- `docs/epics/kpr-462/kpr-465-latency-evidence.md` and epic canon R8/R8-CORRECTION for the split rule.
- The September 7 call evidence (KPR-325 comment `3af09f64`) for hypothesis rows.

**Dependencies:** Tasks 4–6 (whichever actually ran) complete for the session(s) covered. May run with none of them having reached dialing, to close the record honestly at the preflight-only state.

**Interfaces, compatibility, and invariants:** Standing Invariant 5 (R8 split) applies to any before/after table including warm-opener `initToFirstTokenMs`.

**Acceptance criteria:**
- If any live call ran (Tasks 4–6 reached dialing): confirmatory compare CLI run on I1's call id(s) with the seed echoed; output pasted into evidence §8 alongside the R8-split statement. If no live call ran (the session closed at the preflight-only state before dialing), evidence §8 records that no I1 call id exists and the compare-CLI step is `pending` — never fabricated, never silently skipped without that note.
- Hypothesis-vs-observation table for the September 7 handset-silence root cause (evidence §9): recorded as still unexplained unless this session's live run actually produced supported new evidence — never declared proved from a SIP-race hypothesis alone (spec §2; 464 spec §6).
- Final Status line set to exactly one of the four §3.3 terminal states:
  - `live end-to-end acceptance passed` — every required scenario `pass`, voicemail `pass` or `unobserved`, restart/rollback `consumed` or `pass` (I1 pause verdict and any KPR-465-written p50/p95 are **not** gates on this — spec §4.3).
  - `live end-to-end acceptance failed` — a required scenario `fail`; the defect is named and filed, not silently retried inside this ticket.
  - `live end-to-end acceptance incomplete` — the run started and stopped (drift, stop request, lost correlation) leaving required rows `unknown`/`pending`.
  - `no-call preflight verified; live end-to-end acceptance pending` — **only** when Task 2's preflight actually passed (463 T9 passed and every required P1–P7 row green on the current identity, matching spec §3.3's own condition for this exact state) and May's go never materialized, or the session closed before dialing for any other reason after reaching that point. **This state must never overwrite an earlier honest blocker:** if T9 was not yet passed — including if the only 463 artifact is merge SHA `6b993455` / operations.md `implementation verified; migration pending` — or any required P-row failed, Task 2 already recorded that specific blocker on the Status line per its own rule (and Task 1's "name the actual blocker" rule) — Task 7 carries that blocker forward verbatim rather than relabeling it as preflight-verified.

**Verification:**
- Tests and critical failure cases: setting a terminal state not on this exact list; marking the ticket complete while any required row is `unknown` or `pending`; treating a KPR-465-written latency number as an SLO that can fail the ticket; running the compare CLI against a fabricated or reused call id when no live call actually ran; relabeling a Task 2 preflight-failure blocker as `no-call preflight verified; live end-to-end acceptance pending`; treating merge SHA `6b993455` as T9.
- Harness/environment: none beyond what Tasks 1–6 already used.
- Run: the compare CLI command from the plan-level Testing Contract, scoped to the I1 call id(s), with the session's actual seed echoed — only if a live call ran.
- Expected: the evidence record is internally consistent — every §6.1 row has a result, every result traces to a call/speech/turn id or an explicit reason, and the Status line matches what those rows actually show and does not overwrite an earlier recorded blocker.

- [ ] If any live call ran: run the confirmatory compare CLI on I1's call id(s); paste output with the seed echoed and the R8-split statement into evidence §8. If no live call ran, record evidence §8 as `pending` with the reason (no call id exists).
- [ ] Fill the hypothesis-vs-observation table in evidence §9 from this session's actual data, not assumption.
- [ ] Set the final Status line to one of the four §3.3 states based on the recorded rows, carrying forward any earlier Task 2 blocker verbatim rather than relabeling it as preflight-verified.
- [ ] Final privacy pass: confirm no transcript text, phone numbers, destination, tokens, tool arguments, ack phrase text, prompt bytes, or audio appears anywhere in the git-committed evidence record (Standing Invariant 2); move any such content to the operator-only record outside git.
- [ ] Commit the closed (or honestly-still-pending) evidence record.

## Explicitly out of scope for this plan (recorded, not dropped)

- Any default flip; KPR-465 arm selection or the endpointing lever; KPR-463 installer/confinement re-design (R14 already shipped Seatbelt / single-use jobs / clone-on-promote; do not invent a census helper, native guardian, or `JobRequest.accept()` bookkeeping); AMD; `scripts/livekit-setup.ts` mutation; doctor vendor API calls; treating `hive doctor` green as P1–P7 (R18); CNAM/KPR-321; inbound; vendor A/B or cloning; ambience; pre-rendered audio; opening delay; dashboards; Vapi-path changes; new `voice_diagnostic` keys; a `mokie-bench`-style clone (that is KPR-465's own instrument, not reused here); a numeric latency target; consuming `6b993455` as T9; closing T9/T10/S12 from this ticket.
- Refreshing `kpr-464-startup-evidence.md`'s command rows at the merged head (epic follow-up F2) — not this plan's edit.
- `scripts/voice-latency-baseline.ts` and `voice_call_stats` v2 — untouched (canon R4).
- Re-designing KPR-463's packaged confinement (Standing Invariant 6 / R14) — this plan consumes only its approved spec evidence fields. Hangup cleanup remains speech/lease/heartbeat evidence, never installer process accounting.
- Exercising R16 rotation (admission barrier, ordered bootout/start) or invoking the frozen helper / target `deploy.sh` as a 466 proof (R15).

## Execution Handoff

Plan saved to `docs/epics/kpr-462/kpr-466-plan.md`. Ready for independent plan review of this R13–R19 revision. Task 1 may start immediately; Tasks 2–7 remain gated exactly as stated in "Dependency order" above. `ready-to-implement` stays withheld until actual T9 + May's go exist; this revision does not assume either.
