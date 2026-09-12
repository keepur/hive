# KPR-465 instrumentation chunk (A) — close the two warm-lease measurement gaps

> **For agentic workers:** Use dodi-dev:implement after the parent [plan](./kpr-465-plan.md) review gate passes. This chunk is first in the binding order.

**Goal:** Every warm voice turn reports a non-overlapping `queueWaitMs` + (turn 1 only) `bootToInitMs` + `initToFirstTokenMs` decomposition, and both `engine_attempt_terminal` and `engine_terminal` carry `bootToInitMs` and `queueWaitMs` as nullable measures with excluded-by-reason accounting, while cold `stageTimings` stay byte-identical.

**Architecture:** The manager stamps one anchor at `spawnTurn`'s warm-branch entry and threads it (through the pending-opening recursion, `openWarmLease`, `openWarmLeaseAttempt`, `runWarmTurn`) into `WarmTurnRequest.enqueuedAt`; the manager stamps a second anchor immediately before `runner.openVoiceStreamingSession(...)` and hands it to `lease.start(q, { openCalledAt })`. `consumeOneTurn` computes `queueWaitMs` at consume start (for the opener turn the queue stage ends where the boot stage begins, so the three stages never overlap), computes turn-1 `bootToInitMs` at the `system/init` message, and re-bases turn-1 `initToFirstTokenMs` to init → first delta. The adapter maps the values onto `EnginePayload` measures with `not_applicable` for warm turns ≥ 2 and `not_observed` for failed attempts; the reader's allowlist and measure validator accept the two keys in the same commit.

**Tech Stack:** TypeScript, existing `WarmVoiceSession`/`AgentManager`/`VoiceAdapter`, `voice-trace.ts` `Measure`, Vitest with the existing fake-Query and echo-streaming harnesses.

Spec authority: §3.2 (both bullets), §8 R2, R5, R7. Canon R3 (lease semantics unchanged) and R2 (schema v2, `{value, reason}` measures, never zero-coerced).

## Testing Contract (chunk A)

### Required Test Groups

- Unit: `required`
  - Scope: `WarmVoiceSession.consumeOneTurn` anchors (`src/agents/warm-voice-session.test.ts`); reader allowlist/validation (`src/voice/voice-diagnostic-reader.test.ts`); `EnginePayload` privacy (`src/voice/voice-trace.test.ts`).
  - Reason: the three measures are deterministic functions of four timestamps; a fake Query controls all four.
  - Minimum assertions: (1) queued behind an in-flight turn — turn 2's `queueWaitMs ≥` the artificial hold and turn 2's `bootToInitMs === undefined`; (2) turn 1 — `bootToInitMs` spans `openCalledAt → init`, `initToFirstTokenMs` spans init → first delta (not push → delta); (3) turn 1 without an `openCalledAt` (a caller that never passed it) — `bootToInitMs === undefined`, `initToFirstTokenMs` falls back to push → delta; (4) a turn whose output ends before `result` still returns `queueWaitMs` (a number) and `bootToInitMs` undefined; (5) reader accepts `engine_attempt_terminal`/`engine_terminal` rows with `queueWaitMs`/`bootToInitMs` measures, rejects `{value: 0, reason: "not_observed"}`-style mixed measures and unknown keys; (6) KPR-464 fixtures reduce with the same totals as before.
- Integration: `required`
  - Scope: `src/agents/agent-manager.test.ts` warm block (queue anchor through `spawnTurn` recursion and `openGate`); `src/channels/voice/voice-adapter.integration.test.ts` (cold payload stamps from a fake spawn's `stageTimings`); `src/channels/voice/voice-startup.integration.test.ts` (warm payload stamps through the real lease; R5 rows V1/V2-ordering/V4/V8/V9 green before and after).
  - Reason: `queueWaitMs` is measured across the manager's pending-opening wait, which only the real manager exercises; the adapter's `measure(...)` mapping is only proved on the real HTTP path.
  - Harness: `existing` (see parent plan Harness Requirements).
  - Minimum assertions: queued-behind-pending-opening `queueWaitMs ≥ gate hold`; cold `engine_attempt_terminal.bootToInitMs.value === 741` when the fake spawn returns `stageTimings.bootToInitMs: 741` and the "Voice turn complete" log call carries `bootToInitMs: 741`; cold `queueWaitMs` is `{value: null, reason: "not_applicable"}`; warm turn 2 `bootToInitMs` is `{value: null, reason: "not_applicable"}`; failed attempt both `{value: null, reason: "not_observed"}`; cold `stageTimings` object deep-equals `{ lockWaitMs, spawnPrepMs, bootToInitMs, initToFirstTokenMs }` with no extra key.
- E2E: `not-required` for this chunk (the offline bench E2E lives in chunk D and consumes these fields; live rows live in chunk E).

### Critical Flows

- Opener turn: entry → open call (queue) → init (boot) → first delta (model), three disjoint intervals.
- Joiner turn (V9): entry → `waitForVoiceOpening` → recursion → `runWarmTurn` → consume start, one `queueWaitMs`.
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

- `makeFakeQuery` (warm-voice-session.test.ts) is driven by the test; emit `init` only after the test observes the push where the case needs a real boot interval (use `vi.useFakeTimers()` + `vi.advanceTimersByTime` around `emit(initMsg(...))`).
- Manager warm tests use `installEchoStreamingRunner({ openGate })` to hold the opening; the joiner's `queueWaitMs` is asserted against the gate hold measured with fake timers.

### Non-Required Rationale

- E2E: consumed by chunk D's bench test and chunk E's live rows; nothing E2E-shaped is unique to this chunk.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- The one deliberate re-pin in this chunk is `agent-manager.test.ts` line ~7604 (`expect(r1.stageTimings).toEqual({ lockWaitMs: 0, spawnPrepMs: 0, initToFirstTokenMs: expect.any(Number) })`) — it gains `queueWaitMs` and turn-1 `bootToInitMs`; re-pin in Task A2's commit and record the negative-verify (revert A1+A2, confirm it fails).

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
   * The queue stage is measured from here to consume start (turns ≥ 2) or to
   * the openVoiceStreamingSession call (the opener turn), so it folds in the
   * pending-opening wait (V9) and the lease's turnChain wait, and never
   * overlaps the boot stage. Optional only for out-of-manager callers (tests);
   * the manager always passes it.
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
   * enqueuedAt). Always a number when enqueuedAt was supplied; undefined when
   * it was not (then the adapter reports not_observed).
   */
  queueWaitMs?: number;
  // bootToInitMs (inherited from RunResult) is set on the OPENER turn only:
  // openVoiceStreamingSession call → the system/init message observed by
  // this loop. Turns ≥ 2 leave it undefined (the adapter reports
  // not_applicable). initToFirstTokenMs on the opener is init → first delta;
  // on turns ≥ 2 it stays push → first delta (KPR-323 C2, unchanged).
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
    // KPR-465 §3.2: queue stage. Opener turn (ownedTurn === 1 with a recorded
    // open anchor): entry → open call, so it ends exactly where bootToInitMs
    // begins. Every later turn: entry → now (consume start). Never negative.
    const consumeStartedAt = Date.now();
    const queueEndAt = ownedTurn === 1 && this.openCalledAt !== undefined ? this.openCalledAt : consumeStartedAt;
    const queueWaitMs = req.enqueuedAt === undefined ? undefined : Math.max(0, queueEndAt - req.enqueuedAt);
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
              // KPR-465 §3.2: opener turn only — open call → init observed here.
              if (ownedTurn === 1 && this.openCalledAt !== undefined && bootToInitMs === undefined) {
                initAt = Date.now();
                bootToInitMs = Math.max(0, initAt - this.openCalledAt);
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
    vi.useFakeTimers({ now: 1_000 });
    const enqueuedAt = 1_000;
    vi.setSystemTime(1_300); // 300 ms of pre-open wait (runner build, shaping)
    const { fq, lease } = openLease({ openCalledAt: 1_300 });
    const turn = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt });
    await vi.advanceTimersByTimeAsync(0); // consume start
    vi.setSystemTime(1_950); // CLI boot 650 ms
    fq.emit(initMsg("s1"));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(3_250); // model 1 300 ms
    fq.emit(delta("hi"));
    fq.emit(resultMsg({ result: "hi", session_id: "s1" }));
    const r = await turn;
    expect(r.queueWaitMs).toBe(300);
    expect(r.bootToInitMs).toBe(650);
    expect(r.initToFirstTokenMs).toBe(1_300);
  });

  it("turn ≥ 2 queued behind an in-flight turn: queueWaitMs spans entry → consume start; bootToInitMs undefined; initToFirstTokenMs is push → delta", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fq, lease } = openLease({ openCalledAt: 0 });
    fq.emit(initMsg("s1"));
    const t1 = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(100);
    const t2 = lease.runTurn({ text: "t2", timeoutMs: 5_000, enqueuedAt: 100 }); // queued behind t1
    vi.setSystemTime(900);
    fq.emit(delta("a"));
    fq.emit(resultMsg({ result: "a", session_id: "s1" }));
    await t1;
    await vi.advanceTimersByTimeAsync(0); // t2 consume start at 900
    vi.setSystemTime(1_400);
    fq.emit(delta("b"));
    fq.emit(resultMsg({ result: "b", session_id: "s1" }));
    const r2 = await t2;
    expect(r2.queueWaitMs).toBe(800);
    expect(r2.bootToInitMs).toBeUndefined();
    expect(r2.initToFirstTokenMs).toBe(500);
  });

  it("opener without an open anchor: bootToInitMs undefined, initToFirstTokenMs falls back to push → delta, queueWaitMs still measured to consume start", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fq, lease } = openLease();
    const t1 = lease.runTurn({ text: "t1", timeoutMs: 5_000, enqueuedAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(50);
    fq.emit(initMsg("s1"));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(250);
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t1;
    expect(r.bootToInitMs).toBeUndefined();
    expect(r.initToFirstTokenMs).toBe(250);
    expect(r.queueWaitMs).toBe(0);
  });

  it("no enqueuedAt ⇒ queueWaitMs undefined (out-of-manager caller)", async () => {
    const { fq, lease } = openLease({ openCalledAt: Date.now() });
    fq.emit(initMsg("s1"));
    const t = lease.runTurn({ text: "t", timeoutMs: 5_000 });
    fq.emit(delta("x"));
    fq.emit(resultMsg({ result: "x", session_id: "s1" }));
    const r = await t;
    expect(r.queueWaitMs).toBeUndefined();
    expect(typeof r.bootToInitMs).toBe("number");
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
  });
});
```

(`initMsg`, `delta`, `resultMsg`, `makeFakeQuery` already exist at the top of the file.)

- [ ] **Step 5: Verify.**

Run: `npx vitest run src/agents/warm-voice-session.test.ts`
Expected: all existing cases pass; the five new cases pass. Negative-verify: temporarily revert Step 3's `queueEndAt` line to `consumeStartedAt` — the opener case fails on `queueWaitMs` (expects 300, gets 950); restore.

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

Add inside the warm `describe` a case for the pending-opening queue (V9 shape):

```typescript
    it("KPR-465: a request queued behind a pending opening reports queueWaitMs spanning its FIRST warm-branch entry", async () => {
      vi.useFakeTimers({ now: 10_000 });
      let openGateResolve!: () => void;
      const openGate = new Promise<void>((r) => (openGateResolve = r));
      installEchoStreamingRunner({ openGate });
      const t1 = manager.spawnTurn(makeVoiceCtx({ sessionId: undefined }));
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingWarmOpenings(manager).size).toBe(1);
      const t2 = manager.spawnTurn(makeVoiceCtx({ sessionId: undefined })); // joiner
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(10_700); // opening held 700 ms
      openGateResolve();
      const r1 = await t1;
      const r2 = await t2;
      expect(r1.warmTurnSeq).toBe(1);
      expect(r2.warmTurnSeq).toBe(2);
      expect(r2.stageTimings!.queueWaitMs).toBeGreaterThanOrEqual(700);
      expect(r2.stageTimings!.bootToInitMs).toBeUndefined();
      expect(r1.stageTimings!.bootToInitMs).toBeGreaterThanOrEqual(0);
      vi.useRealTimers();
    });
```

Also assert cold immutability in the existing `spawnTurn C1 stageTimings (KPR-323)` block:

```typescript
    it("KPR-465: cold stageTimings carry no queueWaitMs key (byte-identical cold shape)", async () => {
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ bootToInitMs: 741, initToFirstTokenMs: 1263 }));
      const result = await manager.spawnTurn({ ...makeCtx(makeWorkItem({ text: "v" }), "voice"), threadId: "voice:cold" });
      expect(Object.keys(result.stageTimings!).sort()).toEqual(["bootToInitMs", "initToFirstTokenMs", "lockWaitMs", "spawnPrepMs"]);
    });
```

(Use the file's existing `makeRunResult`/`makeCtx`/`makeWorkItem` helpers; the C1 block at ~804–842 already constructs a voice ctx the same way.)

- [ ] **Step 6: Verify.**

Run: `npx vitest run src/agents/agent-manager.test.ts -t "warm voice lease|stageTimings|KPR-465"`
Expected: pass. Then the full file: `npx vitest run src/agents/agent-manager.test.ts` — pass, no other pin moved. Negative-verify: revert Step 4's `queueWaitMs` spread → the re-pinned assertion fails; restore.

- [ ] **Step 7: Commit.**

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "feat(voice): thread the warm queue anchor and opener boot anchor through the manager (KPR-465)"
```

### Task A3: Stamp `bootToInitMs` and `queueWaitMs` on the engine payload

**Files:**
- Modify: `src/voice/voice-trace.ts:290-320` (`EnginePayload`)
- Modify: `src/channels/voice/voice-adapter.ts:600-660` (`engine_attempt_terminal`), `:930-952` (`engine_terminal`)
- Test: `src/channels/voice/voice-adapter.integration.test.ts`, `src/channels/voice/voice-startup.integration.test.ts`

- [ ] **Step 1: Payload keys.**

In `EnginePayload` add after `initToFirstTokenMs?: Measure;`:

```typescript
  /** KPR-465 §3.2: cold every attempt; warm opener only; warm turns ≥ 2 not_applicable; failed not_observed. */
  bootToInitMs?: Measure;
  /** KPR-465 §3.2: warm turns only (entry → consume start / open call); cold not_applicable; failed not_observed. */
  queueWaitMs?: Measure;
```

- [ ] **Step 2: Adapter mapping helpers.**

Add near `measure` usage at the top of `handleTurn`'s closure (just after `const emitEngine = ...` at line ~308):

```typescript
    // KPR-465 §3.2: stage measures with honest reasons. `outcome === "failed"`
    // forces not_observed for both new stages (spec R2) so an excluded attempt
    // never contributes a stage sample; the pre-existing stages are untouched.
    const bootToInitMeasure = (r: TurnResult | undefined, outcome: AttemptOutcome): Measure => {
      if (!r || outcome === "failed") return measure(undefined, "not_observed");
      if (r.warmPath && (r.warmTurnSeq ?? 0) >= 2) return measure(undefined, "not_applicable");
      return measure(r.stageTimings?.bootToInitMs, "not_observed");
    };
    const queueWaitMeasure = (r: TurnResult | undefined, outcome: AttemptOutcome): Measure => {
      if (!r || outcome === "failed") return measure(undefined, "not_observed");
      if (!r.warmPath) return measure(undefined, "not_applicable");
      return measure(r.stageTimings?.queueWaitMs, "not_observed");
    };
```

(`Measure` and `AttemptOutcome` are already imported from `../../voice/voice-trace.js` in this file — confirm the import list at lines 28–37 and add them if absent.)

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

(`requestOutcome` is the request-level `AttemptOutcome` already in scope.)

- [ ] **Step 4: Integration tests.**

`src/channels/voice/voice-adapter.integration.test.ts` — add two cases using the file's real helpers (`makeAdapter({ spawn })`, `workerShapedBody(callId)`, `postChatCompletion(...)`, `echoTurnResult(text)`, `engineRows(event)`; read their signatures at lines 63–215 before writing):

```typescript
  it("KPR-465: cold attempt terminal carries bootToInitMs equal to the log row's and queueWaitMs not_applicable", async () => {
    const spawn = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("hi");
      return { ...echoTurnResult("hi"), stageTimings: { lockWaitMs: 1, spawnPrepMs: 2, bootToInitMs: 741, initToFirstTokenMs: 1263 } };
    };
    const { adapter, port } = await makeAdapter({ spawn });
    try {
      const body = workerShapedBody("cold-465");
      await postChatCompletion(port, body, { bearer: BRIDGE_TOKEN });
      const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "cold-465")!;
      expect(terminal.bootToInitMs).toEqual({ value: 741, reason: null });
      expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
      const requestTerminal = engineRows("engine_terminal").find((r) => r.callId === "cold-465")!;
      expect(requestTerminal.bootToInitMs).toEqual({ value: 741, reason: null });
      const logRow = mockLog.info.mock.calls.find((c) => c[0] === "Voice turn complete")![1] as Record<string, unknown>;
      expect(logRow.bootToInitMs).toBe(741);
      expect(logRow).not.toHaveProperty("queueWaitMs");
    } finally {
      adapter.stop();
    }
  });

  it("KPR-465: a failed attempt reports not_observed for both new stages", async () => {
    const spawn = async (): Promise<TurnResult> => ({ ...echoTurnResult(""), errors: ["boom"], stageTimings: { lockWaitMs: 0, spawnPrepMs: 0, bootToInitMs: 500 } });
    const { adapter, port } = await makeAdapter({ spawn });
    try {
      await postChatCompletion(port, workerShapedBody("failed-465"), { bearer: BRIDGE_TOKEN });
      const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "failed-465")!;
      expect(terminal.outcome).toBe("failed");
      expect(terminal.bootToInitMs).toEqual({ value: null, reason: "not_observed" });
      expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_observed" });
    } finally {
      adapter.stop();
    }
  });
```

(`BRIDGE_TOKEN`, the `makeAdapter` return shape and `postChatCompletion`'s option name for the bearer are whatever the file already uses for its bridge-auth cases — copy them verbatim; the assertions above are the load-bearing part.)

`src/channels/voice/voice-startup.integration.test.ts` — extend the existing warm case ("warm demux drops a cancelled queued request ...", ~line 604) or add a sibling that runs two warm turns on one call and asserts:

```typescript
    const attempts = rows("warm-465", "engine_attempt_terminal");
    expect(attempts[0]).toMatchObject({ warm: true, bootToInitMs: { value: expect.any(Number), reason: null }, queueWaitMs: { value: expect.any(Number), reason: null } });
    expect(attempts[1]).toMatchObject({ warm: true, bootToInitMs: { value: null, reason: "not_applicable" }, queueWaitMs: { value: expect.any(Number), reason: null } });
```

The harness's `runnerControl.openStream` fake must emit `system/init` after the first input pull for the opener's `bootToInitMs` to be non-zero-but-finite; `expect.any(Number)` accepts 0, so no timer manipulation is required here.

- [ ] **Step 5: R5 regression check (before/after).**

Run the startup suite on the parent commit and on this commit: `npx vitest run src/channels/voice/voice-startup.integration.test.ts src/agents/voice-request-cancellation.test.ts --reporter=verbose`. Expected: identical pass lists (V1 identity, V2 ordering, V4 cancellation, V8 no-duplicate, V9 opening-reservation rows are the existing "cold request cancellation releases only its real spawn ticket...", "warm demux drops a cancelled queued request...", "opener reserves...", and the retained-lifetime cases). Record the two pass lists in the delivery notes.

- [ ] **Step 6: Commit.**

```bash
git add src/voice/voice-trace.ts src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts
git commit -m "feat(voice): stamp bootToInitMs and queueWaitMs on engine attempt/request terminals (KPR-465)"
```

### Task A4: Reader allowlist + validation for the two measures; ⚠ version-bump decision

**Files:**
- Modify: `src/voice/voice-diagnostic-reader.ts:263-296` (`PAYLOAD_FIELDS.engine_attempt_terminal`, `.engine_terminal`), `:956-975` (`validatePayload` measure list)
- Test: `src/voice/voice-diagnostic-reader.test.ts`, `src/voice/voice-trace.test.ts`

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
    const text = readFileSync("docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl", "utf8");
    const report = reduceVoiceDiagnostics(text, "call-fixture");
    expect(report.complete).toBe(true);
    expect(report.engineAttempts).toBe(/* copy the value the existing complete-fixture test asserts */ report.engineAttempts);
  });
});
```

(Replace the tautological last assertion with the literal count the existing test at ~line 62 pins — copy it, do not re-derive.)

`src/voice/voice-trace.test.ts` — extend the existing privacy sentinel case: build an `engine_attempt_terminal` event via `voiceDiagnosticEvent` with `bootToInitMs`/`queueWaitMs` and assert `JSON.stringify(event)` contains no `"sentinel-transcript"`, no `"+1555"`, no `"Bearer "` (the sentinels are never passed in, so the assertion is that the payload type admits no string-valued new key — assert `typeof event.bootToInitMs.value` is `number | null`).

- [ ] **Step 4: Verify and commit.**

Run: `npx vitest run src/voice/voice-diagnostic-reader.test.ts src/voice/voice-trace.test.ts`
Expected: pass. Reader fixture CLI: `npx tsx scripts/read-voice-diagnostics.ts --input docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl --call-id call-fixture` exits 0 with the same totals as before this chunk.

```bash
git add src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts src/voice/voice-trace.test.ts
git commit -m "feat(voice): allowlist bootToInitMs/queueWaitMs in the diagnostic reader (KPR-465)"
```

### Task A5: Chunk gate

- [ ] Run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.
- [ ] Run `npm run build` — exit 0.
- [ ] Record in the delivery notes: the R5 before/after pass lists (Task A3 Step 5), the negative-verify results (A1 Step 5, A2 Step 6), and the version decision (A4 Step 2).
