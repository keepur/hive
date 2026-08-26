# KPR-393 — GPT follow-through gap: intent-text turns that end without the promised work

**Epic:** KPR-385 (provider first-class-ness) · child 3 of 4 · independent of the adapter-layer arc
**Status:** spec draft (investigation complete; fix scope follows findings, per ticket)
**Evidence base:** `hive_dodi.provider_turn_history` (17 threads / 65 codex turns, 2026-08-24 → 08-26), worktree `6b58099` (post-KPR-391/392)

---

## TL;DR

The symptom is real but the ticket's premises need correcting: no agent runs `openai/…` — the operator-observed "GPT" is dodi's Sol on **codex** (`codex/gpt-5.6-sol`, `runBoundedDispatchLoop`), and the transcripts that let us verify this live in `provider_turn_history` (codex/grok stateless-replay — the openai lane persists nothing). Real transcripts show ~3 of 65 turns end with a first-person commitment and no (or token) tool execution — all in #conf-tahoe meeting threads; direct work-request threads show robust follow-through. Evidence supports a deterministic, low-risk fix now (a Lane B follow-through prompt section + fleet-wide `intentTrailer` telemetry with a Claude baseline) and defines explicit criteria for a criteria-gated loop-level continuation nudge as a follow-up registered decision — not pre-committed, because the dominant observed shape (contingent cross-turn promises) is not fixable by a loop nudge.

## Key Points

- **Premise correction 1:** the fleet has zero `openai/…` agents. Observed instances are on the **codex adapter** (shared `runBoundedDispatchLoop`). The structural gap is nonetheless identical in both Lane B loop families: `calls.length === 0 → break` (dispatch-loop.ts:~110) and the `@openai/agents` SDK run ending on a no-tool final output. The fix targets the shared Lane B surface, not one adapter.
- **Premise correction 2:** "openai-lane turns are fully persisted" is wrong for openai (`previous_response_id` chaining, no transcript store) and right for codex/grok (`provider_turn_history`, verbatim Responses items, **7d TTL** — evidence window is only the trailing week; the incident May observed may predate the surviving data).
- **Quantified:** 65 turns; 38 zero-tool (mostly legitimate: meeting "No response needed," pure discussion verdicts); **2 clear zero-tool promise turns + 1 promise-with-token-tool-call turn** (~5%), 100% concentrated in #conf-tahoe meeting threads; 0 instances in #agent-gpt work threads (those average 3–8 tool calls/turn and deliver).
- **Two failure sub-modes:** (a) *intra-turn* — model narrates its plan as the final message instead of executing ("First step is to inspect… then I'll post the exact proposed delta" → one `memory_recall`, turn ends); (b) *cross-turn* — contingent promise ("I'll draft rev 2 after we close it") dies with the thread because nothing re-invokes the agent. A loop nudge addresses only (a); (b) needs prompt-shaped norms (say what you're waiting on / schedule explicitly) and borders KPR-386 meeting-mode.
- **In scope (this ticket):** D1 Lane B follow-through prompt section (all four Lane B adapters via `buildProviderInstructions`; Claude lane byte-untouched — golden suite stays zero-diff); D2 `intentTrailer` telemetry on `activity_log` (all providers, giving a Claude control baseline); D3 written decision criteria for the phase-2 nudge.
- **Out of scope:** the loop-level continuation nudge itself (criteria-gated follow-up ticket — needs the D2 data and a registered decision), meeting-turn cadence (KPR-386), moving openai onto the hive loop (C1 — not proposed), any `agent_turn_telemetry` schema change.
- **Risk:** prompt-only pressure may under-correct GPT; that is exactly what D2 measures, with numeric criteria for escalating. Detector is a conservative English-only regex — acceptable for telemetry (booleans, redaction-safe), deliberately NOT used to gate any runtime behavior in this ticket.
- ⚠ **Delegated assumption:** ~5% frequency from a 7-day/65-turn window is treated as representative enough to justify deterministic-first over nudge-first. If the operator has fresh evidence of high-frequency work-thread failures (not meetings), the nudge should be promoted into scope.
- ⚠ **Delegated assumption:** the follow-through section applies to all Lane B providers uniformly (codex/gemini/grok/openai) — no per-provider prompt forks.

---

## Problem

Operator-observed on dodi: GPT acknowledges a task ("got it, I'm on it") and then nothing happens — no tool execution, no follow-up. Hypothesis in the ticket: harness gap — when the model ends its response with intent-text and no tool calls, the Lane B loop terminates the turn; Claude models are trained against this failure mode, GPT in a foreign harness is not, and nothing in our loop or prompt pushes back.

## Evidence (investigation findings)

### Where the evidence actually lives

| Surface | What it holds | Verdict for this investigation |
|---|---|---|
| `provider_turn_history` | Verbatim Responses items (user msg, assistant text, function_call/_output, encrypted reasoning) for **codex + grok** primary turns; 7d TTL | **The evidence surface.** Full per-turn tool/text reconstruction. openai never writes here. |
| `activity_log` | Per-turn `model`, `toolCalls`, `toolSummary`, timings — **no text** (redaction posture) | Counts zero-tool turns fleet-wide but cannot see intent text. Becomes the D2 measurement home. |
| `agent_turn_telemetry` | Token counters only (cache hit-rate feed) | Not usable; no toolCalls, no provider, no text. |
| `sessions` | Resume handles | Not usable. |

### What the transcripts show (hive_dodi, Sol = `gpt`, `codex/gpt-5.6-sol`)

- 17 threads / 65 turns / 38 zero-tool turns. The bulk of zero-tool turns are correct behavior: meeting roll-calls, "No response needed" (meeting-rules-mandated), reflection turns, and substantive discussion verdicts needing no tools.
- **Archetype (intra-turn):** thread `1787632007` t0 — user asks in #conf-tahoe; Sol runs one `memory_recall`, then final text: *"Understood. I'll own the artifact 4 v2 edit… First step is to inspect the current v1 artifact and existing feedback, then I'll post the exact proposed delta."* Turn ends (loop breaks on empty harvest). Next turn: "No response needed." The inspection and delta never happen.
- **Cross-turn:** thread `1787630679` t5+t6 — *"Yes. I'll lead rev 2 and give Fable first review… Fable, send the base commit and paths; I'll draft from there."* Thread ends at t6. The promise is contingent on future input; nothing schedules or re-invokes.
- **Control:** #agent-gpt work threads (5 threads) — every substantive turn executes 1–8 tools (Bash, Read/Grep, slack, structured-memory) and delivers verdicts with evidence. The failure is context-shaped (meetings), not a blanket "GPT doesn't use tools."

### Where the code decides the turn is done

- `src/agents/provider-adapters/dispatch-loop.ts` — `if (calls.length === 0) break;` is the sole non-error exit (codex/gemini/grok). No inspection of final text.
- `src/agents/provider-adapters/openai-agents-adapter.ts` — `runner.run()` (SDK loop) returns when the model yields a final output with no tool calls; adapter returns `{kind:"success"}` unconditionally.
- `buildProviderInstructions` (`src/agents/prefix-builder.ts`) — the Lane B prompt's only tool-use pressure is the toolkit header line *"Try them; don't guess at availability."* Zero follow-through language anywhere in the composed sections (soul → … → toolkit → memory → datetime).

## Goals

1. Put explicit follow-through pressure into every Lane B system prompt: commitments execute in-turn, or the reply states plainly what it is waiting on, or the work is explicitly scheduled.
2. Make the symptom measurable fleet-wide — per-provider intent-trailer rates with Claude as the control — so the phase-2 decision is data-driven, not anecdote-driven.
3. Leave a written, numeric decision rule for whether/when to build the loop-level continuation nudge.

## Non-goals

- No loop-level nudge in this ticket (see D3 — criteria-gated follow-up, registered decision).
- No change to dispatch-loop.ts, turn-scaffold.ts, any adapter, ToolBridge, or session semantics (zero-diff surfaces, C10).
- No openai-onto-hive-loop proposal (C1 respected).
- No meeting-cadence changes (#conf-tahoe turn shape is KPR-386 territory).
- No Claude-lane prompt change: `buildPrefix` output stays byte-identical (golden suite untouched).
- No text/preview persistence in logs or telemetry (redaction posture): booleans only.

## Design

### D1 — Lane B follow-through prompt section

New helper `followThroughSection(): string` in `src/agents/prefix-builder.ts`, composed **only** by `buildProviderInstructions`, inside the existing `toolsExecutable` gate, immediately after the toolkit section (it references tools; placement keeps tool-adjacent guidance contiguous). Proposed text (final wording at implementation, intent binding):

> ## Follow-through
> When your reply commits to an action, do the action first: execute it with your tools in this turn, then report the result. Never end a turn on unexecuted intent ("I'll check…", "on it", "first step is…").
> If you genuinely cannot proceed, do not promise — state exactly what you are waiting on and from whom.
> For work that must happen later, schedule it explicitly with your tools; do not assume a future turn will remember this one.

Notes:
- Generic phrasing, no per-tool paragraphs (operator feedback: no per-tool prompt awareness — the toolkit section already names callback/schedule where provisioned).
- Applies uniformly to codex, gemini, grok, openai (assembly passes `toolsExecutable: true` unconditionally post-KPR-352). ⚠ uniform-application assumption flagged in Key Points.
- Claude lane: `buildPrefix` does not call the helper; golden byte-identity preserved by construction.
- Prompt-cache note: section is static text — Lane B assembles per spawn, position before the memory/datetime sections keeps any provider-side prefix caching benefit.

### D2 — `intentTrailer` turn telemetry (all providers)

New pure module `src/agents/intent-trailer.ts`:

```ts
/** True when delivered text ends on an unexecuted first-person commitment. Conservative, English-only. */
export function detectIntentTrailer(text: string): boolean
```

- Scans only the **final ~300 chars** of the delivered text (promises cluster at the end; cuts false positives from mid-text narration).
- Conservative first-person-future patterns (`I'll <verb>`, `I will`, `I'm going to`, `let me <verb>`, `on it`, `first step is`), curly/straight apostrophes. Fixture set seeded from the real Sol transcripts above (both positives and the "No response needed" / verdict-style negatives).
- **Text-based only — deliberately not conditioned on `toolCalls === 0`:** the archetype turn made one token tool call; `activity_log` already carries `toolCalls`, so analysts slice `intentTrailer × toolCalls` in queries.

Wiring: in `AgentManager.recordActivity` (the existing `activityLogger.record` site), compute `detectIntentTrailer(result.text)` and add optional field `intentTrailer?: true` to `ActivityRecord` (`src/activity/types.ts`) — set only when detected, absent otherwise (additive, schemaless Mongo, no migration). One `log.info` when set (agentId, provider-prefixed model, toolCalls — no text). Runs for **every** provider, which is the point: Claude's rate is the natural control.

Measurement query (documented in the spec, run manually or via doctor later — no doctor section in scope): per-model rate of `intentTrailer` turns over trailing 14d, split by `toolCalls === 0`.

### D3 — Phase-2 decision rule (loop-level continuation nudge — follow-up, not built here)

File the follow-up ticket **iff**, after ≥14 days of D2 data post-deploy:
- Lane B `intentTrailer && toolCalls === 0` rate ≥ **3×** the Claude-lane rate, **and** ≥ **5 occurrences/week** fleet-wide; **and**
- manual precision sampling of flagged turns (read the matching `provider_turn_history` items where available) shows detector precision ≥ **70%**.

Pre-agreed shape for that ticket (so it plans fast; all of it is future work):
- **codex/gemini/grok:** optional `BoundedDispatchLoopDriver` hook (e.g. `onEmptyHarvest?(state, finalText) → "nudge" | undefined`), loop continues at most **once per turn** with a provider-shaped synthetic user message ("You ended your reply committing to an action but executed nothing. Do it now with your tools, or restate what you are waiting on."), consuming the normal round budget; deadline semantics untouched (C2 — the extra round runs under the scaffold's existing deadline).
- **openai:** stays on the SDK loop (C1) — the nudge arm is a second `runner.run` chained via `previousResponseId` with the nudge as prompt. This is an explicit registered decision for that ticket, with its own cost note (codex replay re-billing) and FP-tolerance argument.
- The nudge cannot fix the cross-turn sub-mode; the follow-up's scope statement must repeat that boundary so it doesn't over-promise.

## Integration points

- `src/agents/prefix-builder.ts` — new exported `followThroughSection()`; `buildProviderInstructions` composes it (toolsExecutable-gated, after toolkit). `buildPrefix` untouched.
- `src/agents/intent-trailer.ts` — new pure module + test.
- `src/agents/agent-manager.ts` — one-line compute + field add at the `recordActivity` site; one info log.
- `src/activity/types.ts` — additive optional `intentTrailer?: true`.
- `docs/providers.md` — no parity-matrix behavior rows change (prompt content isn't a matrix row); confirm at implementation and note in PR if a "prompt guidance" caveat row is warranted.

## Edge cases

- Empty delivered text (reflection turns, aborted/error turns): detector short-circuits false on empty/whitespace text; recordActivity path unchanged for error turns (field simply absent).
- Non-English output (e.g. bilingual agents): detector misses — accepted limitation, documented in the module docstring; telemetry undercounts rather than misfires.
- "No response needed" meeting replies: no first-person-future match (fixture-pinned negative).
- Turns with tools that still end on a promise: counted (text-based detection), distinguishable in queries via `toolCalls`.
- 7d `provider_turn_history` TTL: precision sampling in D3 must run promptly on fresh flags; `activity_log` (retentionDays-configured) is the durable counter.

## Testing contract (C10/C16 discipline)

Deliberate deltas — enumerated:
1. `src/agents/intent-trailer.test.ts` — new; fixtures include the three real Sol positives and ≥4 real negatives from the transcripts (paraphrased, no PII beyond what activity requires — use text shapes, not verbatim thread content).
2. `src/agents/prefix-builder.provider.test.ts` — Lane B instruction expectations gain the Follow-through section (deliberate delta, enumerated; the Claude-lane golden suite `prefix-builder.golden.test.ts` must show **zero diff**).
3. `src/agents/agent-manager.test.ts` — recordActivity includes/omits `intentTrailer` correctly (one positive, one negative).

Zero-diff surfaces (no expectation edits permitted): `dispatch-loop.ts`/`.test.ts`, `turn-scaffold.ts`/`.test.ts`, all four adapters + tests, `tool-bridge`, `turn-assembly`, `toolkit-section` (D1 lives in prefix-builder, not the toolkit renderer). Tests are not typechecked — no "compile-forced" claims for test-file deltas; sweep record literals.

## Open assumptions

- ⚠ 7-day evidence window (65 turns) treated as representative; operator can veto deterministic-first if fresher work-thread failures exist. (non-blocking — default stands)
- ⚠ Uniform Lane B application of the follow-through section, no per-provider forks. (non-blocking)
- Detector thresholds in D3 (3×, 5/week, 70% precision) are operator-adjustable at follow-up filing time; they are defaults, not contracts. (non-blocking)
- Exact prompt wording is implementation-final; the three behavioral clauses (do-then-report / state-the-wait / schedule-explicitly) are binding. (non-blocking)

## Canon compliance

- **C1:** openai stays on the SDK loop; the only openai-specific mechanics here are prompt text it already consumes. The phase-2 openai nudge arm is designed within the SDK loop and deferred to a registered decision.
- **C2:** no deadline-semantic changes; the future nudge round explicitly runs under scaffold deadline.
- **C6/C11 (ABI freeze):** no `LaneBProviderModule`/`LaneBModuleDeps` movement.
- **C8/C12:** history wiring untouched.
- **C10/C16:** deltas enumerated above; zero-expectation-edit on untouched surfaces; no compile-forcing claims for tests.
