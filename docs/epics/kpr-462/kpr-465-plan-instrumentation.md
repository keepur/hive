# KPR-465 instrumentation chunk (A) — close the two warm-lease measurement gaps

> **For agentic workers:** Use dodi-dev:implement after the parent [plan](./kpr-465-plan.md) review gate passes. This chunk is first in the binding order.

**Goal:** Every warm voice turn reports a non-overlapping `queueWaitMs` + (turn 1 only) `bootToInitMs` + `initToFirstTokenMs` decomposition, and both `engine_attempt_terminal` and `engine_terminal` carry `bootToInitMs` and `queueWaitMs` as nullable measures with excluded-by-reason accounting, while cold `stageTimings` stay byte-identical.

**Architecture:** The manager stamps one anchor at `spawnTurn`'s warm-branch entry and threads it (through the pending-opening recursion, `openWarmLease`, `openWarmLeaseAttempt`, `runWarmTurn`) into `WarmTurnRequest.enqueuedAt`; the manager stamps a second anchor immediately before `runner.openVoiceStreamingSession(...)` and hands it to `lease.start(q, { openCalledAt })`. `consumeOneTurn` computes `queueWaitMs` at consume start; the **opener** — turn 1 whose `enqueuedAt ≤ openCalledAt` — ends its queue stage at the open call instead, so the three stages never overlap. **Deliberate refinement of spec §3.2 bullet 1** ("to consume start"): for the opener, consume start is *after* boot (the lease is not `ready` until `start()`), so measuring to consume start would fold the whole boot into the queue stage and double-count it against `bootToInitMs`; ending at the open call is the only non-overlapping decomposition. Chunk E's evidence record must describe the stage table with this refinement (one-line pointer; chunk E is not edited here). The `≤` gate is what keeps a KPR-464 cancelled-opener survivor (test `warm-voice-session.test.ts:829` — a cancelled opener never increments `turnCount`, so a later request is also `ownedTurn === 1`) from being anchored on a stale `openCalledAt`: a survivor that entered *after* the open call is measured as a joiner (queue = entry → consume start, no boot stage), while one that entered *before* it honestly waited through boot and is measured as the opener. `consumeOneTurn` also computes turn-1 `bootToInitMs` at the `system/init` message and re-bases turn-1 `initToFirstTokenMs` to init → first delta. All deltas are raw — never `Math.max(0, …)`-clamped — because `voice-trace.ts`'s `measure()` (line 55) already classifies a negative or non-finite value as `{value: null, reason}` (canon R2, never zero-coerced). The adapter maps the values onto `EnginePayload` measures with `not_applicable` for warm turns ≥ 2 / cold queue, and `not_observed` for any attempt whose `outcome !== "completed"` (spec §3.2 bullet 2: "failed, cancelled or disconnected"); the reader's allowlist and measure validator (Task A3) land **one commit before** emission (Task A4), so no intermediate commit emits rows the reader would reject.

**Tech Stack:** TypeScript, existing `WarmVoiceSession`/`AgentManager`/`VoiceAdapter`, `voice-trace.ts` `Measure`, Vitest with the existing fake-Query and echo-streaming harnesses.

Spec authority: §3.2 bullets 1, 2, 4 and 5 (`queueWaitMs`, `bootToInitMs`, additive-under-v2, privacy); **bullet 3 — delivered `effort` and the endpointing stamps — is deliberately not this chunk's: it belongs to chunks C/D.** §8 R2, R5 (offline rows), R7. Canon R3 (lease semantics unchanged) and R2 (schema v2, `{value, reason}` measures, never zero-coerced).

## Testing Contract (chunk A)

### Required Test Groups

- Unit: `required`
  - Scope: `WarmVoiceSession.consumeOneTurn` anchors (`src/agents/warm-voice-session.test.ts`); reader allowlist/validation (`src/voice/voice-diagnostic-reader.test.ts`); `EnginePayload` privacy (`src/voice/voice-trace.test.ts`).
  - Reason: the three measures are deterministic functions of four timestamps; a fake Query controls all four.
  - Minimum assertions: (1) queued behind an in-flight turn — turn 2's `queueWaitMs ≥` the artificial hold and turn 2's `bootToInitMs === undefined`; (2) turn 1 — `bootToInitMs` spans `openCalledAt → init`, `initToFirstTokenMs` spans init → first delta (not push → delta); (3) turn 1 without an `openCalledAt` (a caller that never passed it) — `bootToInitMs === undefined`, `initToFirstTokenMs` falls back to push → delta; (3b) turn 1 without an `enqueuedAt` — `queueWaitMs === undefined` **and** `bootToInitMs === undefined` (fail-closed: without the entry anchor the lease cannot tell the opener from a survivor, so it fabricates nothing); (4) a turn whose output ends before `result` still returns `queueWaitMs` (a number) and `bootToInitMs` undefined; (5) reader accepts `engine_attempt_terminal`/`engine_terminal` rows with `queueWaitMs`/`bootToInitMs` measures, rejects `{value: 0, reason: "not_observed"}`-style mixed measures and unknown keys; (6) KPR-464 fixtures reduce with the same totals as before; (7) **cancelled-opener survivor** (the KPR-464 shape at `warm-voice-session.test.ts:829`) — a survivor whose `enqueuedAt` postdates `openCalledAt` becomes `ownedTurn === 1` and reports `queueWaitMs` = entry → consume start with `bootToInitMs === undefined`, while a survivor that queued *before* the open call is measured as the opener; (8) a negative delta (clock skew, `enqueuedAt` after consume start) is returned raw, never clamped to 0 — `measure()` classifies it downstream; (9) R7 at runtime — a sentinel string in the request transcript never appears in `JSON.stringify` of the warm attempt terminal or of the stage-carrying `TurnResult.stageTimings`.
- Integration: `required`
  - Scope: `src/agents/agent-manager.test.ts` warm block (queue anchor through `spawnTurn` recursion and `openGate`); `src/channels/voice/voice-adapter.integration.test.ts` (cold payload stamps from a fake spawn's `stageTimings`); `src/channels/voice/voice-startup.integration.test.ts` (warm payload stamps through the real lease; R5 rows V1/V2-ordering/V4/V8/V9 green before and after).
  - Reason: `queueWaitMs` is measured across the manager's pending-opening wait, which only the real manager exercises; the adapter's `measure(...)` mapping is only proved on the real HTTP path.
  - Harness: `existing` (see parent plan Harness Requirements).
  - Minimum assertions: queued-behind-pending-opening `queueWaitMs === 700` under a controlled `Date.now` where the joiner's first entry is 700 ms before its consume start and its re-entry only 400 ms before (an un-threaded anchor measures 400 and fails); cold `engine_attempt_terminal.bootToInitMs.value === 741` when the fake spawn returns `stageTimings.bootToInitMs: 741` and the "Voice turn complete" log call carries `bootToInitMs: 741`; cold `queueWaitMs` is `{value: null, reason: "not_applicable"}` and the cold "Voice turn complete" row has no `queueWaitMs` property; a warm "Voice turn complete" row carries a numeric `queueWaitMs` (spec §3.2 bullet 1 names that row); warm turn 2 `bootToInitMs` is `{value: null, reason: "not_applicable"}`; a failed attempt **and** a cancelled (aborted-result) attempt both report `{value: null, reason: "not_observed"}` for the two new measures; cold `stageTimings` object deep-equals `{ lockWaitMs, spawnPrepMs, bootToInitMs, initToFirstTokenMs }` with no extra key; warm attempt rows in the startup suite are selected by `outcome === "completed"` + `selectedContinuity` (`"fresh"` for the opener, `"warm"` for turn 2), never by array index.
- E2E: `not-required` for this chunk (the offline bench E2E lives in chunk D and consumes these fields; live rows live in chunk E).

### Critical Flows

- Opener turn: entry → open call (queue) → init (boot) → first delta (model), three disjoint intervals.
- Joiner turn (V9): entry → `waitForVoiceOpening` → recursion → `runWarmTurn` → consume start, one `queueWaitMs`.
- Cancelled-opener survivor (KPR-464 V4 shape): the opener's `runTurn` throws before `consumeOneTurn` ever increments `turnCount`, so the survivor is `ownedTurn === 1`; it is measured as a joiner when its entry postdates the open call (no boot stage — the adapter reports `not_observed` on turn 1) and as the opener when its entry predates it.
- Cold turn: unchanged `stageTimings`; new payload keys derived from the same values.

### Regression Surface

- `WarmVoiceSession` close/interrupt/watchdog/tool-ack paths — untouched.
- `TurnResult.stageTimings` cold shape — byte-identical (asserted).
- Reader: every existing fixture's report unchanged except the additive `latency` detail added by chunk B (not this chunk).

### Commands

- Unit: `npx vitest run src/agents/warm-voice-session.test.ts src/voice/voice-diagnostic-reader.test.ts src/voice/voice-trace.test.ts`
- Integration: `npx vitest run src/agents/agent-manager.test.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts`
- Broader: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- `makeFakeQuery` (warm-voice-session.test.ts) is driven by the test; emit `init` only after the test observes the push where the case needs a real boot interval. Clock control is `vi.useFakeTimers({ now })` + `vi.setSystemTime(...)` — `useFakeTimers` fakes `Date` by default (everything except `nextTick`/`queueMicrotask`), so `setSystemTime` is what `Date.now()` reads; this file has never used `setSystemTime` before, the KPR-465 block is its first user. Microtask draining uses the file's existing `microFlush()` idiom (line 112 — pure `Promise.resolve()` rounds, works under fake timers), never ad hoc `advanceTimersByTimeAsync(0)` calls. **Sequencing fact the opener cases are built on:** `runTurn` chains `consumeOneTurn` behind `await this.ready` as microtasks, so nothing runs between consecutive synchronous statements — consume start reads whatever `Date.now()` says at the test's first `await` after `start()`. A case that calls `start()` and then drains without advancing the clock puts consume start *at* `openCalledAt`, where "queue ends at the open call" and "queue ends at consume start" are the same number and the case proves nothing (caught by plan-review round 2); every opener-shaped case therefore advances the clock one step between `start()` and its first drain.
- Manager warm tests use `installEchoStreamingRunner({ openGate })` to hold the opening. Because the echo runner awaits `openGate` *inside* `mockRunnerOpenStream` (test line ~7074) — i.e. after the manager's `openCalledAt` anchor — the gate hold lands in the opener's **boot** stage and in the joiner's **queue** stage. The V9 case controls the clock with `vi.spyOn(Date, "now")` over a mutable `now` (not fake timers): the surrounding warm block synchronizes with real-timer `vi.waitFor`, which under fake timers advances the fake clock by its poll interval on every check and would blur the 300 ms window that separates a threaded anchor (700) from an un-threaded one (400). The spy freezes `Date.now` between the test's explicit steps; `vi.waitFor` is unaffected by it — it arms a real `setTimeout` (default 1 000 ms) and a real polling `setInterval` through `getSafeTimers()`, not a `Date.now()`-based deadline — so a `vi.waitFor` whose predicate never becomes true fails by its own 1 s timeout (`Timed out in waitFor!`), and can only fail, never pass falsely, under the spy. (Under *fake* timers, by contrast, every poll calls `vi.advanceTimersByTime(interval)` — that is the fake-clock blur that rules fake timers out for this case.) Restore the spy in `finally` so the block's `afterEach` lease cleanup sees a real clock.
- This worktree (`hive-kpr465-mature`) has no `node_modules` yet; every command in the Commands section assumes `npm ci` has already run there (the lockfile pins vitest 5.0.0).

### Non-Required Rationale

- E2E: consumed by chunk D's bench test and chunk E's live rows; nothing E2E-shaped is unique to this chunk.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- The one deliberate re-pin in this chunk is `agent-manager.test.ts` line 7604 (`expect(r1.stageTimings).toEqual({ lockWaitMs: 0, spawnPrepMs: 0, initToFirstTokenMs: expect.any(Number) })`) — it gains `queueWaitMs` and turn-1 `bootToInitMs`; re-pin in Task A2's commit and record the negative-verify (revert A1+A2, confirm it fails).
- Three negative-verifies are owed, each recorded in the delivery notes: A1 Step 5 (opener queue end — the opener case fails 300 ≠ 400 **and** the early-joiner case 250 ≠ 350; a negative-verify that cannot fail is not a negative-verify), A2 Step 6a (the `runWarmTurn` spread — the re-pin fails) and A2 Step 6b (the recursion anchor — revert the recursive call to the two-argument `this.spawnTurn(ctx, onStream)` and the V9 case fails on 400 ≠ 700).
- Task order is A1 → A2 → A3 (reader) → A4 (emission) → A5: the reader accepts the two keys before any commit emits them.
- The pre-existing stage measures (`lockWaitMs`, `spawnPrepMs`, `initToFirstTokenMs`) stay **outcome-blind** on the payload exactly as today (real values on a cancelled attempt); only the two new measures carry the `outcome !== "completed"` guard. Do not "harmonize" the old three in this chunk — that is a behavior change outside §3.2.

---

### Task A1: Lease anchors and the three warm stage measures

**Files:**
- Modify: `src/agents/warm-voice-session.ts:91-110` (`WarmTurnRequest`, `WarmRunResult`), `:195-225` (`start`), `:412-470` and `:496-531` and `:736-768` (`consumeOneTurn`)
- Test: `src/agents/warm-voice-session.test.ts`

- [ ] **Step 1: Extend the request/result contracts.**

Replace the `WarmTurnRequest` and `WarmRunResult` declarations (lines 91–110) with:

```typescript
export interface WarmTurnRequest {
  /** Turn text — the adapter-shaped prompt (prepareSpawn's voice carve-out is a passthrough). */
  text: string;
  onStream?: StreamCallback;
  /** Per-turn watchdog, mapping the cold path's deadline (agent timeoutMs, default 300s). */
  timeoutMs: number;
  /** Per-request voice cancellation. Ephemeral and never serialized. */
  voiceRequestSignal?: AbortSignal;
  selectText?: (admission: WarmInputAdmission) => string;
  /**
   * KPR-465 §3.2: wall-clock (Date.now()) at spawnTurn's warm-branch entry.
   * The queue stage is measured from here to consume start (turns ≥ 2, and a
   * turn-1 survivor of a cancelled opener whose entry postdates the open
   * call) or to the openVoiceStreamingSession call (the opener: turn 1 with
   * enqueuedAt ≤ openCalledAt), so it folds in the pending-opening wait (V9)
   * and the lease's turnChain wait, and never overlaps the boot stage. Raw
   * delta — the adapter's measure() classifies a negative. Optional only for
   * out-of-manager callers (tests); the manager always passes it, and without
   * it the lease also reports no bootToInitMs (fail-closed: it cannot tell the
   * opener from a survivor).
   */
  enqueuedAt?: number;
}

export interface WarmInputAdmission {
  continuity: "fresh" | "resume" | "warm";
  turnSeq: number;
  launchSessionId?: string;
}

export interface WarmRunResult extends RunResult {
  readonly voiceLifetimeSignal: AbortSignal;
  /**
   * KPR-465 §3.2: lock/queue stage for this warm turn (see WarmTurnRequest.
   * enqueuedAt). Always a number when enqueuedAt was supplied — the RAW
   * delta, possibly negative under clock skew, never clamped (canon R2; the
   * adapter's measure() turns a negative into {value: null, reason}) —
   * undefined when it was not (then the adapter reports not_observed).
   */
  queueWaitMs?: number;
  // bootToInitMs (inherited from RunResult) is set on the OPENER turn only —
  // turn 1 whose enqueuedAt ≤ the recorded openCalledAt: openVoiceStreamingSession
  // call → the system/init message observed by this loop, raw delta. Turns
  // ≥ 2 leave it undefined (the adapter reports not_applicable); a turn-1
  // survivor of a cancelled opener that entered after the open call also
  // leaves it undefined (the adapter reports not_observed on turn 1).
  // initToFirstTokenMs on the opener is init → first delta; on every other
  // turn it stays push → first delta (KPR-323 C2, unchanged).
}
```

- [ ] **Step 2: Record the open-call anchor in `start()`.**

Add a private field beside `resumedSessionId` (line ~157):

```typescript
  private resumedSessionId: string | undefined;
  /** KPR-465: Date.now() immediately before the manager's openVoiceStreamingSession call. */
  private openCalledAt: number | undefined;
```

Change the `start` signature and body (line 195 / 211–213):

```typescript
  start(query: Query, options: { resumedSessionId?: string; openCalledAt?: number } = {}): void {
    // ... unchanged closed-guard block ...
    this.query = query;
    this.resumedSessionId = options.resumedSessionId;
    this.openCalledAt = options.openCalledAt;
    this.markReady();
    // ... unchanged timers ...
  }
```

- [ ] **Step 3: Measure at consume start, at init, and at first delta.**

In `consumeOneTurn`, immediately after `this.turnCount += 1; const ownedTurn = this.turnCount;` (line ~430) insert:

```typescript
    // KPR-465 §3.2: queue stage. The OPENER is turn 1 whose request entered
    // the manager no later than the open call (enqueuedAt ≤ openCalledAt):
    // its queue stage ends at the open call, exactly where bootToInitMs
    // begins (deliberate refinement of §3.2's "to consume start" — consume
    // start is after boot on the opener, so the stages would overlap).
    // A cancelled opener never increments turnCount (runTurn throws before
    // consumeOneTurn — KPR-464 V4, test line 829), so a later survivor is
    // ALSO ownedTurn === 1 with a stale openCalledAt; the ≤ gate fails for it
    // (its entry postdates the open call) and it is measured as a joiner:
    // entry → consume start, no boot stage. A survivor that queued before the
    // open call passes the gate — it genuinely waited through boot. Missing
    // enqueuedAt ⇒ no opener anchor either (fail-closed; tests only).
    // Raw deltas, never clamped: voice-trace's measure() classifies a
    // negative as {value: null, reason} (canon R2, never zero-coerced).
    const consumeStartedAt = Date.now();
    const openAnchor =
      ownedTurn === 1 &&
      req.enqueuedAt !== undefined &&
      this.openCalledAt !== undefined &&
      req.enqueuedAt <= this.openCalledAt
        ? this.openCalledAt
        : undefined;
    const queueEndAt = openAnchor ?? consumeStartedAt;
    const queueWaitMs = req.enqueuedAt === undefined ? undefined : queueEndAt - req.enqueuedAt;
```

Beside `let initToFirstTokenMs: number | undefined;` (line ~465) add:

```typescript
    let initAt: number | undefined;
    let bootToInitMs: number | undefined;
```

Replace the `system`/`init` branch body (lines 517–518):

```typescript
            if (sub === "init") {
              sessionId = (msg as unknown as { session_id: string }).session_id;
              // KPR-465 §3.2: opener turn only (openAnchor gate above) —
              // open call → init observed here. Raw delta, never clamped.
              if (openAnchor !== undefined && bootToInitMs === undefined) {
                initAt = Date.now();
                bootToInitMs = initAt - openAnchor;
              }
            }
```

Replace the first-delta line (line 531):

```typescript
              // KPR-465 §3.2: opener re-based to init → first delta once boot
              // is measured separately; turns ≥ 2 stay push → first delta.
              if (initToFirstTokenMs === undefined) initToFirstTokenMs = Date.now() - (initAt ?? pushedAt);
```

Add both fields to the returned object (after `initToFirstTokenMs,` at line ~767):

```typescript
      initToFirstTokenMs, // KPR-323 C1 field reuse: warm turns ≥ 2 measure push → first delta; opener init → first delta (KPR-465)
      ...(bootToInitMs !== undefined ? { bootToInitMs } : {}),
      ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
```

- [ ] **Step 4: Unit tests (R2 rows 1–4).**

Append to `src/agents/warm-voice-session.test.ts` a `describe("KPR-465 stage anchors", ...)` block:

```typescript
describe("KPR-465 stage anchors", () => {
  afterEach(() => vi.useRealTimers());

  function openLease(opts: { openCalledAt?: number } = {}) {
    const fq = makeFakeQuery();
    const lease = new WarmVoiceSession({ agentId: "a", threadKey: "a:t", onClosed: () => {} });
    lease.start(fq.q, { resumedSessionId: undefined, ...opts });
    return { fq, lease };
  }

  it("opener: queueWaitMs ends at the open call, bootToInitMs spans open → init, initToFirstTokenMs spans init → first delta", async () => {
    // Sequencing IS the assertion here: consume start must land strictly
    // AFTER the open call, otherwise "queue ends at the open call" (the
    // refinement) and "queue ends at consume start" (the spec-literal
    // reading) give the same number and the case discriminates nothing.
    // runTurn chains consumeOneTurn behind `await this.ready` as microtasks,
    // so nothing runs between the synchronous statements below — consume
    // start reads Date.now() at the first await after start().
    vi.useFakeTimers({ now: 1_000 });
    const fq = makeFakeQuery();
    const lease = new WarmVoiceSession({ agentId: "a", threadKey: "a:t", onClosed: () => {} });
    const turn = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: 1_000 }); // entered the manager at 1_000, before the open call
    vi.setSystemTime(1_300); // 300 ms of pre-open wait (runner build, shaping)
    lease.start(fq.q, { openCalledAt: 1_300 });
    vi.setSystemTime(1_400); // the ready → consume hop: consume start lands here, one step AFTER the open call
    await microFlush(); // consume start at 1_400
    vi.setSystemTime(1_950); // CLI boot: 650 ms after the open call
    fq.emit(initMsg("s1"));
    await microFlush();
    vi.setSystemTime(3_250); // model: 1 300 ms after init
    fq.emit(delta("hi"));
    fq.emit(resultMsg({ result: "hi", session_id: "s1" }));
    const r = await turn;
    expect(r.queueWaitMs).toBe(300); // entry 1_000 → open call 1_300 — NOT → consume start 1_400 (400, the un-refined reading)
    expect(r.bootToInitMs).toBe(650);
    expect(r.initToFirstTokenMs).toBe(1_300);
    lease.close("test-cleanup");
  });

  it("turn ≥ 2 queued behind an in-flight turn: queueWaitMs spans entry → consume start; bootToInitMs undefined; initToFirstTokenMs is push → delta", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fq, lease } = openLease({ openCalledAt: 0 });
    fq.emit(initMsg("s1"));
    const t1 = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: 0 });
    await microFlush();
    vi.setSystemTime(100);
    const t2 = lease.runTurn({ text: "t2", timeoutMs: 5_000, enqueuedAt: 100 }); // queued behind t1
    vi.setSystemTime(900);
    fq.emit(delta("a"));
    fq.emit(resultMsg({ result: "a", session_id: "s1" }));
    await t1;
    await microFlush(); // t2 consume start at 900
    vi.setSystemTime(1_400);
    fq.emit(delta("b"));
    fq.emit(resultMsg({ result: "b", session_id: "s1" }));
    const r2 = await t2;
    expect(r2.queueWaitMs).toBe(800);
    expect(r2.bootToInitMs).toBeUndefined();
    expect(r2.initToFirstTokenMs).toBe(500);
    lease.close("test-cleanup");
  });

  it("opener without an open anchor: bootToInitMs undefined, initToFirstTokenMs falls back to push → delta, queueWaitMs still measured to consume start", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fq, lease } = openLease();
    const t1 = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: 0 });
    await microFlush();
    vi.setSystemTime(50);
    fq.emit(initMsg("s1"));
    await microFlush();
    vi.setSystemTime(250);
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t1;
    expect(r.bootToInitMs).toBeUndefined();
    expect(r.initToFirstTokenMs).toBe(250);
    expect(r.queueWaitMs).toBe(0);
    lease.close("test-cleanup");
  });

  it("no enqueuedAt ⇒ queueWaitMs AND bootToInitMs undefined (fail-closed: an out-of-manager caller gives the lease no way to tell the opener from a survivor)", async () => {
    const { fq, lease } = openLease({ openCalledAt: Date.now() });
    fq.emit(initMsg("s1"));
    const t = lease.runTurn({ text: "t", timeoutMs: 5_000 });
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t;
    expect(r.queueWaitMs).toBeUndefined();
    expect(r.bootToInitMs).toBeUndefined();
    expect(typeof r.initToFirstTokenMs).toBe("number"); // push → delta fallback, unchanged
    lease.close("test-cleanup");
  });

  it("failed turn (output ends before result) still reports queueWaitMs and leaves bootToInitMs undefined on turn ≥ 2", async () => {
    const { fq, lease } = openLease({ openCalledAt: Date.now() });
    fq.emit(initMsg("s1"));
    const t1 = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: Date.now() });
    fq.emit(resultMsg({ result: "ok", session_id: "s1" }));
    await t1;
    const t2 = lease.runTurn({ text: "t2", timeoutMs: 5_000, enqueuedAt: Date.now() });
    fq.endOutput();
    const r2 = await t2;
    expect(r2.error).toMatch(/output ended before turn result/);
    expect(typeof r2.queueWaitMs).toBe("number");
    expect(r2.bootToInitMs).toBeUndefined();
    lease.close("test-cleanup");
  });

  // R2 row 7 — the KPR-464 V4 shape (this file, line 829): a cancelled opener
  // rejects in runTurn before consumeOneTurn ever increments turnCount, so the
  // survivor is ALSO ownedTurn === 1 with openCalledAt already recorded.
  it("cancelled-opener survivor that entered AFTER the open call is measured as a joiner: queueWaitMs = entry → consume start, no bootToInitMs", async () => {
    vi.useFakeTimers({ now: 0 });
    const fq = makeFakeQuery();
    const lease = new WarmVoiceSession({ agentId: "a", threadKey: "a:t", onClosed: () => {} });
    const opener = new AbortController();
    const a = lease.runTurn({ text: "dead opener", timeoutMs: 5_000, voiceRequestSignal: opener.signal, enqueuedAt: 0 });
    void a.catch(() => {});
    vi.setSystemTime(100);
    lease.start(fq.q, { openCalledAt: 100 }); // the manager's open call at 100
    opener.abort();
    await expect(a).rejects.toBeInstanceOf(VoiceRequestCancelledError);
    expect(lease.turns).toBe(0); // premise: the cancelled opener never consumed
    vi.setSystemTime(2_000); // lease sat idle 1.9 s
    const b = lease.runTurn({ text: "survivor", timeoutMs: 5_000, enqueuedAt: 2_000 });
    await microFlush(); // survivor consume start at 2_000
    vi.setSystemTime(2_050);
    fq.emit(initMsg("s1")); // init still unconsumed on the stream — observed by the survivor, but NOT measured
    await microFlush();
    vi.setSystemTime(2_400);
    fq.emit(delta("ok"));
    fq.emit(resultMsg({ result: "ok", session_id: "s1" }));
    const r = await b;
    expect(lease.turns).toBe(1); // survivor IS ownedTurn === 1
    expect(r.queueWaitMs).toBe(0); // entry 2_000 → consume start 2_000, NOT 2_000 − 100 = 1_900 (clamped-to-open-call fabrication)
    expect(r.bootToInitMs).toBeUndefined(); // not open(100) → init(2_050) = 1_950 (idle time, not boot)
    expect(r.initToFirstTokenMs).toBe(400); // push → delta fallback
    lease.close("test-cleanup");
  });

  it("cancelled-opener survivor that queued BEFORE the open call honestly measures as the opener", async () => {
    vi.useFakeTimers({ now: 0 });
    const fq = makeFakeQuery();
    const lease = new WarmVoiceSession({ agentId: "a", threadKey: "a:t", onClosed: () => {} });
    const opener = new AbortController();
    const a = lease.runTurn({ text: "dead opener", timeoutMs: 5_000, voiceRequestSignal: opener.signal, enqueuedAt: 0 });
    void a.catch(() => {});
    vi.setSystemTime(50);
    const b = lease.runTurn({ text: "early joiner", timeoutMs: 5_000, enqueuedAt: 50 }); // queued while the opening is pending
    vi.setSystemTime(300);
    lease.start(fq.q, { openCalledAt: 300 });
    opener.abort();
    // Same sequencing discipline as the opener case: b's consume start must
    // land AFTER the open call so the two queue-end readings diverge
    // (250 vs 350). The advance goes BEFORE the `rejects` await — that await
    // is the drain in which a rejects and b's consumeOneTurn starts.
    vi.setSystemTime(400);
    await expect(a).rejects.toBeInstanceOf(VoiceRequestCancelledError);
    await microFlush(); // b consume start (after ready) at 400
    expect(lease.turns).toBe(1); // b consumed; the cancelled opener never did
    vi.setSystemTime(900);
    fq.emit(initMsg("s1"));
    await microFlush();
    vi.setSystemTime(1_000);
    fq.emit(delta("ok"));
    fq.emit(resultMsg({ result: "ok", session_id: "s1" }));
    const r = await b;
    expect(r.queueWaitMs).toBe(250); // entry 50 → open call 300 — NOT → consume start 400 (350, the un-refined reading)
    expect(r.bootToInitMs).toBe(600); // open 300 → init 900: it really waited through boot
    expect(r.initToFirstTokenMs).toBe(100);
    lease.close("test-cleanup");
  });

  // R2 row 8 — canon "never zero-coerced": a negative delta is returned raw;
  // voice-trace's measure() (line 55) classifies it as {value: null, reason}.
  it("reports a negative queue delta raw (clock skew), never clamped to 0", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fq, lease } = openLease({ openCalledAt: 0 });
    fq.emit(initMsg("s1"));
    const t = lease.runTurn({ text: "t", timeoutMs: 5_000, enqueuedAt: 5_000 }); // "entered" 5 s in the future
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t;
    expect(r.queueWaitMs).toBe(-5_000);
    expect(measure(r.queueWaitMs, "not_observed")).toEqual({ value: null, reason: "not_observed" });
    lease.close("test-cleanup");
  });

  // R7 at runtime: the request transcript never rides the stage-carrying
  // result. (Type-level R7 — `Measure.value: number | null` on `EnginePayload` — lands in Task A4 Step 1; this is the observed property.)
  it("the stage fields never carry request bytes", async () => {
    const { fq, lease } = openLease({ openCalledAt: Date.now() });
    fq.emit(initMsg("s1"));
    const t = lease.runTurn({ text: "SENTINEL-TRANSCRIPT-465 +15555550100", timeoutMs: 5_000, enqueuedAt: Date.now() });
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t;
    const stages = JSON.stringify({ q: r.queueWaitMs, b: r.bootToInitMs, i: r.initToFirstTokenMs });
    expect(stages).not.toContain("SENTINEL");
    expect(stages).not.toContain("+1555");
    lease.close("test-cleanup");
  });
});
```

(Every case ends with `lease.close("test-cleanup")`, matching the file's existing hygiene — harmless without it (unref'd timers only), kept for consistency. `initMsg`, `delta`, `resultMsg`, `makeFakeQuery`, `microFlush` already exist at the top of the file; `VoiceRequestCancelledError` is already imported there (line 829's case uses it). Add `import { measure } from "../voice/voice-trace.js"` for the skew case — a pure function, no mock interaction.)

- [ ] **Step 5: Verify.**

Run: `npx vitest run src/agents/warm-voice-session.test.ts`
Expected: all existing cases pass (line 829's cancelled-opener case in particular — the gate must not change its admissions or pushes); the nine new cases pass. Negative-verify (record in the delivery notes): (a) temporarily set `queueEndAt = consumeStartedAt` unconditionally (the un-refined, spec-literal reading) — the opener case fails on `queueWaitMs` (expects 300, gets 400 = consume start 1 400 − entry 1 000) **and** the early-joiner case fails (expects 250, gets 350 = 400 − 50); if either still passes, the case's clock was not advanced between `start()` and its first drain and the case is not discriminating — fix the test, not the expectation; (b) temporarily drop the `req.enqueuedAt <= this.openCalledAt` clause from `openAnchor` — the late-survivor case fails on both `queueWaitMs` (expects 0, gets 100 − 2 000 = −1 900) and `bootToInitMs` (expects undefined, gets 2 050 − 100 = 1 950); (c) temporarily wrap `queueWaitMs` in `Math.max(0, …)` — the skew case fails (expects −5 000, gets 0). Restore after each.

- [ ] **Step 6: Commit.**

```bash
git add src/agents/warm-voice-session.ts src/agents/warm-voice-session.test.ts
git commit -m "feat(voice): measure warm queue wait and opener boot-to-init on the lease (KPR-465)"
```

### Task A2: Thread the anchors through the manager

**Files:**
- Modify: `src/agents/agent-manager.ts:196-250` (`TurnResult.stageTimings`), `:1365-1395` (`spawnTurn` warm branch), `:1803-1821` (`openWarmLease`), `:1823-2005` (`openWarmLeaseAttempt`), `:2041-2130` (`runWarmTurn`)
- Test: `src/agents/agent-manager.test.ts` (warm block, ~7028–8050)

- [ ] **Step 1: Widen `TurnResult.stageTimings`.**

```typescript
  stageTimings?: {
    lockWaitMs: number;
    spawnPrepMs: number;
    bootToInitMs?: number;
    initToFirstTokenMs?: number;
    /** KPR-465 §3.2: warm turns only — spawnTurn warm-branch entry → consume start (opener: → open call). */
    queueWaitMs?: number;
  };
```

- [ ] **Step 2: Anchor the warm branch and carry it through the recursion.**

(Considered and not taken: moving the recursion onto a private re-entry method so `spawnTurn`'s public signature stays two-argument. The re-entry must re-run the whole prologue — `checkVoiceRequest`, `ensureState`, registry/stopped checks, the lease-vs-pending-vs-eligible triage — so a private method would be `spawnTurn` minus the anchor line; a documented optional third parameter that adapters never pass is the smaller change. Revisit only if a second internal parameter ever appears.)

Change the `spawnTurn` signature and warm block (lines 1365–1395):

```typescript
  async spawnTurn(
    ctx: TurnContext,
    onStream?: SpawnTurnStreamCallback,
    /**
     * KPR-465 §3.2: INTERNAL. The original warm-branch entry time, carried
     * across the pending-opening recursion below so a joiner's queueWaitMs
     * spans its first entry, not its re-entry. Adapters never pass it.
     */
    warmEnteredAt?: number,
  ): Promise<TurnResult> {
    checkVoiceRequest(ctx.voiceRequestSignal);
    this.ensureState(ctx.agentId);

    if (!this.registry.get(ctx.agentId)) {
      throw new Error(`Unknown agent: ${ctx.agentId}`);
    }
    if (this.stoppedAgents.has(ctx.agentId)) {
      throw new AgentStoppedError(ctx.agentId);
    }

    const enteredAt = Date.now(); // KPR-323 C1: T1 anchor (admission start)
    const queueAnchor = warmEnteredAt ?? enteredAt; // KPR-465: warm queue anchor

    if (this.isWarmVoiceTurn(ctx)) {
      const threadKey = `${ctx.agentId}:${ctx.threadId}`;
      const lease = this.warmLeases.get(threadKey);
      if (lease && !lease.isClosed) {
        return this.runWarmTurn(lease, ctx, onStream, queueAnchor);
      }
      const pending = this.pendingWarmOpenings.get(threadKey);
      if (pending) {
        await waitForVoiceOpening(pending, ctx.voiceRequestSignal);
        return this.spawnTurn(ctx, onStream, queueAnchor);
      }
      if (this.isWarmPathEligible(ctx)) return this.openWarmLease(ctx, onStream, queueAnchor);
    }
    // ... cold path unchanged; `enteredAt` still feeds lockWaitMs ...
```

- [ ] **Step 3: Thread through the opener.**

`openWarmLease(ctx, onStream, queueAnchor: number)` passes it to `openWarmLeaseAttempt(ctx, onStream, published, queueAnchor)`. Inside `openWarmLeaseAttempt`:

- the opening-ineligible fallback stays `return this.spawnTurn(ctx, onStream);` (cold — no anchor);
- `openingTurn = this.runWarmTurn(pinnedLease, ctx, onStream, queueAnchor);`
- immediately before the runner open call:

```typescript
      checkOpeningLifetime();
      const openCalledAt = Date.now(); // KPR-465 §3.2: boot stage anchor
      const q = await runner.openVoiceStreamingSession({
        input: lease.inputQueue,
        sessionId: openingCtx.sessionId,
        context: { /* unchanged */ },
        systemPromptOverride: ctx.systemPromptOverride ?? "",
      });
      lease.start(q, { resumedSessionId: openingCtx.sessionId, openCalledAt });
```

- [ ] **Step 4: `runWarmTurn` passes the anchor and surfaces the stages.**

Signature: `private async runWarmTurn(lease: WarmVoiceLease, ctx: TurnContext, onStream: SpawnTurnStreamCallback | undefined, queueAnchor: number): Promise<TurnResult>`. In the `lease.runTurn({...})` literal add `enqueuedAt: queueAnchor,`. Replace the `turnResult.stageTimings = {...}` literal (lines 2116–2120):

```typescript
    // C1 on warm turns: lock/spawn stages do not exist (zeros by definition);
    // KPR-465 adds the queue stage and, on the opener only, the boot stage.
    turnResult.stageTimings = {
      lockWaitMs: 0,
      spawnPrepMs: 0,
      ...(runResult.queueWaitMs !== undefined ? { queueWaitMs: runResult.queueWaitMs } : {}),
      ...(runResult.bootToInitMs !== undefined ? { bootToInitMs: runResult.bootToInitMs } : {}),
      initToFirstTokenMs: runResult.initToFirstTokenMs,
    };
```

- [ ] **Step 5: Re-pin and add manager tests.**

In `src/agents/agent-manager.test.ts` at line ~7604 replace the pin with:

```typescript
      expect(r1.stageTimings).toEqual({
        lockWaitMs: 0,
        spawnPrepMs: 0,
        queueWaitMs: expect.any(Number),
        bootToInitMs: expect.any(Number), // KPR-465: opener carries the boot stage
        initToFirstTokenMs: expect.any(Number),
      });
```

and after the `r2` assertions add `expect(r2.stageTimings).toEqual({ lockWaitMs: 0, spawnPrepMs: 0, queueWaitMs: expect.any(Number), initToFirstTokenMs: expect.any(Number) });` (no `bootToInitMs` on turn 2).

Add inside the warm `describe` a case for the pending-opening queue (V9 shape). **Timing facts this test is built on (verified at HEAD `ff646ac4`):** `openWarmLease` registers `pendingWarmOpenings` synchronously (line 1809, before its first await), so a `t2` issued synchronously right after `t1` sees the pending opening and takes the `waitForVoiceOpening → this.spawnTurn(ctx, onStream, queueAnchor)` recursion — the path under test. `published()` (line 1950) fires **before** the open call (1979), so after any drain the pending map is already empty (the existing case at line 7173 pins `size === 0`) — a `t2` issued after a drain would take the `lease && !lease.isClosed` branch and never exercise the recursion. The echo runner awaits `openGate` inside `mockRunnerOpenStream` (line ~7074), i.e. after the manager's `openCalledAt` anchor, so the gate hold lands in the opener's **boot** stage and the joiner's **queue** stage. Clock control is a `Date.now` spy, not fake timers (see Harness Requirements): with `now` = 10 000 at issue, 10 300 at publication/re-entry, 10 700 at release, a threaded anchor measures 700 and an un-threaded one 400.

```typescript
    it("KPR-465: a request queued behind a pending opening reports queueWaitMs spanning its FIRST warm-branch entry", async () => {
      let now = 10_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        let openGateResolve!: () => void;
        const openGate = new Promise<void>((r) => (openGateResolve = r));
        installEchoStreamingRunner({ openGate });
        // Back-to-back, synchronously: t2 must observe the pending opening
        // (registered before openWarmLease's first await) to take the
        // recursion path. Do NOT drain between these two lines.
        const t1 = manager.spawnTurn(makeVoiceCtx({ sessionId: undefined }));
        const t2 = manager.spawnTurn(makeVoiceCtx({ sessionId: undefined })); // joiner, first entry at 10_000
        void t1.catch(() => {});
        void t2.catch(() => {});
        expect(pendingWarmOpenings(manager).size).toBe(1);
        now = 10_300; // publication + t2's re-entry + the open call all land here
        await vi.waitFor(() => expect(mockRunnerOpenStream).toHaveBeenCalledTimes(1));
        expect(pendingWarmOpenings(manager).size).toBe(0);
        now = 10_700; // the opening was held 400 ms past the open call
        openGateResolve();
        const r1 = await t1;
        const r2 = await t2;
        expect(r1.warmTurnSeq).toBe(1);
        expect(r2.warmTurnSeq).toBe(2);
        // Opener: entry 10_000 → open call 10_300 (queue), open call → init at 10_700 (boot), init → delta both at 10_700.
        expect(r1.stageTimings).toEqual({ lockWaitMs: 0, spawnPrepMs: 0, queueWaitMs: 300, bootToInitMs: 400, initToFirstTokenMs: 0 });
        // Joiner: FIRST entry 10_000 → consume start 10_700. An un-threaded
        // anchor (re-entry at 10_300) measures 400 and fails here.
        expect(r2.stageTimings).toEqual({ lockWaitMs: 0, spawnPrepMs: 0, queueWaitMs: 700, initToFirstTokenMs: 0 });
      } finally {
        nowSpy.mockRestore();
      }
    });
```

Also assert cold immutability in the existing `spawnTurn C1 stageTimings (KPR-323)` block (line 804). `makeCtx` is **not** in scope there — it is a local of the `describe` at line 4803; use the top-level `makeVoiceCtx` (line 396), exactly as the sibling cases at 806–842 do, with their `mockConversationIndex.mockResolvedValue(undefined)` setup:

```typescript
    it("KPR-465: cold stageTimings carry no queueWaitMs key (byte-identical cold shape)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ bootToInitMs: 741, initToFirstTokenMs: 1263 }));
      const result = await manager.spawnTurn(makeVoiceCtx({ agentId: "agent-a" }));
      expect(Object.keys(result.stageTimings!).sort()).toEqual(["bootToInitMs", "initToFirstTokenMs", "lockWaitMs", "spawnPrepMs"]);
    });
```

(`makeRunResult` is top-level at line 320; the warm-path flag is off in this block, so the ctx takes the cold path exactly like its siblings.)

- [ ] **Step 6: Verify.**

Run: `npx vitest run src/agents/agent-manager.test.ts -t "warm voice lease|stageTimings|KPR-465"`
Expected: pass. Then the full file: `npx vitest run src/agents/agent-manager.test.ts` — pass, no other pin moved. Two negative-verifies, both recorded in the delivery notes: (6a) revert Step 4's `queueWaitMs` spread → the re-pinned line-7604 assertion fails; restore. (6b) revert only Step 2's recursive call to the two-argument form `this.spawnTurn(ctx, onStream)` (leave everything else in place) → the V9 case fails with `queueWaitMs: 400` against the expected 700, proving the assertion discriminates a threaded anchor from an un-threaded one; restore.

- [ ] **Step 7: Commit.**

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "feat(voice): thread the warm queue anchor and opener boot anchor through the manager (KPR-465)"
```

### Task A3: Reader allowlist + validation for the two measures; ⚠ version-bump decision

**Files:**
- Modify: `src/voice/voice-diagnostic-reader.ts:263-296` (`PAYLOAD_FIELDS.engine_attempt_terminal`, `.engine_terminal`), `:956-975` (`validatePayload` measure list)
- Test: `src/voice/voice-diagnostic-reader.test.ts`, `src/voice/voice-trace.test.ts`

(Sequenced before Task A4 so the reader accepts `bootToInitMs`/`queueWaitMs` before any commit emits them — no intermediate commit produces rows the reader would reject. Nothing at HEAD parses engine rows against the reader in the emission suites, so this is ordering hygiene, not a live breakage.)

- [ ] **Step 1: Allowlist.**

Add `"bootToInitMs", "queueWaitMs"` to both `engine_attempt_terminal` and `engine_terminal` arrays in `PAYLOAD_FIELDS`, and add `"bootToInitMs", "queueWaitMs"` to the `validMeasure` field loop in `validatePayload`.

- [ ] **Step 2: Version decision (spec §3.2 ⚠).**

Record in the commit message and in the evidence record (chunk E): the keys are optional additions under `schemaVersion: 2`; KPR-464-era rows parse unchanged; the comparison reader (chunk B) treats absent keys as `not_observed` for stage tables. A version bump is **not taken**: no existing key changes meaning, and a bump would force the compare mode to refuse pooling across versions for rows that are semantically identical. If plan review prefers the bump, the change is confined to `VOICE_TRACE_VERSION`, `parseVoiceDiagnosticJsonl`'s version check (accept 2 and 3), and chunk B's per-arm version gate — call it out as a review finding, do not pre-build it.

- [ ] **Step 3: Tests.**

`src/voice/voice-diagnostic-reader.test.ts`:

```typescript
describe("KPR-465 additive engine measures", () => {
  const base = {
    kind: "voice_diagnostic", schemaVersion: 2, eventId: "e1", event: "engine_attempt_terminal",
    ts: "2026-09-11T00:00:00.000Z", component: "voice-engine", clockId: "c", monoMs: 1, callId: "k",
    workerBootId: "11111111-1111-4111-8111-111111111111", speechId: null, turnId: "t1", synthesisId: null,
    engineAttemptSeq: 1, outcome: "completed",
  };
  it("accepts bootToInitMs/queueWaitMs measures on attempt and request terminals", () => {
    expect(parseVoiceDiagnosticEvent({ ...base, bootToInitMs: { value: 650, reason: null }, queueWaitMs: { value: null, reason: "not_applicable" } })).not.toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, event: "engine_terminal", engineAttemptSeq: null, queueWaitMs: { value: 12, reason: null } })).not.toBeNull();
  });
  it("rejects malformed measures and unknown keys", () => {
    expect(parseVoiceDiagnosticEvent({ ...base, bootToInitMs: 650 })).toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, bootToInitMs: { value: 0, reason: "not_observed" } })).toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, queueWaitMs: { value: -1, reason: null } })).toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, bootToInit: { value: 1, reason: null } })).toBeNull();
  });
  it("KPR-464-era rows without the keys still parse and the complete fixture still reduces to the same totals", () => {
    // COMPLETE_FIXTURE is the file-level constant at line 22 (import.meta.url-
    // relative — never a cwd-relative readFileSync). The count is the literal
    // the existing fixture test at line 68 pins; a drift here is a real change.
    const report = reduceVoiceDiagnostics(COMPLETE_FIXTURE, "call-fixture");
    expect(report.complete).toBe(true);
    expect(report.engineAttempts).toBe(1);
  });
});
```

`src/voice/voice-trace.test.ts` — add a sibling of "constructs the fixed content-free envelope" (line 49) that makes R7 an **observed** property for the two new keys, not a type constraint: build an `engine_attempt_terminal` event via `voiceDiagnosticEvent` (the file's `event()` helper at line 14 only shapes `call_started`/`call_closed`, so call `voiceDiagnosticEvent` directly with `{ component: "voice-engine", callId: "call", workerBootId: randomUUID() }`) whose `bootToInitMs`/`queueWaitMs` are `measure(650, "not_observed")` / `measure(undefined, "not_applicable")`, then assert `JSON.stringify(row)` still matches the existing content-free regex and additionally contains none of `"SENTINEL"`, `"+1555"`, `"Bearer "`. Because `Measure`'s `value` is typed `number | null`, the only way a string could reach the row is through a caller casting past the type — also pin `typeof row.bootToInitMs.value === "number"` and `row.queueWaitMs.value === null` so a future widening of `Measure` is caught here.

- [ ] **Step 4: Verify and commit.**

Run: `npx vitest run src/voice/voice-diagnostic-reader.test.ts src/voice/voice-trace.test.ts`
Expected: pass. Reader fixture CLI: `npx tsx scripts/read-voice-diagnostics.ts --input docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl --call-id call-fixture` exits 0 with the same totals as before this chunk.

```bash
git add src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts src/voice/voice-trace.test.ts
git commit -m "feat(voice): allowlist bootToInitMs/queueWaitMs in the diagnostic reader (KPR-465)"
```

### Task A4: Stamp `bootToInitMs` and `queueWaitMs` on the engine payload

**Files:**
- Modify: `src/voice/voice-trace.ts:240-273` (`EnginePayload`; `measure()` at 55–59 is the classifier both helpers below lean on)
- Modify: `src/channels/voice/voice-adapter.ts:305-308` (`requestOutcome` / `emitEngine` — helper insertion point), `:614-657` (`engine_attempt_terminal` in the attempt `finally`; `attemptOutcome` is computed at 616–624 and is only ever `"failed" | "cancelled" | "completed"` — the adapter never emits `"interrupted"`: an aborted `TurnResult` maps to `"cancelled"`), `:932-952` (`engine_terminal`; `requestOutcome` may additionally be `"incomplete"`), `:859-878` (the "Voice turn complete" row spreads `result.stageTimings`, so a warm row carries `queueWaitMs` with no adapter change)
- Test: `src/channels/voice/voice-adapter.integration.test.ts`, `src/channels/voice/voice-startup.integration.test.ts`

- [ ] **Step 1: Payload keys.**

In `EnginePayload` add after `initToFirstTokenMs?: Measure;`:

```typescript
  /** KPR-465 §3.2: cold every attempt; warm opener only; warm turns ≥ 2 not_applicable; any outcome other than `completed` (failed, cancelled, incomplete) not_observed. */
  bootToInitMs?: Measure;
  /** KPR-465 §3.2: warm turns only (entry → consume start; opener → open call); cold not_applicable; any outcome other than `completed` (failed, cancelled, incomplete) not_observed. */
  queueWaitMs?: Measure;
```

- [ ] **Step 2: Adapter mapping helpers.**

Add near `measure` usage at the top of `handleTurn`'s closure (just after `const emitEngine = ...` at line ~308):

```typescript
    // KPR-465 §3.2: stage measures with honest reasons. Any attempt whose
    // outcome is not "completed" forces not_observed for BOTH new stages —
    // spec §3.2 bullet 2 says "a failed, cancelled or disconnected attempt",
    // and this adapter encodes a barge-in/disconnect as `cancelled` (an
    // aborted TurnResult → "cancelled" at line ~622; "interrupted" is never
    // emitted here), so guarding only "failed" would let a cancelled turn 1
    // that still returned a result carry real-but-misleading stage values.
    // The request terminal's `incomplete` falls under the same guard. The
    // three pre-existing stages stay outcome-blind exactly as today — not
    // harmonized in this chunk (Verification Rules).
    const bootToInitMeasure = (r: TurnResult | undefined, outcome: AttemptOutcome): Measure => {
      if (!r || outcome !== "completed") return measure(undefined, "not_observed");
      if (r.warmPath && (r.warmTurnSeq ?? 0) >= 2) return measure(undefined, "not_applicable");
      return measure(r.stageTimings?.bootToInitMs, "not_observed"); // cold, or warm turn 1 (a survivor without the boot stage lands here → not_observed)
    };
    const queueWaitMeasure = (r: TurnResult | undefined, outcome: AttemptOutcome): Measure => {
      if (!r || outcome !== "completed") return measure(undefined, "not_observed");
      if (!r.warmPath) return measure(undefined, "not_applicable");
      return measure(r.stageTimings?.queueWaitMs, "not_observed");
    };
```

(`measure`, `AttemptOutcome` and `EnginePayload` are already imported from `../../voice/voice-trace.js` at lines 28–37 of this file; add `type Measure` to that import list — it is not there today.)

- [ ] **Step 3: Stamp the attempt terminal.**

In the `engine_attempt_terminal` literal (after `initToFirstTokenMs: measure(...)`, line ~652):

```typescript
              bootToInitMs: bootToInitMeasure(attemptResult, attemptOutcome),
              queueWaitMs: queueWaitMeasure(attemptResult, attemptOutcome),
```

In the `engine_terminal` literal (after `responseCompleteMs`, line ~943):

```typescript
          bootToInitMs: bootToInitMeasure(finalResult, requestOutcome),
          queueWaitMs: queueWaitMeasure(finalResult, requestOutcome),
```

(`requestOutcome` is the request-level `AttemptOutcome` already in scope.) **Consequence for the later chunks (pointer only; chunks B and E are not edited here):** on a request whose outcome is `incomplete`, the attempt row can still be `completed` with real stage values while the request-level row reports `not_observed` for both keys — attempt-level and request-level truth legitimately disagree. Chunk B's stage-table sourcing and chunk E's evidence record must source stages from `engine_attempt_terminal`, never from the request-level `engine_terminal` row.

- [ ] **Step 4: Integration tests.**

`src/channels/voice/voice-adapter.integration.test.ts` — add three cases inside the `describe("VoiceAdapter integration (KPR-219)")` block using the file's real helpers, whose shapes (verified at HEAD) are: `makeAdapter({ spawn, bridgeToken })` returns a setup object (**not** `{adapter, port}`), `startAdapter(setup)` (line 271, a `describe`-local) starts it and returns `{ port }` and registers it for the block's `afterEach` `adapter.stop()` (line 263) — so no `try/finally` is needed; `postChatCompletion(port, { headers, body })` (line 143) takes the bearer as a `headers.authorization` entry, not a `bearer` option; `workerShapedBody(callId)` (178), `echoTurnResult(text, aborted?)` (186), `engineRows(event)` (204), `E2_BRIDGE_TOKEN = "tok-1"` (176), and the hoisted `mockLog` (17) captures "Voice turn complete" via `mockLog.info`. **Bridge-token wiring is mandatory:** `makeAdapter`'s default `bridgeToken` is `""` (LiveKit disabled — line 136), so a worker-shaped body with a bearer is rejected unless `bridgeToken: E2_BRIDGE_TOKEN` is passed, exactly as the trace-metadata case at line 420 does.

```typescript
  it("KPR-465: cold attempt terminal carries bootToInitMs equal to the log row's and queueWaitMs not_applicable", async () => {
    const spawn = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("hi");
      return { ...echoTurnResult("hi"), stageTimings: { lockWaitMs: 1, spawnPrepMs: 2, bootToInitMs: 741, initToFirstTokenMs: 1263 } };
    };
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("cold-465"),
    });
    expect(res.status).toBe(200);
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "cold-465")!;
    expect(terminal.outcome).toBe("completed");
    expect(terminal.bootToInitMs).toEqual({ value: 741, reason: null });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
    const requestTerminal = engineRows("engine_terminal").find((r) => r.callId === "cold-465")!;
    expect(requestTerminal.bootToInitMs).toEqual({ value: 741, reason: null });
    expect(requestTerminal.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
    const logRow = mockLog.info.mock.calls.find((c) => c[0] === "Voice turn complete")![1] as Record<string, unknown>;
    expect(logRow.bootToInitMs).toBe(741);
    expect(logRow).not.toHaveProperty("queueWaitMs");
  });

  it("KPR-465: a failed attempt reports not_observed for both new stages", async () => {
    const spawn = async (): Promise<TurnResult> => ({
      ...echoTurnResult(""),
      errors: ["boom"],
      stageTimings: { lockWaitMs: 0, spawnPrepMs: 0, bootToInitMs: 500 },
    });
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    await postChatCompletion(p, { headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` }, body: workerShapedBody("failed-465") });
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "failed-465")!;
    expect(terminal.outcome).toBe("failed");
    expect(terminal.bootToInitMs).toEqual({ value: null, reason: "not_observed" });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_observed" });
  });

  // The adapter encodes barge-in/disconnect as `cancelled` (aborted result →
  // "cancelled"), never "interrupted"; spec §3.2 bullet 2 wants not_observed
  // for it too — a cancelled warm turn 1 must not contribute a boot sample.
  it("KPR-465: a cancelled (aborted-result) attempt reports not_observed for both new stages even when the stages were measured", async () => {
    const spawn = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("partial");
      return {
        ...echoTurnResult("partial", true),
        warmPath: true,
        warmTurnSeq: 1,
        stageTimings: { lockWaitMs: 0, spawnPrepMs: 0, queueWaitMs: 12, bootToInitMs: 500, initToFirstTokenMs: 40 },
      };
    };
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    await postChatCompletion(p, { headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` }, body: workerShapedBody("cancelled-465") });
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "cancelled-465")!;
    expect(terminal.outcome).toBe("cancelled");
    expect(terminal.bootToInitMs).toEqual({ value: null, reason: "not_observed" });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_observed" });
    // Pre-existing stages stay outcome-blind (unchanged behavior, pinned so a "harmonizing" edit is caught).
    expect(terminal.initToFirstTokenMs).toEqual({ value: 40, reason: null });
  });
```

(`TurnResult` is already imported in this file; `warmPath`/`warmTurnSeq` are existing optional `TurnResult` fields.)

`src/channels/voice/voice-startup.integration.test.ts` — add a **sibling** of the warm demux case (line 604), not an extension of it: that case's first terminal is the *cancelled* row (`cancelled.req.destroy()` lands before `releaseFirst()`), so any positional `attempts[0]` read would select the `not_observed` row. The new case runs two clean sequential warm turns on one call and selects rows by outcome + continuity. **Fake shape:** the suite's fakes (`successfulQuery` at 243, the inline fake at 610) push `system/init` *before* the first input pull — that is fine and needs no change: the opener's `bootToInitMs` is open call → init observed by the consume loop, a small non-negative number here, and `expect.any(Number)` accepts 0. No timer manipulation.

```typescript
  it("KPR-465: warm attempt terminals carry the boot stage on the opener only and the queue stage on every turn", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const fixture = makeFixture();
    const pushed: string[] = [];
    runnerControl.openStream.mockImplementation(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        successfulQuery(input, "warm-465-text", "warm-465-session", pushed),
    );
    const port = await start(fixture.adapter);
    // body(callId) uses the callId itself as the user content (line 201), which
    // legitimately appears on every row as `callId` — so the R7 sentinel is an
    // explicit transcript line, not the callId.
    const TRANSCRIPT_SENTINEL = "SENTINEL-TRANSCRIPT-465 +15555550100";
    const withSentinel = () => ({ ...body("warm-465"), messages: [{ role: "user", content: TRANSCRIPT_SENTINEL }] });
    const a = begin(port, withSentinel());
    expect(await a.done).toContain("[DONE]");
    const b = begin(port, withSentinel());
    expect(await b.done).toContain("[DONE]");
    await vi.waitFor(() => expect(rows("warm-465", "engine_terminal")).toHaveLength(2));
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);

    const attempts = rows("warm-465", "engine_attempt_terminal").filter((r) => r.outcome === "completed" && r.warm === true);
    expect(attempts).toHaveLength(2);
    const opener = attempts.find((r) => r.selectedContinuity === "fresh")!;
    const second = attempts.find((r) => r.selectedContinuity === "warm")!;
    expect(opener).toMatchObject({ bootToInitMs: { value: expect.any(Number), reason: null }, queueWaitMs: { value: expect.any(Number), reason: null } });
    expect(second).toMatchObject({ bootToInitMs: { value: null, reason: "not_applicable" }, queueWaitMs: { value: expect.any(Number), reason: null } });
    const requestTerminals = rows("warm-465", "engine_terminal");
    expect(requestTerminals.map((r) => r.queueWaitMs)).toEqual([
      { value: expect.any(Number), reason: null },
      { value: expect.any(Number), reason: null },
    ]);
    // Spec §3.2 bullet 1 names the "Voice turn complete" row: a warm row carries queueWaitMs (the cold row's absence is pinned in the adapter suite).
    const warmLogRows = traceLog.info.mock.calls.filter((c) => c[0] === "Voice turn complete" && (c[1] as Record<string, unknown>).callId === "warm-465");
    expect(warmLogRows).toHaveLength(2);
    for (const [, data] of warmLogRows) expect(typeof (data as Record<string, unknown>).queueWaitMs).toBe("number");
    // R7 at runtime: the request transcript never rides any engine row.
    expect(pushed.join("\n")).toContain("SENTINEL-TRANSCRIPT-465"); // the sentinel really reached the provider input …
    for (const row of rows("warm-465", "engine_attempt_terminal")) expect(JSON.stringify(row)).not.toContain("SENTINEL");
    for (const row of rows("warm-465", "engine_terminal")) expect(JSON.stringify(row)).not.toContain("+1555");
    for (const [, data] of warmLogRows) expect(JSON.stringify(data)).not.toContain("SENTINEL"); // … and never the log row either
  });
```

(`makeFixture` 135, `body` 198, `begin` 411 — `begin` defaults its bearer to `"bridge-token"`, matching the fixture — `rows` 447, `start` is the `describe`-local at 492 which registers the adapter for `afterEach`; `traceLog` is the hoisted logger mock at 38 whose `info` is a `vi.fn()`; `successfulQuery` at 243 records each pushed prompt into `pushed`, which is what makes the positive half of the sentinel check honest.)

- [ ] **Step 5: R5 regression check (before/after).**

Run the startup suite on the parent commit and on this commit: `npx vitest run src/channels/voice/voice-startup.integration.test.ts src/agents/voice-request-cancellation.test.ts --reporter=verbose`. Expected: identical pass lists (V1 identity, V2 ordering, V4 cancellation, V8 no-duplicate, V9 opening-reservation rows are the existing "cold request cancellation releases only its real spawn ticket...", "warm demux drops a cancelled queued request...", "opener reserves...", and the retained-lifetime cases). Record the two pass lists in the delivery notes.

- [ ] **Step 6: Commit.**

```bash
git add src/voice/voice-trace.ts src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts
git commit -m "feat(voice): stamp bootToInitMs and queueWaitMs on engine attempt/request terminals (KPR-465)"
```

### Task A5: Chunk gate

- [ ] Run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.
- [ ] Run `npm run build` — exit 0.
- [ ] Record in the delivery notes: the R5 before/after pass lists (Task A4 Step 5), the negative-verify results (A1 Step 5 a/b/c, A2 Step 6a/6b), the version decision (A3 Step 2), and four pointers for the later chunks — (i) for chunk E's evidence record: the opener's queue stage ends at the open call, a deliberate refinement of spec §3.2 bullet 1 so the stage table's three warm stages are disjoint; (ii) for chunk E: the two new measures are `not_observed` for **every** non-`completed` outcome (failed, cancelled, incomplete), while the three pre-existing stage measures remain outcome-blind as before; (iii) for chunks B and E: on an `incomplete` request the attempt row can be `completed` with real stage values while the request-level row is `not_observed` — source stage tables and evidence from `engine_attempt_terminal`, never the request-level row (Task A4 Step 3); (iv) a sampling-bias note for chunk E: forcing `not_observed` on a cancelled turn 1 discards genuinely observed boot timing under barge-in, so if barge-in-on-turn-1 turns out to be common in the live sample the boot-stage sample is biased toward uninterrupted openers and the evidence record must say so (the cancelled-attempt row count against the completed-opener count is the check).
