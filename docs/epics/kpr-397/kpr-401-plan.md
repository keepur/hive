# KPR-401 — Aborted-Turn Accounting Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Deadline- and operator-aborted Claude-lane turns stop recording `costUsd=0 durationMs=0 llmMs=-<toolMs>` with all-zero token counters: `AgentRunner.send()` accumulates per-API-call usage from the assistant messages the SDK already streams (deduplicated per `message.id` via a `Set` — firm review ruling), records wall-clock `durationMs` whenever no result message arrived, and clamps `llmMs = Math.max(0, durationMs − toolMs)` (Lane B parity); the three consumer records that could not segment aborted turns gain the flags — `aborted` + `timedOut` on the dispatcher "Work item dispatched" log line and the `activity_log` doc, sparse `aborted: true` on the `agent_turn_telemetry` doc behind a relaxed `(!aborted || hadUsage)` gate. `costUsd` stays 0 on result-less turns (the SDK never streams cost; no estimation). The breaker is changed **zero** — its success-only sampling at both `pushSample` sites plus the negative guard are pinned by tests.

**Architecture:** Five source files, four test files. `src/agents/agent-runner.ts` — four minimal edits, all inside `send()` (accumulator + dedupe Set, wall anchor, `sawResult`-gated durationMs fallback, unconditional clamp); the result message stays authoritative (assignments overwrite the accumulator, success path byte-identical). `src/agents/turn-telemetry.ts` + `src/activity/types.ts` — optional sparse fields only, no reader/pipeline changes. `src/agents/agent-manager.ts` — one function (`recordSpawnObservability`): relaxed telemetry gate + two sparse pass-throughs. `src/channels/dispatcher.ts` — two log fields on the L338 call site (`convertTurnResult` already maps both faithfully; no mapping change). **No Lane B changes (verified clean, spec Key Points), no breaker code change, no classification/dispatch/persistence changes (D1/D3/D6 untouched), no dashboard/doctor renderer changes, no `docs/providers.md` edit (accounting/telemetry surface — no parity-matrix row moves).**

**Tech Stack:** TypeScript (strict), Vitest, existing mock seams only — `agent-runner.test.ts`'s `mockQueryOverride`/`mockMessages` (KPR-306), `agent-manager.test.ts`'s mocked runner + stores, `dispatcher.test.ts`'s `mockLogInfo` + mocked agentManager, `provider-circuit-breaker.test.ts`'s fake-clock `makeRegistry`.

> **Decision Register canon consumed (KPR-397 epic description):** D1 (progress predicate NOT extended — token counters never join it), D3 (dispatcher outage gate untouched; the L338 edit is log-fields-only on a different call site), D6 (kpr-398-spec §Design.4 table holds byte-for-byte — classification inputs unchanged), D8 (accepted residuals: lower-bound tokens on aborted turns, ephemeral TTL breakdown undefined, contextWindow 0, catch-block log lines print pre-fallback durationMs).
>
> **KPR-399 merge-order awareness (PR #414, not on this branch):** KPR-399 touches `agent-manager.ts` in the `spawnTurn` retry chain (~L1020–1131) and `finalizeSpawnResult` (~L1869–1990); this plan's only `agent-manager.ts` edit is `recordSpawnObservability` (L1794–1841 today) — **disjoint regions, same file**. Its spec explicitly declares the telemetry gate unchanged; **this ticket owns that edit**. All anchors below are text-based, so they survive line drift if #414 merges first. In `agent-manager.test.ts`, KPR-399 inserts its describes between the gemini stale-handle describe and the Lane A describe and re-scopes the L2018 legacy row; this plan's test insertion (inside the `spawnTurn shaping (KPR-224)` describe, after the success-observability row) does not collide. This plan does NOT touch `synthesizeAbortedResult`'s doc comment (KPR-399 edits it; the "telemetry skipped" claim stays true here — zero-usage aborted shapes remain excluded by `hadUsage`).

**Authoritative spec:** `docs/epics/kpr-397/kpr-401-spec.md` @ 5d6bb12 (two Frontier review rounds; the Set-based per-id dedupe is a firm ruling; its §Design 1–4 and Tests 1–9 are binding).

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* (1) **Runner accounting** (`agent-runner.test.ts`, `mockQueryOverride`/`mockMessages` seams): partial-usage snapshot on deadline abort (per-id sum across two API calls, all four counters, wall `durationMs > 0`, `llmMs ≥ 0`, `costUsd = 0`, flags intact), the **duplicate-id row** (per-content-block emission — same id twice counts once, the naive-sum bug would report 2×), null-coalesce belt (a `null` cache counter sums as 0), result-authoritative overwrite (success path byte-identical — result usage/cost/duration values exactly, not accumulator+result), abort-before-any-assistant-message (zero counters, wall duration, clamped llmMs), clamp identity row (`llmMs === Math.max(0, durationMs − toolMs)` with recorded tool time). (2) **Observability gate** (`agent-manager.test.ts`): aborted+usage+sessionId → `turnTelemetryStore.record` called with `aborted: true` (and no `timedOut` key); aborted+zero-usage → not called (`synthesizeAbortedResult` noise guard); success → called **without** the `aborted` key (doc shape unchanged); activity audit receives sparse `aborted`/`timedOut` on aborted turns and **neither key** on success. (3) **Dispatcher log row** (`dispatcher.test.ts`): aborted TurnResult → "Work item dispatched" fields include `aborted: true, timedOut: true` and non-negative llmMs. (4) **Breaker pins** (`provider-circuit-breaker.test.ts`, zero source change): closed-state `record()` with `aborted`/`turn-deadline` + large positive llmMs → window empty; half-open probe settled `aborted`/`turn-deadline` + large llmMs → reopens inconclusive, window empty; `success` with `llmMs: -1` → never sampled (negative guard belt).
  - *Reason:* the runner accumulator is the defect fix (spec Tests 1–4); the gate/flag rows are the consumer contract (Tests 5–7); the breaker pins become load-bearing the moment aborted turns start carrying large real llmMs values (Test 8 — "keep it that way" ticket constraint).
  - *Minimum assertions:* spec §Tests rows 1–9 mapped: rows 1 (incl. duplicate-id), 2, 3, 4 → `src/agents/agent-runner.test.ts` (new `aborted-turn accounting (KPR-401)` describe); rows 5, 7 → `src/agents/agent-manager.test.ts` (new nested `aborted-turn observability (KPR-401)` describe); row 6 → `src/channels/dispatcher.test.ts` (one new row in `Per-turn dispatch (unconditional, KPR-220 Phase 9)`); row 8 → `src/agents/provider-circuit-breaker.test.ts` (new KPR-401 describe, three rows); row 9 (negative-verify) → Tasks 2/4/6 reverse-apply steps.
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable.

### Critical Flows

1. **Incident shape:** deadline abort mid-tool-turn after two completed API calls → RunResult carries the summed per-call tokens (subagent calls included by construction — every distinct id counts), wall-clock `durationMs > 0`, `llmMs ≥ 0`, `costUsd = 0`, `aborted: true, timedOut: true`. The evidence line `costUsd=0 durationMs=0 llmMs=-294391` becomes impossible.
2. **Duplicate emission:** one API call emitted as N assistant messages (one per content block, identical id+usage) counts exactly once — the Set holds unconditionally, including any future interleaving of parallel-subagent bursts (firm spec-review ruling).
3. **Success path byte-identical:** a turn with a result message reports exactly the result message's usage/cost/duration — the accumulator is invisible (assignments overwrite).
4. **Consumer segmentation:** the dispatcher log line, `activity_log` doc, and `agent_turn_telemetry` doc all let a dashboard exclude/segment aborted turns; zero-usage aborted turns produce no telemetry noise docs.
5. **Breaker immunity, both sites:** aborted/deadline outcomes never enter the p95 window whether recorded closed-state or as a half-open probe settle; a negative sample never enters regardless of outcome.

### Regression Surface

- `src/agents/agent-runner.test.ts` — **every pre-existing row preserved verbatim** (KPR-306 timedOut rows, completion-record rows, KPR-312 is_error rows, scope/toolkit/cache suites). Verified while drafting: no existing row pins `durationMs === 0`, negative `llmMs`, or zero token counters on aborted shapes — the KPR-401 additions are append-only.
- `src/agents/agent-manager.test.ts` — **no pre-existing row changes.** Verified: no row pins "telemetry skipped on aborted" (the only telemetry-count assertion, `records telemetry… on success` ~L3900, runs a single success spawn). The aborted fixtures at L539/L1212/L1239 (default token counters > 0, sessionId "session-1") now fire a fire-and-forget telemetry record — none of those tests assert on `turnTelemetryStore.record`, all pass unchanged. KPR-347 synthesized-abort rows (~L2228+) stay excluded by `hadUsage` (all-zero shape).
- `src/channels/dispatcher.test.ts` — untouched rows all pass: the KPR-220 Phase-1 log row asserts specific fields only (extra keys harmless); the KPR-307 outage rows (`timedOut && aborted` with breaker open) never reach the L338 log site.
- `src/agents/provider-circuit-breaker.test.ts` — append-only; every KPR-306/turn-deadline row re-runs unedited (no source change behind it).
- `src/agents/turn-telemetry.test.ts`, `src/activity/activity-logger.test.ts` — untouched files; the interface additions are optional fields flowing through `{ ...input }` / `insertMany` untouched code paths.
- Lane B adapter suites, error-classification suite, outage/dispatcher-conference suites — no source changes behind them; must pass unedited in the final gate.

### Commands

All commands run from the child worktree root. **The delivery worktree ships without `node_modules` — Task 0 runs `npm ci` first.** Env stubs are required for anything importing config:

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Setup (Task 0):** `npm ci`
- **Unit (the four touched suites):** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/channels/dispatcher.test.ts src/agents/provider-circuit-breaker.test.ts`
- **Integration / E2E:** n/a
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness only. `agent-runner.test.ts`'s `mockQueryOverride` (hang-until-close) and `mockMessages` (finite sequence) seams, `agent-manager.test.ts`'s `makeRunResult`/`makeWorkItem`/local `makeCtx` + `localManager`-with-activityLogger pattern, `dispatcher.test.ts`'s `mockLogInfo` + `makeMockAgentManager`, `provider-circuit-breaker.test.ts`'s `makeRegistry` fake clock — all already exist; no new harness.

### Non-Required Rationale (only for not-required groups)

- **Integration:** the mocked-SDK runner suite drives the real `send()` loop end-to-end (message iteration → abort → finally → completion record → RunResult), and the mocked-runner manager suite drives the real `recordSpawnObservability` — those ARE this repo's integration surfaces for accounting. The only cross-boundary unknown (exact SDK emission cadence of assistant-message usage) was verified empirically against live session transcripts during spec review (42 messages / 18 ids, all duplicated, contiguous) and the Set design is correct under ANY cadence — nothing left for an integration tier to de-risk.
- **E2E:** no channel, process, or vendor boundary changes; log fields and sparse Mongo doc fields have no aggregating consumer that could break (spec Non-Goals: pipelines unchanged).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Honest exit codes: never pipe a vitest run through another command without `set -o pipefail` in that shell; the commands below deliberately avoid pipes.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** stash-free, commit-anchored reverse-apply — `git diff HEAD~1 HEAD -- <source-file> | git apply -R`, run the suite, then `git checkout HEAD -- <source-file>` to restore. **Never `git stash`** (shared stash stack across worktrees is forbidden). Load-bearing behavioral anchors: Task 2 (runner), Task 4 (manager), Task 6 (dispatcher). Task 7's breaker pins are **degenerate by construction** — they pin existing behavior with zero source change, so there is no pre-fix state to fail against; documented as such in the task (KPR-399 Task 2 precedent).
- Per-commit-green discipline: every commit below leaves the touched suites green; the negative-verify steps run between the source commit and its test commit, never leaving a red tree behind a commit boundary.

---

## Task 0: Worktree setup + baseline

**Files:** none (setup/verification only)

- [ ] **Step 1:** Install dependencies (the delivery worktree has no `node_modules`):

```bash
npm ci
```

- [ ] **Step 2:** Baseline the four suites this plan touches — must be green before any edit:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/channels/dispatcher.test.ts src/agents/provider-circuit-breaker.test.ts
```

Expected: 0 failures. If not, stop — the branch base is broken; report a blocker.

- [ ] **Step 3:** No commit.

## Task 1: Runner accounting — accumulator, wall anchor, durationMs fallback, clamp

**Files:**
- Modify: `src/agents/agent-runner.ts` (five text-anchored edits, all inside `send()`: counter declarations ~L2010–2013; deadline arm ~L2033–2034; assistant branch ~L2094–2095; result branch ~L2120–2122; totalToolMs/llmMs ~L2221–2222)
- Test: none in this task (existing suite must stay green; new tests are Task 2)

- [ ] **Step 1 (spec §Design 1(b) — state):** Add the accumulator state beside the existing counters. Replace:

```ts
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
```

with:

```ts
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    // KPR-401: streamed-usage accumulation for result-less turns (deadline
    // abort, operator abort, mid-iteration throw). The SDK emits one
    // `assistant` message per CONTENT BLOCK, repeating the same message.id
    // with identical usage — countedUsageIds counts each API call's usage
    // exactly once. The Set (not a last-seen-id comparison) is prescribed:
    // its once-per-id guarantee holds unconditionally, including under any
    // future interleaving of parallel-subagent bursts (spec-review ruling —
    // a silent double-count under an SDK ordering change is the exact bug
    // class this ticket exists to fix). When a result message arrives, its
    // cumulative totals authoritatively OVERWRITE the accumulator (sawResult
    // gates the durationMs fallback below).
    let sawResult = false;
    const countedUsageIds = new Set<string>();
```

- [ ] **Step 2 (spec §Design 1(a) — wall anchor):** Replace:

```ts
    let timedOut = false;
    const deadline = setTimeout(() => {
```

with:

```ts
    let timedOut = false;
    // KPR-401: wall-clock anchor — durationMs comes from the result message
    // when one arrives; result-less exits fall back to Date.now() − this.
    const turnStartedAt = Date.now();
    const deadline = setTimeout(() => {
```

- [ ] **Step 3 (spec §Design 1(b) — accumulate):** In the assistant branch, snapshot per-API-call usage before the content loop. Replace:

```ts
        if (msg.type === "assistant") {
          const content = (msg as any).message?.content;
```

with:

```ts
        if (msg.type === "assistant") {
          const assistantMessage = (msg as any).message;
          // KPR-401: per-API-call usage snapshot — ADDED once per distinct
          // message.id (repetitions carry identical usage; first emission
          // suffices). Subagent messages (parent_tool_use_id != null) are
          // deliberately included: subagent spawns are paid spend. The four
          // counters coalesce uniformly — cache_read/cache_creation are
          // typed number | null; input/output are plain number (harmless
          // belt). The result branch below overwrites all four when a
          // result message arrives, so success turns are byte-identical.
          const usageMessageId: string | undefined = assistantMessage?.id;
          const messageUsage = assistantMessage?.usage;
          if (usageMessageId && messageUsage && !countedUsageIds.has(usageMessageId)) {
            countedUsageIds.add(usageMessageId);
            inputTokens += messageUsage.input_tokens ?? 0;
            outputTokens += messageUsage.output_tokens ?? 0;
            cacheReadTokens += messageUsage.cache_read_input_tokens ?? 0;
            cacheCreationTokens += messageUsage.cache_creation_input_tokens ?? 0;
          }
          const content = assistantMessage?.content;
```

- [ ] **Step 4 (spec §Design 1(b) — result stays authoritative):** Replace:

```ts
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          costUsd = result.total_cost_usd;
```

with:

```ts
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          // KPR-401: the result message is the SDK's own cumulative turn
          // total — authoritative. The usage ASSIGNMENTS below (not
          // additions) overwrite the streamed accumulator, keeping the
          // success path and the error_during_execution / error_max_turns
          // paths byte-identical to pre-401 behavior.
          sawResult = true;
          costUsd = result.total_cost_usd;
```

(The existing `inputTokens = usage.input_tokens ?? 0;` etc. assignment lines inside this branch stay **byte-for-byte untouched** — they are the overwrite.)

- [ ] **Step 5 (spec §Design 1(c)+(d) — fallback + clamp):** Replace:

```ts
    const totalToolMs = toolCalls.reduce((sum, tc) => sum + ((tc.endMs ?? Date.now()) - tc.startMs), 0);
    const llmMs = durationMs - totalToolMs;
```

with:

```ts
    const totalToolMs = toolCalls.reduce((sum, tc) => sum + ((tc.endMs ?? Date.now()) - tc.startMs), 0);
    // KPR-401 (c): result-less exits (deadline abort, operator abort, mid-
    // iteration throw) never assigned durationMs — real wall clock instead
    // of 0. Cosmetic residual, deliberate: the two catch-block log lines
    // above print durationMs BEFORE this fallback runs, so they still show
    // 0 on result-less crashes; the completion log and RunResult carry the
    // corrected value (spec Edge cases — noted so review doesn't re-flag).
    if (!sawResult) durationMs = Date.now() - turnStartedAt;
    // KPR-401 (d): unconditional clamp — Lane B parity (all three adapters
    // clamp verbatim). Pre-401 this computed 0 − toolMs on aborted turns
    // (the llmMs=-294391 incident shape); on success turns it only alters
    // clock-skew negatives, which pushSample dropped anyway (they now enter
    // the window as 0-samples, matching Lane B — accepted, spec Edge cases).
    const llmMs = Math.max(0, durationMs - totalToolMs);
```

- [ ] **Step 6:** Verify — format, typecheck, existing suite untouched-green:

```bash
npx prettier --write src/agents/agent-runner.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
```

Expected: typecheck clean; all existing agent-runner tests pass (0 failures — no pre-existing row pins the old zeros/negatives, verified at plan time).

- [ ] **Step 7:** Commit:

```bash
git add src/agents/agent-runner.ts
git commit -m "fix(agent-runner): aborted-turn accounting — per-id streamed-usage snapshot, wall durationMs, llmMs clamp (KPR-401)

A deadline or operator abort closes the SDK iterator without a result
message, so costUsd/durationMs/tokens were never set and llmMs computed
0 − toolMs (the llmMs=-294391 incident shape). send() now accumulates
per-API-call usage from the assistant messages the SDK already streams —
counted once per message.id via a Set (the SDK repeats the same id with
identical usage once per content block; the Set holds under any future
interleaving, spec-review ruling) — records wall-clock durationMs whenever
no result arrived, and clamps llmMs = max(0, durationMs − toolMs) (Lane B
parity). The result message stays authoritative: its cumulative totals
overwrite the accumulator, so success paths are byte-identical. costUsd
stays 0 on result-less turns — the SDK never streams cost; no estimation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Runner tests — partial-usage sum, duplicate-id pin, result-authoritative, wall clock, clamp + negative-verify

**Files:**
- Modify: `src/agents/agent-runner.test.ts` (one new describe inserted immediately BEFORE the line `describe("AgentRunner is_error result guard (KPR-312, via send)", () => {` — i.e. after the closing `});` of the `completion record reports killed runs as failures` describe)

- [ ] **Step 1:** Insert the new describe at the location above, verbatim:

```ts
describe("aborted-turn accounting (KPR-401)", () => {
  beforeEach(() => {
    mockQueryOverride = null;
    mockMessages = null;
  });
  afterEach(() => {
    mockQueryOverride = null;
    mockMessages = null;
  });

  // Per-API-call BetaUsage shapes. USAGE_B's cache_creation is null on
  // purpose — the accumulator's ?? 0 coalesce belt (cache counters are
  // typed number | null).
  const USAGE_A = { input_tokens: 1000, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 250 };
  const USAGE_B = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9500, cache_creation_input_tokens: null };

  function assistantMsg(id: string, usage: Record<string, number | null> | undefined, content: any[]) {
    return { type: "assistant", session_id: "s-kpr401", message: { id, usage, content } };
  }

  /** Yields `messages`, then hangs until abort()/the deadline close()s the query. */
  function yieldingThenHangingQuery(messages: any[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockQueryOverride = () => ({
      close: () => release(),
      [Symbol.asyncIterator]: async function* () {
        for (const m of messages) yield m;
        await gate;
      },
    });
  }

  it("deadline abort snapshots streamed usage: per-id sum, wall durationMs, clamped llmMs, costUsd 0", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): on pre-fix code this row fails
    // with all token counters 0 (assistant usage never read), durationMs 0
    // (only the result branch assigned it), and llmMs === -toolMs (negative).
    yieldingThenHangingQuery([
      assistantMsg("msg_A", USAGE_A, [{ type: "tool_use", name: "Bash", id: "toolu_1" }]),
      assistantMsg("msg_B", USAGE_B, [{ type: "text", text: "partial" }]),
    ]);
    const runner = makeRunner({ timeoutMs: 25 });
    const result = await runner.send("hi");
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.inputTokens).toBe(2200);
    expect(result.outputTokens).toBe(120);
    expect(result.cacheReadTokens).toBe(18500);
    expect(result.cacheCreationTokens).toBe(250); // null in USAGE_B coalesced to 0
    expect(result.costUsd).toBe(0); // SDK never streams cost — honest zero, segmented by aborted
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.llmMs).toBeGreaterThanOrEqual(0);
  });

  it("per-content-block repetitions of one message.id count usage exactly ONCE (duplicate-id pin)", async () => {
    // The SDK emits one assistant message per content block, repeating the
    // same message.id with identical usage (verified empirically: 42
    // messages / 18 API calls, all ids duplicated). The naive-sum bug would
    // report 2×A here — on exactly the tool-heavy turns this ticket targets.
    yieldingThenHangingQuery([
      assistantMsg("msg_X", USAGE_A, [{ type: "text", text: "thinking" }]),
      assistantMsg("msg_X", USAGE_A, [{ type: "tool_use", name: "Bash", id: "toolu_2" }]),
    ]);
    const runner = makeRunner({ timeoutMs: 25 });
    const result = await runner.send("hi");
    expect(result.inputTokens).toBe(USAGE_A.input_tokens); // exactly once, not 2×
    expect(result.outputTokens).toBe(USAGE_A.output_tokens);
    expect(result.cacheReadTokens).toBe(USAGE_A.cache_read_input_tokens);
    expect(result.cacheCreationTokens).toBe(USAGE_A.cache_creation_input_tokens);
  });

  it("result message stays authoritative: cumulative totals OVERWRITE the accumulator (success path byte-identical)", async () => {
    // Passes both pre- and post-fix — that is the point (spec Goal 4).
    mockMessages = [
      assistantMsg("msg_A", USAGE_A, [{ type: "text", text: "working" }]),
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.42,
        duration_ms: 1234,
        session_id: "s-kpr401",
        usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9, cache_creation_input_tokens: 10 },
      },
    ];
    const runner = makeRunner();
    const result = await runner.send("hi");
    expect(result.inputTokens).toBe(7); // NOT 7 + USAGE_A.input_tokens — assignment, not addition
    expect(result.outputTokens).toBe(8);
    expect(result.cacheReadTokens).toBe(9);
    expect(result.cacheCreationTokens).toBe(10);
    expect(result.costUsd).toBe(0.42);
    expect(result.durationMs).toBe(1234); // result-reported, not wall clock
    expect(result.text).toBe("done");
  });

  it("abort before any assistant message: zero counters, wall durationMs > 0, llmMs ≥ 0", async () => {
    yieldingThenHangingQuery([]);
    const runner = makeRunner({ timeoutMs: 25 });
    const result = await runner.send("hi");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0); // pre-fix: 0
    expect(result.llmMs).toBeGreaterThanOrEqual(0);
  });

  it("clamp: result-less turn with recorded tool time — llmMs === max(0, durationMs − toolMs), never negative", async () => {
    yieldingThenHangingQuery([
      assistantMsg("msg_T", USAGE_A, [{ type: "tool_use", name: "Bash", id: "toolu_3" }]),
    ]);
    const runner = makeRunner({ timeoutMs: 25 });
    const result = await runner.send("hi");
    expect(result.toolMs).toBeGreaterThan(0); // tool timing runs until the post-loop close
    // Exact identity against the returned fields — pre-fix llmMs is -toolMs,
    // which can never equal max(0, 0 − toolMs) = 0 while toolMs > 0.
    expect(result.llmMs).toBe(Math.max(0, result.durationMs - result.toolMs));
    expect(result.llmMs).toBeGreaterThanOrEqual(0);
  });
});

```

- [ ] **Step 2:** Verify green on fixed code:

```bash
npx prettier --write src/agents/agent-runner.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
```

Expected: all tests pass, including the five new KPR-401 rows.

- [ ] **Step 3:** Negative-verify (repo convention — NO `git stash`). Task 1's commit is `HEAD`; reverse-apply its runner diff:

```bash
git diff HEAD~1 HEAD -- src/agents/agent-runner.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
```

Expected: **failures confined to the new KPR-401 describe** — the partial-usage row (counters 0, durationMs 0, llmMs negative), the duplicate-id row (counters 0, expected USAGE_A), the abort-before-assistant row (durationMs 0), and the clamp row (llmMs === -toolMs ≠ 0). The result-authoritative row passes both ways — **deliberately** (it pins the byte-identical success path). Every pre-existing row still passes. If the four rows do NOT fail here, stop — the tests are not pinning the behavior change; fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/agents/agent-runner.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
```

Expected `git status --short`: exactly ` M src/agents/agent-runner.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/agents/agent-runner.test.ts
git commit -m "test(agent-runner): KPR-401 accounting pins — partial-usage sum, duplicate-id, result-authoritative, wall clock, clamp

Negative-verified: with Task 1's agent-runner.ts diff reverse-applied, the
partial-usage, duplicate-id, abort-before-assistant, and clamp rows fail on
pre-fix code (zeros and negative llmMs reappear); the result-authoritative
row passes both ways by design (success path byte-identical), and every
pre-existing row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: Observability source — relaxed telemetry gate, sparse aborted doc field, activity flags

**Files:**
- Modify: `src/agents/turn-telemetry.ts` (both interfaces, L6–31)
- Modify: `src/activity/types.ts` (end of `ActivityRecord`)
- Modify: `src/agents/agent-manager.ts` (`recordSpawnObservability` only, L1794–1867 — disjoint from KPR-399's PR #414 regions)
- Test: none in this task (new tests are Task 4)

- [ ] **Step 1:** `src/agents/turn-telemetry.ts` — sparse `aborted` on the doc interface. Replace:

```ts
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
  createdAt: Date;
}
```

with:

```ts
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
  /** KPR-401: present (true) only on aborted turns with real usage — sparse,
   * matching the ephemeral-counter optional style. Lets dashboards segment
   * aborted-turn spend; the aggregation pipelines are deliberately unchanged
   * (aborted turns' completed API calls are real cache traffic). */
  aborted?: true;
  createdAt: Date;
}
```

- [ ] **Step 2:** Same file — mirror on the input interface. Replace:

```ts
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
}
```

with:

```ts
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
  /** KPR-401: sparse — set only when true (see TurnTelemetryDoc.aborted). */
  aborted?: true;
}
```

(`record()` spreads `{ ...input, createdAt }`, so the field flows through with zero store-code change.)

- [ ] **Step 3:** `src/activity/types.ts` — optional flags on `ActivityRecord`. Replace:

```ts
  // Outcome
  streamed: boolean;
  error?: string;
}
```

with:

```ts
  // Outcome
  streamed: boolean;
  error?: string;
  /** KPR-401: sparse — set only when true, so aborted turns stop
   * masquerading as free, instant, clean turns in the audit trail. */
  aborted?: boolean;
  timedOut?: boolean;
}
```

- [ ] **Step 4:** `src/agents/agent-manager.ts` — relax the telemetry gate (spec §Design 2, verbatim condition). In `recordSpawnObservability`, replace:

```ts
    if (result.sessionId && !result.aborted) {
      this.turnTelemetryStore
        .record({
```

with:

```ts
    // KPR-401: aborted turns with real spend are recorded (sparse aborted
    // flag on the doc); zero-usage aborted turns — operator abort before the
    // first API call, and the manager's synthesizeAbortedResult early-abort
    // shape (resumed sessionId, never spawned) — stay out: nothing to
    // account, no noise docs. Deliberately provider-AGNOSTIC: Lane B
    // adapters already return real partial totals on operator-aborted
    // turns, and that spend is just as real — do not provider-gate this.
    const hadUsage =
      result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens > 0;
    if (result.sessionId && (!result.aborted || hadUsage)) {
      this.turnTelemetryStore
        .record({
```

- [ ] **Step 5:** Same call — sparse flag on the doc. Replace:

```ts
          ephemeral1hTokens: result.ephemeral1hTokens,
        })
        .catch(() => {
```

with:

```ts
          ephemeral1hTokens: result.ephemeral1hTokens,
          // KPR-401: sparse — only aborted:true is ever written.
          ...(result.aborted ? { aborted: true as const } : {}),
        })
        .catch(() => {
```

- [ ] **Step 6:** Same function — activity flags (spec §Design 3). Replace:

```ts
      streamed: result.streamed,
      error: result.error,
    });
  }
```

with:

```ts
      streamed: result.streamed,
      error: result.error,
      // KPR-401: sparse abort flags — the audit row's costUsd:0/durationMs
      // zeros on aborted turns are now segmentable instead of masquerading
      // as free, instant, clean turns.
      ...(result.aborted ? { aborted: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    });
  }
```

- [ ] **Step 7:** Verify — format, typecheck, both affected suites green:

```bash
npx prettier --write src/agents/turn-telemetry.ts src/activity/types.ts src/agents/agent-manager.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts src/agents/turn-telemetry.test.ts
```

Expected: typecheck clean; 0 failures (plan-time audit: no existing row pins "telemetry skipped on aborted"; the aborted fixtures with default token counters now fire fire-and-forget records nothing asserts on).

- [ ] **Step 8:** Commit:

```bash
git add src/agents/turn-telemetry.ts src/activity/types.ts src/agents/agent-manager.ts
git commit -m "feat(observability): record aborted-turn spend in agent_turn_telemetry + activity_log abort flags (KPR-401)

recordSpawnObservability's telemetry gate relaxes from sessionId && !aborted
to sessionId && (!aborted || hadUsage): aborted turns with real tokens (now
carried by the KPR-401 runner accumulator, and by Lane B partial totals —
the condition is deliberately provider-agnostic) enter agent_turn_telemetry
with a sparse aborted:true doc field; zero-usage aborted shapes (incl.
synthesizeAbortedResult) stay out. ActivityRecord gains sparse
aborted/timedOut so the audit trail's honest zeros are segmentable.
Aggregation pipelines and every reader unchanged. This edit is the one
KPR-399's spec explicitly left to this ticket; regions are disjoint from
PR #414's retry-chain/finalizeSpawnResult edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Manager tests — telemetry gate rows + activity pass-through + negative-verify

**Files:**
- Modify: `src/agents/agent-manager.test.ts` (one nested describe inserted inside `describe("spawnTurn shaping (KPR-224)")`, immediately AFTER the closing `});` of the `it("records telemetry, conversation index, and activity audit on success", …)` block and BEFORE the line `it("voice carve-out: passes raw text to runner.send and skips model router", async () => {`)

- [ ] **Step 1:** Insert the describe at the location above, verbatim (the enclosing shaping describe's `beforeEach` already stubs `mockConversationIndex`; its local `makeCtx` helper is in scope):

```ts
    describe("aborted-turn observability (KPR-401)", () => {
      function makeObsManager() {
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );
        return { localManager, activityLogger };
      }

      it("aborted turn WITH usage + sessionId records telemetry with aborted: true (relaxed gate)", async () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the gate is
        // `sessionId && !aborted` — record() is never called; this row fails.
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s-kpr401-tel", text: "" }),
        );
        const item = makeWorkItem({ text: "tel aborted", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
        const telArg = turnTelemetryStore.record.mock.calls[0]![0];
        expect(telArg.aborted).toBe(true);
        expect(telArg.sessionId).toBe("s-kpr401-tel");
        expect(telArg.inputTokens).toBe(100); // real spend from the runner accumulator, not zeros
        expect("timedOut" in telArg).toBe(false); // telemetry doc carries aborted only (spec §Design 2)
      });

      it("aborted turn with ZERO usage stays out of telemetry (synthesizeAbortedResult noise guard)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({
            aborted: true,
            timedOut: true,
            sessionId: "s-kpr401-zero",
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }),
        );
        const item = makeWorkItem({ text: "tel zero", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).not.toHaveBeenCalled();
      });

      it("success turns record WITHOUT the aborted field — doc shape unchanged", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-kpr401-ok" }));
        const item = makeWorkItem({ text: "tel clean", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
        const telArg = turnTelemetryStore.record.mock.calls[0]![0];
        expect("aborted" in telArg).toBe(false);
      });

      it("activity audit passes aborted/timedOut through sparsely — set on aborted turns, absent on success", async () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the audit payload has
        // neither key — the aborted-turn assertions fail.
        const { localManager, activityLogger } = makeObsManager();
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({
            aborted: true,
            timedOut: true,
            sessionId: "s-kpr401-act",
            text: "",
            costUsd: 0,
            durationMs: 294_391,
          }),
        );
        const item1 = makeWorkItem({ text: "audit aborted", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item1, "sms"));
        expect(activityLogger.record).toHaveBeenCalledTimes(1);
        const abortedArg = activityLogger.record.mock.calls[0]![0];
        expect(abortedArg.aborted).toBe(true);
        expect(abortedArg.timedOut).toBe(true);
        expect(abortedArg.costUsd).toBe(0); // honest zero, now flagged
        expect(abortedArg.durationMs).toBe(294_391); // real wall clock from the runner

        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-kpr401-ok2" }));
        const item2 = makeWorkItem({ text: "audit clean", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item2, "sms"));
        const successArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("aborted" in successArg).toBe(false); // sparse: absent, not false
        expect("timedOut" in successArg).toBe(false);
      });
    });

```

- [ ] **Step 2:** Verify green on fixed code:

```bash
npx prettier --write src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: all tests pass, including the four new KPR-401 rows.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 3's commit is `HEAD`; reverse-apply **only its `agent-manager.ts` diff** (the interface additions in `turn-telemetry.ts`/`activity/types.ts` stay — pre-fix manager code never references them, and Vitest strips types so nothing blocks execution):

```bash
git diff HEAD~1 HEAD -- src/agents/agent-manager.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: **failures confined to the new KPR-401 describe** — the aborted-with-usage telemetry row (record never called pre-fix) and the activity pass-through row (payload has neither flag). Rows that pass both ways — deliberately: the zero-usage row (excluded pre-fix by `!aborted`, post-fix by `hadUsage`) and the success rows (shape unchanged is the claim). Every pre-existing row still passes. If the two new-direction rows do NOT fail here, stop — the tests are not pinning the behavior change; fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/agents/agent-manager.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected `git status --short`: exactly ` M src/agents/agent-manager.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(agent-manager): KPR-401 observability pins — relaxed telemetry gate, sparse aborted doc field, activity flag pass-through

Negative-verified: with Task 3's agent-manager.ts diff reverse-applied, the
aborted-with-usage telemetry row and the activity pass-through row fail on
pre-fix code; the zero-usage exclusion and success-shape rows pass both
ways by design, and every pre-existing row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 5: Dispatcher — aborted/timedOut on the work-item-dispatched log line

**Files:**
- Modify: `src/channels/dispatcher.ts` (the L338 log call only — NOT the outage gate, NOT `convertTurnResult`, which already maps both flags faithfully per its every-field-explicit contract)

- [ ] **Step 1:** Replace:

```ts
        log.info("Work item dispatched", {
          agentId,
          source: item.source.kind,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          llmMs: runResult.llmMs,
          toolMs: runResult.toolMs,
          toolCalls: runResult.toolCalls,
          toolSummary: runResult.toolSummary,
        });
```

with:

```ts
        log.info("Work item dispatched", {
          agentId,
          source: item.source.kind,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          llmMs: runResult.llmMs,
          toolMs: runResult.toolMs,
          toolCalls: runResult.toolCalls,
          toolSummary: runResult.toolSummary,
          // KPR-401: segmentation flags — log-based dashboards can now
          // exclude aborted/timed-out turns' honest zeros from spend and
          // latency stats. convertTurnResult already maps both faithfully.
          aborted: runResult.aborted,
          timedOut: runResult.timedOut,
        });
```

- [ ] **Step 2:** Verify — format, typecheck, dispatcher suite untouched-green:

```bash
npx prettier --write src/channels/dispatcher.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: typecheck clean; 0 failures (the Phase-1 log row asserts specific fields only; extra keys are harmless).

- [ ] **Step 3:** Commit:

```bash
git add src/channels/dispatcher.ts
git commit -m "feat(dispatcher): aborted/timedOut flags on the work-item-dispatched log line (KPR-401)

The evidence line logged costUsd/durationMs/llmMs/toolMs with no way to
segment aborted turns' zeros out. Log-fields-only change on the delivery
call site; the KPR-307 post-turn outage gate and convertTurnResult are
untouched (D3).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 6: Dispatcher test — log-row pin + negative-verify

**Files:**
- Modify: `src/channels/dispatcher.test.ts` (one new row inside `describe("Per-turn dispatch (unconditional, KPR-220 Phase 9)")`, inserted immediately AFTER the closing `});` of the `it("KPR-220 Phase 1: per-turn dispatch propagates non-zero llmMs/toolMs/toolCalls into the work-item-dispatched log", …)` block and BEFORE the line `it("routeVoiceTurn does NOT dedup on workItem.id", async () => {`)

- [ ] **Step 1:** Insert the row at the location above, verbatim:

```ts
  it("KPR-401: aborted/timedOut TurnResult surfaces both flags + non-negative llmMs on the work-item-dispatched log", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the log-field object
    // simply lacks the two keys — fields.aborted is undefined; this fails.
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    // The incident shape post-KPR-401: honest zeros for cost, real wall
    // duration, clamped llmMs, real token counters, both flags. Breaker
    // state is null in this mock (stateFor → null), so the KPR-307 post-turn
    // outage gate does not intercept — the turn reaches normal delivery.
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "",
      newSessionId: "s-kpr401",
      usage: {
        inputTokens: 2200,
        outputTokens: 120,
        cacheReadTokens: 18500,
        cacheCreationTokens: 250,
        contextWindow: 0,
        costUsd: 0,
        durationMs: 294_391,
      },
      errors: [],
      llmMs: 0,
      toolMs: 294_391,
      toolCalls: 46,
      toolSummary: "Bash:46x/294.4s",
      streamed: true,
      compactions: 0,
      timedOut: true,
      aborted: true,
    });

    mockLogInfo.mockClear();

    const item = makeWorkItem({
      source: { kind: "sms", id: "PN_LINE_M", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_M:+15550101",
      text: "hey Jasper, kpr401 probe", // agent-name-bearing, mirroring the Phase-1 row's resolution path
    });
    await dispatcher.dispatch(item);

    const logCall = mockLogInfo.mock.calls.find(([msg]) => msg === "Work item dispatched");
    expect(logCall).toBeDefined();
    const fields = logCall![1] as Record<string, unknown>;
    expect(fields.aborted).toBe(true);
    expect(fields.timedOut).toBe(true);
    expect(fields.llmMs).toBe(0);
    expect(fields.llmMs as number).toBeGreaterThanOrEqual(0);
    expect(fields.costUsd).toBe(0); // honest zero, now segmentable
  });

```

- [ ] **Step 2:** Verify green on fixed code:

```bash
npx prettier --write src/channels/dispatcher.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: all tests pass, including the new KPR-401 row.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 5's commit is `HEAD`; reverse-apply its dispatcher diff:

```bash
git diff HEAD~1 HEAD -- src/channels/dispatcher.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: **exactly the new KPR-401 row fails** (`fields.aborted` is `undefined` on pre-fix code); every pre-existing row passes. If it does not fail, stop and fix the test.

Restore and confirm:

```bash
git checkout HEAD -- src/channels/dispatcher.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected `git status --short`: exactly ` M src/channels/dispatcher.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test(dispatcher): KPR-401 log-row pin — aborted/timedOut fields + non-negative llmMs

Negative-verified: with Task 5's dispatcher.ts diff reverse-applied, the
row fails (the log-field object lacks both keys on pre-fix code); every
pre-existing row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 7: Breaker pins — success-only sampling at BOTH pushSample sites + negative guard (zero source change)

**Files:**
- Modify: `src/agents/provider-circuit-breaker.test.ts` (new describe appended at end of file, after the closing `});` of the `turn-deadline is breaker-INCONCLUSIVE` describe)

- [ ] **Step 1:** Append at end of file, verbatim (module-level helpers `makeRegistry`/`hardFault`/`success`/`aborted` are in scope; `deadlineFault` is scoped to the KPR-306 describe, so this describe declares its own):

```ts

describe("KPR-401 pins — aborted/deadline turns never pollute the p95 window (zero breaker code change)", () => {
  // These rows pin EXISTING behavior that becomes load-bearing with KPR-401:
  // aborted turns now carry large real llmMs values (wall-clock durationMs −
  // toolMs) instead of negatives the pushSample guard happened to drop.
  // Ticket constraint: "keep it that way" — success-only sampling at BOTH
  // pushSample sites, plus the negative guard as belt. No source change
  // backs this describe, so negative-verify is degenerate by construction
  // (there is no pre-fix state to fail against) — these are pins, not
  // regression proofs.
  const deadlineFault = (): TurnClassification => ({
    outcome: "fault",
    kind: "turn-deadline",
    message: "turn wall-clock deadline expired",
  });

  it("closed-state record(): aborted / turn-deadline with LARGE positive llmMs leave the window empty", () => {
    const { registry, turn } = makeRegistry();
    turn(aborted(), 294_391);
    turn(deadlineFault(), 294_391);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.sampleCount).toBe(0); // only `case "success"` samples
    expect(snap.p95Ms).toBeNull();
  });

  it("probe settle: aborted / turn-deadline probes with LARGE llmMs reopen inconclusive, window stays empty", () => {
    for (const classification of [aborted(), deadlineFault()]) {
      const { registry, turn, advance } = makeRegistry();
      turn(hardFault());
      turn(hardFault());
      turn(hardFault()); // open
      advance(15_000);
      const probe = registry.acquire("claude");
      expect(probe.isProbe).toBe(true); // half-open probe admitted
      registry.record(probe, classification, 294_391);
      const snap = registry.stateFor("claude")!;
      expect(snap.state).toBe("open"); // reopened inconclusive, not closed
      expect(snap.sampleCount).toBe(0); // settleProbe's success gate did not sample
      expect(snap.p95Ms).toBeNull();
    }
  });

  it("pushSample negative guard: success with llmMs −1 never samples (belt for any future non-clamped caller)", () => {
    const { registry, turn } = makeRegistry();
    turn(success(), -1);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.sampleCount).toBe(0);
  });
});
```

- [ ] **Step 2:** Verify — the suite green, and confirm zero breaker source change:

```bash
npx prettier --write src/agents/provider-circuit-breaker.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts
git diff --stat HEAD -- src/agents/provider-circuit-breaker.ts
```

Expected: all tests pass including the three new pins; the `git diff --stat` prints **nothing** (the breaker source is untouched — spec Goal 5).

- [ ] **Step 3:** Commit:

```bash
git add src/agents/provider-circuit-breaker.test.ts
git commit -m "test(circuit-breaker): KPR-401 pins — success-only sampling at both pushSample sites + negative guard (zero breaker code change)

Aborted turns now carry large real llmMs values (KPR-401 wall clock) where
they used to carry negatives the pushSample guard dropped — the success-
only gates at the closed-state record() arm and the settleProbe arm become
load-bearing. Pinned at both sites plus the negative-sample belt; no
source change (ticket constraint: keep the breaker immune).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 8: Final verification — full quality gate + scope containment

**Files:** none (verification only)

- [ ] **Step 1:** Run the complete repo gate with the required env stubs:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: all four gates green — typecheck (tsc, no errors), lint (eslint, no errors), format (prettier --check, no diffs), test (vitest, 0 failures — including the untouched `turn-telemetry`, `activity-logger`, `error-classification`, Lane B adapter, and outage suites).

- [ ] **Step 2:** Confirm scope containment — the seven KPR-401 commits touch exactly nine files; none of them is a Lane B adapter, the breaker source, the classifier, the outage processor, the session store, `finalizeSpawnResult`/the retry chain (KPR-399's PR #414 surface), or `docs/providers.md`:

```bash
git diff --stat HEAD~7 HEAD -- ':!docs'
```

Expected file list, exactly:

```
src/activity/types.ts
src/agents/agent-manager.ts
src/agents/agent-manager.test.ts
src/agents/agent-runner.ts
src/agents/agent-runner.test.ts
src/agents/provider-circuit-breaker.test.ts
src/agents/turn-telemetry.ts
src/channels/dispatcher.ts
src/channels/dispatcher.test.ts
```

Additionally confirm the `agent-manager.ts` diff stays inside `recordSpawnObservability` (merge-order guard vs PR #414):

```bash
git diff HEAD~7 HEAD -- src/agents/agent-manager.ts
```

Expected: every hunk falls within `recordSpawnObservability`; no hunk touches `spawnTurn`'s retry chain or `finalizeSpawnResult`.

- [ ] **Step 3:** No commit (verification-only task). Do not push, do not open a PR — that is the deliver lane's job.

---

## Plan-drafting advisories (implementer notes, not deviations)

- **[Task 1, Step 3]:** the assistant-branch anchor `const content = (msg as any).message?.content;` appears once in the file (verified at plan time). The replacement re-derives `content` from the hoisted `assistantMessage` — behavior identical (`(msg as any).message?.content` ≡ `assistantMessage?.content`).
- **[Task 1]:** the two `catch`-block log lines ("crashed after producing response" / "Agent query failed") still print `durationMs: 0` on result-less crashes — the wall fallback runs after the `finally`. **Deliberate cosmetic residual per the spec's Edge cases ("noted so plan review doesn't re-flag it")**; do not "fix" it. The `resultText && costUsd > 0` crashed-after-response heuristic is untouched — the accumulator never writes `costUsd`, so its behavior is provably identical.
- **[Task 3, Step 5]:** the `ephemeral1hTokens: result.ephemeral1hTokens,` line also exists in `finalizeSpawnResult`'s TurnResult literal — the three-line anchor including `})` + `.catch(() => {` is unique to the telemetry record call. If an exact-match edit tool complains, widen the anchor upward with `ephemeral5mTokens: result.ephemeral5mTokens,`.
- **[Task 4]:** the telemetry rows use the shared `manager` (its `beforeEach` constructs it without an activityLogger — telemetry assertions don't need one); only the activity row builds a `localManager` via `makeObsManager()`. `vi.clearAllMocks()` in the file-level `beforeEach` resets `turnTelemetryStore.record` call history between rows.
- **[Task 4/Task 6 fixtures]:** the aborted fixtures deliberately reuse the incident's magnitudes (294 391 ms, 46 tool calls, 2 200/120/18 500/250 tokens) so the rows read as the production shape; nothing asserts on the magnitudes beyond what the contract requires.
- **[Prettier reflow]:** several new `it(...)` titles and object literals exceed print width; each task's `prettier --write` before commit rewraps them — do not treat the reflow as a deviation.
- **[If PR #414 (KPR-399) merges into the epic branch mid-implementation]:** rebase; every anchor in this plan is text-based and lands in regions #414 does not touch (`recordSpawnObservability`, the runner, the dispatcher log site, test-insertion points). The only shared file-level neighbors are `agent-manager.ts`/`agent-manager.test.ts` — resolve any hunk-adjacency noise in favor of both changes; there is no semantic conflict (KPR-399's spec explicitly cedes the telemetry-gate edit to this ticket).

---

## Plan-review advisories (r1, verbatim — implementer notes, not deviations)

1. [Task 6, Step 1] The in-test comment attributes gate non-interception to `stateFor → null`; the actual first exit is `if (!outage) return false` (the test dispatcher is built without an outage store). Both hold — word the comment "no outage store configured (and breaker state is null)" for precision.
2. [Task 1, Step 4] The result-branch overwrite is conditional on the existing `if (usage)`: a hypothetical result message lacking `usage` would retain accumulator values instead of zeros. Unreachable with real SDK result messages (usage is required on `SDKResultMessage`) — implementer awareness only, change nothing.
3. [Task 8, Step 2] "Expected file list, exactly" means the file SET shown, exactly — `git diff --stat` also prints change bars and a summary line; don't diff literal output.
4. [Task 4] The two `await Promise.resolve()` waits are belt (the `record` call is synchronous inside `recordSpawnObservability` before `spawnTurn` resolves) — keep for symmetry with the existing success-observability row.
