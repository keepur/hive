# KPR-324 — Implementation Plan: Mid-call tool acks + latency masking + PO/order grounding contracts

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Ticket:** KPR-324 (W5.4), child of epic KPR-320 (W5 Voice v2). **Consumes:** KPR-322 shipped worker/bridge (`bbd9581`, PR #391 — text-only SSE seam, E1 bearer, E2 `abortThread`) and KPR-323 warm lease (`f0f4abd`, PR #395 — `WarmVoiceSession.consumeOneTurn` as the in-call spawn path the ack must be correct under). **Blocks:** KPR-325 (pilot). **Adjacent:** W1B / KPR-300 (parked — implements the `orders` contract this ticket's spec §6 defines; nothing in this plan builds it).
**Spec:** [`kpr-324-spec.md`](./kpr-324-spec.md) (clean, spec-ready; §n refs below are spec sections; C1–C9 are the spec §8 engine-change inventory; T1–T3 are the spec §12.2 empiricism gates). The spec is binding — this plan renders it, it does not redesign it.
**Plan type:** CODE plan (engine diff: ack helper + both spawn loops, telemetry copy path, voice-prompt supplement, config lever, test fixture + registry guard) + one ops step (C9, Mongo agent def) + D3-gated empirical tasks (T1–T3 — designed, NOT run).
**Anchors:** plan written 2026-08-28 against epic worktree `/Users/may/github/keepur/hive/.claude/worktrees/kpr-320` @ `d1d61e8` (epic branch `kpr-320`; spec was cut at `f0f4abd` — only coherence-review fixups + the 2026-08-28 main sync landed since, drift verified **cosmetic**, see Task 0 table). Line refs below are `d1d61e8`. Delivery re-pins at Task 0.
**Status:** DRAFT — dispatcher runs the plan-review loop; not self-approved.

**Goal:** Fill the silent gap on a live voice call while a server-side MCP tool runs — a hive-side, code-shaped acknowledgment phrase injected as ordinary SSE text at `tool_use` on voice turns where the model did not already speak (S2) — plus the supporting telemetry (`toolAckInjected` end-to-end through `RunResult` → `finalizeSpawnResult` → `TurnResult` → the "Voice turn complete" line and `convertTurnResult`, S4), the voice-prompt tool paragraph (S8), the `voice.toolAck.enabled` rollback lever (S7), and the `voice-fixture` test double + `voice-pilot`-only entitlement guard (§7) so T-gates can run with W1B parked. The `orders` MCP contract itself is **spec-only** (D2/S5): this plan ships **no** `orders` server, no `SERVER_CATALOG.orders` key, no ERP anything (C8 is a comment).

**Architecture:** One pure helper (`src/agents/voice-tool-ack.ts`: gate + caller-owned phrase rotation), wired at the two spawn-loop `tool_use` observation sites — `AgentRunner.send` (cold, `agent-runner.ts:2292-2334` assistant branch) and `WarmVoiceSession.consumeOneTurn` (warm, `warm-voice-session.ts:511-543` assistant case). The ack is emitted through the existing `onStream` → SSE `delta.content` path, so Vapi and LiveKit both speak it and the 322 bridge/worker are untouched (**no worker diff, no new HTTP route, no LiveKit function tools, no schema/migration, no new secrets** — spec §8). The count rides `RunResult.toolAckInjected` (new, **required** number) through `finalizeSpawnResult` onto `TurnResult.toolAckInjected` (new, required) and back through the chat dispatcher's `convertTurnResult` (typecheck-load-bearing, C5e). Rollback: `voice.toolAck.enabled: false` (C6; absent/garbage → **on** — inverse of 323's warm-path default, S7) + C9-reverse; C4/C5a–e stay in place harmlessly.

**Tech stack:** TypeScript strict / Node 22; `@anthropic-ai/claude-agent-sdk` message-loop observation (no new SDK surface); `createSdkMcpServer` + zod for the fixture; vitest (existing fake-query idioms in `agent-runner.test.ts` / `warm-voice-session.test.ts`); MongoDB agent def update via admin MCP (C9, ops).

**Epic decision-register canon binding this plan** (each already reflected in the tasks; listed so review can check without re-deriving):

| Canon | How this plan honors it |
|---|---|
| **E4** — `voice_call` LiveKit initiation shipped with 322 (`bbd9581`); 325 consumes it | Not a mid-call tool. No task touches `voice-mcp-server.ts` / `livekit-voice-mcp-server.ts`; C4's prompt paragraph explicitly forbids initiating a `voice_call` from a live call |
| **agents-js pin** — exact 1.6.4 lockstep (+ rtc-node 0.13.33, livekit-server-sdk 2.14.1); 1.6.4 API pins documented in `session.ts` | **No worker diff and no dependency change** (spec §8). §4.5's rejection of `session.say` as a gap filler is precisely a 1.6.4 SpeechHandle-semantics argument — do not revisit it here |
| **E2** — `AgentManager.abortThread(agentId, threadId)` per-thread ticket abort on pre-completion socket close | Untouched. Barge-in mid-tool stays 322/323 semantics (spec §4.4); this plan adds **no** abort surface and no tool-cancel token (Task 13 verifies call recovery, not tool SIGKILL) |
| **E1** — bridge bearer load-bearing; loopback bind default with `voice.bindHost` escape hatch | Untouched. No new HTTP surface (S1); the ack rides the existing authenticated SSE seam |
| **D3** — every empirical gate designed-not-run, per-run operator go | Tasks 11–14 each open with a GO block; Tasks 0–10 are CI-only. Executing a gated task without a recorded go is a scope breach |
| **TTS cells** — pre-refresh ids (`sonic-3`, `eleven_flash_v2_5`) in code; §14.1.1 Sonic-3.6 / Eleven v3 confirm-or-revert binds at the **P4** window | Out of scope here (spec §13). No task touches `config.ts`'s `defaultTts`/`defaultStt` defaults. If a T-gate runs in the same window as P4, the whitelist reconcile is 322's task, not this one |
| **FABLE_MAKEUP** — open obligations on KPR-320 (pre-PR fable finals substituted opus at `95686ff`, `4e5a9fa`) | Consumed at the epic-PR fable make-up round; **not** this ticket's concern and not a task here. Noted only so the delivery lane does not adopt it |

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `src/agents/voice-tool-ack.test.ts` (new — gate truth table, rotation), `src/agents/agent-runner.test.ts` (cold-loop inject cases + `RunResult.toolAckInjected`), `src/agents/warm-voice-session.test.ts` (warm-loop inject cases), `src/config.test.ts` (C6 resolver), `src/agents/prompt-builder.test.ts` (new — C4 paragraph present, toolkit dump still absent), `src/voice/voice-fixture-mcp-server.test.ts` (new — clamp, canned §6.2 shape, no-content logging), `src/agents/agent-registry.test.ts` (strip guard), `src/tools/server-catalog.test.ts` (C8: no `orders`, no `voice-fixture` key), `src/channels/voice/voice-adapter.test.ts` (C5d log fields), `src/voice-worker/hive-llm.test.ts` (S1 regression lock: POST body has no `tools` key).
  - Reason: the segment rule (§4.1) is the ticket's correctness core — a wrong gate speaks `"One moment."` into Slack or double-speaks over the model's own wait line on a live vendor call; the copy path (§4.6) is the spec's named failure mode ("a spawn-loop counter not on `RunResult` drops at the copy and C5d logs 0/undefined"); the fixture guard is the "loaded gun on a production call" risk (§7).
  - Minimum assertions (spec §12.1, verbatim mapping — all of these, exactly):
    1. `shouldInjectToolAck` true only when enabled + not streamed + has onStream + `channel === "voice"`. False when channel is `slack`/`sms`/`ws` even with `onStream` set; false when voice but `onStream` missing; false when disabled. (Task 2)
    2. Text-then-tool: no inject. Silent tool: inject once. Two silent tools — sequential assistant messages **and** two `tool_use` blocks in one assistant message: inject twice. Text + tool in the **same** assistant message: no inject (text blocks processed first). (Tasks 4 & 5, both loops)
    3. Injected chunk is exactly a §4.2 phrase plus the single trailing separator space (`PHRASE + " "`; `chunk.trimEnd()` ∈ the constant set); `onStream` receives it **before** the test's fake tool-result message is emitted. (Tasks 4 & 5)
    4. Cold and warm loops both honor (3): mock `onStream`, emit a `tool_use` assistant message with no prior deltas, fixture `channelKind`/channel is `"voice"`; each loop's returned `RunResult.toolAckInjected` equals the inject count. (Tasks 4 & 5)
    5. Copy path: a `RunResult.toolAckInjected` from the (mocked) runner survives `finalizeSpawnResult` onto `TurnResult.toolAckInjected` (integration, Task 3); the voice adapter's "Voice turn complete" entry carries numeric `toolCalls` / `toolMs` / `toolSummary` / `toolAckInjected` and **no phrase text** (Task 6); `convertTurnResult` maps `TurnResult.toolAckInjected` → `RunResult.toolAckInjected` (Task 3).
    6. Fixture: `delayMs` clamped to [0, 5000] (over-cap clamps, never errors); default 1500; canned body matches the §6.2 `orders_get` template byte-for-byte with `poNumber` echoed; registry load strips `voice-fixture` from any non-`voice-pilot` agent's `coreServers` and logs an error; `voice-pilot` keeps it. (Task 8)
    7. C6 liberal loader: absent → on; `"false"` / `0` / `"no"` / array / non-object → on (garbage); literal `false` → off; literal `true` → on. (Task 1)
    8. `buildVoiceSystemPrompt` output contains the Voice-tools paragraph and still contains no "Your toolkit" section / delegate catalog. (Task 7)
    9. `HiveLLM` POST body snapshot: parsed request body has no `tools` key (S1 regression lock — new assertion in `hive-llm.test.ts`). (Task 9)
    10. Worker unchanged: the existing `hive-llm.test.ts` `maxInterChunkGapMs` gap test (`:127`) still passes without modification. (Task 9, regression)
    11. `SERVER_CATALOG` has no `orders` key and no `voice-fixture` key. (Task 9)
    12. `nextAckPhrase` rotation is caller-owned: two independent `{ index }` states advanced interleaved produce independent sequences (no shared module counter); rotation wraps after the phrase-set length. (Task 2)

- Integration: **required**
  - Scope: `src/agents/agent-manager.test.ts` (real `AgentManager` + the file's mocked `AgentRunner`): cold copy path (mocked `send` returns `toolAckInjected: 3` → `TurnResult.toolAckInjected === 3`); warm end-to-end (real `WarmVoiceSession` over the fake streaming Query emits a silent `tool_use` → `onStream` spy receives an ack phrase AND the returned `TurnResult.toolAckInjected === 1` — proves manager wiring, not just the module). `src/channels/dispatcher.test.ts`: `convertTurnResult` mapping assertion (TurnResult with `toolAckInjected: 2` → converted RunResult carries 2).
  - Reason: the copy path spans three modules; only the real coordinator proves the field survives `finalizeSpawnResult` on both the cold and warm lanes (§4.6 steps 2–5), and only the dispatcher test proves C5e's every-field-mapped contract holds at runtime, not just at `tsc`.
  - Harness: **existing** (`agent-manager.test.ts` — real manager, `mockRunnerSend`, `makeRunResult`, hoisted config mock with `voice: { warmPath: … }`; 323's warm describe + fake streaming Query). Extension required: `toolAck: { enabled: … }` added to the config mock's `voice` object **and** to the three warm-describe sites that replace `appConfig.voice` wholesale (`agent-manager.test.ts:6258/6266/6272`) — set `toolAck: { enabled: false }` there so 323's existing warm cases are behavior-identical, and flip to `true` only in the new ack cases.
  - Minimum assertions: the two copy-path cases + the dispatcher mapping case above; plus **flag-off**: with `toolAck.enabled: false`, a silent-tool voice turn injects nothing and `TurnResult.toolAckInjected === 0`.

- E2E: **not-required** (in CI) / **required as gated empiricism** (T1/T2/T3 — designed, NOT run; each run requires a recorded per-run operator go per D3)
  - Scope: live-call ack audibility + gap-delta measurement (T1), barge-in mid-fixture-delay on the warm path (T2), natural-mask no-double-speak (T3) — Tasks 12–14 ARE the protocols.
  - Reason: audibility, TTS drain behavior, and worker `maxInterChunkGapMs` deltas are runtime properties of a live PSTN/LiveKit/Vapi loop; the program ruling (D3) forbids unapproved runs.
  - Harness: setup-required at the T-gate window — 322's `voice-pilot` test agent (322 Task 14 prep; **not a repo seed**) with C9 executed (`voice-fixture` in its Mongo `coreServers` + SIGUSR1), `toolAck` on, whichever of the Vapi/LiveKit paths is live.
  - Minimum assertions: the spec §12.2 pass/decision rules verbatim, including T1's control-vs-ack `maxInterChunkGapMs` N=3 comparison and the < 200ms-delta demote-to-best-effort operator call.

### Critical Flows

- Silent-to-tool voice turn (cold and warm): caller hears a §4.2 phrase, then the tool result — `toolAckInjected ≥ 1` on the "Voice turn complete" line, `maxInterChunkGapMs` falls vs control.
- Model-speaks-first tool turn: zero injects (natural mask wins; no double-speak) — `toolAckInjected: 0`.
- Chat/SMS/Slack/WS turn with `onStream`: byte-identical to today — the channel gate is load-bearing; no canned line ever reaches a text channel.
- `toolAck.enabled: false`: zero injects everywhere; tools still run; telemetry reads 0 — the rollback lever.
- Barge-in during ack TTS or tool runtime: unchanged 322/323 semantics (cold ticket abort; warm `interrupt()`-and-keep-warm) — this plan adds no abort surface.
- Fixture misplacement: a non-`voice-pilot` def carrying `voice-fixture` is stripped at registry load with an error log; the runner's second gate refuses to build it regardless.

### Regression Surface

- `AgentRunner.send()` across ALL channels: the full `agent-runner.test.ts` suite green; non-voice turns must show zero behavior delta (the inject is gated per-boundary, not per-loop).
- KPR-323 warm lease: entire `warm-voice-session.test.ts` + the 323 warm describe blocks in `agent-manager.test.ts` green — lease lifecycle, demux, interrupt, close contract untouched (C3 is an observation-site add inside `consumeOneTurn`).
- KPR-322 bridge/worker: `src/voice-worker/*` untouched by code (Task 9 adds one assertion to `hive-llm.test.ts` only); `voice-adapter.test.ts` + `voice-adapter.integration.test.ts` green (C5d adds log fields only).
- `RunResult`/`TurnResult` consumers: making `toolAckInjected` required ripples through every construction site — `synthesizeAbortedResult`, Lane B `turn-scaffold.buildResult`, `convertTurnResult`, and test fixtures (`makeRunResult`, dispatcher/adapter TurnResult literals). `npm run typecheck` is the enumeration tool; every site defaults 0. **Caveat: `tsc` under-enumerates in tests** — `agent-manager.test.ts`'s `makeRunResult` has an *inferred* return type (`function makeRunResult(overrides: Partial<RunResult> = {})`, `:307`), so a missing field there compiles clean and only surfaces as a runtime `undefined`. Task 3 Step 7 names it explicitly rather than trusting the compiler alone.
- **Plugin-facing type surface (KPR-394/KPR-407):** `RunResult` is re-exported through `@keepur/hive/provider-abi` (`src/agents/provider-adapters/provider-abi.ts:112`) and ships in the bundled `pkg/types/` d.ts closure. Adding a required field changes what an out-of-engine provider plugin compiles against — see Task 3 Step 3b for the ruling (no ABI bump; runtime belt at the copy site).
- **Config-mock surface in tests (defect class, verified at `d1d61e8`):** both spawn loops newly read `config.voice.toolAck.enabled`, and the two suites that drive them mock `config` **wholesale** with `voice` objects that have no `toolAck` key (`agent-runner.test.ts:183-190`; `agent-manager.test.ts:83-92` plus four `(appConfig as any).voice = …` replacements at `:6258/:6266/:6272/:6920`). `agent-runner.test.ts` already emits `tool_use` messages in five existing cases (`:3778`, `:3801`, `:3851`, `:4394`, `:4431`), and the gate's argument object is evaluated **before** the channel short-circuit — so an un-updated mock is a `TypeError`, not a silent pass, on tests that have nothing to do with voice. Tasks 4/5 fix the mocks as their FIRST step.
- Prefix goldens: `prefix-builder.golden.test.ts` untouched — C4 edits `buildVoiceSystemPrompt` (`prompt-builder.ts`), which is a separate assembly from `buildPrefix`; the Claude-lane golden bytes must stay green un-edited.
- Engine bundle gates: `npm run bundle` + `npm run check:bundle` (fixture + helper bundle into the engine; no new business strings).

### Commands

- Targeted: `npx vitest run src/agents/voice-tool-ack.test.ts src/agents/agent-runner.test.ts src/agents/warm-voice-session.test.ts src/agents/agent-manager.test.ts src/agents/agent-registry.test.ts src/agents/prompt-builder.test.ts src/channels/dispatcher.test.ts src/channels/voice src/voice/voice-fixture-mcp-server.test.ts src/tools/server-catalog.test.ts src/voice-worker/hive-llm.test.ts src/config.test.ts`
- Full quality gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle gates: `npm run check:bundle`
- E2E: gated-empiricism-only — protocols in Tasks 12–14; **never run without the recorded operator go**.

### Harness Requirements

- Existing vitest harness; no new services. Three mock edits are **required, not optional** (see the Regression Surface config-mock bullet — verified at `d1d61e8`):
  1. `agent-runner.test.ts` (`:141` `importOriginal` mock): `importOriginal` spreads the module's *other* exports but replaces the `config` singleton with a literal — the real C6 default does **not** flow through it. Its `voice` object (`:183-190`) must gain `toolAck: { enabled: true }`, or the five existing `tool_use` cases throw.
  2. `agent-manager.test.ts`: base config mock's `voice` (`:83-92`) gains `toolAck: { enabled: false }` (323 cases stay behavior-identical), and **all four** wholesale `(appConfig as any).voice = { warmPath: … }` replacements (`:6258`, `:6266`, `:6272`, `:6920`) gain the same key. New ack cases opt in with `true`.
  3. `warm-voice-session.test.ts` gains a factory `vi.mock("../config.js", …)` (meeting-classifier idiom) — the module newly imports config, there is no vitest env setup file (`vitest.config.ts` has no `setupFiles`), and the real `config.ts` throws at import on missing `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`.
- Gated empiricism harness: instance with a live voice path (Vapi or LiveKit — spec §12.2: whichever is live, masking is behind the HTTP seam); `voice-pilot` agent with C9 landed; 322 §14.2 10-turn vendor-style script.

### Non-Required Rationale

- E2E (CI): live-call audio and worker JSONL gap metrics cannot exist in CI, and D3 forbids unapproved runs. All other groups required.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Channel-gate rule:** every task that touches a spawn loop re-runs the non-voice suites (`agent-runner.test.ts`, `agent-manager.test.ts`, `dispatcher.test.ts`) before its commit — chat paths must be provably untouched at every step.
- **T1's < 200ms-delta outcome is an operator call, not a spec fork** (spec §12.2): record the finding, file a follow-up, keep S2 best-effort or demote to prompt-only — do **not** silently ship lever b (worker `session.say`) in this ticket.

---

## 0. How to run this plan

- **Program mode:** maturity-first (D3, Gate 1 2026-07-13). Engine tasks (0–10) are CI-verifiable and may execute when the delivery lane opens. Tasks 11–14 (C9 ops + T1–T3) each begin with an operator-go block; executing any without a recorded "go" (date + words, in Linear KPR-324 comments at execution time) is a scope breach. Approvals are per-gate, never generalized.
- **Rollback lever:** `voice.toolAck.enabled: false` in hive.yaml (literal `false` disables; absent/garbage → **on** — S7, deliberately the inverse of 323's warm-path default because masking *is* this ticket). C9-reverse removes the fixture entitlement. C4/C5a–e stay in place on rollback (prompt + telemetry + chat mapping are harmless).
- **Hard boundaries (spec §13):** no `POST /v1/tools`, no LiveKit function tools, no worker `session.say` filler, no `src/orders/` production server, no `SERVER_CATALOG.orders` or `SERVER_CATALOG.voice-fixture` key, no Lane B adapter wiring (openai/codex/gemini/grok spawn loops untouched — Lane A cold voice gets C2 for free via `AgentRunner.send`), no Honeypot keys. Finding yourself editing `src/voice-worker/` (beyond the Task 9 test assertion) or `openai-translator.ts` means you've left the plan.
- **Secrets/redaction:** the ack phrases are constants and are never logged as content — telemetry carries counts and durations only; the fixture logs `delayMs` + duration, never its canned prose; no PO numbers in engine logs.
- **Conventions:** `createLogger` for logging; strict TS, no `any` without justification; tests beside source; commit per task; `npm run check` before any PR.
- Tick each `- [ ]` as executed.

---

## 1. Execution order

```
Task 0 (anchor re-confirm gate — HARD)
   ├─ T1(C6 config) ── T2(C1 helper) ── T3(C5a/b/c/e field plumbing) ── T4(C2 cold inject)
   │                                                                  ── T5(C3 warm inject)
   │                                                                  ── T6(C5d adapter log)
   ├─ T7(C4 voice prompt)                (independent after 0)
   ├─ T8(C7 fixture + guard + wiring)    (independent after 0)
   └─ T9(C8 comment + S1 regression locks) (independent after 0)
T10 (CI close-out: full gates)
gated:  T11[GO] (C9 ops: voice-pilot Mongo entitlement — instance, not repo)
        T12[GO] (T1 ack audible — needs T11)
        T13[GO] (T2 barge-in mid-tool, warm on — needs T11)
        T14[GO] (T3 natural mask wins — needs T11)
T15 (close-out)
```

| Task | What | Depends on | Parallel with |
|---|---|---|---|
| 0 | Anchor re-confirm gate | — (blocks all) | — |
| 1 | C6 `voice.toolAck.enabled` config | 0 | 7, 8, 9 |
| 2 | C1 `voice-tool-ack.ts` helper | 0 | 1, 7, 8, 9 |
| 3 | C5a/b/c/e: `toolAckInjected` field plumbing (types + copy + mapping + fixture ripple) | 0 | 7, 8, 9 |
| 4 | C2 cold inject in `AgentRunner.send` | 1, 2, 3 | 5 (different files), 7, 8, 9 |
| 5 | C3 warm inject in `WarmVoiceSession.consumeOneTurn` | 1, 2, 3 | 4, 7, 8, 9 |
| 6 | C5d "Voice turn complete" log fields | 3 (4/5 recommended first for end-to-end sense) | 7, 8, 9 |
| 7 | C4 Voice Call Mode paragraph | 0 | 1–6, 8, 9 |
| 8 | C7 `voice-fixture` server + strip guard + wiring | 0 | 1–7, 9 |
| 9 | C8 catalog comment + S1/S11 regression locks | 0 | 1–8 |
| 10 | CI close-out (check + bundle gates) | 1–9 | — |
| 11 | **C9** ops: `voice-pilot` Mongo `coreServers` + SIGUSR1 [GO] | 8 deployed | — |
| 12 | **T1** ack audible [GO] | 11 + 1–6 deployed | — |
| 13 | **T2** barge-in mid-tool [GO] | 11 + warm path on | — |
| 14 | **T3** natural mask wins [GO] | 11 | — |
| 15 | Close-out | all | — |

**File map (created/modified):**

| File | Change | Task |
|---|---|---|
| `src/config.ts` | C6: `voice.toolAck` key + pure resolver | 1 |
| `src/config.test.ts` | resolver cases | 1 |
| `src/agents/voice-tool-ack.ts` | **new** — C1 gate + phrases + rotation | 2 |
| `src/agents/voice-tool-ack.test.ts` | **new** — C1 unit suite | 2 |
| `src/agents/agent-runner.ts` | C5a `RunResult.toolAckInjected` (T3); C2 inject + counter (T4); C7 fixture wiring + inventory descriptor (T8) | 3, 4, 8 |
| `src/agents/agent-manager.ts` | C5b `TurnResult.toolAckInjected`; C5c finalize copy + `synthesizeAbortedResult` zero (T3) | 3 |
| `src/agents/provider-adapters/turn-scaffold.ts` | C5c rider: Lane B `buildResult` zero-shape | 3 |
| `src/channels/dispatcher.ts` | C5e `convertTurnResult` mapping | 3 |
| `src/agents/warm-voice-session.ts` | C3 inject + counter in `consumeOneTurn` | 5 |
| `src/channels/voice/voice-adapter.ts` | C5d: four tool fields on "Voice turn complete" | 6 |
| `src/agents/prompt-builder.ts` | C4: Voice-tools paragraph inside Voice Call Mode | 7 |
| `src/agents/prompt-builder.test.ts` | **new** — C4 assertions | 7 |
| `src/voice/voice-fixture-mcp-server.ts` | **new** — C7 fixture server | 8 |
| `src/voice/voice-fixture-mcp-server.test.ts` | **new** — C7 unit suite | 8 |
| `src/agents/in-process-servers.ts` | C7: `"voice-fixture"` in the Set + the two name constants | 8 |
| `src/agents/agent-registry.ts` | C7: `voice-fixture` strip guard at load | 8 |
| `src/agents/agent-registry.test.ts` | strip cases | 8 |
| `src/tools/server-catalog.ts` | C8: comment-only spec pointer (no key) | 9 |
| `src/tools/server-catalog.test.ts` | no-`orders` / no-`voice-fixture` assertions | 9 |
| `src/voice-worker/hive-llm.test.ts` | S1 lock: POST body has no `tools` key (test-only) | 9 |
| `src/agents/agent-manager.test.ts`, `src/channels/dispatcher.test.ts`, `src/channels/voice/voice-adapter.test.ts`, `src/agents/warm-voice-session.test.ts`, `src/agents/agent-runner.test.ts` | field-ripple defaults + new cases | 3–6 |
| `CLAUDE.md` | one-line in-process-server list entry for `voice-fixture` (delegateServers-constraint paragraph only — NOT the MCP-servers catalog list) | 8 |
| instance `agent_definitions` (Mongo) | C9: `voice-pilot.coreServers += "voice-fixture"` via MCP `agent_update` + SIGUSR1 | 11 (ops) |

No new processes, no new HTTP surfaces, no schema changes, no new secrets, **no worker diff** (spec §8).

---

## 2. Tasks

### Task 0 — Anchor re-confirmation gate (mandatory; demote-to-spec escape hatch)

**Files:** none modified except cosmetic line-ref updates in this plan. Output: a pass/fail table in the implement-lane notes.

Rule: re-locate each anchor at delivery HEAD by symbol, not line. **Cosmetic drift** (line shifts, comment growth) → update refs inline and proceed. **Material drift** (signature/semantics/shape changes) → STOP, demote to the spec lane.

Plan-time re-pin (spec was cut at `f0f4abd`; this table is already re-verified at `d1d61e8` — delivery re-confirms):

| Spec anchor (at `f0f4abd`) | Found at `d1d61e8` | Verdict |
|---|---|---|
| `RunResult` `agent-runner.ts:134-168` (three tool fields, no `toolAckInjected`) | `:138-174` — `toolMs`/`toolCalls`/`toolSummary` at `:144-146`; no `toolAckInjected` anywhere in `src/` | COSMETIC (KPR-323 C1 fields + KPR-388 `resumedSession` added; shape intact) |
| `send()` tool_use timing block `:2186-2204` | assistant branch `:2292-2334` (`tool_use` push at `:2316-2327`); text_delta forward `:2271-2280`; return literal `:2508-2518` | COSMETIC (KPR-401 usage accumulator grew the loop; per-block iteration + `activeToolName` timing semantics unchanged) |
| `WarmVoiceSession.consumeOneTurn` `:485-515` | `:405-664`; text_delta case `:494-510`; assistant case `:511-543`; return `:634-663`; `WarmTurnRequest` `:85-91` | COSMETIC |
| `TurnResult` `agent-manager.ts:133-148` | `:167-224` (same three tool fields `:180-182`; KPR-323/388 additions) | COSMETIC |
| `finalizeSpawnResult` `:2287-2311` | `:2747-2866` (copies the three tool fields at `:2853-2856`); `synthesizeAbortedResult` `:2307-2326`; `runWarmTurn` `:1779-1848` (returns `finalizeSpawnResult(ctx, runResult, …)` at `:1813`) | COSMETIC (large shift from KPR-386–414 merges; semantics intact) |
| `convertTurnResult` `dispatcher.ts:384-411` (+ helper contract comment `:379-382`) | `:474-505` (contract comment `:469-472`: "Every field of `RunResult` MUST be mapped explicitly here"); `routeVoiceTurn` `:1105` returns `spawnTurn`'s `TurnResult` directly | COSMETIC |
| "Voice turn complete" `voice-adapter.ts:532-550` | `:532-550` — carries KPR-323 C1/C2 fields; **omits** `toolCalls`/`toolMs`/`toolSummary`/`toolAckInjected` as the spec states | UNCHANGED |
| `buildVoiceSystemPrompt` `prompt-builder.ts:34-38` | `:34-39` (Voice Call Mode push; no toolkit/delegates) | UNCHANGED |
| `IN_PROCESS_PORTED_SERVERS` (`in-process-servers.ts`) | `:23-36` (11 names incl. `worker-pool`) | UNCHANGED |
| `buildInProcessServers` / `shouldEnableInProcessServer` | `agent-runner.ts:1463` / `:477-479`; inventory compensation pattern (memory `:1367-1379`, worker-pool `:1385-1397`) | UNCHANGED |
| Registry KPR-184 strip pattern | `agent-registry.ts:45-55` (`sanitizeDelegateServers`), applied in `load()` at `:241-247` | UNCHANGED |
| `SERVER_CATALOG` — no `orders`, no `voice-fixture` | `server-catalog.ts:20-144` — neither key present | UNCHANGED |
| `buildInstanceCapabilities`: check-less catalog key → `configured` | `instance-capabilities.ts:89-91` (`SERVER_CREDENTIAL_CHECKS` at `:44`) | UNCHANGED (C8's fake-live rationale holds) |
| S1: no `/v1/tools`, `HiveLLM` POST body has no `tools` key | `grep -rn "v1/tools" src/` empty; `hive-llm.ts` POST body fields verified | UNCHANGED |
| `voice` config block | `config.ts:534-557` (after 322 E1/E3 + 323 C4 keys); `resolveVoiceWarmPathConfig` at `:249-266` is the C6 template | COSMETIC |
| **New (plan-added, not in spec §15):** `RunResult` re-exported to plugin authors | `provider-adapters/provider-abi.ts:112` (`export type { RunResult, StreamCallback, WorkItemContext }`); `LANE_B_PROVIDER_ABI_VERSION = 1`; bundled into `pkg/types/` by the KPR-407 closure trace | PRESENT — drives Task 3 Step 6b's no-bump ruling |
| **New (plan-added):** config-mock sites that must learn `toolAck` | `agent-runner.test.ts:183-190`; `agent-manager.test.ts:83-92` + `:6258/:6266/:6272/:6920`; `agent-runner.test.ts` `tool_use` cases at `:3778/:3801/:3851/:4394/:4431` | PRESENT — Tasks 4/5 Step 0 |
| **New (plan-added):** bundle forbidden-string list | `scripts/check-bundle-strings.mjs:18` — `["dodi", "hubspot", "cabinet"]` | PRESENT — Task 8 fixture-prose constraint |

- [ ] Re-run the table above at delivery HEAD (grep by symbol). Any material row → demote-to-spec, stop.
- [ ] ⚠ registry #2 reconfirm: `tool_use` is observed in the message loop **before** the tool handler runs (the assistant message with `tool_use` blocks is yielded ahead of `tool_progress`/tool results — `agent-runner.ts:2283-2334` ordering). If a delivery-HEAD SDK bump changed this, the inject site moves to the `tool_progress` branch (same helper, different event — spec §14 fallback) — that is a plan amendment, not a demote.
- [ ] Reconfirm `voice.toolAck` does not already exist in `src/config.ts` and `toolAckInjected` appears nowhere in `src/` (`grep -rn "toolAck" src/` empty).
- [ ] Record the table (anchor → found-at → verdict) in lane notes.

### Task 1 — C6: `voice.toolAck.enabled` config key (default **on**)

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1:** Add the pure resolver directly below `resolveVoiceWarmPathConfig` (`config.ts:~266`):

```typescript
/**
 * KPR-324 C6/S7: resolve the optional hive.yaml `voice.toolAck` section.
 * Liberal-loader style (KPR-225 F3) with the INVERSE default of 323's
 * warm-path flag: masking IS the ticket, so absent/garbage → ENABLED.
 * Only a literal `false` disables injection (the rollback lever, spec §8).
 * Phrases, rotation, and the fixture delay cap are constants in
 * voice-tool-ack.ts / voice-fixture-mcp-server.ts — deliberately NOT config.
 * Exported pure for unit tests.
 */
export interface VoiceToolAckConfig {
  enabled: boolean;
}

export function resolveVoiceToolAckConfig(raw: unknown): VoiceToolAckConfig {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return { enabled: src.enabled !== false };
}
```

- [ ] **Step 2:** Add one line inside the `voice` block (`config.ts:534-557`, beside the 323 `warmPath` key):

```typescript
    // KPR-324 C6: mid-call tool-start acknowledgment master switch. Default
    // ON (S7 — masking is the ticket); literal `false` is the rollback lever.
    toolAck: resolveVoiceToolAckConfig((hive.voice as Record<string, unknown> | undefined)?.toolAck),
```

- [ ] **Step 3:** Tests in `src/config.test.ts` (beside the `resolveVoiceWarmPathConfig` describe):

```typescript
import { resolveVoiceToolAckConfig } from "./config.js";

describe("resolveVoiceToolAckConfig (KPR-324 C6)", () => {
  it("defaults to enabled on absent/garbage input (spec §12.1 #7)", () => {
    for (const input of [undefined, null, 42, "x", [], {}, { enabled: "false" }, { enabled: 0 }, { enabled: "no" }]) {
      expect(resolveVoiceToolAckConfig(input).enabled).toBe(true);
    }
  });
  it("disables on literal false only", () => {
    expect(resolveVoiceToolAckConfig({ enabled: false }).enabled).toBe(false);
  });
  it("enables on literal true; ignores unknown keys", () => {
    expect(resolveVoiceToolAckConfig({ enabled: true, phrases: ["x"] }).enabled).toBe(true);
  });
});
```

- [ ] **Step 4:** Verify — `npx vitest run src/config.test.ts` green; `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck` green.
- [ ] **Step 5:** Commit — `git add src/config.ts src/config.test.ts && git commit -m "feat(kpr-324): C6 voice.toolAck.enabled config key (default on)"`

### Task 2 — C1: `src/agents/voice-tool-ack.ts` helper

Pure module: the voice-channel gate and the caller-owned phrase rotation (spec §4.3). No I/O, no logging, no config import — callers supply `enabled`.

**Files:**
- Create: `src/agents/voice-tool-ack.ts`
- Create: `src/agents/voice-tool-ack.test.ts`

- [ ] **Step 1:** Create `src/agents/voice-tool-ack.ts` (complete file):

```typescript
/**
 * KPR-324 C1/S2: hive-side tool-start acknowledgment for voice turns.
 *
 * When a voice-channel spawn loop observes a `tool_use` block and the model
 * produced no spoken text in the current segment (turn-start → this
 * boundary, or previous boundary → this one — spec §4.1), the caller injects
 * one canned phrase through the existing `onStream` SSE path so the caller
 * hears something before the tool-run silence. The phrase is NEVER written
 * into the SDK session transcript (spec §4.1 "do not insert into history").
 *
 * Pure module: no I/O, no logging, no config read — both spawn loops
 * (AgentRunner.send cold, WarmVoiceSession.consumeOneTurn warm) pass
 * `enabled` from config.voice.toolAck and their own channel/stream facts.
 *
 * Rotation state is CALLER-OWNED and per-turn (spec §4.2): each spawn-loop
 * iteration keeps its own `{ index }` local, so concurrent calls never
 * skip/collide phrases. Do not add a module-level counter.
 */

/**
 * Phone-native phrase set (spec §4.2): constants, not config. Delivery may
 * retune wording without a spec amendment; 325 may persona-split later.
 * No markdown, no "as an AI" — normalizeForTTS passes these through as-is.
 */
export const VOICE_TOOL_ACK_PHRASES: readonly string[] = [
  "One moment.",
  "Let me check that.",
  "Hang on, I'll look that up.",
];

/**
 * Single separator appended by CALL SITES (not part of the phrase constants):
 * SSE `delta.content` chunks concatenate verbatim downstream, so without it
 * the ack would fuse with the model's post-tool sentence ("moment.The
 * status…") and defeat TTS sentence splitting. Wording-latitude ruling
 * (spec §4.2, "delivery may retune") covers this one-space addition.
 */
export const VOICE_TOOL_ACK_SEPARATOR = " ";

export interface ToolAckGateArgs {
  /** config.voice.toolAck.enabled — the S7 rollback lever. */
  enabled: boolean;
  /** True iff any assistant text was streamed/emitted in the current segment. */
  streamedThisSegment: boolean;
  /** True iff the loop has an onStream callback to speak through. Necessary but NOT sufficient (spec §4.3). */
  hasOnStream: boolean;
  /** Cold: WorkItemContext.channelKind; warm: the lease's channel (always "voice"). The load-bearing gate. */
  channel: string;
}

/** Spec §4.1 gate: inject iff enabled ∧ silent segment ∧ streamable ∧ voice. */
export function shouldInjectToolAck(args: ToolAckGateArgs): boolean {
  return args.enabled && !args.streamedThisSegment && args.hasOnStream && args.channel === "voice";
}

/** Caller-owned per-turn rotation state (starts at 0 each send/consumeOneTurn). */
export interface AckRotationState {
  index: number;
}

/**
 * Next phrase in rotation, wrapping. Pure: returns the phrase and the NEW
 * index; the caller reassigns its local state (spec §4.3 signature).
 */
export function nextAckPhrase(state: AckRotationState): { phrase: string; index: number } {
  const phrase = VOICE_TOOL_ACK_PHRASES[state.index % VOICE_TOOL_ACK_PHRASES.length]!;
  return { phrase, index: state.index + 1 };
}
```

- [ ] **Step 2:** Create `src/agents/voice-tool-ack.test.ts` (complete file):

```typescript
import { describe, it, expect } from "vitest";
import {
  VOICE_TOOL_ACK_PHRASES,
  shouldInjectToolAck,
  nextAckPhrase,
} from "./voice-tool-ack.js";

describe("shouldInjectToolAck (KPR-324 §4.1 gate — spec §12.1 #1)", () => {
  const base = { enabled: true, streamedThisSegment: false, hasOnStream: true, channel: "voice" };

  it("true only when enabled + silent segment + onStream + voice", () => {
    expect(shouldInjectToolAck(base)).toBe(true);
  });

  it("false for text channels even with onStream set (load-bearing channel gate)", () => {
    for (const channel of ["slack", "sms", "ws", "internal", "scheduler", ""]) {
      expect(shouldInjectToolAck({ ...base, channel })).toBe(false);
    }
  });

  it("false when voice but onStream is missing (non-streaming degenerate)", () => {
    expect(shouldInjectToolAck({ ...base, hasOnStream: false })).toBe(false);
  });

  it("false when the segment already streamed text (natural mask wins)", () => {
    expect(shouldInjectToolAck({ ...base, streamedThisSegment: true })).toBe(false);
  });

  it("false when disabled (S7 rollback lever)", () => {
    expect(shouldInjectToolAck({ ...base, enabled: false })).toBe(false);
  });
});

describe("nextAckPhrase rotation (spec §12.1 #12)", () => {
  it("rotates in order and wraps", () => {
    let state = { index: 0 };
    const seen: string[] = [];
    for (let i = 0; i < VOICE_TOOL_ACK_PHRASES.length + 1; i++) {
      const { phrase, index } = nextAckPhrase(state);
      seen.push(phrase);
      state = { index };
    }
    expect(seen.slice(0, VOICE_TOOL_ACK_PHRASES.length)).toEqual([...VOICE_TOOL_ACK_PHRASES]);
    expect(seen[VOICE_TOOL_ACK_PHRASES.length]).toBe(VOICE_TOOL_ACK_PHRASES[0]);
  });

  it("is caller-owned: two interleaved states advance independently (no module counter)", () => {
    let a = { index: 0 };
    let b = { index: 0 };
    const r1 = nextAckPhrase(a);
    a = { index: r1.index };
    const r2 = nextAckPhrase(b); // interleaved second caller
    const r3 = nextAckPhrase(a);
    expect(r1.phrase).toBe(VOICE_TOOL_ACK_PHRASES[0]);
    expect(r2.phrase).toBe(VOICE_TOOL_ACK_PHRASES[0]); // NOT phrase[1] — no shared counter
    expect(r3.phrase).toBe(VOICE_TOOL_ACK_PHRASES[1]);
  });

  it("phrase set is phone-native: non-empty, no markdown characters", () => {
    for (const p of VOICE_TOOL_ACK_PHRASES) {
      expect(p.length).toBeGreaterThan(0);
      expect(p).not.toMatch(/[*_`#\[\]]/);
    }
  });
});
```

- [ ] **Step 3:** Verify — `npx vitest run src/agents/voice-tool-ack.test.ts` green; typecheck green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-324): C1 voice-tool-ack helper (channel gate + caller-owned rotation)"`

### Task 3 — C5a/C5b/C5c/C5e: `toolAckInjected` field plumbing (types, copy, mapping — zeros everywhere first)

Adds the field as a **required** number on both `RunResult` and `TurnResult`, defaulting 0 at every construction site, so `tsc` enumerates the ripple and the copy path exists before the counters go live (Tasks 4–5 turn the two spawn-loop zeros into real counts). This ordering makes each subsequent task compile-green in isolation.

**Files:**
- Modify: `src/agents/agent-runner.ts` (C5a type + `send()` return zero), `src/agents/agent-manager.ts` (C5b type, C5c copy + `synthesizeAbortedResult`), `src/agents/warm-voice-session.ts` (return zero), `src/agents/provider-adapters/turn-scaffold.ts` (Lane B zero-shape), `src/channels/dispatcher.ts` (C5e mapping)
- Test: `src/agents/agent-manager.test.ts`, `src/channels/dispatcher.test.ts` (+ mechanical fixture ripple wherever typecheck flags)

- [ ] **Step 1 (C5a):** `agent-runner.ts` — extend `RunResult` (`:138-174`), after `toolSummary`:

```typescript
  /**
   * KPR-324 C5a/S4: count of hive-injected tool-start acknowledgment phrases
   * spoken on this turn (voice channel only — 0 on every other channel, when
   * voice.toolAck.enabled is false, or when the model spoke before each
   * tool_use). REQUIRED, not optional: a spawn-loop counter that is not on
   * RunResult drops at the finalizeSpawnResult copy and the adapter logs
   * 0/undefined (spec §4.6) — the required type makes every construction
   * site declare it.
   */
  toolAckInjected: number;
```

and add `toolAckInjected: 0,` to `send()`'s return literal (`:2508-2518`, beside `toolSummary`) — Task 4 replaces the 0 with the live counter.

- [ ] **Step 2 (C5b):** `agent-manager.ts` — extend `TurnResult` (`:167-224`), after `toolSummary`:

```typescript
  /** KPR-324 C5b/S4: copied verbatim from RunResult.toolAckInjected by
   *  finalizeSpawnResult (the same copy the other three tool fields ride).
   *  Voice adapter logs it (C5d); chat convertTurnResult maps it back (C5e). */
  toolAckInjected: number;
```

- [ ] **Step 3 (C5c):** `agent-manager.ts` — `finalizeSpawnResult`'s return literal (`:2840-2865`), beside the other three:

```typescript
      toolSummary: result.toolSummary || null,
      // KPR-324 C5c — the load-bearing copy (spec §4.6 step 3). The `?? 0`
      // is the out-of-engine belt, NOT slack for in-engine callers: an
      // adapter shipped by a provider plugin (KPR-394) was compiled against
      // an older `pkg/types/` RunResult and can legitimately omit the field
      // at runtime, where `undefined` would flow into a required-number
      // TurnResult slot and log as `undefined` on C5d. Every in-engine
      // construction site still declares it explicitly (C5a is required).
      toolAckInjected: result.toolAckInjected ?? 0,
```

and `synthesizeAbortedResult` (`:2307-2326`) gains `toolAckInjected: 0,` beside `toolCalls: 0`.

- [ ] **Step 3b (ABI ruling — record it, do not act on it):** `RunResult` is re-exported to plugin authors via `@keepur/hive/provider-abi` (`provider-abi.ts:112`) and ships in `pkg/types/`, so C5a widens the plugin-facing declaration. **Ruling: `LANE_B_PROVIDER_ABI_VERSION` stays `1`.** The handshake is an exact-integer runtime check against the manifest's `abi:` — bumping it would fail activation for every installed provider plugin (turning an additive, engine-populated telemetry field into an ecosystem break), while the actual runtime contract is unchanged: an adapter that omits the field degrades to 0 via Step 3's belt. Note this in the commit message and in lane notes so review does not re-derive it. Do **not** edit `provider-abi.ts`, `LANE_B_PROVIDER_ABI_VERSION`, or the bundle's type-closure tracer — the new field rides the existing trace automatically.

- [ ] **Step 4 (C5c rider — Lane B zero-shape):** `turn-scaffold.ts` `buildResult` return literal (`:310-332`), beside `toolCalls`:

```typescript
      toolCalls,
      // KPR-324 C5a: Lane B adapters never inject voice acks (spec §4.3 —
      // W5 voice is Claude-lane; a future Lane B voice path reopens the
      // helper at that adapter's tool-round boundary). Honest zero.
      toolAckInjected: 0,
```

- [ ] **Step 5:** `warm-voice-session.ts` — `consumeOneTurn`'s return literal (`:634-663`) gains `toolAckInjected: 0,` beside `toolCalls` (Task 5 replaces with the live counter).

- [ ] **Step 6 (C5e):** `dispatcher.ts` `convertTurnResult` (`:474-505`) — beside `toolSummary`:

```typescript
      toolSummary: turn.toolSummary ?? "",
      // KPR-324 C5e: helper contract — every RunResult field mapped
      // explicitly. Voice never passes through here (routeVoiceTurn returns
      // TurnResult straight from spawnTurn); this mapping keeps the chat
      // lane's RunResult honest and is what C5a's required type enforces.
      toolAckInjected: turn.toolAckInjected,
```

- [ ] **Step 7 (fixture ripple):** run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck` and add `toolAckInjected: 0` to every construction site it flags. **`tsc` under-enumerates here — do the first bullet even if the compiler stays silent:**
  - `src/agents/agent-manager.test.ts` — `makeRunResult` helper (`:307-327`): add `toolAckInjected: 0,` to the base object (the `overrides` parameter then covers all cases). Its return type is **inferred**, not annotated `: RunResult`, so a missing field compiles clean and surfaces only as a runtime `undefined` in the Step 8 copy-path assertion. Non-negotiable step.
  - `src/channels/dispatcher.test.ts` — TurnResult literals (~7 sites: `:192`, `:212`, `:444`, `:870`, `:932`, `:1194`, `:2277` at plan-time).
  - `src/channels/voice/voice-adapter.test.ts` / `voice-adapter.integration.test.ts` — TurnResult fixtures.
  - Any other `RunResult`/`TurnResult` literal in tests (`warm-voice-session.test.ts` builds results only via the module — no literal expected).
- [ ] **Step 8 (tests):**
  - `agent-manager.test.ts` (integration, additive): cold copy — `mockRunnerSend.mockResolvedValue(makeRunResult({ toolAckInjected: 3 }))`, spawn an SMS turn, assert the returned `TurnResult.toolAckInjected === 3` (proves C5c; the field is channel-agnostic on the copy — gating lives in the spawn loops).
  - `dispatcher.test.ts` (additive): extend an existing `convertTurnResult`-exercising case (e.g. the `:870` telemetry case) or add one: `runWorkItemTurn` resolves a TurnResult with `toolAckInjected: 2` → the "Work item dispatched" flow completes and, where the case inspects the converted RunResult, `toolAckInjected === 2`. Minimum: a direct assertion that the mapping exists (spec §12.1 #5's `convertTurnResult` clause).
- [ ] **Step 9:** Verify — `npx vitest run src/agents src/channels` green (full ripple proof); typecheck green.
- [ ] **Step 10:** Commit — `git commit -m "feat(kpr-324): C5a-e toolAckInjected field plumbing (RunResult/TurnResult required, finalize copy, convertTurnResult mapping)"`

### Task 4 — C2: cold inject in `AgentRunner.send`

Wire the helper at the cold loop's `tool_use` observation (assistant branch, `agent-runner.ts:2292-2334`), tracking the §4.1 segment rule. The ack goes to `onStream` only — never into the SDK transcript, never into `resultText`, and it does **not** set the loop's `streamed` flag (it is not model text; `RunResult.streamed` keeps meaning "the model streamed").

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Test: `src/agents/agent-runner.test.ts`

- [ ] **Step 0 (harness — do this FIRST, it is a break, not a polish):** `agent-runner.test.ts`'s config mock replaces the `config` singleton wholesale (`importOriginal` only preserves the module's *other* exports), and its `voice` object (`:183-190`) has no `toolAck` key. The gate's argument object is built **before** `shouldInjectToolAck` can short-circuit on channel, so `config.voice.toolAck.enabled` throws a `TypeError` on every `tool_use` message — including the five pre-existing, non-voice cases at `:3778`, `:3801`, `:3851`, `:4394`, `:4431`. Add to that mock's `voice` object:

```typescript
        // KPR-324 C6: the runner reads this at every tool_use boundary.
        toolAck: { enabled: true },
```

Run `npx vitest run src/agents/agent-runner.test.ts` now (before Step 1) and confirm green — this establishes the pre-change baseline.

- [ ] **Step 1:** Import the helper at the top of `agent-runner.ts`:

```typescript
import { shouldInjectToolAck, nextAckPhrase, VOICE_TOOL_ACK_SEPARATOR } from "./voice-tool-ack.js";
```

- [ ] **Step 2:** Add the per-turn locals in `send()` beside the instrumentation block (`:2210-2212`, after `activeToolName`):

```typescript
    // KPR-324 C2/S2: tool-start acknowledgment state (spec §4.1 segment
    // rule). Per-turn locals — rotation is caller-owned so concurrent calls
    // never share a counter (spec §4.2).
    let streamedThisSegment = false;
    let toolAckInjected = 0;
    let ackRotation = { index: 0 };
```

- [ ] **Step 3:** In the text_delta branch (`:2271-2280`), after `streamed = true;`:

```typescript
            onStream(event.delta.text);
            streamed = true;
            streamedThisSegment = true; // KPR-324 §4.1: the model spoke in this segment
```

- [ ] **Step 4:** In the assistant branch (`:2292-2334`), immediately before the `for (const block of content)` loop, add the text-blocks-first scan; and inside the `tool_use` block handling, add the inject + segment reset. Full replacement of the content-handling section:

```typescript
          const content = assistantMessage?.content;
          if (Array.isArray(content)) {
            // KPR-324 §4.1: text blocks are processed BEFORE tool blocks so a
            // "let me check that" + tool_use in ONE assistant message counts
            // as streamed (no double-speak — spec §4.1 same-message rule).
            if (content.some((b: any) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)) {
              streamedThisSegment = true;
            }
            for (const block of content) {
              if (block.type === "text") {
                resultText = block.text;
              } else if (block.type === "tool_use") {
                // KPR-324 C2/S2: speak a canned hold line iff this segment was
                // silent and this is a streaming VOICE turn. SSE-only — the
                // phrase never enters the SDK transcript or resultText, and
                // does not set `streamed` (not model text). tool_use is
                // observed BEFORE the handler runs (⚠ registry #2, Task 0),
                // so the ack reaches TTS while the tool executes.
                if (
                  shouldInjectToolAck({
                    enabled: config.voice.toolAck.enabled,
                    streamedThisSegment,
                    hasOnStream: !!onStream,
                    channel: context?.channelKind ?? "",
                  })
                ) {
                  const next = nextAckPhrase(ackRotation);
                  ackRotation = { index: next.index };
                  onStream!(next.phrase + VOICE_TOOL_ACK_SEPARATOR);
                  toolAckInjected += 1;
                }
                streamedThisSegment = false; // §4.1: the tool-run gap starts now
                // Close previous tool timing if any
                if (activeToolName && toolCalls.length > 0) {
                  toolCalls[toolCalls.length - 1]!.endMs = Date.now();
                }
                activeToolName = block.name;
                const activeToolStart = Date.now();
                toolCalls.push({ tool: block.name, startMs: activeToolStart });
                log.info("Tool call started", {
                  agent: this.agentConfig.id,
                  tool: block.name,
                });
              }
            }
          }
```

- [ ] **Step 5:** Replace the Task 3 placeholder in the return literal: `toolAckInjected: 0,` → `toolAckInjected,`.
- [ ] **Step 6:** Tests in `agent-runner.test.ts` (additive; use the file's existing query-mock idiom — the Step 0 mock edit supplies `enabled: true`; the disabled case mutates `config.voice.toolAck.enabled` in-test and restores it in a `finally`). A voice `WorkItemContext` fixture: `{ adapterId: "voice", channelId: "call-1", channelKind: "voice", channelLabel: "voice:call-1", threadId: "voice:call-1", slackTs: "", slackThreadTs: "" }`. Cases (spec §12.1 #2/#3/#4 cold half):
  1. **Silent tool injects once:** mock query emits `system/init` → assistant message `{ content: [{ type: "tool_use", name: "mcp__voice-fixture__voice_fixture_lookup", id: "t1", input: {} }] }` → assistant text → `result`. `onStream` spy: FIRST call is `VOICE_TOOL_ACK_PHRASES[0] + " "` and it happens before the result message is emitted (script the mock to assert ordering, or assert call order vs a delta emitted after the tool_use). Returned `RunResult.toolAckInjected === 1`.
  2. **Text-then-tool no inject:** a text_delta (forwarded) precedes the tool_use assistant message → spy never receives an ack phrase; `toolAckInjected === 0`.
  3. **Two silent tools inject twice — both shapes:** (a) two sequential assistant messages each with one `tool_use` → phrases [0] then [1], `toolAckInjected === 2`; (b) ONE assistant message with two `tool_use` blocks → same.
  4. **Text + tool same assistant message no inject:** `content: [{ type: "text", text: "let me check" }, { type: "tool_use", … }]` → `toolAckInjected === 0`.
  5. **Channel gate:** same silent-tool script with `channelKind: "slack"` and `onStream` set → zero injects (spec §12.1 #1's loop-level proof).
  6. **Disabled:** mutate `config.voice.toolAck.enabled = false` (restore in `finally`) → zero injects on the silent-tool voice script; `toolAckInjected === 0`.
  7. **No onStream:** silent-tool voice script without `onStream` → no throw, `toolAckInjected === 0`.
- [ ] **Step 7:** Verify — `npx vitest run src/agents/agent-runner.test.ts` green; then the channel-gate rule: `npx vitest run src/agents/agent-manager.test.ts src/channels/dispatcher.test.ts` green untouched; typecheck green.
- [ ] **Step 8:** Commit — `git commit -m "feat(kpr-324): C2 cold-path tool-start ack injection in AgentRunner.send"`

### Task 5 — C3: warm inject in `WarmVoiceSession.consumeOneTurn`

Identical observation-site add inside the warm demux loop (`warm-voice-session.ts:494-543`). The module newly imports `config` (for the S7 flag — per-turn read at the boundary, same as cold) and passes the literal channel `"voice"` (a lease is voice-only by 323 §4.7 eligibility; passing it keeps C2 and C3 on one gate — spec §4.3). **Zero changes to the 323 lease lifecycle** — no new close paths, no abort changes, no timer changes.

**Files:**
- Modify: `src/agents/warm-voice-session.ts`
- Test: `src/agents/warm-voice-session.test.ts`, `src/agents/agent-manager.test.ts` (warm end-to-end)

- [ ] **Step 1:** Add imports to `warm-voice-session.ts`:

```typescript
import { config } from "../config.js";
import { shouldInjectToolAck, nextAckPhrase, VOICE_TOOL_ACK_SEPARATOR } from "./voice-tool-ack.js";
```

- [ ] **Step 2:** Add the per-turn locals in `consumeOneTurn` beside `toolCalls`/`activeToolName` (`:442-443`):

```typescript
    // KPR-324 C3/S2: tool-start ack state — per-turn locals (spec §4.2
    // caller-owned rotation; a lease serves ONE call but each turn restarts
    // the rotation, matching the cold path).
    let streamedThisSegment = false;
    let toolAckInjected = 0;
    let ackRotation = { index: 0 };
```

- [ ] **Step 3:** In the `stream_event` case (`:494-510`), after `streamed = true;` add `streamedThisSegment = true;`.
- [ ] **Step 4:** In the `assistant` case (`:511-543`), mirror Task 4 Step 4 exactly — text-blocks-first scan before the block loop, then in the `tool_use` branch:

```typescript
            const content = assistantMessage?.content;
            if (Array.isArray(content)) {
              // KPR-324 §4.1: text blocks BEFORE tool blocks (same-message rule).
              if (content.some((b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)) {
                streamedThisSegment = true;
              }
              for (const block of content) {
                if (block.type === "text") {
                  text = block.text;
                } else if (block.type === "tool_use") {
                  // KPR-324 C3/S2: warm twin of the cold inject. channel is
                  // the literal "voice" — warm eligibility is already
                  // voice-only (323 §4.7); passing it keeps C2/C3 on one
                  // shared gate (spec §4.3). SSE-only; never into history.
                  if (
                    shouldInjectToolAck({
                      enabled: config.voice.toolAck.enabled,
                      streamedThisSegment,
                      hasOnStream: !!req.onStream,
                      channel: "voice",
                    })
                  ) {
                    const next = nextAckPhrase(ackRotation);
                    ackRotation = { index: next.index };
                    try {
                      req.onStream!(next.phrase + VOICE_TOOL_ACK_SEPARATOR);
                    } catch (err) {
                      // Same containment as the delta relay above: a throwing
                      // onStream must not kill the turn (322 E2 suppression
                      // throws nothing, but the lease's throw-safety posture
                      // is unconditional).
                      safeLog("warn", "onStream callback threw during tool ack", {
                        ...this.logCtx(),
                        error: String(err),
                      });
                    }
                    toolAckInjected += 1;
                  }
                  streamedThisSegment = false; // §4.1: tool-run gap starts now
                  if (activeToolName && toolCalls.length > 0) {
                    toolCalls[toolCalls.length - 1]!.endMs = Date.now();
                  }
                  activeToolName = block.name;
                  toolCalls.push({ tool: block.name, startMs: Date.now() });
                }
              }
            }
```

- [ ] **Step 5:** Replace the Task 3 placeholder in the return literal: `toolAckInjected: 0,` → `toolAckInjected,`. (`runWarmTurn` already returns this `RunResult` into `finalizeSpawnResult` unchanged — spec §4.3 wire item 2; no `agent-manager.ts` edit in this task.)
- [ ] **Step 6:** `warm-voice-session.test.ts` — the module now imports the real `config.ts`, which throws in a bare vitest process (`required("SLACK_APP_TOKEN")`). Add a factory mock at the top (meeting-classifier idiom), with a hoisted mutable flag so cases can flip it:

```typescript
const toolAckFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("../config.js", () => ({
  config: { voice: { toolAck: toolAckFlag } },
}));
```

New cases (additive; reuse `makeFakeQuery`/`emit` helpers; existing cases untouched — they emit no `tool_use`, so behavior is identical):
  1. **Silent tool injects once (warm half of spec §12.1 #4):** start a lease, emit `assistantMsg`-shaped message whose content is `[{ type: "tool_use", name: "mcp__voice-fixture__voice_fixture_lookup", id: "t1", input: {} }]` with no prior deltas, then a text delta, then `result`. `onStream` spy first call `=== VOICE_TOOL_ACK_PHRASES[0] + " "`, received before the result was emitted; returned `RunResult.toolAckInjected === 1`.
  2. **Text-then-tool no inject:** delta first → `toolAckInjected === 0`, spy has no ack chunk.
  3. **Two tool_use in one assistant message:** two ack chunks (phrases [0], [1]); `toolAckInjected === 2`.
  4. **Disabled:** `toolAckFlag.enabled = false` (restore after) → zero injects.
  5. **Per-turn rotation reset:** two sequential `runTurn`s, each with one silent tool → BOTH turns speak phrase [0] (rotation is per-turn, not per-lease — spec §4.2).
- [ ] **Step 7:** `agent-manager.test.ts` — warm end-to-end (additive; this is spec §12.1 #4's "each loop's returned RunResult" + §12.1 #5's warm copy proof through the REAL manager). Harness first: this suite uses the **real** `WarmVoiceSession`, so its config mock is what the warm loop reads.
  - Add `toolAck: { enabled: false }` to the base config mock's `voice` object (`:83-92`, beside `warmPath`) — **off** by default so every pre-existing case stays behavior-identical, matching the 323 precedent for `warmPath`.
  - Update **all four** wholesale `(appConfig as any).voice = { warmPath: … }` replacements — `:6258`, `:6266`, `:6272`, **and `:6920`** (easy to miss; `grep -n 'appConfig as any).voice\s*=' src/agents/agent-manager.test.ts` is the enumeration) — to also carry `toolAck: { enabled: false }`. A replacement that drops the key re-creates the Task 4 Step 0 `TypeError` the moment any case emits a `tool_use`.
  - New ack cases set `toolAck: { enabled: true }` explicitly.
  - New case: warm flag on + `toolAck` on, drive the fake streaming Query to answer the pushed message with a silent `tool_use` assistant message then a delta then `result` → `onStream` spy received an ack chunk; the `TurnResult` returned by `spawnTurn` has `toolAckInjected === 1` and `warmPath === true`.
- [ ] **Step 8:** Verify — `npx vitest run src/agents/warm-voice-session.test.ts src/agents/agent-manager.test.ts` green (all 323 cases untouched); typecheck green.
- [ ] **Step 9:** Commit — `git commit -m "feat(kpr-324): C3 warm-path tool-start ack injection in WarmVoiceSession.consumeOneTurn"`

### Task 6 — C5d: tool fields on "Voice turn complete"

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts`
- Test: `src/channels/voice/voice-adapter.test.ts`

- [ ] **Step 1:** Extend the log call (`voice-adapter.ts:532-550`) — insert after the KPR-323 C1 spread, before the warm markers:

```typescript
      // KPR-324 C5d/S4: tool observability for T-gates and 325 pause
      // attribution. Counts + durations + server-name summary only — the
      // existing redaction posture (tool NAMES, never args, never content,
      // never the ack phrase text).
      toolCalls: result.toolCalls,
      toolMs: result.toolMs,
      toolSummary: result.toolSummary ?? "none",
      toolAckInjected: result.toolAckInjected,
```

- [ ] **Step 2:** Test in `voice-adapter.test.ts` (additive — mirror the KPR-323 C1 log-field case at `:333`, using the existing `mockLog` spies): drive a turn whose mocked `TurnResult` carries `toolCalls: 2, toolMs: 1800, toolSummary: "voice-fixture:1x/1.5s", toolAckInjected: 1`; find the "Voice turn complete" call; assert the four fields present with those values; assert **no** field of the entry contains any `VOICE_TOOL_ACK_PHRASES` string (no-content check, spec §12.1 #5).
- [ ] **Step 3:** Verify — `npx vitest run src/channels/voice` green (all existing adapter + integration cases untouched); typecheck green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-324): C5d tool fields on Voice turn complete (toolCalls/toolMs/toolSummary/toolAckInjected)"`

### Task 7 — C4: Voice Call Mode tool paragraph

Appends the spec §5 guardrail paragraph **inside** the existing static Voice Call Mode `parts.push` (`prompt-builder.ts:34-39`) — static text, no per-call data, so the voice prefix stays cache-friendly and no new section breaks the assembly order. The toolkit dump stays omitted (S8: the SDK still attaches MCP schemas, so the model can call tools without the KPR-87 section).

**Files:**
- Modify: `src/agents/prompt-builder.ts`
- Create: `src/agents/prompt-builder.test.ts`

- [ ] **Step 1:** Replace the Voice Call Mode push with:

```typescript
  // Voice-specific instructions
  // KPR-324 C4/S8: the tools paragraph is complementary to the engine's
  // code-shaped tool-start ack (S2), not a substitute — models skip
  // prompt-only wait lines. Static text: sits with the rest of Voice Call
  // Mode, before goal/context/memory/datetime (prefix-cache friendly).
  // Deliberately still NO toolkit dump / delegate catalog here — the SDK
  // attaches MCP schemas, so the model can call tools without the KPR-87
  // section (spec §5).
  parts.push(
    `## Voice Call Mode\n\n` +
    `You are currently on a live phone call. Keep responses conversational and concise — ` +
    `you are speaking out loud, not writing text. Avoid markdown, bullet points, or long lists. ` +
    `Speak naturally as a human would on the phone. Identify yourself at the start of the call.\n\n` +
    `You have your normal tools on this call; the caller cannot see tool names or output. ` +
    `If you need to look something up, a brief spoken acknowledgment first is good — ` +
    `the system may also speak a short hold line if you go straight to a tool; do not apologize for it or repeat it. ` +
    `Speak results the way a person would on the phone: no markdown, no bullet dumps, no raw JSON. ` +
    `Confirm a PO or reference number back only when the caller cares about the digits. ` +
    `Do not start long-running work while the caller is waiting — no browser automation, code tasks, ` +
    `background jobs, or skill authoring on a live call. Prefer a single lookup; if you cannot find it, ` +
    `say so and offer to follow up after the call. Never initiate another voice_call from a live call.`,
  );
```

- [ ] **Step 2:** Create `src/agents/prompt-builder.test.ts` (complete file):

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { memory: { hotBudgetTokens: 1000 } },
}));

import { buildVoiceSystemPrompt } from "./prompt-builder.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";

const fakeMemory = {
  read: vi.fn().mockResolvedValue(null),
  getHotTierPrompt: vi.fn().mockResolvedValue(null),
} as unknown as MemoryManager;

const agent = {
  id: "voice-pilot",
  soul: "You are a helpful voice agent.",
  systemPrompt: "Answer questions about orders.",
} as AgentConfig;

describe("buildVoiceSystemPrompt (KPR-324 C4 — spec §12.1 #8)", () => {
  it("contains the Voice-tools paragraph inside Voice Call Mode", async () => {
    const prompt = await buildVoiceSystemPrompt(agent, fakeMemory);
    expect(prompt).toContain("## Voice Call Mode");
    expect(prompt).toContain("You have your normal tools on this call");
    expect(prompt).toContain("do not apologize for it");
    expect(prompt).toContain("Never initiate another voice_call from a live call.");
  });

  it("still omits the toolkit dump and delegate catalog (S8)", async () => {
    const prompt = await buildVoiceSystemPrompt(agent, fakeMemory);
    expect(prompt).not.toContain("Your toolkit");
    expect(prompt).not.toContain("Delegate");
    expect(prompt).not.toContain("mcp__");
  });

  it("keeps the paragraph static (identical across calls, before goal/context)", async () => {
    const p1 = await buildVoiceSystemPrompt(agent, fakeMemory);
    const p2 = await buildVoiceSystemPrompt(agent, fakeMemory, { goal: "check PO 45021" });
    const staticEnd = p1.indexOf("Never initiate another voice_call");
    expect(p2.slice(0, staticEnd)).toBe(p1.slice(0, staticEnd));
    expect(p2.indexOf("## Call Goal")).toBeGreaterThan(p2.indexOf("Never initiate another voice_call"));
  });
});
```

- [ ] **Step 3:** Verify — `npx vitest run src/agents/prompt-builder.test.ts` green; `npx vitest run src/agents/prefix-builder.golden.test.ts` green **untouched** (C4 must not reach the Claude-lane prefix bytes); `npx vitest run src/channels/voice` green (voice-adapter mocks `buildVoiceSystemPrompt`-adjacent surfaces; confirm no fixture drift); typecheck green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-324): C4 Voice Call Mode tool paragraph (spoken-style guardrails, no toolkit dump)"`

### Task 8 — C7: `voice-fixture` in-process MCP + strip guard + runner wiring

The test double so T-gates run with W1B parked (spec §7): one tool, `voice_fixture_lookup`, byte-stable §6.2-shaped canned prose after a clamped delay. Entitlement is `voice-pilot`-only, enforced twice: registry load **strips** it from any other agent (KPR-184 posture) and the runner refuses to build it for any other agent id (belt — the fixture is a loaded gun on a production call). **No `SERVER_CATALOG` key** (C7/C8 — a check-less catalog key would render `configured` in instance capabilities).

**Files:**
- Create: `src/voice/voice-fixture-mcp-server.ts`, `src/voice/voice-fixture-mcp-server.test.ts`
- Modify: `src/agents/in-process-servers.ts` (Set + constants), `src/agents/agent-runner.ts` (wiring + inventory descriptor), `src/agents/agent-registry.ts` (strip guard), `CLAUDE.md` (one-line in-process-server list entry, Step 8)
- Test: `src/agents/agent-registry.test.ts`

- [ ] **Step 1:** `in-process-servers.ts` — add to the Set and export the two names (this file is deliberately import-free; the constants live here so registry/runner/fixture all share one spelling without cycles):

```typescript
/** KPR-324 C7: test-only voice fixture — allowed on ONE agent (spec §7). */
export const VOICE_FIXTURE_SERVER_NAME = "voice-fixture";
export const VOICE_FIXTURE_ALLOWED_AGENT_ID = "voice-pilot";
```

and inside `IN_PROCESS_PORTED_SERVERS`:

```typescript
  // KPR-390: meeting worker pool — in-process only (no per-server bundle).
  "worker-pool",
  // KPR-324 C7: voice-pilot test fixture — in-process only, never delegable.
  "voice-fixture",
```

- [ ] **Step 2:** Create `src/voice/voice-fixture-mcp-server.ts` (complete file):

```typescript
/**
 * KPR-324 C7 (spec §7): voice-pilot-ONLY test fixture for the mid-call
 * latency-masking T-gates. One tool that sleeps a clamped delay and returns
 * byte-stable canned prose in the spec §6.2 `orders_get` template shape, so
 * T1–T3 (and 322 §14.2's "one lookup pause") can run while W1B (KPR-300,
 * the real `orders` implementation) is parked.
 *
 * This is NOT `orders` and must never ship to a production agent:
 *  - registry load strips it from any non-voice-pilot def (agent-registry.ts)
 *  - AgentRunner refuses to build it for any other agent id (belt)
 *  - it has NO SERVER_CATALOG key (a check-less key would render as a
 *    `configured` capability — spec C8's fake-live trap)
 *
 * Logging: duration + delayMs only — never the canned prose (spec §7).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../logging/logger.js";

const log = createLogger("voice-fixture-mcp");

/** Spec §7: default 1500ms, HARD CAP 5000ms. Clamp, never error (spec §11). */
export const VOICE_FIXTURE_DEFAULT_DELAY_MS = 1500;
export const VOICE_FIXTURE_MAX_DELAY_MS = 5000;

export function clampFixtureDelay(delayMs: number | undefined): number {
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs)) return VOICE_FIXTURE_DEFAULT_DELAY_MS;
  return Math.min(Math.max(0, Math.floor(delayMs)), VOICE_FIXTURE_MAX_DELAY_MS);
}

/**
 * Byte-stable canned body — the spec §6.2 `orders_get` output template
 * (fixed Acme / 45021 fixture). `poNumber` is echoed for digit-confirmation
 * turns but never changes the data (spec §7 input table).
 *
 * ⚠ Bundle guard: this prose is minified into the shipped engine bundle and
 * scanned by scripts/check-bundle-strings.mjs, whose forbidden list is
 * ["dodi", "hubspot", "cabinet"]. Millwork-flavored fixture data is one
 * synonym away from tripping it — keep the spec's wording ("maple doors",
 * "drawer boxes"). Do NOT write "cabinet doors", and never resolve a guard
 * failure by editing the guard's list.
 */
export function buildFixtureResult(poNumber?: string): string {
  const po = poNumber && poNumber.trim().length > 0 ? poNumber.trim() : "45021";
  return [
    `PO ${po} · Acme Hardware · Open`,
    `Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026`,
    `Ship to: shop`,
    `Lines:`,
    `- 12 maple doors — 8 received, 4 open`,
    `- 6 drawer boxes — 0 received, 6 open`,
    `Notes: vendor quoted late Friday`,
  ].join("\n");
}

export function createVoiceFixtureMcpServer() {
  return createSdkMcpServer({
    name: "voice-fixture",
    version: "1.0.0",
    tools: [
      tool(
        "voice_fixture_lookup",
        "TEST FIXTURE: look up a purchase order (canned data). Sleeps a fixed delay, then returns a stable PO status. For voice latency-masking tests only.",
        {
          delayMs: z
            .number()
            .optional()
            .describe(`Simulated lookup latency in ms (default ${VOICE_FIXTURE_DEFAULT_DELAY_MS}, capped at ${VOICE_FIXTURE_MAX_DELAY_MS})`),
          poNumber: z.string().optional().describe("PO number to echo back in the canned result (data is fixed)"),
        },
        async ({ delayMs, poNumber }) => {
          // KPR-122 in-process contract: handler exceptions must never crash
          // the hive — try/catch → structured error.
          try {
            const delay = clampFixtureDelay(delayMs);
            const startedAt = Date.now();
            await new Promise((resolve) => setTimeout(resolve, delay));
            log.info("voice_fixture_lookup complete", {
              delayMs: delay,
              durationMs: Date.now() - startedAt,
            });
            return {
              content: [{ type: "text" as const, text: buildFixtureResult(poNumber) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `backend_unavailable\nfixture error: ${String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
```

- [ ] **Step 3:** `agent-registry.ts` — add the strip guard beside `sanitizeDelegateServers` (`:45-55`):

```typescript
import { IN_PROCESS_PORTED_SERVERS, VOICE_FIXTURE_SERVER_NAME, VOICE_FIXTURE_ALLOWED_AGENT_ID } from "./in-process-servers.js";

/**
 * KPR-324 C7 (spec §7 guard): `voice-fixture` is a test double that returns
 * fake purchase-order data — a loaded gun on a production call. Only the
 * dedicated `voice-pilot` test agent may carry it. Same posture as the
 * KPR-184 delegate sanitizer: strip + error log, operator repairs the doc
 * via admin agent_update.
 */
function sanitizeVoiceFixture(agentId: string, coreServers: string[]): string[] {
  if (agentId === VOICE_FIXTURE_ALLOWED_AGENT_ID) return coreServers;
  if (!coreServers.includes(VOICE_FIXTURE_SERVER_NAME)) return coreServers;
  log.error("voice-fixture is test-only (voice-pilot). Stripping from coreServers.", {
    agentId,
    allowedAgent: VOICE_FIXTURE_ALLOWED_AGENT_ID,
  });
  return coreServers.filter((s) => s !== VOICE_FIXTURE_SERVER_NAME);
}
```

and apply it in `load()` beside the KPR-184 call (`:241-247`):

```typescript
      agentConfig.delegateServers = sanitizeDelegateServers(agentConfig.id, agentConfig.delegateServers);
      // KPR-324 C7: strip the test fixture from any non-pilot def.
      agentConfig.coreServers = sanitizeVoiceFixture(agentConfig.id, agentConfig.coreServers);
```

- [ ] **Step 4:** `agent-runner.ts` — wire the in-process server in `buildInProcessServers` (after the worker-pool block, `:1616-1634`), with the agent-id belt:

```typescript
    // KPR-324 C7: voice-fixture — in-process test double, voice-pilot ONLY.
    // Double gate: registry load already strips it from other defs; this
    // agent-id check is the belt so a bypassed registry (direct DB write +
    // SIGUSR1 race) still cannot arm the fixture on a production agent.
    // No db dependency — canned data. No SERVER_CATALOG key (C8 trap).
    if (
      this.agentConfig.id === VOICE_FIXTURE_ALLOWED_AGENT_ID &&
      this.shouldEnableInProcessServer(VOICE_FIXTURE_SERVER_NAME)
    ) {
      if (!this.voiceFixtureMcpServer) {
        this.voiceFixtureMcpServer = createVoiceFixtureMcpServer();
      }
      servers[VOICE_FIXTURE_SERVER_NAME] = this.voiceFixtureMcpServer;
    }
```

with the field declared beside the other cached servers (`:375-378` region): `private voiceFixtureMcpServer?: ReturnType<typeof createVoiceFixtureMcpServer>;` and imports:

```typescript
import { createVoiceFixtureMcpServer } from "../voice/voice-fixture-mcp-server.js";
import { IN_PROCESS_PORTED_SERVERS, VOICE_FIXTURE_SERVER_NAME, VOICE_FIXTURE_ALLOWED_AGENT_ID } from "./in-process-servers.js";
```

(extend the existing `in-process-servers.js` import).

- [ ] **Step 5:** `agent-runner.ts` — Lane B inventory compensation (CLAUDE.md standing obligation #1 for any new in-process-only server; the spec's C7 text omits it but the engine rule is unconditional — the fixture has no stdio placeholder, so without this it is *silently* invisible to a Lane B partition instead of honestly bridged). Add after the worker-pool descriptor block (`:1385-1397`), gate mirroring Step 4's runtime wiring exactly:

```typescript
    // KPR-324 C7 + KPR-327 pattern: voice-fixture is in-process-only with no
    // stdio placeholder — surface its descriptor explicitly so the Lane B
    // partition sees it honestly (bridged, not silently absent). Gate
    // mirrors the runtime wiring in buildInProcessServers, including the
    // voice-pilot-only belt. (Standing obligation, CLAUDE.md "Adding an
    // in-process MCP server".)
    if (
      this.agentConfig.id === VOICE_FIXTURE_ALLOWED_AGENT_ID &&
      this.shouldEnableInProcessServer(VOICE_FIXTURE_SERVER_NAME) &&
      !mcpServers[VOICE_FIXTURE_SERVER_NAME]
    ) {
      inventory.push({
        ...classifyToolTransport({
          name: VOICE_FIXTURE_SERVER_NAME,
          transport: "sdk-in-process",
          source: "core",
          requiresTurnContext: false,
          requiresHiveRuntime: true,
          inProcess: true,
        }),
        schemas: { kind: "connect-time" },
      });
    }
```

(Obligation #2 — the three `suppressAutoInjectedServers` gates — does NOT apply: the fixture is coreServers-gated, never auto-injected. State this in the commit message so review doesn't re-derive it.)

> **Known, accepted cosmetic (do not "fix" it with a catalog key):** `buildQueryEnvelope` composes the toolkit from `Object.keys(mcpServers)` *after* the in-process assign (`agent-runner.ts:1999-2009`), and `voice-fixture` has no `SERVER_CATALOG` entry — so a **non-voice** turn on `voice-pilot` renders the KPR-87 toolkit line as `- voice-fixture — voice-fixture` (the exact shape `server-catalog.ts`'s `team-roster` comment documents). Voice turns are unaffected: they run on `systemPromptOverride`, which omits the toolkit entirely (S8). The remedy is **not** a blurb-only catalog key — that is precisely C8's fake-live trap (`buildInstanceCapabilities` would classify it `configured`). Leave it; it is a test agent, and the tool schema reaches the model via the SDK regardless.

- [ ] **Step 6:** Create `src/voice/voice-fixture-mcp-server.test.ts` (complete file):

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  clampFixtureDelay,
  buildFixtureResult,
  createVoiceFixtureMcpServer,
  VOICE_FIXTURE_DEFAULT_DELAY_MS,
  VOICE_FIXTURE_MAX_DELAY_MS,
} from "./voice-fixture-mcp-server.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("clampFixtureDelay (spec §7 / §11)", () => {
  it("defaults, clamps over-cap, floors, and never errors", () => {
    expect(clampFixtureDelay(undefined)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(NaN)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(99999)).toBe(VOICE_FIXTURE_MAX_DELAY_MS);
    expect(clampFixtureDelay(-5)).toBe(0);
    expect(clampFixtureDelay(1500.9)).toBe(1500);
  });
});

describe("buildFixtureResult (spec §6.2 orders_get template)", () => {
  it("is byte-stable with the default PO", () => {
    expect(buildFixtureResult()).toBe(
      "PO 45021 · Acme Hardware · Open\n" +
        "Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026\n" +
        "Ship to: shop\n" +
        "Lines:\n" +
        "- 12 maple doors — 8 received, 4 open\n" +
        "- 6 drawer boxes — 0 received, 6 open\n" +
        "Notes: vendor quoted late Friday",
    );
  });
  it("echoes a caller-stated PO number without changing the data", () => {
    const out = buildFixtureResult("77-104");
    expect(out.startsWith("PO 77-104 · Acme Hardware · Open")).toBe(true);
    expect(out).toContain("maple doors");
  });
});

describe("createVoiceFixtureMcpServer", () => {
  it("constructs an in-process SDK server named voice-fixture", () => {
    const server = createVoiceFixtureMcpServer();
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("voice-fixture");
  });
});
```

- [ ] **Step 7:** `agent-registry.test.ts` — additive describe (mirror the KPR-184 strip cases at `:539`):
  1. A def `_id: "nora"` with `coreServers: ["contacts", "voice-fixture"]` loads with `coreServers: ["contacts"]` and an error was logged.
  2. A def `_id: "voice-pilot"` with `coreServers: ["voice-fixture"]` keeps it.
  3. The stripped agent still loads (active, not rejected).
- [ ] **Step 8 (docs — house precedent, 322 plan Task ~2190):** one-line `CLAUDE.md` update under **Agent Anatomy → `delegateServers` constraint (KPR-184)**, appending `voice-fixture` to the enumerated in-process server list with a `(KPR-324, test-only — voice-pilot)` qualifier. Do **not** add it to the "MCP Servers" catalog list at the top of that file: it is a test double with no `SERVER_CATALOG` key, and listing it there would read as an operator-installable capability (the same fake-live posture C8 exists to prevent).
- [ ] **Step 9:** Verify — `npx vitest run src/voice/voice-fixture-mcp-server.test.ts src/agents/agent-registry.test.ts src/agents/agent-runner.test.ts` green; typecheck green. Also `npm run bundle && node scripts/check-bundle-strings.mjs` (or defer to Task 10 Step 2) to prove the fixture prose is clean of `dodi`/`hubspot`/`cabinet`.
- [ ] **Step 10:** Commit — `git commit -m "feat(kpr-324): C7 voice-fixture in-process MCP (voice-pilot only: registry strip + runner belt + Lane B inventory descriptor; auto-injection gates N/A — coreServers-gated)"`

### Task 9 — C8 + S1/S11 regression locks

**Files:**
- Modify: `src/tools/server-catalog.ts` (comment only)
- Test: `src/tools/server-catalog.test.ts`, `src/voice-worker/hive-llm.test.ts`

- [ ] **Step 1:** Add the C8 comment at the top of `SERVER_CATALOG` (`server-catalog.ts:20`):

```typescript
export const SERVER_CATALOG: Record<string, ServerCatalogEntry> = {
  // KPR-324 C8: there is deliberately NO `orders` key here. The read-only
  // purchase-order MCP contract (`orders_lookup` / `orders_get`) is defined
  // in docs/epics/kpr-320/kpr-324-spec.md §6 and is implemented by W1B
  // (KPR-300), which inserts the key WITH the live server. Do not add a
  // blurb-only key: buildInstanceCapabilities treats a catalog key with no
  // SERVER_CREDENTIAL_CHECKS entry as `configured`, so it would render as a
  // live capability that does not exist. The same rule covers the KPR-324
  // `voice-fixture` test double — in-process-wired only, never cataloged.
```

- [ ] **Step 2:** `server-catalog.test.ts` — additive:

```typescript
  it("KPR-324 C8: has no orders key and no voice-fixture key until W1B ships the live server", () => {
    expect(SERVER_CATALOG).not.toHaveProperty("orders");
    expect(SERVER_CATALOG).not.toHaveProperty("voice-fixture");
  });
```

- [ ] **Step 3:** `hive-llm.test.ts` — S1 regression lock (spec §12.1 #9), using the file's existing fetch-capture idiom: on any successful `chat()` run, parse the captured POST body and assert:

```typescript
  it("KPR-324 S1: POST body carries no tools key (tool_use never crosses the bridge)", async () => {
    // reuse the file's standard run-one-turn setup; capture the fetch body
    const body = JSON.parse(capturedInit.body as string);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
```

- [ ] **Step 4:** Confirm the existing `maxInterChunkGapMs` gap test (`hive-llm.test.ts:127`) passes **unmodified** (spec §12.1 #10) and that `git diff --stat src/voice-worker/` shows the test file only — **no worker source diff**.
- [ ] **Step 5:** Verify — `npx vitest run src/tools/server-catalog.test.ts src/voice-worker/hive-llm.test.ts` green; typecheck green.
- [ ] **Step 6:** Commit — `git commit -m "docs+test(kpr-324): C8 no-orders catalog comment; S1 bridge no-tools regression lock"`

### Task 10 — CI close-out

- [ ] **Step 1:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — all four gates green (typecheck + lint + format + test). Expected: 0 failures; if format rewrites, re-stage and re-run.
- [ ] **Step 2:** `npm run check:bundle` — bundle + the 4 guards green. The fixture, the helper, and the widened `RunResult` declaration all enter the shipped surface: `check-bundle-strings.mjs` scans both `pkg/*.min.js` **and** the `pkg/types/` d.ts closure against `["dodi", "hubspot", "cabinet"]`. "Acme Hardware" / "maple doors" / "drawer boxes" are clean by inspection; a hit means the fixture prose drifted (see Task 8 Step 2's ⚠) — fix the prose, **never** the guard list. `check-bundle-pack.mjs` should still find the provider-abi barrel; the new `RunResult` field rides the existing KPR-407 trace with no tracer edit.
- [ ] **Step 3:** Channel-gate final sweep: `npx vitest run src/channels` green — chat/SMS/Slack/dispatcher byte-path proof.
- [ ] **Step 4:** Commit any stragglers — `git commit -m "chore(kpr-324): quality-gate close-out"` (or nothing to commit).

### Task 11 — C9 [GO]: `voice-pilot` Mongo entitlement (ops, not a code diff)

> **GO block (D3):** requires a recorded operator go (date + words in Linear KPR-324) AND the Task 1–10 engine build deployed on the target instance. This touches a live instance's `agent_definitions`. **Never Nora/Sige.**

Precondition: the `voice-pilot` test agent exists on the instance (created by 322 Task 14 prep via MCP `agent_create` — it is NOT a repo seed). If absent, run 322's Task 14 prep first; do not create an ad-hoc def here.

- [ ] **Step 1:** Via the admin MCP (`src/admin/admin-mcp-server.ts`, live tool `agent_update` — CLAUDE.md's `admin_agent_update` is a docs alias), update the `voice-pilot` document: `coreServers` += `"voice-fixture"` (preserve existing entries). Record the tool-call output in lane notes.
- [ ] **Step 2:** `launchctl kickstart` is NOT needed — send SIGUSR1 to the hive process to hot-reload agent definitions.
- [ ] **Step 3:** Verify entitlement: engine log shows no `voice-fixture … Stripping` error for `voice-pilot` (the guard passes it); a chat probe turn on `voice-pilot` can see `voice_fixture_lookup` (or check the toolkit line / an `agent_get` read of the reloaded def).
- [ ] **Step 4:** Verify the guard: temporarily confirm via `agent_get` that no OTHER def carries `voice-fixture`; if one does, the registry strip error must appear in logs on reload (this is the spec §11 "production agent with voice-fixture" row observed live).
- [ ] **Rollback:** `agent_update` removing `"voice-fixture"` + SIGUSR1 (C9-reverse; part of the ticket rollback lever).

### Task 12 — T1 [GO]: ack audible (designed, NOT run)

> **GO block (D3):** live PSTN/LiveKit/Vapi call — recorded per-run operator go required. Prefer whichever voice path is live (spec §12.2 — masking is behind the HTTP seam, both are valid). Requires Tasks 1–11 deployed, `voice.toolAck.enabled` on (default).

- [ ] **Setup:** 322 §14.2 10-turn vendor-style script on `voice-pilot`, with a scripted turn that forces `voice_fixture_lookup` (`delayMs: 1500`) — e.g. call goal instructs "when asked about PO 45021, look it up with your tool before answering, without narrating".
- [ ] **Run A (ack on):** N=3 calls. Operator listens for a §4.2 phrase **before** the canned PO status on each forced-lookup turn; no double-speak on any turn where the model already said its own wait line.
- [ ] **Run B (control):** flip `voice.toolAck.enabled: false` in the instance hive.yaml + restart; N=3 calls, same script/fixture delay.
- [ ] **Evidence:** engine "Voice turn complete" rows — Run A forced-lookup turns show `toolAckInjected ≥ 1` and `toolMs` ≈ 1500; Run B shows `toolAckInjected: 0`. Worker JSONL — Run A `maxInterChunkGapMs` on tool-turns **lower** than Run B (correlate by `callId`).
- [ ] **Pass:** phrase audible before status; `toolAckInjected` ≥ 1; gap delta ≥ 200ms vs control.
- [ ] **Decision rule (spec §12.2, verbatim):** if the control-vs-ack `maxInterChunkGapMs` delta is < 200ms (e.g. `tool_use` observed too late), **do not ship lever b in this ticket** — record the finding, file a follow-up, keep S2 best-effort or demote to prompt-only. Operator call at the gate, not a spec fork.
- [ ] Restore `toolAck` to on after the control run; record results (date, N, numbers) in Linear KPR-324.

### Task 13 — T2 [GO]: barge-in mid-tool, warm path on (designed, NOT run)

> **GO block (D3):** recorded per-run operator go; requires `voice.warmPath.enabled: true` on the instance (323 W2 posture) + Task 11.

- [ ] **Run:** during a forced `voice_fixture_lookup` delay (use `delayMs: 5000` for a wide window), the caller interrupts mid-delay.
- [ ] **Pass:** agent audio stops; the next turn answers the interrupting utterance; the lease stays up — the NEXT "Voice turn complete" row shows `warmPath: true` (323 interrupt-and-keep-warm, spec §4.4). The fixture handler is **not** required to abort (⚠ in-flight tool may finish and be discarded — the gate cares about call recovery, not tool SIGKILL).
- [ ] Record results in Linear KPR-324.

### Task 14 — T3 [GO]: natural mask still wins (designed, NOT run)

> **GO block (D3):** recorded per-run operator go; requires Task 11.

- [ ] **Run:** scripted turn where the model is prompted to say a wait line *then* look up (call goal: "always say 'give me a second to pull that up' before using your lookup tool").
- [ ] **Pass:** `toolAckInjected: 0` on that turn's "Voice turn complete" row; the operator hears exactly one wait line, not two (the §4.1 same-message / streamed-segment rule holding live).
- [ ] Record results in Linear KPR-324.

### Task 15 — Close-out

- [ ] All engine tasks committed; `npm run check` + `npm run check:bundle` green at HEAD.
- [ ] Spec §8 inventory cross-check: C1–C8 each map to a landed commit; C9 either executed (with GO record) or explicitly parked for the T-gate window.
- [ ] Non-goals audit: `grep -rn "v1/tools\|session.say" src/channels src/voice-worker` shows no new hits; `git diff <base>..HEAD --stat src/voice-worker/` shows `hive-llm.test.ts` only; no `SERVER_CATALOG.orders`/`voice-fixture` key; no Lane B adapter diff beyond the `buildResult` zero-shape line.
- [ ] T1–T3 status recorded in Linear (run + results, or designed-not-run with the gate open).
- [ ] Hand to dodi-dev:review (fresh-context) — do not self-approve.

---

## 3. Risks & watch-list (from spec §14, operationalized)

- ⚠ **`tool_use` observed before the handler runs** — Task 0 reconfirms; unit assertion #3 pins ordering in-harness; T1 is the live proof. Fallback: move the inject to the `tool_progress` branch (same helper) — plan amendment, not demote.
- ⚠ **Double-speak race (text_delta vs helper)** — mitigated by text-blocks-first + `streamedThisSegment`; T3 is the live check.
- ⚠ **`firstTokenMs` shift on silent-to-tool turns** — documented, not fixed: the ack becomes first SSE byte, so tool-turn `firstTokenMs` drops to time-to-`tool_use`. Do NOT rebase 323's blessed baseline (it is the no-tool comparand and its harvest drops `warmPath: true` rows); `toolAckInjected > 0` is the discriminator when reading mixed logs.
- ⚠ **Fixture on a production agent** — double gate (registry strip + runner agent-id belt) + Task 11 Step 4 live observation.
- ⚠ **`voice-pilot` existence** is an instance fact — Task 11 precondition, never assumed by CI tasks.
- **Required-field ripple under-enumeration** — Task 3 Step 7 trusts `tsc` over the plan's site list for *source*, but `tsc` is **not** sufficient for tests: `makeRunResult`'s return type is inferred, so that one site is a named, non-negotiable step rather than a compiler finding.
- ⚠ **Plugin-facing `RunResult` widening (KPR-394/KPR-407)** — C5a changes a type re-exported via `@keepur/hive/provider-abi` and shipped in `pkg/types/`. Ruling recorded at Task 3 Step 3b: **no `LANE_B_PROVIDER_ABI_VERSION` bump** (the handshake is an exact-integer runtime check; a bump would fail activation for every installed provider plugin over an additive telemetry field), with `?? 0` at the finalize copy as the runtime belt for adapters compiled against the older declaration. If a future reviewer wants the bump, that is an epic-register amendment, not a delivery call.
- **Config-mock `TypeError` class** — the two spawn loops read `config.voice.toolAck.enabled` eagerly at each `tool_use` boundary, and both driving suites mock `config` wholesale. Tasks 4/5 fix the mocks as their first step; a missed site (notably `agent-manager.test.ts:6920`) fails loudly, not silently — but it fails in tests that have nothing to do with voice, which is the confusing part worth pre-empting.
