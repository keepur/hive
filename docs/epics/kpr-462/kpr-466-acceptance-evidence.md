# KPR-466 acceptance evidence

**Status:** 463 T9 not yet passed as of 2026-09-15; Task 2 stopped — T9 evidence file absent (P1–P7 not attempted)
**Ticket-complete?** No — none of the four spec §3.3 terminal states is reachable until T9 passes and P1–P7 are recorded on the live identity.
**Build/pins:** pending
**Running identities (read back at session start):** pending

Authored 2026-09-15 (offline only). Task 1 wrote the skeleton. Task 2 (same date) reconfirmed `docs/epics/kpr-462/kpr-463-deployment-evidence.md` is absent in this worktree and in git (`git ls-files` no match), then **stopped**. No instance, database, log, launchd, hive doctor, or call was touched. Later tasks fill cells in the sections below; they do not rename sections, invent a fifth ticket-terminal state, or copy live numbers from sibling evidence files.

Authority: [kpr-466-spec.md](./kpr-466-spec.md) at `ff9ff7b0` (sha256 `f6de0e83b79d04c1592797705d55b1f47fea90048cf69610bfea9a3cddd8adef`). Sibling evidence, referenced not duplicated: [kpr-465-latency-evidence.md](./kpr-465-latency-evidence.md), [kpr-464-startup-evidence.md](./kpr-464-startup-evidence.md). Required T9 input [kpr-463-deployment-evidence.md](./kpr-463-deployment-evidence.md) does not exist (Task 2). Merge SHA `6b993455` is not T9 (canon R17).

Standing Invariant 2: this git-committed record must not contain transcript text, phone numbers, destination, tokens, tool arguments, ack phrase text, prompt bytes, or audio. Controlled script text appears as labels only. Human observations stay sanitized (first-audible class, pause three-way, booleans, per-turn correct/wrong/missing). Result vocabulary is only `pass` / `fail` / `unknown` / `unobserved` / `pending` / `consumed` (spec §3.1). T9 consumption may also read `blocked` when the preceding child's evidence is absent (spec §8 item 5).

## 1. Status line

**Status:** `463 T9 not yet passed as of 2026-09-15; Task 2 stopped — T9 evidence file absent (P1–P7 not attempted)`

This is a pre-terminal blocker (plan Task 2: name the actual blocker until a §3.3 state is reachable). It is not a fifth ticket-terminal state name. A reviewer does not need the spec to see that none of the four states below is claimed. Task 1's "preflight not attempted" phrasing is superseded by this Task 2 stop.

| Spec §3.3 terminal state | Ticket complete? | Claimed in this record? |
| --- | --- | --- |
| `no-call preflight verified; live end-to-end acceptance pending` | No | no — requires 463 T9 passed and P1–P7 green on the identity that would dial |
| `live end-to-end acceptance passed` | Yes | no |
| `live end-to-end acceptance failed` | No | no |
| `live end-to-end acceptance incomplete` | No | no |

Reason the first §3.3 state is not claimed: `docs/epics/kpr-462/kpr-463-deployment-evidence.md` is absent (Task 2 reconfirmed 2026-09-15). [kpr-463-operations.md](./kpr-463-operations.md) status remains `implementation verified; migration pending`. Merge SHA `6b993455` is not T9 (R17). Task 2 **stopped** without attempting P1–P7 (rows stay `pending`, not `fail`) and without any live probe. Task 7 must carry this blocker forward verbatim rather than relabel it as preflight-verified.

## 2. Build/pins and running identities

Live readback. Public-safe path patterns only in this file; exact local paths stay in the operator record outside git.

| Field | Value |
| --- | --- |
| Engine identity (running) | pending |
| Worker identity (running) | pending |
| Package version | pending |
| Archive digest (from 463 evidence) | pending |
| Lock digest (from 463 evidence) | pending |
| P7 Hive package realpath (public-safe) | pending |
| P7 LiveKit job-helper realpaths (public-safe) | pending |
| P7 RTC/native library realpaths (public-safe) | pending |
| P7 Silero model-asset realpath (public-safe) | pending |
| `@livekit/agents` (required pin 1.6.4; observed) | pending |
| Node (observed; Node 24 is T10 proof, not a 466 support narrow) | pending |
| UTC clock basis | pending |
| launchd engine ProgramArguments (eligibility: `<instance>/.hive/pkg/server.min.js`, no extra args) | pending |
| launchd worker ProgramArguments (eligibility: `<instance>/.hive/pkg/voice-worker.min.js start`) | pending |
| Working directory / config selector | pending |

A `dist/` or git-checkout ProgramArguments remains ineligible. Pilot recovery is a separate 463 profile (R18) and is not a 466 live identity.

## 3. KPR-465 configuration input and readback

466 consumes the later 465 decision (or keep-cold-by-absence). It does not select an arm, write a warm default, or import 465 bench/offline V-rows as 466 live pass (spec §4.3; canon R12).

| Item | Value |
| --- | --- |
| 465 §6.4 decision as recorded in [kpr-465-latency-evidence.md](./kpr-465-latency-evidence.md) | pending — that file's decision section is still unfilled at skeleton authoring; not a 466 live `hive.yaml` readback |
| Keep-cold-by-absence fallback applicable? | pending (live keys unread) |
| `voice.warmPath.enabled` readback | pending |
| Mokie `effort` readback | pending |
| `voice.livekit.endpointing` presence/absence | pending |
| Model | pending |
| Mokie Cartesia voice mapping (boolean only) | pending |
| `@livekit/agents` at session start | pending |
| Arm label for I1 compare CLI (`warm` or `cold` substring required) | pending |

## 4. P1–P7 preflight table

No-call checks (spec §5). A failed required row stops the session (no dialing). `hive doctor` green is not P1–P7 (R18). Keepur remains untouched. Do not run `scripts/livekit-setup.ts`.

Task 2 (2026-09-15) did **not** run these checks: T9 evidence is absent, so P1–P7 remain `pending` (not `fail`). No launchd, log, Mongo, hive doctor, or live-instance probe was issued.

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Artifact and process identity | pending | pending |
| P2 | Engine boot | pending | pending |
| P3 | Bridge authentication (status/classification only; no model spawn) | pending | pending |
| P4 | Worker registration | pending | pending |
| P5 | Twilio / LiveKit outbound setup (read-only lookup; names/ids only) | pending | pending |
| P6 | Deepgram / Cartesia (cell-defaults names + mapping boolean; no vendor HTTP) | pending | pending |
| P7 | Loaded-artifact containment | pending | pending |

## 5. KPR-463 T9 consumption

| Field | Value |
| --- | --- |
| Evidence file | [kpr-463-deployment-evidence.md](./kpr-463-deployment-evidence.md) — **does not exist** |
| Digest | pending (file absent) |
| Restart/rollback (spec §6.1 row R) | not `consumed` — Task 2 stopped on absent T9 evidence; cannot consume until T9 is recorded as passed in that file |
| T9 consumption | blocked |
| Not T9 (R17) | merge SHA `6b993455`; operations.md `implementation verified; migration pending` |

466 does not issue `hive update`, `hive rollback`, frozen-helper `--restart`, or `launchctl kickstart` to re-prove 463 (Standing Invariant 8).

## 6. Session log

Task 2 (2026-09-15): **stopped**. T9 evidence file absent. P1–P7 not attempted. No live session authorized. No launchd, log, Mongo, hive doctor, or instance probe.

Each session gets one subsection recording:

- May's go (who, when, scope)
- Quiet-window check (freshest `spawn_coordinator_stats` ≤ 30 s: `activeSpawns == 0` and `warmVoiceSessions == 0` for every agent; no `meeting_worker_claims` with `status: "running"`; no live call up)
- Call list with call/dispatch ids (destination never copied)
- Classified V outcomes (`no_sip_answer` / `answered_voicemail` / `answered_human` / `unclassified`)
- Stop events (drift, unexpected destination, lost correlation, May's stop)

Call set to fill (spec §6.3): Call 1 I1; Calls 2–4 L2/L3/L4; optional Call 5 V. Repeats stay in the denominator.

## 7. Per-scenario table (spec §6.1)

Every live-dependent cell is `pending`. Destination is omitted by rule, not deferred. Caller observations use sanitized classes only. Controlled I1 script text, when recorded at execution, is labels (quiet through opening; two short factual questions; one mid-sentence interruption; one read-only lookup naming the tool's job; goodbye and hangup). L2 instructed "hello" and L3/L4 caller actions are labels only.

| ID | Result | Call / speech / turn ids | Timings | Caller observation | Sanitized JSONL slice |
| --- | --- | --- | --- | --- | --- |
| I1 | pending | pending | pending | pending | pending |
| V | pending | pending | pending | pending | pending |
| L1 | pending | pending | pending | pending | pending |
| L2 | pending | pending | pending | pending | pending |
| L3 | pending | pending | pending | pending | pending |
| X | pending | pending | pending | pending | pending |
| B | pending | pending | pending | pending | pending |
| T | pending | pending | pending | pending | pending |
| H | pending | pending | pending | pending | pending |
| L4 | pending | pending | pending | pending | pending |
| C | pending | pending | pending | pending (I1 pause three-way is recorded, not a C or ticket gate) | pending |
| R | pending | — | — | — | 463 T9 evidence absent; see §5 |

L2 observed-ordering class (`l2_suppressed` / `l2_late_final_replaced` / `l2_late_final_sdk_interrupted` / `l2_ordering_unknown`): pending.

I1 pause three-way (`acceptable` / `borderline` / `annoying`): pending. Not a conversation defect and not a ticket-complete gate (spec §4.3).

## 8. Confirmatory compare CLI output for I1 (R8 split)

pending: no I1 call id exists; the compare CLI has not been run. Task 7 must not fabricate output or silently skip this section without that note.

Planned harvest (operator, after an authorized I1, bounded 32 MiB):

```text
npx tsx scripts/read-voice-diagnostics.ts --input <call-filtered jsonl> --call-id <id>
npx tsx scripts/voice-latency-compare.ts --input <jsonl> --call <id>=<arm> --engine-log <hive.log slice> --seed 20260913
```

`<arm>` must contain exactly one of `warm` / `cold` (the arm Task 3 actually read back). Seed echoed: pending.

**R8 CORRECTION (statement, not measured data):** any before/after latency table in this record that includes warm-opener `initToFirstTokenMs` must split at the KPR-465 boundary (`a0a026e0` and earlier: push → first text including boot; `687235f7` / `28619e03` and after: init → first text, boot in `bootToInitMs`). Parsing across the boundary is fine; pooling those values is not. `38506f03` is the docs-only correction commit, not a runtime cut. Application of this split to I1 numbers: pending (no I1 numbers).

September 7/11 rows are v1 provenance only, never a 466 arm (they are cold, `warmPath: false`). They are not the confirmatory comparand. Population of a provenance pointer: pending. `scripts/voice-latency-baseline.ts` is not a comparand (canon R4).

Compare CLI output (seed echoed): pending.

## 9. Hypothesis-versus-observation (September 7)

September 7 handset silence remains unexplained unless new evidence from an authorized 466 run supports a cause. Do not declare a SIP race proved (spec §2; 464 spec §6). 466 may close live acceptance without proving that historical cause.

| Hypothesis | Observation | n | Supported? |
| --- | --- | --- | --- |
| September 7 Call 2 connected; caller reported no audible speech in the opening window (sanitized: `heard_none` for that window). Root cause unknown. | pending — no 466 live call has run; historical cause still unexplained | pending | pending |
| SIP scheduling race as the cause of that silence | Do not declare proved from 464 offline scheduling evidence or from this skeleton | pending | pending |

September 7 Call 1 (voicemail-without-ring) is historical V classification context only. 466 does not need to reproduce that pathology. Those rows are not plotted as a 466 arm (see §8).
