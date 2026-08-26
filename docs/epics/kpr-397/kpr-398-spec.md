# KPR-398 — Claude-lane deadline abort must not classify as a hard provider timeout when the turn made observable progress

Child of hotfix epic **KPR-397**. Status: **spec draft** (Gate 1 delegated).

> **Decision Register canon:** the KPR-397 epic predates its first merge — no
> `## Decision Register — Canon` section exists yet anywhere in the epic docs.
> Nothing to reconcile against; this spec's ⚠-flagged assumptions are the
> candidate entries.

## TL;DR

`classifyTurnResult` rule 1 (`src/agents/provider-adapters/error-classification.ts:147-149`) maps every `timedOut && aborted` result to the hard `"timeout"` fault, so a Claude-lane turn killed by the runner's own wall-clock deadline while its tools were demonstrably executing counts toward the fleet-wide claude breaker streak exactly like a hung provider — three long tool-heavy turns opened the claude circuit for the whole fleet on 2026-08-25. The fix reuses the existing breaker-inconclusive `"turn-deadline"` kind (Lane B's precedent, same file L67): a deadline abort **with observed progress** (`toolCalls > 0 || streamed || text.length > 0`) classifies `turn-deadline`; a **zero-progress** deadline abort keeps classifying hard `"timeout"` so genuine hangs still trip the breaker. No breaker changes; one call-site reconciliation in the dispatcher's post-turn outage gate.

## Key Points

- **Root-cause fix, classifier-only.** The change lives in `classifyTurnResult` (+ its input type) and pattern-pinning tests. `provider-circuit-breaker.ts` already treats `turn-deadline` as inconclusive (never trips L285-293, never resets a streak, never closes a probe L428-448) — **zero breaker edits**, and KPR-400 (probe redesign) is explicitly out of scope.
- **Progress predicate (the heart):** `hasObservedProgress = toolCalls > 0 || streamed === true || text.length > 0`. Any of the three is proof the provider responded this turn; all three absent is indistinguishable from a hung provider and stays hard `"timeout"`. Fail-closed: progress fields **absent/undefined ⇒ no progress ⇒ hard timeout** (pre-fix behavior preserved for any narrowed caller).
- **Reuses the existing `turn-deadline` kind — no third deadline shape** (binding cross-epic constraint; KPR-385's `classification-crosscheck.test.ts` pins the Lane B `error_turn_deadline` shape, which this change does not touch — its rows never set both `timedOut` and `aborted`).
- **No call-site change at the breaker feed:** `agent-manager.ts:1095` already passes the full `RunResult`, which structurally carries `toolCalls`/`streamed`/`text`. Extending `TurnFaultInput` with optional fields makes them visible with no manager edit.
- **One integration reconciliation (in scope):** the dispatcher's post-turn outage gate (`src/channels/dispatcher.ts:566-573`) narrows the classifier input to `{error, timedOut, aborted}` AND keeps a redundant `hangTimeout = timedOut && aborted` local that would keep routing with-progress deadline turns into the outage replay queue — silently re-running a partially-executed tool turn's side effects, the exact hazard its own Finding-4 comment forbids. Fix: pass the full `runResult`, drop `hangTimeout` (the hard-`timeout` classification already covers zero-progress hangs).
- **Accepted residual false-positive:** a zero-output, zero-tool turn that is merely *slow* (300s of pure first-LLM-call thinking, no streaming callback) still classifies hard timeout. No observable in `RunResult` distinguishes it from a hang; conservative-toward-protection is the deliberate choice and is not a regression (identical to today).
- **Accepted residual false-negative:** a provider that partially responds then hangs *every* turn never trips via deadline turns — but `turn-deadline` never *resets* the streak either, so interleaved hard faults still accumulate. Lane B already accepts a strictly weaker version of this trade (ALL its deadline expiries are inconclusive, progress-blind); the Claude lane becomes strictly more protective than Lane B, not less.
- ⚠ **Delegated:** predicate composition (three-signal binary OR, no `toolMs`-dominance ratio, no `compactions` signal), the classification `message` format, and the dispatcher-gate reconciliation are routine choices made here, flagged for the register. No open product questions.

## Problem

**Incident (epic KPR-397, 2026-08-25 evening PT / 2026-08-26 02:05–02:17Z):** three consecutive fable/milo turns each burned the 300s `timeoutMs` wall clock inside active tool execution (`toolMs ≈ 293–294s`, `toolCalls=46` on the flagship turn — tools visibly streaming, provider demonstrably up). The runner's deadline fired, aborting each turn; `classifyTurnResult` saw `timedOut: true, aborted: true` → hard `"timeout"`; three consecutive hard faults opened the **claude** provider circuit fleet-wide (`record()` streak arm, `provider-circuit-breaker.ts:280-284`), telemetry showing `reason:"timeout"`, `lastFaultMessage:"turn deadline exceeded"`, circuit OPENED ×3. Half-open probes re-admitted the same long turns — self-sustaining. 224 timeouts across 14 agents in the window; Grok had the identical episode. The tourniquet (timeoutMs 300000→900000 for four architect agents) is live; every other agent still runs 300s, and the claude streak sat at 2/3 post-incident.

**Mechanism.** On the Claude lane the deadline timer (`agent-runner.ts:2034-2043`) sets `timedOut = true` and then calls `this.abort()`, which sets `_aborted = true` (L2292-2298) — so the runner's own deadline **always** produces `timedOut && aborted`, the exact shape rule 1 (`error-classification.ts:147-149`) reserves for a hung provider. The abort unwinds the SDK iterator by *closing* it, not throwing, so `error` stays `undefined` (comment at `agent-runner.ts:2224-2230`) and the message defaults to `"turn deadline exceeded"`. A 294-seconds-of-tools turn and a 294-seconds-of-silence hang are indistinguishable to the classifier — but not to the `RunResult`, which already carries the discriminating evidence (`toolCalls`, `toolMs`, `streamed`, `text` — L134-156).

**Precedent already in-tree.** The three Lane B adapters emit the `TURN_DEADLINE_SUBTYPE` sentinel (`error_turn_deadline`, `error-classification.ts:67`) with `aborted: false` pinned precisely so rule 1 can never match; it short-circuits to the dedicated `turn-deadline` kind, which the breaker treats as INCONCLUSIVE. The design comment says it outright: "a slow-but-healthy tool must never trip a healthy provider." The Claude lane deserves the same distinction — and, unlike Lane B, it has per-turn progress evidence to gate it on.

## Goals

1. A Claude-lane deadline abort with observed progress classifies `turn-deadline` (breaker-inconclusive) instead of hard `timeout`.
2. A zero-progress deadline abort — the true hang signature — keeps classifying hard `timeout`, preserving hang-type outage detection.
3. The hang-detection asymmetry is preserved end-to-end: `turn-deadline` never trips, never resets a hard-fault streak, never closes a half-open probe (already implemented; verified by existing breaker tests, not re-touched).
4. The dispatcher's post-turn outage gate agrees with the new semantics (no outage-queue replay of a with-progress deadline turn).
5. Regression tests pin both directions plus the negative pins, per repo convention.

## Non-Goals

- **No `provider-circuit-breaker.ts` changes.** Streak/probe/cooldown semantics, including how `turn-deadline` is consumed, are untouched. Half-open probe redesign (probes re-admitting long turns) is **KPR-400**, which will be specified against the post-398 semantics stated in §Design → Post-398 classification contract.
- **No Lane B changes.** The `TURN_DEADLINE_SUBTYPE` sentinel path, its `aborted: false` pin, and its progress-blind inconclusive classification are unchanged.
- **No new `ProviderFaultKind`.** Binding constraint: reuse `turn-deadline`.
- **No `timeoutMs` policy changes.** The 300s default, the 900s architect tourniquet, and per-agent tuning are operational matters outside this ticket.
- **No changes to `classifyThrown`,** the pattern tables, `HARD_FAULT_KINDS` membership, or the auth-row superset rule.
- **No telemetry schema changes** — `lastFaultKind`/`lastFaultMessage` simply start carrying `turn-deadline` for claude where they previously carried `timeout`.

## Design

### 1. Input type extension (`error-classification.ts`)

Extend `TurnFaultInput` with three optional progress fields, names matching `RunResult` verbatim so both existing full-`RunResult` call sites are structurally assignable with **no call-site edits**:

```ts
export interface TurnFaultInput {
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
  // KPR-398: per-turn progress evidence (RunResult field names, verbatim).
  // Consulted ONLY inside the timedOut && aborted rule; absent fields are
  // fail-closed (no progress ⇒ hard timeout — a narrowed caller keeps
  // pre-KPR-398 behavior).
  toolCalls?: number;
  streamed?: boolean;
  text?: string;
}
```

The module stays pure and dependency-free (no logger, no config, no thresholds).

### 2. The progress predicate

```ts
/** KPR-398: proof the provider responded THIS turn. Any one signal suffices;
 * all three absent is indistinguishable from a hung provider. */
function hasObservedProgress(input: TurnFaultInput): boolean {
  return (input.toolCalls ?? 0) > 0 || input.streamed === true || (input.text?.length ?? 0) > 0;
}
```

Signal soundness, per `agent-runner.ts`:

- **`toolCalls > 0`** — incremented only when a complete `tool_use` block arrives in an assistant message (L2100-2107). The provider streamed an entire assistant message to emit it: the provider is up. This is the incident's signal (`toolCalls=46`). Note it also subsumes `toolMs` (`toolMs > 0 ⟺ toolCalls > 0` — the last open tool's `endMs` is closed at abort time, L2202-2204, which is why the incident telemetry showed `toolMs≈294s`).
- **`streamed === true`** — set only when a `content_block_delta` text delta reached the stream callback (L2076-2082): provider bytes arrived this turn. Covers the deadline-mid-first-message case where no assistant message ever completes.
- **`text.length > 0`** — `resultText` is captured from completed assistant text blocks (L2098-2099) independently of the stream callback. Covers non-streaming spawns (no `onStream` — e.g. cron/reflection turns, where `streamed` can never become true) that completed at least one assistant message before the deadline.

**Rejected signals** (⚠ delegated, recorded for the register):
- *`toolMs`-dominance ratio* (ticket's "toolMs dominant" phrasing): adds a tunable threshold with zero extra discrimination over `toolCalls > 0`, and `durationMs` is unusable as a denominator anyway — it comes from the SDK result message, which never arrives on an aborted turn, so it is `0` and `llmMs = durationMs - toolMs` is *negative* on every deadline abort (L2222). A ratio would be built on garbage. Binary predicate wins.
- *`compactions > 0` / token counters*: token/cost fields also come only from the result message (always 0 at abort); `compactions` is a plausible but marginal fourth signal — YAGNI, and any turn that compacted has virtually always also streamed or run tools.

### 3. Rule change (`classifyTurnResult`, rule 1)

```ts
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    // KPR-398: the Claude runner's own deadline sets BOTH flags
    // (agent-runner.ts deadline timer → abort()), so this shape covers two
    // very different turns. Observed progress = the provider responded this
    // turn ⇒ the same breaker-INCONCLUSIVE turn-deadline kind Lane B's
    // sentinel gets (never trips, never resets a streak, never closes a
    // probe). Zero progress = the hang signature ⇒ hard timeout, so a
    // genuinely hung provider still trips the breaker. Fail-closed on
    // absent fields.
    if (hasObservedProgress(input)) {
      return {
        outcome: "fault",
        kind: "turn-deadline",
        message:
          input.error ??
          `turn deadline exceeded with progress (toolCalls=${input.toolCalls ?? 0}, streamed=${input.streamed === true}, textLen=${input.text?.length ?? 0})`,
      };
    }
    return { outcome: "fault", kind: "timeout", message: input.error ?? "turn deadline exceeded" };
  }
  if (input.aborted === true) return { outcome: "aborted" };
  if (!input.error) return { outcome: "success" };
  return classifyErrorString(input.error);
}
```

Notes:
- Rule ordering and rules 2–5 are byte-identical. Progress fields are consulted **nowhere else** — an `aborted`-only result stays neutral `"aborted"` regardless of progress, and the pattern tables never see the new fields.
- The `message` embeds the evidence (deterministic, no timestamps, no free text from the turn) so breaker telemetry (`lastFaultMessage`, `hive doctor`) distinguishes a claude with-progress deadline both from the old hard-timeout message and from Lane B's bare `error_turn_deadline` sentinel. The `input.error ??` guard is belt-and-suspenders — on the Claude deadline path `error` is always `undefined` (iterator closed, not thrown).
- `TURN_DEADLINE_SUBTYPE` short-circuit in `classifyErrorString` (L123-125) is unchanged; Lane B results (`timedOut: true, aborted: false`) still never reach rule 1.

### 4. Post-398 classification contract (for KPR-400 and the parity record)

Every deadline/abort shape, exhaustively — **KPR-400's spec is written against this table**:

| Lane | Result shape | Classification | Breaker effect |
|---|---|---|---|
| Claude (+Lane A passthrough) | `timedOut && aborted`, progress (`toolCalls>0` ∨ `streamed` ∨ `text≠""`) | fault / **`turn-deadline`** | inconclusive: no trip, no streak reset, probe stays failed-inconclusive (reopen, backoff exponent unchanged) |
| Claude (+Lane A passthrough) | `timedOut && aborted`, zero progress | fault / **`timeout`** (hard) | streak +1; ≥3 opens; fails a probe with backoff escalation |
| Claude (+Lane A passthrough) | `aborted` only (operator abort/stop) | **`aborted`** | neutral (streak unchanged, probe inconclusive) — unchanged |
| Lane B (codex/openai/gemini) | `error === "error_turn_deadline"`, `timedOut: true, aborted: false` | fault / **`turn-deadline`** (progress-blind) | inconclusive — unchanged |
| Any | narrowed input, `timedOut && aborted`, progress fields absent | fault / **`timeout`** | fail-closed pre-398 behavior |

Lane A passthrough providers (kimi/deepseek/grok) ride the Claude rows automatically — they run `ClaudeAgentAdapter`/`AgentRunner` (`claude-agent-adapter.ts:9-10` returns `runner.send(...)` verbatim), so their per-provider breakers gain the same fix with zero extra work. (The epic notes Grok had the identical episode.)

### 5. Dispatcher post-turn outage gate reconciliation (`dispatcher.ts:551-576`)

Current code narrows the input and keeps a redundant hang check:

```ts
const classification = classifyTurnResult({
  error: runResult.error, timedOut: runResult.timedOut, aborted: runResult.aborted,
});
const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
const hangTimeout = runResult.timedOut === true && runResult.aborted === true;
if (!hardFault && !hangTimeout) return false;
```

Two problems post-398: (a) the narrowed literal strips the progress fields, and (b) `hangTimeout` bypasses classification entirely, so a with-progress deadline turn with the breaker coincidentally open would be queued into `outage_queue` and **replayed — silently re-running a partially-executed tool turn's side effects**, precisely what the gate's own Finding-4 comment ("a partially-executed tool turn's side effects must not be silently re-run") routes to the legacy path for `non-provider`. The same reasoning applies verbatim to `turn-deadline`-with-progress (it *by definition* executed tools or streamed).

Change to:

```ts
const classification = classifyTurnResult(runResult); // full RunResult — carries toolCalls/streamed/text (KPR-398)
const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
if (!hardFault) return false;
```

`hangTimeout` is deleted, not rewritten: a zero-progress hang now classifies `"timeout"`, which is in `HARD_FAULT_KINDS`, so `hardFault` alone covers exactly the shape `hangTimeout` existed to catch (it was already redundant even pre-398 — rule 1 fires irrespective of `error`, so `{timedOut:true, aborted:true}` always classified hard; the Finding-3-r2 comment's real content was the L559 cheap-exit condition, which is untouched). Update the §7.2 doc comment accordingly. `convertTurnResult` (`dispatcher.ts:384-412`) already carries `toolCalls`/`streamed`/`text` faithfully (`text: turn.finalMessage` ← `finalizeSpawnResult`'s raw `result.text` passthrough — no synthetic message injection anywhere on that path, verified), so the full-object pass is sound.

Net dispatcher behavior change: with-progress deadline + breaker open → legacy error path (no queue, no replay). Zero-progress hang + breaker open → outage path, unchanged. Existing dispatcher tests at `dispatcher.test.ts:1221/1234` use `makeTurn({ finalMessage: "", ..., timedOut: true, aborted: true })` with fixture defaults `toolCalls: 0, streamed: false` — zero-progress shapes, so they pass unchanged and become the preserved-direction pins on this call site.

### 6. What does NOT change (verified against source)

- `agent-runner.ts` — no changes. The deadline timer, the `activeQuery` guard (KPR-306), and `RunResult` assembly already produce every field the predicate needs.
- `agent-manager.ts` — no changes. L1095 `classifyTurnResult(finalResult)` picks up the new fields structurally. The stop/abort synthetic results (~L1505-1550) set `aborted` without `timedOut` → still neutral. `classifyThrown` paths (L1091) unaffected.
- `provider-circuit-breaker.ts` — no changes (see Non-Goals). The `turn-deadline` arms at L285-293 (closed-state record) and L428-448 (probe settle: inconclusive reopen, exponent unchanged) are the consuming semantics this spec relies on, already tested.
- Lane B adapters, `TURN_DEADLINE_SUBTYPE`, `HARD_FAULT_KINDS`, `SDK_NON_PROVIDER_SUBTYPES`, `FAULT_PATTERNS` — no changes.

## Integration points

| Surface | File | Change |
|---|---|---|
| Classifier | `src/agents/provider-adapters/error-classification.ts` | `TurnFaultInput` +3 optional fields; `hasObservedProgress`; rule-1 split; doc-comment updates (rule list, `timeout` kind comment L20) |
| Breaker feed | `src/agents/agent-manager.ts:1095` | none (structural) |
| Outage gate | `src/channels/dispatcher.ts:551-576` | pass full `runResult`; delete `hangTimeout`; comment update |
| Tests | `src/agents/provider-adapters/error-classification.test.ts` | new describe block, §Tests below |
| Tests | `src/channels/dispatcher.test.ts` | one new with-progress row; existing 1221/1234 rows re-annotated as zero-progress pins |
| Cross-epic | KPR-385's `classification-crosscheck.test.ts` (not on this branch) | no conflict — its rows never set `timedOut && aborted`; whichever epic lands second re-runs it unedited. Its Lane B deadline row (`aborted: false`) remains green under this change |
| Docs | `docs/providers.md` | **not required** — parity matrix rows describe provider behavior surfaces; breaker classification is engine-internal. ⚠ flagged in case review disagrees; the change is one sentence if wanted |
| KPR-400 | — | consumes §Design.4 contract table |

## Edge cases

1. **Incident shape** — `toolCalls=46, toolMs≈294s, streamed=true, text=""`, deadline abort → `turn-deadline`. Breaker: no trip; streak (sitting at 2/3) neither incremented nor reset.
2. **Zero-progress hang** — fresh turn, provider accepts connection, nothing ever streams: `toolCalls=0, streamed=false, text=""` → hard `timeout`. Three consecutive still open the circuit. **Preserved.**
3. **Streamed text, no tools** — model streamed prose then the deadline hit: `streamed=true` → `turn-deadline`. Provider demonstrably responded; and because inconclusive never resets the streak, this cannot mask an interleaved hang pattern.
4. **Partial first tool call** — deadline mid-first-tool: the `tool_use` block's arrival already implies a completed assistant message → `toolCalls=1` → `turn-deadline`.
5. **Deadline during final synthesis after tools finished** — `toolCalls>0` → `turn-deadline`.
6. **Non-streaming spawn (no `onStream` — cron/reflection), completed a message then stalled** — `streamed` can never be true, but `text.length>0` catches it → `turn-deadline`.
7. **Non-streaming spawn, deadline mid-first-message** — deltas arrived but no callback observed them and no message completed: all signals false → hard `timeout`. Conservative-toward-protection; identical to pre-fix behavior; accepted (no observable evidence exists in `RunResult`).
8. **Operator abort of a turn that had progress** — `aborted` only, rule 2: neutral `"aborted"`. Progress fields never consulted.
9. **Operator abort racing the deadline** — the KPR-306 `activeQuery` guard (runner L2025-2032) already prevents a late deadline fire from stamping `timedOut` on an operator abort; unchanged.
10. **Lane B deadline** — sentinel string path, `aborted:false`; rule 1 unreachable; progress-blind `turn-deadline` as today.
11. **Narrowed caller** (hypothetical future/plugin) — progress fields absent → fail-closed hard `timeout` = pre-398 behavior.
12. **`llmMs` on deadline turns is negative** (SDK result never arrives ⇒ `durationMs=0`) — irrelevant to the breaker either way: `turn-deadline` and `timeout` faults never reach `pushSample` (only `success` does). Noted so nobody "fixes" the predicate to use it.

## Tests

All in `src/agents/provider-adapters/error-classification.test.ts`, new `describe("KPR-398 — deadline abort with observed progress")` block, following the file's existing row-pin style:

**New direction (with-progress → `turn-deadline`):**
1. Incident-shaped row: `{ timedOut: true, aborted: true, toolCalls: 46, streamed: true, text: "" }` → `{ outcome: "fault", kind: "turn-deadline" }`; assert `HARD_FAULT_KINDS.has(kind) === false`.
2. Each signal independently sufficient (three rows): `toolCalls: 1` alone; `streamed: true` alone; `text: "partial reply"` alone — each with the other two signals at their zero values → `turn-deadline`.
3. Message pin: the synthesized message embeds the evidence (`toolCalls=`, `streamed=`, `textLen=`) — pinned with `toMatchObject`/exact string so telemetry-distinguishability doesn't silently regress.

**Preserved direction (zero-progress → hard `timeout`):**
4. Explicit zeros: `{ timedOut: true, aborted: true, toolCalls: 0, streamed: false, text: "" }` → `kind: "timeout"`, message `"turn deadline exceeded"`.
5. Fail-closed: fields absent — the existing L18 row (`{ timedOut: true, aborted: true }` → `timeout`) is kept verbatim and re-annotated as the fail-closed pin; do not weaken it.

**Negative pins (repo convention — `feedback_negative_verify_regression_tests` applies at implementation time: revert the rule-1 split and confirm row 1 fails on pre-fix code):**
6. Progress fields on an `aborted`-only input still classify neutral `"aborted"` (progress must not create new outcomes outside rule 1): `{ aborted: true, toolCalls: 46, streamed: true }` → `{ outcome: "aborted" }`.
7. Progress fields on a plain error-string input do not perturb the pattern tables: `{ error: "429 Too Many Requests", toolCalls: 46 }` → `rate-limit`.
8. Progress fields on a success input: `{ toolCalls: 46, streamed: true }` (no flags, no error) → `success`.
9. Lane B shape unchanged: `{ error: TURN_DEADLINE_SUBTYPE, timedOut: true, aborted: false, toolCalls: 0 }` → `turn-deadline` (sentinel short-circuit, progress-blind).
10. `HARD_FAULT_KINDS` membership pin already exists (L147-154) and must stay exactly `{auth, connect-fail, rate-limit, server-error, timeout}` — `turn-deadline` stays out.

**Dispatcher (`src/channels/dispatcher.test.ts`, outage-interception describe):**
11. New row: with-progress deadline turn (`makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true })`) with breaker open+enabled → **legacy path, not queued** (mirror of the ★ row at L1221).
12. Existing rows L1221 (zero-progress + open → outage path) and L1234 (zero-progress + closed → legacy) pass unchanged — re-annotate as the zero-progress pins for this gate.

No new breaker tests: `turn-deadline` consumption is pre-existing, already covered in `provider-circuit-breaker`'s suite, and out of scope.

## Open assumptions (⚠ = delegated, decided here; none blocking)

- ⚠ **A1 — Predicate composition:** binary OR of `toolCalls>0 | streamed | text≠""`; no thresholds, no `toolMs` ratio, no `compactions`/token signals (rationale in §Design.2). Routine engineering choice.
- ⚠ **A2 — With-progress message format:** deterministic evidence-embedding string (§Design.3). Telemetry nicety; any reviewer-preferred wording is fine as long as it is deterministic and distinguishable from Lane B's bare sentinel.
- ⚠ **A3 — Dispatcher gate reconciliation** (delete `hangTimeout`, pass full `RunResult`, with-progress deadlines follow the legacy path instead of outage replay): held in-scope because leaving it produces semantics that contradict this ticket at its only other call site, and the change direction is forced by the gate's own Finding-4 rationale. If review wants it split out, it is a clean two-line extraction — but the epic's clean-wrap-over-debt posture says finish it here.
- ⚠ **A4 — `docs/providers.md` untouched:** classification is engine-internal, not a provider-behavior surface. One-sentence addition if review rules otherwise.
- **A5 (informational)** — Lane A passthrough providers inherit the fix through `ClaudeAgentAdapter` with no per-provider work; grok's incident episode is covered by the same change.
